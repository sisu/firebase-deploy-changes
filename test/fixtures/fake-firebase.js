#!/usr/bin/env node
// Stands in for the firebase CLI in tests. Prints per-function results the way
// firebase-tools does. FAKE_FIREBASE (JSON) controls the outcome:
//   { fail: [names], skip: [names], silent: bool, exit: number }
// Each invocation's arguments are appended to the file named by FAKE_FIREBASE_CALLS.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opts = JSON.parse(process.env.FAKE_FIREBASE || '{}');
appendFileSync(process.env.FAKE_FIREBASE_CALLS, `${JSON.stringify(args)}\n`);
const only = args[args.indexOf('--only') + 1].split(',').map((t) => t.split(':').pop());
const fail = opts.fail ?? [];
const skip = opts.skip ?? [];
for (const name of only) {
  if (opts.silent || skip.includes(name) || fail.includes(name)) continue;
  console.log(`✔  functions[${name}(us-central1)] Successful update operation.`);
}
if (fail.length) {
  console.log(`\nFunctions deploy had errors with the following functions:${fail.map((n) => `\n\t${n}(us-central1)`).join('')}\n`);
  console.error('Error: There was an error deploying functions');
  process.exit(opts.exit ?? 2);
}
process.exit(opts.exit ?? 0);
