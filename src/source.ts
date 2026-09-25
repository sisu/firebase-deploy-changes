// A snapshot of the functions source directory: the working tree or a git revision.
// Paths are POSIX, relative to the functions directory.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Source {
  /** Every file in the snapshot (node_modules excluded). */
  files(): string[];
  /** Content identity of a file, or undefined if it does not exist. */
  blobId(rel: string): string | undefined;
  read(rel: string): string;
}

export class FsSource implements Source {
  private dir: string;
  private ids = new Map<string, string>();
  private list: string[] = [];

  constructor(dir: string) {
    this.dir = dir;
    const walk = (rel: string) => {
      for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== '.git') walk(r);
        } else if (e.isFile()) {
          this.list.push(r);
        }
      }
    };
    walk('');
  }

  files() { return this.list; }

  blobId(rel: string) {
    let id = this.ids.get(rel);
    if (id === undefined && this.list.includes(rel)) {
      id = createHash('sha1').update(readFileSync(path.join(this.dir, rel))).digest('hex');
      this.ids.set(rel, id);
    }
    return id;
  }

  read(rel: string) { return readFileSync(path.join(this.dir, rel), 'utf8'); }
}

export class GitSource implements Source {
  private repo: string;
  private blobs = new Map<string, string>();

  /** `dir` is the functions directory relative to the repo root ('' for the root). */
  constructor(repo: string, rev: string, dir: string) {
    this.repo = repo;
    const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
    const out = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', rev, '--', prefix || '.'], {
      encoding: 'utf8', maxBuffer: 1 << 28,
    });
    for (const line of out.split('\0')) {
      if (!line) continue;
      const [meta, file] = line.split('\t');
      const [, type, sha] = meta.split(' ');
      if (type !== 'blob' || !file.startsWith(prefix)) continue;
      const rel = file.slice(prefix.length);
      if (rel.split('/').includes('node_modules')) continue;
      this.blobs.set(rel, sha);
    }
  }

  files() { return [...this.blobs.keys()]; }
  blobId(rel: string) { return this.blobs.get(rel); }

  read(rel: string) {
    const sha = this.blobs.get(rel);
    if (!sha) throw new Error(`no such file in revision: ${rel}`);
    return execFileSync('git', ['-C', this.repo, 'cat-file', 'blob', sha], { encoding: 'utf8', maxBuffer: 1 << 28 });
  }
}
