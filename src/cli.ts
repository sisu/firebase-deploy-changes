#!/usr/bin/env node
// fdc: find which Firebase functions need redeploying.
//
//   fdc deploy [--all] [--dry-run] [-- <firebase args>]
//                                        deploy functions whose code changed since recorded, record the ones that succeed
//   fdc changed [--rev R] [--json]       list functions whose code changed since recorded (exit 1 if any)
//   fdc record [<names>...] [--all] [--rev R]
//                                        mark functions as deployed; `record --all --rev <sha>` bootstraps the state
//   fdc fingerprint [--rev R]            print {function: fingerprint} as JSON
//   fdc diff <base-rev> [<head-rev>] [--explain]
//                                        functions whose code differs between revisions (head defaults to the working tree)
//   fdc replay [-n N]                    evaluate over the last N commits touching the functions directory
//
// Common options: --dir <functions dir> (default .), --state <file> (default
// .fdc-state.json next to firebase.json).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseDeployLog, runFirebase } from './deploy.ts';
import { analyzeProject, type Analysis } from './project.ts';
import { FsSource, GitSource, type Source } from './source.ts';
import { loadState, plan, saveState, type State } from './state.ts';

const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const passthrough = dashDash >= 0 ? argv.slice(dashDash + 1) : [];
const { values: opts, positionals } = parseArgs({
  args: dashDash >= 0 ? argv.slice(0, dashDash) : argv,
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: '.' },
    rev: { type: 'string' },
    state: { type: 'string' },
    all: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    firebase: { type: 'string', default: 'firebase' },
    explain: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    n: { type: 'string', short: 'n', default: '100' },
  },
});

const dir = path.resolve(opts.dir);
const config = functionsConfig();
const statePath = path.resolve(opts.state ?? path.join(
  config.root, config.codebase === 'default' ? '.fdc-state.json' : `.fdc-state.${config.codebase}.json`));
// A state file inside the functions directory must not count as a deployed asset.
const ignore = [...config.ignore, ...(isInside(statePath, dir) ? [path.relative(dir, statePath)] : [])];

function git(args: string[], cwd = dir) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

let repoRoot: string | undefined;
function repo() {
  return repoRoot ??= git(['rev-parse', '--show-toplevel']).trim();
}

/** The functions directory relative to the repo root, POSIX-style ('' for the root). */
function dirInRepo() {
  // git reports the top level with symlinks resolved (e.g. /tmp -> /private/tmp on macOS).
  return path.relative(repo(), realpathSync(dir)).split(path.sep).join('/');
}

