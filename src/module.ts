// Per-file analysis: split a CommonJS module into top-level "units" and record,
// for each unit, what it depends on. A unit is the smallest piece whose code is
// hashed: a declaration, an `exports.X = ...` assignment, one property of a
// `module.exports = { ... }` literal, or a loose top-level statement.
//
// The analysis depends only on the file's own text; resolving require specifiers
// to files happens later (project.ts), so results can be cached by content.
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import traverseModule, { type NodePath } from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';

const traverse = ((traverseModule as any).default ?? traverseModule) as typeof traverseModule;
const generate = ((generatorModule as any).default ?? generatorModule) as typeof generatorModule;

export type Dep =
  | { kind: 'unit'; unit: number }
  /** `name: null` means the whole module object escapes, so every export counts. */
  | { kind: 'import'; spec: string; name: string | null }
  /** This module's own exports read back, e.g. `exports.foo()` or `module.exports`. */
  | { kind: 'self'; name: string | null }
  /** Something static analysis cannot follow, e.g. `require(variable)`. */
  | { kind: 'opaque'; reason: string };

export interface Unit {
  hash: string;
  label: string;
  line: number;
  deps: Dep[];
  /** Runs on module load and is not tied to a local binding, so it can affect every function. */
  global: boolean;
}

export interface ModuleInfo {
  units: Unit[];
  exports: Map<string, number>;
  /** Unit of `module.exports = <not an object literal>`, if any. */
  defaultExport: number | null;
}

type Import = { spec: string; name: string | null };

export function analyzeJson(text: string): ModuleInfo {
  return {
    units: [{ hash: sha(text), label: 'json', line: 1, deps: [], global: false }],
    exports: new Map(),
    defaultExport: 0,
  };
}

