// Thin, typed wrapper around the cmux CLI / Unix socket.
//
// Every fleet operation funnels through here so the rest of the codebase never
// shells out to `cmux` directly. This is also the seam where a future tmux
// backend would slot in (see plan).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Resolve the cmux binary: explicit override → bundled path → PATH → app default. */
function resolveBinary(): string {
  const candidates = [
    process.env.CMUX_BIN,
    process.env.CMUX_BUNDLED_CLI_PATH,
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: assume it's on PATH and let exec fail loudly if not.
  return "cmux";
}

const CMUX_BIN = resolveBinary();

export class CmuxError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CmuxError";
  }
}

/** Run a cmux subcommand, returning trimmed stdout. Throws CmuxError on failure. */
export function cmux(args: string[]): string {
  try {
    const out = execFileSync(CMUX_BIN, args, {
      encoding: "utf8",
      env: { ...process.env, CMUX_QUIET: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = (e.stderr?.toString() ?? "") + (e.stdout?.toString() ?? "");
    throw new CmuxError(
      `cmux ${args.join(" ")} failed: ${stderr.trim() || e.message}`,
      args,
      stderr,
    );
  }
}

/** Run a cmux subcommand that emits JSON (pass the `--json` flag yourself). */
export function cmuxJson<T = unknown>(args: string[]): T {
  const raw = cmux(args);
  return JSON.parse(raw) as T;
}

/**
 * Extract the first `<kind>:<n>` ref from cmux stdout.
 * e.g. parseRef("OK workspace:4", "workspace") === "workspace:4"
 */
export function parseRef(stdout: string, kind: "workspace" | "surface" | "pane" | "window"): string {
  const m = stdout.match(new RegExp(`${kind}:\\d+`));
  if (!m) throw new Error(`could not parse ${kind} ref from cmux output: ${JSON.stringify(stdout)}`);
  return m[0];
}

export interface SurfaceInfo {
  ref: string;
  id: string;
  index: number;
  title: string;
  type: "terminal" | "browser";
  selected: boolean;
}

interface PaneSurfacesResponse {
  pane_ref: string;
  pane_id: string;
  workspace_ref: string;
  workspace_id: string;
  surfaces: SurfaceInfo[];
}

/** List the surfaces in a workspace (with both refs and UUIDs). */
export function listSurfaces(workspaceRef: string): PaneSurfacesResponse {
  return cmuxJson<PaneSurfacesResponse>([
    "list-pane-surfaces",
    "--workspace",
    workspaceRef,
    "--id-format",
    "both",
    "--json",
  ]);
}

/** True if a workspace still exists (used to reconcile a stale registry). */
export function workspaceExists(workspace: string): boolean {
  try {
    listSurfaces(workspace);
    return true;
  } catch {
    return false;
  }
}

export interface NewWorkspaceResult {
  workspaceRef: string;
  workspaceId: string;
  surfaceRef: string;
  surfaceId: string;
}

/**
 * Create a workspace and (optionally) launch a command in its terminal.
 * Launching via `--command` lets cmux boot the PTY and run the program itself,
 * which is far more reliable than typing into a not-yet-live terminal.
 */
export function newWorkspace(opts: {
  name: string;
  cwd: string;
  command?: string;
  focus?: boolean;
}): NewWorkspaceResult {
  const args = ["new-workspace", "--name", opts.name, "--cwd", opts.cwd, "--focus", opts.focus ? "true" : "false"];
  if (opts.command) args.push("--command", opts.command);
  const out = cmux(args);
  const workspaceRef = parseRef(out, "workspace");
  const info = listSurfaces(workspaceRef);
  const surface = info.surfaces.find((s) => s.selected) ?? info.surfaces[0];
  if (!surface) throw new Error(`no surface in ${workspaceRef} after new-workspace`);
  return {
    workspaceRef,
    workspaceId: info.workspace_id,
    surfaceRef: surface.ref,
    surfaceId: surface.id,
  };
}

function sleepMs(ms: number): void {
  // Blocking sleep via syscall (we run synchronously, one cmux call at a time).
  execFileSync("sleep", [(ms / 1000).toFixed(3)]);
}

// ── Addressing ────────────────────────────────────────────────────────────
// Workers are addressed by a Target = { workspace, surface } (UUIDs preferred —
// stable across ref renumbering). We pass BOTH --workspace and --surface on
// every read/send: `--workspace` alone resolves to the focused pane's selected
// surface, which breaks once the workspace also holds a browser surface
// ("Surface is not a terminal"). `--surface` alone is unreliable in this build;
// `--workspace <ws> --surface <terminal>` is the combination that works.
export interface Target {
  workspace: string;
  surface?: string;
}

function addr(t: Target): string[] {
  const a = ["--workspace", t.workspace];
  if (t.surface) a.push("--surface", t.surface);
  return a;
}

/**
 * Wait until a worker's terminal has booted and can be read. cmux boots a
 * background workspace's PTY lazily, so `new-workspace` returns before the
 * terminal is live. Polls read-screen (the op that requires a live terminal).
 */
export function waitForTerminal(target: Target, timeoutMs = 15000): void {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      // Wait for non-empty content: the PTY can report "live" a beat before the
      // shell prompt / launched command has actually rendered anything.
      const screen = cmux(["read-screen", ...addr(target), "--lines", "3"]);
      if (screen.trim().length > 0) return;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    sleepMs(200);
  }
  throw new Error(`workspace ${target.workspace} terminal never became live: ${lastErr}`);
}

/** Read the visible screen (or scrollback) of a worker's terminal. */
export function readScreen(target: Target, lines = 50, scrollback = false): string {
  const args = ["read-screen", ...addr(target), "--lines", String(lines)];
  if (scrollback) args.push("--scrollback");
  return cmux(args);
}

/** Type literal text into a worker's terminal (does NOT press Enter). */
export function sendText(target: Target, text: string): void {
  cmux(["send", ...addr(target), text]);
}

/** Send a named key (e.g. "Enter", "ctrl+c") to a worker's terminal. */
export function sendKey(target: Target, key: string): void {
  cmux(["send-key", ...addr(target), key]);
}

/** Type text then submit it with Enter — the common "talk to the agent" op. */
export function submit(target: Target, text: string): void {
  sendText(target, text);
  sendKey(target, "Enter");
}

/** Close a workspace by handle. */
export function closeWorkspace(workspace: string): void {
  cmux(["close-workspace", "--workspace", workspace]);
}