function isInside(file: string, parent: string) {
  const rel = path.relative(parent, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The firebase.json directory and this functions directory's codebase and ignore patterns. */
function functionsConfig() {
  let root = dir;
  while (!existsSync(path.join(root, 'firebase.json')) && path.dirname(root) !== root) root = path.dirname(root);
  const defaults = { codebase: 'default', ignore: ['node_modules', '.git', 'firebase-debug.log', 'firebase-debug.*.log', '*.local'] };
  if (!existsSync(path.join(root, 'firebase.json'))) return { root: dir, ...defaults };
  const functions = JSON.parse(readFileSync(path.join(root, 'firebase.json'), 'utf8')).functions;
  const entries: any[] = Array.isArray(functions) ? functions : functions ? [functions] : [];
  const entry = entries.find((e) => path.resolve(root, e.source ?? 'functions') === dir);
  return { root, codebase: entry?.codebase ?? defaults.codebase, ignore: entry?.ignore ?? defaults.ignore };
}

function analyze(rev: string | undefined): Analysis {
  const src: Source = rev === undefined
    ? new FsSource(dir)
    : new GitSource(repo(), rev, dirInRepo());
  const a = analyzeProject(src, { ignore });
  for (const w of a.warnings) console.error(`warning: ${w}`);
  return a;
}

/** The commit being deployed, for the record; null outside git. */
function currentRev(rev?: string): string | null {
  try {
    if (rev !== undefined) return git(['rev-parse', rev]).trim();
    const head = git(['rev-parse', 'HEAD']).trim();
    return git(['status', '--porcelain', '--', '.']).trim() ? `${head}-dirty` : head;
  } catch {
    return null;
  }
}

function record(state: State, a: Analysis, names: string[], rev: string | null) {
  const recordedAt = new Date().toISOString();
  for (const name of names) state.functions[name] = { fingerprint: a.fingerprints.get(name)!, rev, recordedAt };
}

const target = (name: string) => `functions:${config.codebase === 'default' ? '' : `${config.codebase}:`}${name}`;

function printPlan(p: ReturnType<typeof plan>, total: number) {
  console.log(`${p.changed.length} changed, ${p.added.length} not recorded as deployed, ${p.removed.length} removed (of ${total})`);
  for (const name of p.changed) console.log(`  changed  ${name}`);
  for (const name of p.added) console.log(`  new      ${name}`);
  for (const name of p.removed) {
    console.log(`  removed  ${name}  (still recorded; delete it with \`firebase functions:delete ${name}\`)`);
  }
}

function compare(base: Analysis, head: Analysis) {
  const changed: string[] = [], added: string[] = [], removed: string[] = [];
  for (const [name, fp] of head.fingerprints) {
    const old = base.fingerprints.get(name);
    if (old === undefined) added.push(name);
    else if (old !== fp) changed.push(name);
  }
  for (const name of base.fingerprints.keys()) if (!head.fingerprints.has(name)) removed.push(name);
  return { changed, added, removed };
}

/** A dependency path from `name` to one piece of code whose content differs between revisions. */
function explain(base: Analysis, head: Analysis, name: string): string[] {
  for (const [a, b] of [[head, base], [base, head]] as const) {
    const other = new Set(b.reach.get(name)!.values());
    for (const [id, c] of a.reach.get(name)!) {
      if (!c || other.has(c)) continue;
      const chain: string[] = [];
      for (let at: string | undefined = id; at; at = a.parents.get(name)!.get(at)) chain.unshift(a.describe(at));
      if (a === base) chain.push('(removed)');
      return chain;
    }
  }
  return [];
}

function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(q * (s.length - 1))] : 0;
}

