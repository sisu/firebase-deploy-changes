import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDeployLog } from '../src/deploy.ts';

// Lines as firebase-tools prints them (release/fabricator.js, release/reporter.js).
const ok = (label: string, op = 'update') => `✔  functions[${label}] Successful ${op} operation.`;
const errors = (...labels: string[]) =>
  ['', `Functions deploy had errors with the following functions:${labels.map((l) => `\n\t${l}`).join('')}`, ''].join('\n');

const sorted = (s: Set<string>) => [...s].sort();

test('success lines mark functions deployed', () => {
  const log = parseDeployLog([
    'i  functions: updating Node.js 22 (2nd Gen) function a(us-central1)...',
    ok('a(us-central1)'),
    ok('b(europe-west1)', 'create'),
    '✔  Deploy complete!',
  ].join('\n'));
  assert.deepEqual(sorted(log.succeeded), ['a', 'b']);
  assert.deepEqual(sorted(log.failed), []);
});

test('functions in the error list fail, including when another region succeeded', () => {
  const log = parseDeployLog([
    ok('a(us-central1)'),
    ok('b(us-central1)'),
    ok('c(us-central1)'),
    errors('b(europe-west1)', 'd(us-central1)'),
    'Unable to set the invoker for the IAM policy on the following functions:',
    '\tc(us-central1)',
    'Error: There was an error deploying functions',
  ].join('\n'));
  assert.deepEqual(sorted(log.succeeded), ['a', 'c']);
  assert.deepEqual(sorted(log.failed), ['b', 'd']);
});

test('skipped, deleted and unmentioned functions are not deployed', () => {
  const log = parseDeployLog([
    '✔  functions[a(us-central1)] Skipped (No changes detected)',
    ok('b(us-central1)', 'delete'),
    '⚠  functions: Skipping updates for functions that may be unsafe to update.',
  ].join('\n'));
  assert.deepEqual(sorted(log.succeeded), []);
});

test('codebase labels are matched to the requested codebase', () => {
  const out = [ok('api:a(us-central1)'), ok('b(us-central1)'), errors('api:c(us-central1)')].join('\n');
  assert.deepEqual(sorted(parseDeployLog(out, 'api').succeeded), ['a']);
  assert.deepEqual(sorted(parseDeployLog(out, 'api').failed), ['c']);
  assert.deepEqual(sorted(parseDeployLog(out).succeeded), ['b']);
});

test('ANSI colors and CRLF line endings are tolerated', () => {
  const log = parseDeployLog('\x1b[32m✔\x1b[39m  \x1b[1m\x1b[32mfunctions[my-fn(us-central1)]\x1b[39m\x1b[22m Successful update operation.\r\n');
  assert.deepEqual(sorted(log.succeeded), ['my-fn']);
});
