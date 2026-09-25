// The local record of what is deployed: one fingerprint per function.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** A missing file is an empty state: nothing is known to be deployed. */
export function loadState(file: string): State {
  if (!existsSync(file)) return { version: FINGERPRINT_VERSION, functions: {} };
  const state = JSON.parse(readFileSync(file, 'utf8')) as State;
  if (state.version !== FINGERPRINT_VERSION) {
    throw new Error(
      `${file} was written by fingerprint version ${state.version}, this is version ${FINGERPRINT_VERSION}. ` +
      `Recreate it with \`fdc record --all --rev <commit that is deployed>\`.`);
  }
  return state;
}

export function saveState(file: string, state: State) {
  const sorted = Object.fromEntries(Object.entries(state.functions).sort(([a], [b]) => a.localeCompare(b)));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: state.version, functions: sorted }, null, 2)}\n`);
  renameSync(tmp, file);
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
