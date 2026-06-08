# TypeScript / ESM / tsx conventions

This is a **pure-ESM TypeScript** project that runs through `tsx` with **no build
step**. The config choices in `tsconfig.json` impose a few rules that bite if
ignored. Current resolved versions live in [versions.md](versions.md).

## No build step — `tsx` runs the source

- `bin/fleet` → `tsx src/cli.ts`. There is no `dist/`; `npm run build` does not
  exist. Don't add a bundler or emit step unless there's a real reason.
- `package.json` has `"type": "module"` — everything is ESM.
- Run a command during development with `./bin/fleet <command>` (or
  `npm run fleet -- <command>`).

## Relative imports MUST end in `.js`

`moduleResolution: "Bundler"` + ESM means **runtime** relative imports use the
`.js` extension even though the file on disk is `.ts`:

```ts
import { spawn } from "./commands/spawn.js";   // ✅ resolves spawn.ts at runtime
import { spawn } from "./commands/spawn";       // ❌ breaks under ESM
```

Every internal import in `src/` already does this. Match it.

## `verbatimModuleSyntax` → use `import type` for type-only imports

A type imported without the `type` modifier is emitted as a real runtime import
and will fail. Separate type imports:

```ts
import { spawn, type SpawnOptions } from "./commands/spawn.js";  // ✅ inline type
import type { Agent } from "./registry.js";                       // ✅ type-only
```

## strict + `noUncheckedIndexedAccess`

`strict: true` and `noUncheckedIndexedAccess: true` are on. Indexing an array or
record yields `T | undefined`, so the codebase uses `!` / guards deliberately
(e.g. `argv[i]!`, `info.surfaces[0]`). Don't disable these; handle the `undefined`.

Target is `ES2022`, lib `ES2023`, `types: ["node"]` only. `resolveJsonModule` is
on (JSON imports allowed). `skipLibCheck` is on.

## Verification is `tsc --noEmit`

The single automated gate is `npm run typecheck` (= `tsc --noEmit`). There is no
test runner — see [verification.md](verification.md). Keep typecheck green; it is
the bar before every commit.

## Zero runtime dependencies

`package.json` has only **devDependencies** (`tsx`, `typescript`). The CLI relies
on Node built-ins (`node:child_process`, `node:fs`, `node:os`, `node:path`) and
the cmux binary. Adding a runtime dependency is a real decision — prefer the
standard library. Node 20+ is required (Node 22 LTS "Jod" is the current local
runtime; `fetch`/`AbortController` are used unflagged).
