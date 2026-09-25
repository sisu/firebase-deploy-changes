import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { analyzeProject } from '../src/project.ts';
import type { Source } from '../src/source.ts';

type Files = Record<string, string>;

function source(files: Files): Source {
  return {
    files: () => Object.keys(files),
    blobId: (f) => (f in files ? createHash('sha1').update(files[f]).digest('hex') : undefined),
    read: (f) => files[f],
  };
}

/** Names of functions whose fingerprint differs between two versions of a project. */
function changed(before: Files, edits: Files): string[] {
  const a = analyzeProject(source(before)).fingerprints;
  const b = analyzeProject(source({ ...before, ...edits })).fingerprints;
  return [...b.keys()].filter((k) => a.get(k) !== b.get(k)).sort();
}

const lib = `
const { onCall } = require('firebase-functions/v2/https');
function helper() { return 1; }
function f() { return helper(); }
function g() { return 2; }
module.exports = { f, g };
`;

test('named imports: only the function using the edited export changes', () => {
  const files = {
    'lib/a.js': lib,
    'index.js': `const { f, g } = require('./lib/a');\nexports.F = () => f();\nexports.G = () => g();`,
  };
  assert.deepEqual(changed(files, { 'lib/a.js': lib.replace('return 2', 'return 3') }), ['G']);
  assert.deepEqual(changed(files, { 'lib/a.js': lib.replace('return 1', 'return 5') }), ['F']);
});

test('namespace member access is precise; an escaping namespace depends on everything', () => {
  const files = {
    'lib/a.js': lib,
    'index.js': `const a = require('./lib/a');\nexports.F = () => a.f();\nexports.H = () => Object.keys(a);`,
  };
  assert.deepEqual(changed(files, { 'lib/a.js': lib.replace('return 2', 'return 3') }), ['H']);
  assert.deepEqual(changed(files, { 'lib/a.js': lib.replace('return 1', 'return 5') }), ['F', 'H']);
});

test('comment and whitespace edits change nothing', () => {
  const files = { 'lib/a.js': lib, 'index.js': `const { f } = require('./lib/a');\nexports.F = () => f();` };
  assert.deepEqual(changed(files, { 'lib/a.js': `// hello\n${lib.replace('return 1;', '/* one */ return   1;')}\n\n` }), []);
});

test('exports.X = ... style, lazy requires, and require(...).member', () => {
  const a = `exports.f = () => 1;\nexports.g = () => 2;`;
  const files = {
    'lib/a.js': a,
    'index.js': `exports.F = () => require('./lib/a').f();\nexports.G = require('./lib/a').g;`,
  };
  assert.deepEqual(changed(files, { 'lib/a.js': a.replace('2', '3') }), ['G']);
  assert.deepEqual(changed(files, { 'lib/a.js': a.replace('1', '3') }), ['F']);
});

test('top-level side effects affect every function, including what they reference', () => {
  const idx = `const { setGlobalOptions } = require('firebase-functions/v2');\nconst REGION = 'x';\nsetGlobalOptions({ region: REGION });\nexports.F = () => 1;\nexports.G = () => 2;`;
  const files = { 'index.js': idx };
  assert.deepEqual(changed(files, { 'index.js': idx.replace("'x'", "'y'") }), ['F', 'G']);
  const libSide = `console.log('loaded');\nexports.f = () => 1;`;
  const withLib = { 'lib/a.js': libSide, 'index.js': `const { f } = require('./lib/a');\nexports.F = f;\nexports.G = () => 2;` };
  assert.deepEqual(changed(withLib, { 'lib/a.js': libSide.replace('loaded', 'hi') }), ['F', 'G']);
});

test('a statement mutating a local binding belongs to that binding', () => {
  const idx = `const cache = new Map();\ncache.set('a', 1);\nexports.F = () => cache.get('a');\nexports.G = () => 2;`;
  assert.deepEqual(changed({ 'index.js': idx }, { 'index.js': idx.replace("'a', 1", "'a', 2") }), ['F']);
});

test('reassignment of a top-level variable from another unit is a dependency', () => {
  const idx = `let flag = false;\nfunction enable() { flag = true; }\nexports.F = () => flag;\nexports.G = () => enable();\nexports.H = () => 3;`;
  assert.deepEqual(changed({ 'index.js': idx }, { 'index.js': idx.replace('flag = true', 'flag = 1') }), ['F', 'G']);
});

test('require cycles do not make everything depend on everything', () => {
  const a = `const b = require('./b');\nexports.a1 = () => b.b1();\nexports.a2 = () => 'a2';`;
  const b = `const a = require('./a');\nexports.b1 = () => 'b1';\nexports.b2 = () => a.a2();`;
  const files = { 'a.js': a, 'b.js': b, 'index.js': `exports.F = require('./a').a1;\nexports.G = require('./b').b2;` };
  assert.deepEqual(changed(files, { 'b.js': b.replace("'b1'", "'B1'") }), ['F']);
  assert.deepEqual(changed(files, { 'a.js': a.replace("'a2'", "'A2'") }), ['G']);
});

test('npm package changes affect only functions that import the package', () => {
  const lock = (v: string) => JSON.stringify({ packages: {
    '': { dependencies: { stripe: '1', qrcode: '1' } },
    'node_modules/stripe': { version: '1.0.0', dependencies: { qs: '1' } },
    'node_modules/qs': { version: v },
    'node_modules/qrcode': { version: '1.0.0' },
  } });
  const files = {
    'package-lock.json': lock('1.0.0'),
    'index.js': `const Stripe = require('stripe');\nconst qr = require('qrcode');\nexports.F = () => Stripe();\nexports.G = () => qr();`,
  };
  // qs is a transitive dependency of stripe only.
  assert.deepEqual(changed(files, { 'package-lock.json': lock('1.0.1') }), ['F']);
});

test('non-code files count only for functions that use fs', () => {
  const files = {
    'assets/logo.png': 'v1',
    'index.js': `const fs = require('fs');\nexports.F = () => fs.readFileSync('assets/logo.png');\nexports.G = () => 2;`,
  };
  assert.deepEqual(changed(files, { 'assets/logo.png': 'v2' }), ['F']);
});

test('a dynamic require depends on the whole codebase', () => {
  const files = {
    'lib/a.js': `exports.f = () => 1;`,
    'index.js': `exports.F = (n) => require('./lib/' + n);\nexports.G = () => 2;`,
  };
  assert.deepEqual(changed(files, { 'lib/a.js': `exports.f = () => 7;` }), ['F']);
});

test('added and removed functions are reported by name', () => {
  const a = analyzeProject(source({ 'index.js': `exports.F = () => 1;\nexports.G = () => 2;` })).fingerprints;
  const b = analyzeProject(source({ 'index.js': `exports.F = () => 1;\nexports.H = () => 2;` })).fingerprints;
  assert.deepEqual([...a.keys()], ['F', 'G']);
  assert.deepEqual([...b.keys()], ['F', 'H']);
  assert.equal(a.get('F'), b.get('F'));
});
