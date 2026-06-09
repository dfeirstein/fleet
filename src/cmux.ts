// Thin, typed wrapper around the cmux CLI / Unix socket.
//
// Every fleet operation funnels through here so the rest of the codebase never
// shells out to `cmux` directly. This is also the seam where a future tmux
// backend would slot in (see plan).
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
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

/** The resolved cmux binary path (for spawning long-lived subprocesses like the event stream). */
export function cmuxBin(): string {
  return CMUX_BIN;
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

// ── Event stream (the push trigger behind the event-driven Captain) ─────────
// `cmux events` is a beta surface; both the event-driven daemon/watch and the
// `blocked-on-you` lane HARD-gate on this capability and fall back to today's
// poll path when it's absent. Per CLAUDE.md, the long-lived subprocess spawn
// lives here in the seam — never a fresh spawn in a consumer.

let cachedEventsSupported: boolean | undefined;

/** True iff this cmux advertises the `events.stream` method (cached). Fail-safe:
 *  any error resolving capabilities is treated as "unsupported" so consumers
 *  degrade to polling rather than crash. */
export function eventsSupported(): boolean {
  if (cachedEventsSupported !== undefined) return cachedEventsSupported;
  try {
    const caps = cmuxJson<{ methods?: string[] }>(["capabilities"]);
    cachedEventsSupported = Array.isArray(caps.methods) && caps.methods.includes("events.stream");
  } catch {
    cachedEventsSupported = false;
  }
  return cachedEventsSupported;
}

export interface EventStreamHandle {
  stop(): void;
}

/**
 * Subscribe to the cmux event stream (NDJSON), dispatching ack vs event frames.
 * cmux's `--reconnect` resumes from the last received sequence on a drop; the
 * optional `--cursor-file` makes the cursor durable across daemon restarts.
 * `onExit` lets a caller restart on a hard process death. Heartbeat frames are
 * suppressed (`--no-heartbeat`); the ack is kept (gap detection needs it).
 */
export function streamEvents(opts: {
  categories?: string[];
  names?: string[];
  cursorFile?: string;
  reconnect?: boolean;
  onAck?: (ack: unknown) => void;
  onFrame: (frame: unknown) => void;
  onExit?: (code: number | null) => void;
}): EventStreamHandle {
  const args = ["events", "--no-heartbeat"];
  if (opts.reconnect !== false) args.push("--reconnect");
  if (opts.cursorFile) args.push("--cursor-file", opts.cursorFile);
  for (const c of opts.categories ?? []) args.push("--category", c);
  for (const n of opts.names ?? []) args.push("--name", n);

  const child = spawn(CMUX_BIN, args, {
    env: { ...process.env, CMUX_QUIET: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(t) as { type?: string };
      } catch {
        return; // a torn line — skip
      }
      if (parsed.type === "ack") opts.onAck?.(parsed);
      else if (parsed.type === "event") opts.onFrame(parsed);
    });
  }
  child.on("exit", (code) => opts.onExit?.(code));

  return {
    stop() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
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

/** List the surfaces in a workspace's focused pane (with both refs and UUIDs). */
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

interface PanesResponse {
  panes: { ref: string; selected_surface_ref: string }[];
}

export interface GridCell {
  paneRef: string;
  surfaceRef: string;
  surfaceId: string;
  workspaceId: string;
}

/** Split a pane/surface and return the NEW surface's ref. */
export function newSplit(
  direction: "left" | "right" | "up" | "down",
  target: Target,
  opts?: { focus?: boolean },
): string {
  const args = ["new-split", direction, "--workspace", target.workspace, "--focus", opts?.focus ? "true" : "false"];
  if (target.surface) args.push("--surface", target.surface);
  return parseRef(cmux(args), "surface");
}

/** Enumerate every pane's terminal surface in a workspace, with stable UUIDs. */
export function listGridCells(workspaceRef: string): GridCell[] {
  const { panes } = cmuxJson<PanesResponse>(["list-panes", "--workspace", workspaceRef, "--json"]);
  const cells: GridCell[] = [];
  for (const p of panes) {
    const info = cmuxJson<PaneSurfacesResponse>([
      "list-pane-surfaces",
      "--workspace",
      workspaceRef,
      "--pane",
      p.ref,
      "--id-format",
      "both",
      "--json",
    ]);
    const s = info.surfaces.find((x) => x.selected) ?? info.surfaces[0];
    if (s) cells.push({ paneRef: p.ref, surfaceRef: s.ref, surfaceId: s.id, workspaceId: info.workspace_id });
  }
  return cells;
}

/** Close a single surface (pane) by workspace+surface. */
export function closeSurface(target: Target): void {
  const args = ["close-surface", "--workspace", target.workspace];
  if (target.surface) args.push("--surface", target.surface);
  cmux(args);
}

interface WorkspaceListResponse {
  workspaces?: { id?: string; ref?: string; selected?: boolean }[];
}

/**
 * The currently focused workspace — the `selected` one in the active window.
 * Lets a global hotkey (run outside any pane, so no $CMUX_WORKSPACE_ID) target
 * the workspace the user is looking at.
 */
export function focusedWorkspace(): { id: string; ref: string } | undefined {
  try {
    const { workspaces } = cmuxJson<WorkspaceListResponse>(["rpc", "workspace.list"]);
    const sel = (workspaces ?? []).find((w) => w.selected && w.id);
    if (sel?.id) return { id: sel.id, ref: sel.ref ?? sel.id };
  } catch {
    // can't reach cmux — caller falls back
  }
  return undefined;
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

/** True if a specific surface (pane) still exists within its workspace. */
export function surfaceExists(target: { workspace: string; surface: string }): boolean {
  try {
    return listGridCells(target.workspace).some((c) => c.surfaceId === target.surface);
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

/**
 * Submit a prompt into a Claude Code TUI reliably. cmux `send` arrives as a
 * bracketed paste; an Enter sent too soon lands INSIDE the paste (becoming a
 * newline in the input) instead of submitting, so messages just pile up in the
 * box. So: type the text, let the paste settle, press Enter, then VERIFY the
 * input actually cleared — re-pressing Enter until our text is no longer sitting
 * in the input region. (Checking the input cleared is the only reliable signal;
 * the "paste again to expand" collapse indicator only covers one failure mode.)
 */
export function submitToClaude(target: Target, text: string): void {
  sendText(target, text);
  sleepMs(450); // let the bracketed paste settle before Enter
  sendKey(target, "Enter");

  // A distinctive, whitespace-normalized chunk of the message. If it's still in
  // the bottom of the screen (the input box), the prompt wasn't submitted yet.
  const probe = text.replace(/\s+/g, " ").trim().slice(0, 28);
  for (let i = 0; i < 6; i++) {
    sleepMs(450);
    let screen = "";
    try {
      screen = readScreen(target, 20);
    } catch {
      return;
    }
    const tail = screen.split("\n").slice(-9).join("\n").replace(/\s+/g, " ");
    if (probe.length < 4 || !tail.includes(probe)) return; // left the input → submitted
    sendKey(target, "Enter"); // still in the input box → nudge again
  }
}

/** Close a workspace by handle. */
export function closeWorkspace(workspace: string): void {
  cmux(["close-workspace", "--workspace", workspace]);
}

/**
 * Reload cmux config in place (Ghostty + ~/.config/cmux/cmux.json), no restart.
 * Best-effort: returns false instead of throwing if cmux isn't reachable, so a
 * config edit still succeeds when the app happens to be down.
 */
export function reloadConfig(): boolean {
  try {
    cmux(["reload-config"]);
    return true;
  } catch {
    return false;
  }
}
