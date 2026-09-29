# CLAUDE.md

`fdc` finds which Firebase Cloud Functions changed, by static analysis, and
deploys only those. See README.md for usage and design.

## Workflow

- **Commit after every change.** Each completed change gets its own commit
  once tests and typecheck pass. Don't batch unrelated changes into one commit.
- This project will be published as open source. Never mention private
  projects used for testing or evaluation (names, paths, function names, or
  numbers from them) in code, tests, docs, or commit messages.

## Commands

```sh
npm test            # node --test "test/*.test.ts"
npm run test:firestore  # Firestore state tests in the emulator
npm run typecheck   # tsc, type checking only
npm run build       # compile src/ to dist/ for publishing
node src/cli.ts <command> --dir <functions dir>
```

## Code layout

- `src/module.ts`: per-file analysis. It splits a module into top-level units
  and records each unit's dependencies. It depends only on file content, so
  results are cached by blob id.
- `src/project.ts`: links units across files, resolves requires, and computes
  per-function fingerprints. Bump `FINGERPRINT_VERSION` whenever a change
  alters fingerprints of unchanged code.
- `src/source.ts`: a snapshot of the functions directory, either the working
  tree or a git revision. Both must produce identical blob ids for identical
  files.
- `src/state.ts`: the record of deployed fingerprints, in a local file or a
  Firestore collection (one document per function).
- `src/deploy.ts`: runs `firebase deploy` and parses per-function results.
- `src/cli.ts`: commands.
- `test/fixtures/fake-firebase.js`: a stand-in for the firebase CLI in the
  end-to-end tests.

## Conventions

- Node runs the `.ts` files directly (type stripping). Use only erasable
  TypeScript syntax (no enums, no parameter properties), and import with
  `.ts` extensions.
- When the analysis can't be sure, it must err toward redeploying. Never
  treat a function as unchanged or deployed without evidence.
- Every analysis behavior gets a test in `test/project.test.ts` that edits a
  small in-memory project and asserts exactly which functions change.