export function analyzeModule(code: string, filename: string): ModuleInfo {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    sourceFilename: filename,
  });
  let program!: NodePath<t.Program>;
  traverse(ast, { Program(p) { program = p; p.stop(); } });

  const prelude = ast.program.directives.map((d) => d.value.value).join(';');
  const units: Unit[] = [];
  const unitByNode = new Map<t.Node, number>();
  const exportsMap = new Map<string, number>();
  let defaultExport: number | null = null;
  const imports = new Map<string, Import>(); // top-level binding -> required module
  const owner = new Map<string, number>(); // top-level binding -> declaring unit
  const importInits = new Set<t.Node>(); // require() calls already recorded as imports
  const exportTargets = new Set<t.Node>(); // `exports.X` on the left of a defining assignment
  const loose: [NodePath<t.Statement>, number][] = [];

  const addUnit = (node: t.Node, label: string): number => {
    const body = generate(node, { comments: false }).code;
    units.push({ hash: sha(`${prelude}\0${body}`), label, line: node.loc?.start.line ?? 0, deps: [], global: false });
    unitByNode.set(node, units.length - 1);
    return units.length - 1;
  };

  for (const stmt of program.get('body')) {
    const n = stmt.node;
    if (t.isVariableDeclaration(n)) {
      const found = n.declarations.map(requireBindings);
      if (found.every((f) => f !== null)) {
        for (const [i, f] of found.entries()) {
          for (const [name, imp] of f!) imports.set(name, imp);
          importInits.add(n.declarations[i].init!);
        }
        continue;
      }
      const names = n.declarations.flatMap((d) => Object.keys(t.getBindingIdentifiers(d.id)));
      const u = addUnit(n, `${n.kind} ${names.join(', ')}`);
      for (const name of names) owner.set(name, u);
    } else if ((t.isFunctionDeclaration(n) || t.isClassDeclaration(n)) && n.id) {
      owner.set(n.id.name, addUnit(n, `${t.isClassDeclaration(n) ? 'class' : 'function'} ${n.id.name}`));
    } else if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression, { operator: '=' })) {
      const { left, right } = n.expression;
      const name = exportName(left);
      if (name !== undefined) {
        exportTargets.add(left);
        exportsMap.set(name, addUnit(n, `exports.${name}`));
      } else if (isModuleExports(left)) {
        exportTargets.add(left);
        if (t.isObjectExpression(right) && right.properties.every(isPlainProperty)) {
          for (const p of right.properties as (t.ObjectProperty | t.ObjectMethod)[]) {
            const key = propertyKey(p)!;
            exportsMap.set(key, addUnit(p, `exports.${key}`));
          }
        } else {
          defaultExport = addUnit(n, 'module.exports');
        }
      } else {
        loose.push([stmt, addUnit(n, `statement`)]);
      }
    } else {
      loose.push([stmt, addUnit(n, `statement`)]);
    }
  }

  // A loose statement that mutates a local binding (`cache.set(...)`, `X.y = 1`,
  // `Object.freeze(X)`) belongs to that binding: whoever uses X depends on it.
  // Anything else (`setGlobalOptions(...)`, `admin.initializeApp()`) is global.
  for (const [stmt, u] of loose) {
    const root = t.isExpressionStatement(stmt.node) ? mutationRoot(stmt.node.expression) : null;
    const o = root !== null ? owner.get(root) : undefined;
    if (o !== undefined) units[o].deps.push({ kind: 'unit', unit: u });
    else units[u].global = true;
  }

  const unitOf = (p: NodePath): number | null => {
    for (let q: NodePath | null = p; q; q = q.parentPath) {
      const u = unitByNode.get(q.node);
      if (u !== undefined) return u;
    }
    return null;
  };

  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    const imp = imports.get(name);
    const o = owner.get(name);
    for (const ref of binding.referencePaths) {
      const u = unitOf(ref);
      if (u === null) continue;
      if (imp) {
        const member = imp.name === null ? memberName(ref) : undefined;
        units[u].deps.push({ kind: 'import', spec: imp.spec, name: imp.name ?? member ?? null });
      } else if (o !== undefined && o !== u) {
        units[u].deps.push({ kind: 'unit', unit: o });
      }
    }
    // Code elsewhere that reassigns a top-level binding changes what its readers see.
    for (const cv of binding.constantViolations) {
      const u = unitOf(cv);
      if (o !== undefined && u !== null && u !== o) units[o].deps.push({ kind: 'unit', unit: u });
    }
  }

  program.traverse({
    CallExpression(p) {
      if (!isRequire(p) || importInits.has(p.node)) return;
      const u = unitOf(p);
      if (u === null) return;
      const spec = literalArg(p.node);
      if (spec === null) {
        units[u].deps.push({ kind: 'opaque', reason: `dynamic require at line ${p.node.loc?.start.line}` });
        return;
      }
      for (const name of requiredNames(p)) units[u].deps.push({ kind: 'import', spec, name });
    },
    MemberExpression(p) {
      if (exportTargets.has(p.node)) return;
      const u = unitOf(p);
      if (u === null) return;
      const name = exportName(p.node);
      if (name !== undefined && !p.scope.hasBinding('exports', true)) {
        units[u].deps.push({ kind: 'self', name });
      } else if (isModuleExports(p.node) && !t.isMemberExpression(p.parent, { object: p.node })) {
        units[u].deps.push({ kind: 'self', name: null });
      }
    },
  });

  return { units, exports: exportsMap, defaultExport };
}

