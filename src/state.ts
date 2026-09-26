// The record of what is deployed: one fingerprint per function, kept in a
// local JSON file or, shared between machines, in a Firestore collection.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FINGERPRINT_VERSION } from './project.ts';

export interface FunctionRecord {
  fingerprint: string;
  /** Git commit the function was deployed from, suffixed `-dirty` for uncommitted changes. */
  rev: string | null;
  recordedAt: string;
}

export interface State {
  version: number;
  functions: Record<string, FunctionRecord>;
}

export interface StateStore {
  /** Where the state lives, for messages. */
  readonly location: string;
  load(): Promise<State>;
  /** Write these records over any existing ones; with `replace`, drop every other record. */
  save(records: Record<string, FunctionRecord>, replace: boolean): Promise<void>;
}

/** `firestore:<collection>` or a file path. */
export function openStore(spec: string, projectId: () => string): StateStore {
  if (spec.startsWith('firestore:')) return new FirestoreStore(spec.slice('firestore:'.length), projectId());
  return new FileStore(path.resolve(spec));
}

/** A missing file is an empty state: nothing is known to be deployed. */
export function loadState(file: string): State {
  if (!existsSync(file)) return { version: FINGERPRINT_VERSION, functions: {} };
  const state = JSON.parse(readFileSync(file, 'utf8')) as State;
  if (state.version !== FINGERPRINT_VERSION) {
    throw new Error(
      `${file} was written by fingerprint version ${state.version}, this is version ${FINGERPRINT_VERSION}. ` +
      `Recreate it with \`fdc record --all --replace --rev <commit that is deployed>\`.`);
  }
  return state;
}

export function saveState(file: string, state: State) {
  const sorted = Object.fromEntries(Object.entries(state.functions).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: state.version, functions: sorted }, null, 2)}\n`);
  renameSync(tmp, file);
}

class FileStore implements StateStore {
  readonly location: string;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    this.location = file;
  }
  async load() {
    return loadState(this.file);
  }
  async save(records: Record<string, FunctionRecord>, replace: boolean) {
    const state = replace ? { version: FINGERPRINT_VERSION, functions: {} } : loadState(this.file);
    Object.assign(state.functions, records);
    saveState(this.file, state);
  }
}

/**
 * One document per function, so machines deploying at the same time only
 * write their own functions' records. A document written by another
 * fingerprint version counts as not recorded: that function is deployed again.
 */
class FirestoreStore implements StateStore {
  readonly location: string;
  readonly collection: string;
  readonly projectId: string;
  #db: Promise<import('@google-cloud/firestore').Firestore> | undefined;

  constructor(collection: string, projectId: string) {
    this.collection = collection;
    this.projectId = projectId;
    this.location = `firestore:${collection} in project ${projectId}`;
  }

  // Loaded on first use, so file-state users never load the client.
  db() {
    return this.#db ??= import('@google-cloud/firestore').then(({ Firestore }) => new Firestore({ projectId: this.projectId }));
  }

  async load(): Promise<State> {
    const snap = await (await this.db()).collection(this.collection).get();
    const functions: Record<string, FunctionRecord> = {};
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.version === FINGERPRINT_VERSION) functions[doc.id] = { fingerprint: d.fingerprint, rev: d.rev, recordedAt: d.recordedAt };
    }
    return { version: FINGERPRINT_VERSION, functions };
  }

  async save(records: Record<string, FunctionRecord>, replace: boolean) {
    const db = await this.db();
    const col = db.collection(this.collection);
    const writes: ((b: import('@google-cloud/firestore').WriteBatch) => void)[] = [];
    for (const [name, rec] of Object.entries(records)) {
      writes.push((b) => b.set(col.doc(name), { ...rec, version: FINGERPRINT_VERSION }));
    }
    if (replace) {
      for (const ref of await col.listDocuments()) if (!(ref.id in records)) writes.push((b) => b.delete(ref));
    }
    // A batch holds at most 500 writes.
    for (let i = 0; i < writes.length; i += 500) {
      const batch = db.batch();
      for (const w of writes.slice(i, i + 500)) w(batch);
      await batch.commit();
    }
  }
}

export interface Plan {
  changed: string[];
  added: string[];
  removed: string[];
}

/** Compare current fingerprints with the recorded ones. */
export function plan(fingerprints: Map<string, string>, state: State): Plan {
  const changed: string[] = [], added: string[] = [];
  for (const [name, fp] of fingerprints) {
    const rec = state.functions[name];
    if (!rec) added.push(name);
    else if (rec.fingerprint !== fp) changed.push(name);
  }
  const removed = Object.keys(state.functions).filter((n) => !fingerprints.has(n));
  return { changed, added, removed };
}
