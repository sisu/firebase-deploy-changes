#!/usr/bin/env node
// fdc: find which Firebase functions need redeploying.
//
//   fdc fingerprint [--dir D] [--rev R]         print {function: fingerprint} as JSON
//   fdc diff <base-rev> [<head-rev>] [--dir D] [--explain]
//                                               functions whose code differs (head defaults to the working tree)
//   fdc replay [--dir D] [-n N]                 evaluate over the last N commits touching D
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeProject, type Analysis } from './project.ts';
import { FsSource, GitSource, type Source } from './source.ts';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: '.' },
    rev: { type: 'string' },
    explain: { type: 'boolean', default: false },
    n: { type: 'string', short: 'n', default: '100' },
  },
});

const dir = path.resolve(opts.dir);
const repo = git(['-C', dir, 'rev-parse', '--show-toplevel']).trim();
const relDir = path.relative(repo, dir).split(path.sep).join('/');
const ignore = firebaseIgnore();

function git(args: string[]) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** `functions.ignore` patterns for this source directory from firebase.json, if any. */
function firebaseIgnore(): string[] {
  const file = path.join(repo, 'firebase.json');
  if (!existsSync(file)) return [];
  const config = JSON.parse(readFileSync(file, 'utf8')).functions;
  const entries: any[] = Array.isArray(config) ? config : config ? [config] : [];
  const entry = entries.find((e) => path.resolve(repo, e.source ?? 'functions') === dir);
  return entry?.ignore ?? ['node_modules', '.git', 'firebase-debug.log', 'firebase-debug.*.log', '*.local'];
}

function analyze(rev: string | undefined): Analysis {
  const src: Source = rev === undefined ? new FsSource(dir) : new GitSource(repo, rev, relDir);
  return analyzeProject(src, { ignore });
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

const [command, ...args] = positionals;
switch (command) {
  case 'fingerprint': {
    const a = analyze(opts.rev);
    for (const w of a.warnings) console.error(`warning: ${w}`);
    console.log(JSON.stringify(Object.fromEntries(a.fingerprints), null, 2));
    break;
  }
  case 'diff': {
    if (!args[0]) throw new Error('usage: fdc diff <base-rev> [<head-rev>]');
    const base = analyze(args[0]);
    const head = analyze(args[1]);
    for (const w of head.warnings) console.error(`warning: ${w}`);
    const { changed, added, removed } = compare(base, head);
    console.log(`${changed.length} changed, ${added.length} added, ${removed.length} removed (of ${head.fingerprints.size})`);
    for (const name of changed) {
      console.log(`  changed  ${name}`);
      if (opts.explain) for (const step of explain(base, head, name)) console.log(`             → ${step}`);
    }
    for (const name of added) console.log(`  added    ${name}`);
    for (const name of removed) console.log(`  removed  ${name}  (a filtered deploy does not delete it)`);
    const deploy = [...changed, ...added];
    if (deploy.length) console.log(`\nfirebase deploy --only ${deploy.map((n) => `functions:${n}`).join(',')}`);
    break;
  }
  case 'replay': {
    const log = git(['-C', repo, 'log', '--format=%H %s', '-n', opts.n, '--', relDir || '.']).trim().split('\n').filter(Boolean);
    const cache = new Map<string, Analysis>();
    const at = (rev: string) => {
      const sha = git(['-C', repo, 'rev-parse', rev]).trim();
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
    break;
  }
  default:
    console.error('usage: fdc fingerprint|diff|replay [--dir D] ...');
    process.exit(2);
}