async function main(): Promise<number> {
  const [command, ...args] = positionals;
  switch (command) {
    case 'deploy': {
      const rev = currentRev();
      const a = analyze(undefined);
      const state = loadState(statePath);
      const p = plan(a.fingerprints, state);
      printPlan(p, a.fingerprints.size);
      const targets = opts.all ? [...a.fingerprints.keys()] : [...p.changed, ...p.added];
      if (!targets.length) {
        console.log('Nothing to deploy.');
        return 0;
      }
      const firebaseArgs = ['deploy', '--only', targets.map(target).join(','), '--non-interactive', ...passthrough];
      if (opts['dry-run']) {
        console.log(`\n${opts.firebase} ${firebaseArgs.join(' ')}`);
        return 0;
      }
      console.log(`\nDeploying ${targets.length} function(s)...\n`);
      const { code, output } = await runFirebase(opts.firebase, firebaseArgs, config.root);
      const log = parseDeployLog(output, config.codebase);
      const deployed = targets.filter((n) => log.succeeded.has(n));
      record(state, a, deployed, rev);
      saveState(statePath, state);
      console.log(`\nRecorded ${deployed.length} of ${targets.length} deployed function(s) in ${statePath}.`);
      const failed = targets.filter((n) => log.failed.has(n));
      const unconfirmed = targets.filter((n) => !log.succeeded.has(n) && !log.failed.has(n));
      if (failed.length) console.error(`Failed (will be deployed again next time): ${failed.join(', ')}`);
      if (unconfirmed.length) {
        console.error(`Not confirmed as deployed (will be deployed again next time): ${unconfirmed.join(', ')}`);
        if (code === 0 && deployed.length === 0) {
          console.error('firebase exited successfully but printed no recognizable per-function results. ' +
            'Its output format may have changed; please report this with your firebase-tools version.');
        } else if (code === 0) {
          console.error('firebase exited successfully without deploying these. It skips functions whose event type ' +
            'changes unless forced: rerun with `fdc deploy -- --force` if that is intended.');
        }
      }
      return code !== 0 ? code : failed.length || unconfirmed.length ? 1 : 0;
    }
    case 'changed': {
      const a = analyze(opts.rev);
      const p = plan(a.fingerprints, loadState(statePath));
      const targets = [...p.changed, ...p.added];
      if (opts.json) console.log(JSON.stringify(p));
      else printPlan(p, a.fingerprints.size);
      if (targets.length && !opts.json) console.log(`\nfirebase deploy --only ${targets.map(target).join(',')}`);
      return targets.length ? 1 : 0;
    }
    case 'record': {
      const a = analyze(opts.rev);
      const names = opts.all ? [...a.fingerprints.keys()] : args;
      if (!names.length) throw new Error('usage: fdc record <names>... | --all [--rev R]');
      const unknown = names.filter((n) => !a.fingerprints.has(n));
      if (unknown.length) throw new Error(`not exported functions: ${unknown.join(', ')}`);
      const state = loadState(statePath);
      record(state, a, names, currentRev(opts.rev));
      saveState(statePath, state);
      console.log(`Recorded ${names.length} function(s) in ${statePath}.`);
      return 0;
    }
    case 'fingerprint': {
      console.log(JSON.stringify(Object.fromEntries(analyze(opts.rev).fingerprints), null, 2));
      return 0;
    }
    case 'diff': {
      if (!args[0]) throw new Error('usage: fdc diff <base-rev> [<head-rev>]');
      const base = analyze(args[0]);
      const head = analyze(args[1]);
      const { changed, added, removed } = compare(base, head);
      console.log(`${changed.length} changed, ${added.length} added, ${removed.length} removed (of ${head.fingerprints.size})`);
      for (const name of changed) {
        console.log(`  changed  ${name}`);
        if (opts.explain) for (const step of explain(base, head, name)) console.log(`             → ${step}`);
      }
      for (const name of added) console.log(`  added    ${name}`);
      for (const name of removed) console.log(`  removed  ${name}`);
      return 0;
    }
    case 'replay': {
      const relDir = dirInRepo();
      const log = git(['log', '--format=%H %s', '-n', opts.n, '--', relDir || '.'], repo()).trim().split('\n').filter(Boolean);
      const cache = new Map<string, Analysis>();
      const at = (rev: string) => {
        const sha = git(['rev-parse', rev]).trim();
        let a = cache.get(sha);
        if (!a) { a = analyze(sha); cache.set(sha, a); }
        if (cache.size > 4) cache.delete(cache.keys().next().value!);
        return a;
      };
      const counts: number[] = [];
      for (const line of log.reverse()) {
        const sha = line.slice(0, 40);
        const subject = line.slice(41);
        let base: Analysis, head: Analysis;
        try {
          base = at(`${sha}^`);
          head = at(sha);
        } catch (e) {
          console.log(`${sha.slice(0, 9)}  skipped: ${(e as Error).message.split('\n')[0]}`);
          continue;
        }
        const { changed, added, removed } = compare(base, head);
        const n = changed.length + added.length;
        counts.push(n);
        const extra = added.length || removed.length ? ` (+${added.length} -${removed.length})` : '';
        console.log(`${sha.slice(0, 9)}  ${String(n).padStart(4)} / ${head.fingerprints.size}${extra}  ${subject.slice(0, 70)}`);
      }
      const touched = counts.filter((c) => c > 0);
      console.log(`\n${counts.length} commits; ${counts.length - touched.length} needed no function deploy.`);
      console.log(`Functions to deploy per commit, all commits:       median ${quantile(counts, 0.5)}, p75 ${quantile(counts, 0.75)}, p90 ${quantile(counts, 0.9)}, max ${quantile(counts, 1)}`);
      console.log(`Functions to deploy per commit, commits with any:  median ${quantile(touched, 0.5)}, p75 ${quantile(touched, 0.75)}, p90 ${quantile(touched, 0.9)}, max ${quantile(touched, 1)}`);
      return 0;
    }
    default:
      console.error('usage: fdc deploy|changed|record|fingerprint|diff|replay [--dir D] [--state F] ...');
      return 2;
  }
}

main().then((code) => process.exit(code), (e: Error) => {
  console.error(`fdc: ${e.message}`);
  process.exit(2);
});