function sha(s: string) {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

function isRequire(p: NodePath<t.CallExpression>) {
  return t.isIdentifier(p.node.callee, { name: 'require' }) && !p.scope.hasBinding('require', true);
}

function literalArg(call: t.CallExpression): string | null {
  const a = call.arguments[0];
  if (t.isStringLiteral(a)) return a.value;
  if (t.isTemplateLiteral(a) && a.expressions.length === 0) return a.quasis[0].value.cooked ?? null;
  return null;
}

/** Which exports a nested `require(...)` call uses: `[null]` means all of them. */
function requiredNames(p: NodePath<t.CallExpression>): (string | null)[] {
  const parent = p.parent;
  if (t.isMemberExpression(parent, { object: p.node }) && !parent.computed && t.isIdentifier(parent.property)) {
    return [parent.property.name];
  }
  if (t.isVariableDeclarator(parent, { init: p.node }) && t.isObjectPattern(parent.id)) {
    const keys = parent.id.properties.map((q) => (t.isObjectProperty(q) && !q.computed ? propertyKey(q) : undefined));
    if (keys.every((k) => k !== undefined)) return keys as string[];
  }
  return [null];
}

/**
 * Bindings created by a top-level declarator that is a pure require:
 * `const x = require('m')`, `const { a, b: c } = require('m')`, `const y = require('m').a`.
 * Returns null if the declarator is anything else.
 */
function requireBindings(d: t.VariableDeclarator): [string, Import][] | null {
  const init = d.init;
  if (t.isCallExpression(init) && t.isIdentifier(init.callee, { name: 'require' })) {
    const spec = literalArg(init);
    if (spec === null) return null;
    if (t.isIdentifier(d.id)) return [[d.id.name, { spec, name: null }]];
    if (t.isObjectPattern(d.id)) {
      const out: [string, Import][] = [];
      for (const q of d.id.properties) {
        if (!t.isObjectProperty(q) || q.computed || !t.isIdentifier(q.value)) return null;
        out.push([q.value.name, { spec, name: propertyKey(q)! }]);
      }
      return out;
    }
    return null;
  }
  if (
    t.isMemberExpression(init) && !init.computed && t.isIdentifier(init.property) &&
    t.isCallExpression(init.object) && t.isIdentifier(init.object.callee, { name: 'require' }) &&
    t.isIdentifier(d.id)
  ) {
    const spec = literalArg(init.object);
    if (spec === null) return null;
    return [[d.id.name, { spec, name: init.property.name }]];
  }
  return null;
}

/** `ns.foo` → 'foo' when `ref` is the object of a static member access. */
function memberName(ref: NodePath): string | undefined {
  const parent = ref.parent;
  if ((t.isMemberExpression(parent) || t.isOptionalMemberExpression(parent)) && parent.object === ref.node && !parent.computed && t.isIdentifier(parent.property)) {
    return parent.property.name;
  }
  return undefined;
}

function isModuleExports(n: t.Node) {
  return t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.object, { name: 'module' }) && t.isIdentifier(n.property, { name: 'exports' });
}

/** `exports.X` or `module.exports.X` → 'X'. */
function exportName(n: t.Node): string | undefined {
  if (!t.isMemberExpression(n) || n.computed || !t.isIdentifier(n.property)) return undefined;
  if (t.isIdentifier(n.object, { name: 'exports' }) || isModuleExports(n.object)) return n.property.name;
  return undefined;
}

function isPlainProperty(p: t.Node) {
  return (t.isObjectProperty(p) || t.isObjectMethod(p)) && !p.computed && propertyKey(p) !== undefined;
}

function propertyKey(p: t.ObjectProperty | t.ObjectMethod): string | undefined {
  if (t.isIdentifier(p.key)) return p.key.name;
  if (t.isStringLiteral(p.key)) return p.key.value;
  return undefined;
}

/** The local binding a statement mutates, if it clearly mutates exactly one. */
function mutationRoot(e: t.Expression): string | null {
  const root = (n: t.Node): string | null => {
    while (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) n = n.object;
    return t.isIdentifier(n) ? n.name : null;
  };
  if (t.isAssignmentExpression(e)) return root(e.left);
  if (t.isUpdateExpression(e)) return root(e.argument);
  if (t.isCallExpression(e) && (t.isMemberExpression(e.callee) || t.isOptionalMemberExpression(e.callee))) {
    const c = e.callee;
    if (t.isIdentifier(c.object, { name: 'Object' }) && t.isIdentifier(c.property) &&
        ['assign', 'freeze', 'seal', 'defineProperty', 'defineProperties'].includes(c.property.name)) {
      return e.arguments[0] ? root(e.arguments[0]) : null;
    }
    return root(c.object);
  }
  return null;
}
