// Project-level analysis: link module units into one graph and compute, for each
// exported function of the entry file, a fingerprint of everything it can reach.
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import picomatch from 'picomatch';
import { analyzeJson, analyzeModule, type Dep, type ModuleInfo } from './module.ts';
import type { Source } from './source.ts';

export interface Options {
  /** Glob patterns (firebase.json `functions.ignore`) for files that are not deployed. */
  ignore?: string[];
}

/** One function's reachable set: node id → hash contribution. */
export type Reach = Map<string, string>;

export interface Analysis {
  fingerprints: Map<string, string>;
  reach: Map<string, Reach>;
  /** Node id → parent node id on a shortest path from the function (for explanations). */
  parents: Map<string, Map<string, string>>;
  describe(id: string): string;
  warnings: string[];
}

/** Bump whenever a change to the analysis changes fingerprints of unchanged code. */
export const FINGERPRINT_VERSION = 1;

const CODE_EXT = /\.(c?js|json)$/;
const FS_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);
const GLOBAL = 'global';

// Module analysis depends only on file content, so it is shared across revisions.
const moduleCache = new Map<string, ModuleInfo>();

export function analyzeProject(src: Source, opts: Options = {}): Analysis {
  const warnings: string[] = [];
  const pkg = readJson(src, 'package.json') ?? {};
  const main = path.posix.normalize(pkg.main ?? 'index.js');
  const lock = readJson(src, 'package-lock.json');

  const modules = new Map<string, ModuleInfo>();
  const load = (file: string): ModuleInfo => {
    let m = modules.get(file);
    if (m) return m;
    const key = `${file.endsWith('.json') ? 'json' : 'js'}:${src.blobId(file)}`;
    m = moduleCache.get(key);
    if (!m) {
      const text = src.read(file);
      m = file.endsWith('.json') ? analyzeJson(text) : analyzeModule(text, file);
      moduleCache.set(key, m);
    }
    modules.set(file, m);
    return m;
  };

  const resolveCache = new Map<string, string>();
  /** Node id a require specifier leads to, or null if it has no deploy-relevant content. */
  const resolveSpec = (from: string, spec: string, name: string | null): string | null => {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const key = `${from}\0${spec}`;
      let file = resolveCache.get(key);
      if (file === undefined) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
        file = [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}/index.js`, `${base}/index.json`]
          .find((c) => CODE_EXT.test(c) && src.blobId(c) !== undefined) ?? '';
        resolveCache.set(key, file);
        if (!file) warnings.push(`${from}: cannot resolve require('${spec}')`);
      }
      if (!file) return `missing:${spec}`;
      return name === null ? `m:${file}` : `e:${file}:${name}`;
    }
    if (FS_MODULES.has(spec)) return 'assets';
    if (isBuiltin(spec)) return null;
    const parts = spec.split('/');
    return `p:${spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]}`;
  };

  const depNode = (file: string, d: Dep): string | null => {
    switch (d.kind) {
      case 'unit': return `u:${file}:${d.unit}`;
      case 'import': return resolveSpec(file, d.spec, d.name);
      case 'self': return d.name === null ? `m:${file}` : `e:${file}:${d.name}`;
      case 'opaque': return 'all';
    }
  };

  const unitsOf = (file: string) => load(file).units.map((_, i) => `u:${file}:${i}`);

  /** Children of a node in the reachability graph. */
  const edges = (id: string): string[] => {
    const [kind, ...rest] = id.split(':');
    if (kind === 'u') {
      const idx = Number(rest.pop());
      const file = rest.join(':');
      return load(file).units[idx].deps.map((d) => depNode(file, d)).filter((x): x is string => x !== null);
    }
    if (kind === 'e') {
      const name = rest.pop()!;
      const file = rest.join(':');
      const m = load(file);
      const u = m.exports.get(name) ?? m.defaultExport;
      // Not a statically visible export: be conservative and depend on the whole module.
      return u === null || u === undefined ? [`m:${file}`] : [`u:${file}:${u}`];
    }
    if (kind === 'm') return unitsOf(rest.join(':'));
    if (id === GLOBAL) return globalRoots;
    return [];
  };

  // Every module the entry file can load, at any depth.
  const allModules: string[] = [];
  {
    const seen = new Set<string>([main]);
    const queue = [main];
    while (queue.length) {
      const file = queue.shift()!;
      allModules.push(file);
      const m = load(file);
      for (const u of m.units) for (const d of u.deps) {
        if (d.kind !== 'import') continue;
        const n = resolveSpec(file, d.spec, null);
        if (n?.startsWith('m:') && !seen.has(n.slice(2))) { seen.add(n.slice(2)); queue.push(n.slice(2)); }
      }
    }
  }

  // Top-level side effects run whenever the codebase loads, so every function
  // depends on them (and on whatever they reference).
  const globalRoots = allModules.flatMap((f) => load(f).units.flatMap((u, i) => (u.global ? [`u:${f}:${i}`] : [])));

  const blobHash = (files: string[]) =>
    hash([...files].sort().map((f) => `${f}\0${src.blobId(f)}`).join('\n'));

  const isIgnored = picomatch(opts.ignore ?? [], { dot: true, basename: true });
  const ignoredPath = (f: string) => f.split('/').some((_, i, a) => isIgnored(a.slice(0, i + 1).join('/')));
  const envFiles = src.files().filter((f) => /^\.env/.test(f) && !f.endsWith('.local'));
  const assetFiles = src.files().filter((f) =>
    !CODE_EXT.test(f) && !/\.(m|c)?ts$/.test(f) && !envFiles.includes(f) && !ignoredPath(f));
  // What a dynamic require could load: any deployed code file.
  const codeFiles = src.files().filter((f) => CODE_EXT.test(f) && !ignoredPath(f));

  const contributions = new Map<string, string>();
  const contribution = (id: string): string => {
    let c = contributions.get(id);
    if (c === undefined) { c = computeContribution(id); contributions.set(id, c); }
    return c;
  };
  const computeContribution = (id: string): string => {
    const [kind, ...rest] = id.split(':');
    if (kind === 'u') {
      const idx = Number(rest.pop());
      return load(rest.join(':')).units[idx].hash;
    }
    if (kind === 'p') return packageHash(rest.join(':'), lock, pkg);
    if (id === 'assets') return `assets:${blobHash(assetFiles)}`;
    if (id === 'all') return `all:${blobHash(codeFiles)}`;
    if (id === GLOBAL) {
      const runtime = JSON.stringify([pkg.engines, pkg.main, pkg.type]);
      return `global:${hash(runtime)}:${blobHash(envFiles)}`;
    }
    if (kind === 'missing') return id;
    return ''; // structural nodes (exports, whole modules) contribute only through children
  };

  const fingerprints = new Map<string, string>();
  const reach = new Map<string, Reach>();
  const parents = new Map<string, Map<string, string>>();
  for (const name of load(main).exports.keys()) {
    const root = `e:${main}:${name}`;
    const seen: Reach = new Map();
    const parent = new Map<string, string>();
    const queue = [root, GLOBAL];
    for (const q of queue) seen.set(q, '');
    while (queue.length) {
      const id = queue.shift()!;
      seen.set(id, contribution(id));
      for (const c of edges(id)) {
        if (!seen.has(c)) { seen.set(c, ''); parent.set(c, id); queue.push(c); }
      }
    }
    const parts = [...new Set(seen.values())].filter(Boolean).sort();
    fingerprints.set(name, hash(parts.join('\n')));
    reach.set(name, seen);
    parents.set(name, parent);
  }

  const describe = (id: string): string => {
    const [kind, ...rest] = id.split(':');
    if (kind === 'u') {
      const idx = Number(rest.pop());
      const file = rest.join(':');
      const u = load(file).units[idx];
      return `${file}:${u.line} ${u.label}${u.global ? ' (top-level side effect)' : ''}`;
    }
    if (kind === 'e') { const n = rest.pop(); return `${rest.join(':')} export ${n}`; }
    if (kind === 'm') return `${rest.join(':')} (whole module)`;
    if (kind === 'p') return `npm package ${rest.join(':')}`;
    if (id === 'assets') return 'non-code files read via fs';
    if (id === 'all') return 'entire codebase (dynamic require)';
    if (id === GLOBAL) return 'global: top-level side effects, runtime, .env';
    return id;
  };

  return { fingerprints, reach, parents, describe, warnings: [...new Set(warnings)] };
}

function hash(s: string) {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

function readJson(src: Source, file: string): any {
  if (src.blobId(file) === undefined) return undefined;
  return JSON.parse(src.read(file));
}

/** Hash of an npm package and everything it transitively installs, per package-lock.json. */
function packageHash(name: string, lock: any, pkg: any): string {
  const packages: Record<string, any> | undefined = lock?.packages;
  if (!packages) {
    return `p:${name}@${pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? '?'}`;
  }
  const find = (from: string, dep: string): string | undefined => {
    for (let dir = from; ; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/node_modules/')))) {
      const candidate = dir ? `${dir}/node_modules/${dep}` : `node_modules/${dep}`;
      if (packages[candidate]) return candidate;
      if (!dir) return undefined;
    }
  };
  const start = find('', name);
  if (!start) return `p:${name}:missing`;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    const e = packages[at];
    for (const dep of Object.keys({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies })) {
      const p = find(at, dep);
      if (p && !seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  const lines = [...seen].sort().map((p) => `${p}@${packages[p].version}:${packages[p].integrity ?? packages[p].resolved ?? ''}`);
  return `p:${name}:${hash(lines.join('\n'))}`;
}
