# firebase-deploy-changes (`fdc`)

Deploy only the Firebase Cloud Functions whose code actually changed.

`firebase deploy --only functions` decides what changed using a hash of the
whole functions source directory. Edit one line anywhere and every function
counts as changed. With hundreds of functions, that makes deploys slow and runs
into Cloud Functions API quotas.

`fdc` statically analyzes the functions codebase, works out which code each
exported function can reach, and redeploys only the functions whose reachable
code changed since they were last deployed.

> **Status: early prototype.** Supports CommonJS JavaScript codebases. See
> [Limitations](#limitations).

## Requirements

- Node.js 23.6 or newer. The TypeScript sources run directly, with no build
  step.
- The Firebase CLI (`firebase`) on your `PATH`.
- Git, for the commands that read revisions (`record --rev`, `diff`,
  `replay`).

## Usage

Run from a clone of this repository, from the Firebase project directory:

```sh
npm install                       # in this repository
alias fdc="node /path/to/firebase-deploy-changes/src/cli.ts"
```

```sh
# First time: tell fdc which commit is currently deployed (optional; without
# it the first `fdc deploy` deploys every function).
fdc record --all --rev <deployed-commit> --dir functions

# See what would be deployed. Exit code 1 means something needs deploying.
fdc changed --dir functions

# The same, for a commit instead of the working tree, as JSON for scripts:
# {"changed": [...], "added": [...], "removed": [...]}
fdc changed --dir functions --rev origin/main --json

# Deploy changed functions and record the ones that succeed.
fdc deploy --dir functions
fdc deploy --dir functions --dry-run          # print the firebase command only
fdc deploy --dir functions -- --project prod  # arguments after -- go to firebase
fdc deploy --dir functions --all              # deploy everything

# After deploying some functions by hand:
fdc record myFunction otherFunction --dir functions
```

| Command | What it does |
| --- | --- |
| `deploy [--all] [--dry-run] [-- <firebase args>]` | Deploy changed functions and record the ones that succeed |
| `changed [--rev R] [--json]` | List changed, new and removed functions |
| `record [<names>...] [--all] [--rev R]` | Mark functions as deployed without deploying |
| `fingerprint [--rev R]` | Print every function's fingerprint as JSON |
| `diff <base-rev> [<head-rev>] [--explain]` | Functions whose code differs between two revisions; `--explain` shows why |
| `replay [-n N]` | Replay the last N commits and report how many functions each one would deploy |

Common options:

- `--dir <path>`: the functions source directory (default `.`).
- `--state <file>`: the state file (default: `.fdc-state.json` next to
  `firebase.json`, or `.fdc-state.<codebase>.json` for a non-default
  codebase).

### The state file

The state file records, for each function, the fingerprint and git commit it
was last deployed from. It is local, so add it to `.gitignore`. If you deploy
from a temporary worktree, point `--state` at a location that outlives it.

Functions removed from the code stay in the state file and are listed by
`fdc changed`. `firebase deploy --only` never deletes functions, so delete them
with `firebase functions:delete`.

### How deploy results are determined

`firebase deploy --json` does not report results per function. A zero exit
code does not mean every targeted function was deployed: in non-interactive
mode, firebase-tools skips updates that change a function's event type, prints
only a warning, and still exits 0. So `fdc deploy` reads the per-function lines
firebase prints:

```
✔  functions[myFunction(us-central1)] Successful update operation.
Functions deploy had errors with the following functions:
	otherFunction(us-central1)
```

A function is recorded only if it has a create/update success line and no
error entry. Anything unconfirmed stays unrecorded and is deployed again next
time. A wrongly recorded function would leave production silently stale; a
wrongly unrecorded one only costs a redeploy.

If firebase exits successfully but prints no recognizable results, `fdc` warns
that the output format may have changed and records nothing.

## How it works

1. **Split modules into units.** Each file is parsed with Babel into top-level
   units: declarations, `exports.X = ...` assignments, properties of
   `module.exports = { ... }`, and other statements. A unit's hash ignores
   comments and formatting.
2. **Link units.** Babel's scope analysis resolves every identifier to the
   unit that declares it. Imports are tracked at the level of individual
   names: `const { a } = require('./x')`, `x.a`, and `require('./x').a` inside
   function bodies. Require cycles between files do not merge their
   functions' dependencies.
3. **Fingerprint functions.** For each export of the entry file (`main` in
   `package.json`), everything reachable is hashed together with:
   - top-level statements that run for their side effects
     (`setGlobalOptions(...)`, `initializeApp()`), which every function
     depends on;
   - `.env` files and the runtime fields of `package.json`;
   - each npm package the function imports, including that package's own
     dependencies, as pinned in `package-lock.json`;
   - non-code files, for functions that use `fs`.

Where static analysis can't be precise, `fdc` errs toward redeploying:

- a module object used as a whole (`Object.keys(mod)`) depends on all of that
  module;
- `require` with a computed path depends on every code file;
- an export that isn't statically visible depends on the whole module.

## Limitations

- **Module formats.** Only CommonJS JavaScript is supported. There is no
  support yet for ESM `import`/`export`, for TypeScript output patterns
  (`Object.defineProperty(exports, ...)`, `__importStar`), or for grouped
  exports (`exports.group = { ... }`).
- **Initializers of unused variables.** A top-level initializer runs whenever
  the module loads, but is only charged to functions that use the variable.
  For example, a change inside `const db = init()` does not redeploy functions
  that don't use `db`.
- **Imported objects.** Mutating an object imported from another module is not
  tracked.
- **Changes outside the code.** New secret versions and other settings that
  don't live in the source directory are invisible to `fdc`. Use
  `fdc deploy --all` when they change.
- **Deploy confirmation.** It relies on firebase-tools' console output, which
  is not a stable API.

## Development

```sh
npm test            # node --test
npm run typecheck   # tsc (type checking only; Node runs the .ts files directly)
```
