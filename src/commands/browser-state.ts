// `fleet browser-state save|load <project>` — authenticated smoke states.
//
// Captures the cmux browser profile's session (cookies + local/session storage
// + tabs) to a per-project file so `fleet verify --visual --state <project>`
// can run authenticated smoke checks. `--import --from <browser> --domain <d>`
// seeds the profile from a desktop browser first.
//
// SECURITY (mandatory): a state file IS a set of live session cookies —
// possession equals being logged in. Verified live: `cmux browser state save`
// dumps the ENTIRE shared profile (every domain's cookies), not just the
// current page, and writes the file with default (world-readable) modes. So:
//   - states live ONLY under ~/.fleet/browser-states/ — never inside a git
//     repo/worktree where they could be committed or swept into an artifact
//     (`assertOutsideRepo` fails closed, including when $HOME itself is a repo);
//   - the directory is chmod 700 and each file chmod 600 right after save;
//   - `fleet digest` can never capture them: digest only writes terminal
//     screen captures (readScreen) under <project>/.claude-docs/waves/ and
//     reads nothing from ~/.fleet — see src/commands/digest.ts.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  browserImport,
  browserOpen,
  browserStateLoad,
  browserStateSave,
  browserSupported,
  browserWaitLoaded,
  closeWorkspace,
  newWorkspace,
} from "../cmux.js";
import { repoRoot } from "../git.js";

export function browserStatesDir(): string {
  return join(homedir(), ".fleet", "browser-states");
}

/** ~/.fleet/browser-states/<project>.json — `project` is a NAME, not a path. */
export function statePathFor(project: string, base = browserStatesDir()): string {
  // Separators/specials collapse to "-"; leading dots are stripped too so a
  // path-shaped name ("../evil") can't produce dot-prefixed or traversal-y files.
  const slug = project.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
  if (!slug) throw new Error(`browser-state: invalid project name "${project}"`);
  return join(base, `${slug}.json`);
}

/**
 * Refuse to place a state file anywhere inside a git repo/worktree (it would
 * be committable). The target dir may not exist yet on FIRST save, and
 * `repoRoot` returns undefined for a nonexistent cwd (git exits 128, "cannot
 * change to …") — which would pass this check vacuously. So walk up to the
 * nearest EXISTING ancestor and assert on that: a not-yet-created subdir of a
 * repo is still inside the repo. Exported for tests (detector injectable).
 */
export function assertOutsideRepo(dir: string, gitRootOf: (d: string) => string | undefined = repoRoot): void {
  let probe = resolve(dir);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break; // filesystem root
    probe = parent;
  }
  const root = gitRootOf(probe);
  if (root) {
    throw new Error(
      `browser-state: refusing to write session cookies inside a git repo/worktree (${dir} is in ${root}) — ` +
        `state files hold live credentials and must never be committable`,
    );
  }
}

/** Resolve an existing state file for --state <project>; missing = hard error. */
export function resolveStatePath(project: string): string {
  const path = statePathFor(project);
  if (!existsSync(path)) {
    throw new Error(`browser-state: no saved state for "${project}" (expected ${path}) — run \`fleet browser-state save ${project}\` first`);
  }
  return path;
}

/** Run `fn` against a throwaway browser surface in a scratch workspace. The
 *  cmux browser profile is shared, so ANY surface sees the same session jar. */
function withScratchBrowser<T>(startUrl: string, fn: (surfaceId: string) => T): T {
  if (!browserSupported()) {
    throw new Error("this cmux build does not advertise the browser rail (capabilities: browser.*) — cannot manage states");
  }
  const ws = newWorkspace({ name: "fleet-browser-state", cwd: homedir(), focus: false });
  try {
    const b = browserOpen(startUrl, ws.workspaceId);
    return fn(b.surfaceId);
  } finally {
    try {
      closeWorkspace(ws.workspaceId);
    } catch {
      // already gone
    }
  }
}

export function saveState(project: string, opts: { importFrom?: string; domain?: string; url: string }): string {
  const path = statePathFor(project);
  assertOutsideRepo(dirname(path));
  mkdirSync(dirname(path), { recursive: true });
  chmodSync(dirname(path), 0o700);
  if (opts.importFrom) browserImport({ from: opts.importFrom, domain: opts.domain });
  // `state save` runs its collector as in-page JS, so the surface needs a real
  // http(s) origin loaded — about:blank/data: throw js_error (verified live).
  // The dump itself is profile-wide regardless of which page is showing. The
  // URL is caller-provided (required): no default external network touch.
  withScratchBrowser(opts.url, (s) => {
    if (!browserWaitLoaded(s, 15_000)) {
      throw new Error(
        `browser-state: could not load ${opts.url} — \`state save\` needs a reachable http(s) page (e.g. your local app)`,
      );
    }
    browserStateSave(s, path);
  });
  // cmux writes the dump with default modes (world-readable, verified live) —
  // tighten immediately; the window is the save call itself, inside a 700 dir.
  chmodSync(path, 0o600);
  return path;
}

/** Load a saved state into the SHARED cmux browser profile (all future
 *  surfaces — including verify surfaces and worker browser panes — see it).
 *  Unlike save, `state load` works from about:blank (no in-page collector). */
export function loadState(project: string): string {
  const path = resolveStatePath(project);
  withScratchBrowser("about:blank", (s) => browserStateLoad(s, path));
  return path;
}
