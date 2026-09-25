// Running `firebase deploy` and reading back which functions it deployed.
//
// `firebase deploy --json` carries no per-function results, and a zero exit
// code does not mean every targeted function was deployed (in non-interactive
// mode, updates that change a function's event type are skipped with only a
// warning). So the evidence is the per-function lines firebase-tools prints
// (deploy/functions/release/fabricator.js and reporter.js):
//
//   ✔  functions[myFn(us-central1)] Successful update operation.
//   Functions deploy had errors with the following functions:
//   	codebase:otherFn(europe-west1)
//
// A function counts as deployed only with a create/update success line and no
// error entry. Anything unconfirmed stays unrecorded, so it is deployed again
// next time instead of being silently left stale.
import { spawn } from 'node:child_process';

export interface DeployLog {
  succeeded: Set<string>;
  failed: Set<string>;
}

const LABEL = /^(?:([\w-]+):)?([\w-]+)\(([\w-]+)\)$/;
const SUCCESS = /functions\[([^\]]+)\] Successful (create|update) operation\./;
const ERRORS_HEADER = 'Functions deploy had errors with the following functions:';

/** Function ids in `codebase` that the output confirms as deployed or failed. */
export function parseDeployLog(output: string, codebase = 'default'): DeployLog {
  const ids = new Map<string, 'ok' | 'failed'>();
  const idIn = (label: string): string | null => {
    const m = LABEL.exec(label.trim());
    return m && (m[1] ?? 'default') === codebase ? m[2] : null;
  };
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ok = SUCCESS.exec(lines[i]);
    if (ok) {
      const id = idIn(ok[1]);
      if (id !== null && ids.get(id) !== 'failed') ids.set(id, 'ok');
    } else if (lines[i].includes(ERRORS_HEADER)) {
      // Labels follow one per line; a function failing in any region failed.
      for (i++; i < lines.length && LABEL.test(lines[i].trim()); i++) {
        const id = idIn(lines[i]);
        if (id !== null) ids.set(id, 'failed');
      }
    }
  }
  const pick = (s: string) => new Set([...ids].filter(([, v]) => v === s).map(([k]) => k));
  return { succeeded: pick('ok'), failed: pick('failed') };
}

/**
 * Run firebase with its output passed through to the terminal and captured.
 * Ctrl-C reaches firebase directly; this process waits for it to exit so the
 * functions deployed so far can still be recorded.
 */
export function runFirebase(bin: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
    const ignoreInterrupt = () => {};
    process.on('SIGINT', ignoreInterrupt);
    let output = '';
    child.stdout.on('data', (d: Buffer) => { process.stdout.write(d); output += d; });
    child.stderr.on('data', (d: Buffer) => { process.stderr.write(d); output += d; });
    child.on('error', (e) => { process.off('SIGINT', ignoreInterrupt); reject(e); });
    child.on('close', (code, signal) => {
      process.off('SIGINT', ignoreInterrupt);
      resolve({ code: code ?? (signal ? 130 : 1), output });
    });
  });
}
