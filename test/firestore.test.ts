// Firestore state, against the emulator: `npm run test:firestore`.
// Skipped when FIRESTORE_EMULATOR_HOST is not set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');
const skip = !process.env.FIRESTORE_EMULATOR_HOST && 'FIRESTORE_EMULATOR_HOST is not set';
const PROJECT = 'demo-fdc';
let n = 0;

function project(index = `exports.a = () => 'a';\nexports.b = () => 'b';\nexports.c = () => 'c';\n`) {
  const root = mkdtempSync(path.join(tmpdir(), 'fdc-fs-'));
  mkdirSync(path.join(root, 'functions'));
  writeFileSync(path.join(root, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
  writeFileSync(path.join(root, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT } }));
  writeFileSync(path.join(root, 'functions/package.json'), JSON.stringify({ main: 'index.js' }));
  writeFileSync(path.join(root, 'functions/index.js'), index);
  const collection = `fdc_test_${process.pid}_${n++}`;
  return {
    collection,
    edit: (code: string) => writeFileSync(path.join(root, 'functions/index.js'), code),
    fdc(args: string[]) {
      const r = spawnSync(process.execPath, [cli, '--dir', path.join(root, 'functions'), '--state', `firestore:${collection}`, ...args],
        { encoding: 'utf8' });
      return { code: r.status, out: r.stdout + r.stderr };
    },
    recorded(): string[] {
      const r = this.fdc(['state']);
      assert.equal(r.code, 0, r.out);
      return Object.keys(JSON.parse(r.out).functions).sort();
    },
  };
}

test('records, reads back and compares like the file state', { skip }, () => {
  const p = project();
  assert.deepEqual(p.recorded(), []);
  assert.equal(p.fdc(['record', 'a', 'b']).code, 0);
  assert.deepEqual(p.recorded(), ['a', 'b']);
  const r = p.fdc(['changed', '--json']);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out), { changed: [], added: ['c'], removed: [] });
});

test('separate records merge rather than overwrite each other', { skip }, () => {
  const p = project();
  p.fdc(['record', 'a']);
  p.fdc(['record', 'b']);
  assert.deepEqual(p.recorded(), ['a', 'b']);
});

test('--replace drops records of functions no longer in the code', { skip }, () => {
  const p = project();
  p.fdc(['record', '--all']);
  p.edit(`exports.a = () => 'a';\n`);
  assert.deepEqual(JSON.parse(p.fdc(['changed', '--json']).out).removed, ['b', 'c']);
  assert.equal(p.fdc(['record', '--all', '--replace']).code, 0);
  assert.deepEqual(p.recorded(), ['a']);
});

test('a record from another fingerprint version counts as not recorded', { skip }, async () => {
  const p = project();
  p.fdc(['record', '--all']);
  const db = new Firestore({ projectId: PROJECT });
  await db.collection(p.collection).doc('a').update({ version: -1 });
  await db.terminate();
  assert.deepEqual(p.recorded(), ['b', 'c']);
});

test('--project overrides .firebaserc', { skip }, () => {
  const p = project();
  p.fdc(['record', 'a', '--project', 'demo-other']);
  assert.deepEqual(p.recorded(), []);
  assert.equal(JSON.parse(p.fdc(['state', '--project', 'demo-other']).out).functions.a !== undefined, true);
});
