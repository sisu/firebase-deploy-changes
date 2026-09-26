import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '../src/cli.ts');
const fakeFirebase = path.join(here, 'fixtures/fake-firebase.js');

const INDEX = `exports.a = () => 'a';\nexports.b = () => 'b';\nexports.c = () => 'c';\n`;

/** A Firebase project with functions a, b and c, and helpers to run fdc in it. */
function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'fdc-'));
  mkdirSync(path.join(root, 'functions'));
  writeFileSync(path.join(root, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
  writeFileSync(path.join(root, 'functions/package.json'), JSON.stringify({ main: 'index.js' }));
  writeFileSync(path.join(root, 'functions/index.js'), INDEX);
  const calls = path.join(root, 'calls.txt');
  const statePath = path.join(root, '.fdc-state.json');
  return {
    root,
    edit: (code: string) => writeFileSync(path.join(root, 'functions/index.js'), code),
    fdc(args: string[], fake: object = {}) {
      const r = spawnSync(process.execPath, [cli, '--dir', path.join(root, 'functions'), '--firebase', fakeFirebase, ...args], {
        encoding: 'utf8',
        env: { ...process.env, FAKE_FIREBASE: JSON.stringify(fake), FAKE_FIREBASE_CALLS: calls },
      });
      return { code: r.status, out: r.stdout + r.stderr };
    },
    recorded: (): string[] => existsSync(statePath)
      ? Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).functions) : [],
    calls: (): string[][] => existsSync(calls)
      ? readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [],
  };
}

test('first deploy deploys everything; an unchanged second run calls nothing', () => {
  const p = project();
  const first = p.fdc(['deploy']);
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(p.calls()[0].slice(0, 4), ['deploy', '--only', 'functions:a,functions:b,functions:c', '--non-interactive']);
  assert.deepEqual(p.recorded(), ['a', 'b', 'c']);

  const second = p.fdc(['deploy']);
  assert.equal(second.code, 0);
  assert.match(second.out, /Nothing to deploy/);
  assert.equal(p.calls().length, 1);
});

test('only the edited function is deployed', () => {
  const p = project();
  p.fdc(['deploy']);
  p.edit(INDEX.replace("'b'", "'B'"));
  assert.equal(p.fdc(['changed']).code, 1);
  assert.equal(p.fdc(['deploy']).code, 0);
  assert.deepEqual(p.calls()[1][2], 'functions:b');
  assert.equal(p.fdc(['changed']).code, 0);
});

test('partial failure records only confirmed functions and passes the exit code through', () => {
  const p = project();
  const r = p.fdc(['deploy'], { fail: ['b'] });
  assert.equal(r.code, 2);
  assert.match(r.out, /Failed \(will be deployed again next time\): b/);
  assert.deepEqual(p.recorded(), ['a', 'c']);
  // The retry deploys only what failed.
  assert.equal(p.fdc(['deploy']).code, 0);
  assert.deepEqual(p.calls()[1][2], 'functions:b');
});

test('a function skipped despite exit 0 is not recorded, and fdc exits non-zero', () => {
  const p = project();
  const r = p.fdc(['deploy'], { skip: ['c'] });
  assert.equal(r.code, 1);
  assert.match(r.out, /Not confirmed as deployed.*: c/);
  assert.match(r.out, /--force/);
  assert.deepEqual(p.recorded(), ['a', 'b']);
});

test('exit 0 with no recognizable output records nothing and says the format may have changed', () => {
  const p = project();
  const r = p.fdc(['deploy'], { silent: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /output format may have changed/);
  assert.deepEqual(p.recorded(), []);
});

test('record marks functions deployed without deploying; --dry-run deploys nothing', () => {
  const p = project();
  assert.equal(p.fdc(['record', 'a', 'b']).code, 0);
  assert.deepEqual(p.recorded(), ['a', 'b']);
  const dry = p.fdc(['deploy', '--dry-run']);
  assert.match(dry.out, /deploy --only functions:c --non-interactive/);
  assert.equal(p.calls().length, 0);
  assert.equal(p.fdc(['record', 'nope']).code, 2);
});

test('extra firebase arguments after -- are passed through', () => {
  const p = project();
  p.fdc(['deploy', '--', '--project', 'demo', '--force']);
  assert.deepEqual(p.calls()[0].slice(4), ['--project', 'demo', '--force']);
});

test('removed functions are reported and stay recorded', () => {
  const p = project();
  p.fdc(['deploy']);
  p.edit(`exports.a = () => 'a';\nexports.b = () => 'b';\n`);
  const r = p.fdc(['changed']);
  assert.equal(r.code, 0);
  assert.match(r.out, /removed {2}c/);
  assert.deepEqual(p.recorded(), ['a', 'b', 'c']);
});

test('state recorded from a git revision matches an identical working tree', () => {
  const p = project();
  writeFileSync(path.join(p.root, 'functions/.env'), 'GREETING=hi\n');
  writeFileSync(path.join(p.root, 'functions/logo.txt'), 'logo');
  p.edit(`${INDEX}exports.d = () => require('fs').readFileSync('logo.txt');\n`);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: p.root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  assert.equal(p.fdc(['record', '--all', '--rev', 'HEAD']).code, 0);
  const r = p.fdc(['changed']);
  assert.equal(r.code, 0, r.out);
});

test('--rev works when --dir reaches the repo through a symlink', () => {
  const p = project();
  const git = (...args: string[]) => spawnSync('git', args, { cwd: p.root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const link = path.join(mkdtempSync(path.join(tmpdir(), 'fdc-link-')), 'project');
  symlinkSync(p.root, link);
  const state = path.join(p.root, 'linked-state.json');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, '--dir', path.join(link, 'functions'), '--state', state, ...args], { encoding: 'utf8' });
  const record = run(['record', '--all', '--rev', 'HEAD']);
  assert.equal(record.status, 0, record.stderr);
  const r = run(['changed', '--rev', 'HEAD', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { changed: [], added: [], removed: [] });
});

test('changed --rev --json reports a commit, not the working tree', () => {
  const p = project();
  const git = (...args: string[]) => spawnSync('git', args, { cwd: p.root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  assert.equal(p.fdc(['record', '--all', '--rev', 'HEAD']).code, 0);
  p.edit(INDEX.replace("'b'", "'B'").replace("exports.c = () => 'c';\n", "exports.d = () => 'd';\n"));
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'edit');
  p.edit(INDEX.replace("'a'", "'A'"));

  const r = p.fdc(['changed', '--rev', 'HEAD', '--json']);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(JSON.parse(r.out), { changed: ['b'], added: ['d'], removed: ['c'] });
});

test('state prints the record; record --replace keeps only the named functions', () => {
  const p = project();
  p.fdc(['record', '--all']);
  assert.deepEqual(Object.keys(JSON.parse(p.fdc(['state']).out).functions), ['a', 'b', 'c']);
  assert.equal(p.fdc(['record', 'a', '--replace']).code, 0);
  assert.deepEqual(p.recorded(), ['a']);
});
