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

// ── tmux-compat verbs (wait-for, pipe-pane) ─────────────────────────────────
// These are CLI-side compat commands NOT advertised in `cmux capabilities`
// (methods list), so the capability gate greps the cached `cmux help` text
// instead. Fail-safe: any error reads as "unsupported" so consumers behave
// exactly as on an older cmux.

let cachedHelpText: string | undefined;

function helpText(): string {
  if (cachedHelpText === undefined) {
    try {
      cachedHelpText = cmux(["help"]);
    } catch {
      cachedHelpText = "";
    }
  }
  return cachedHelpText;
}

/** Pure gating decision: does this help text list `verb` as a command (a line
 *  starting with the verb)? Exported for tests. */
export function helpListsVerb(help: string, verb: string): boolean {
  return new RegExp(`^\\s*${verb}\\b`, "m").test(help);
}

/** True iff this cmux build lists the `wait-for` signal verb. */
export function signalsSupported(): boolean {
  return helpListsVerb(helpText(), "wait-for");
}

/** True iff this cmux build lists the `pipe-pane` verb. */
export function pipePaneSupported(): boolean {
  return helpListsVerb(helpText(), "pipe-pane");
}

/**
 * Send (signal) a named cmux synchronization point: `wait-for -S <name>`.
 * Verified semantics (live binary, 2026-06-09): the signal wakes every process
 * currently blocked in `cmux wait-for <name>`; with no waiter it is STICKY —
 * the next single wait returns immediately and consumes it.
 */
export function sendSignal(name: string): void {
  cmux(["wait-for", "-S", name]);
}

/**
 * Dump a pane's text (screen + scrollback) through a shell command:
 * `pipe-pane --command`. Verified semantics (live binary, 2026-06-09): this is
 * a ONE-SHOT asynchronous dump, NOT tmux's continuous stream — the command
 * receives the pane's current content on stdin once and the call returns before
 * the dump lands. Callers that want fresh content re-invoke it.
 */
export function pipePaneDump(target: Target, command: string): void {
  cmux(["pipe-pane", ...addr(target), "--command", command]);
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
  type: SurfaceInfo["type"];
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
    if (s) cells.push({ paneRef: p.ref, surfaceRef: s.ref, surfaceId: s.id, workspaceId: info.workspace_id, type: s.type });
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
 * The input-box region of a Claude Code TUI screen: the lines strictly between
 * the LAST `╭…╮`/`╰…╯` border pair. Scoping the cleared-input probe here —
 * rather than a raw tail of the screen — keeps echoed transcript text from
 * reading as "still in the input box" (which caused spurious retry-Enters that
 * could land on a permission dialog's highlighted default). Falls back to the
 * last 9 lines when no box is visible (mid-redraw). Pure; exported for tests.
 */
export function inputBoxRegion(screen: string): string {
  const lines = screen.split("\n");
  for (let close = lines.length - 1; close >= 0; close--) {
    if (!lines[close]?.trimStart().startsWith("╰")) continue;
    for (let open = close - 1; open >= 0; open--) {
      if (lines[open]?.trimStart().startsWith("╭")) {
        return lines.slice(open + 1, close).join("\n");
      }
    }
    break; // a ╰ with no matching ╭ above — treat as no box
  }
  return lines.slice(-9).join("\n");
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
  // the input box, the prompt wasn't submitted yet.
  const probe = text.replace(/\s+/g, " ").trim().slice(0, 28);
  for (let i = 0; i < 6; i++) {
    sleepMs(450);
    let screen = "";
    try {
      screen = readScreen(target, 20);
    } catch {
      return;
    }
    const box = inputBoxRegion(screen).replace(/\s+/g, " ");
    if (probe.length < 4 || !box.includes(probe)) return; // left the input → submitted
    sendKey(target, "Enter"); // still in the input box → nudge again
  }
}

/** Close a workspace by handle. */
export function closeWorkspace(workspace: string): void {
  cmux(["close-workspace", "--workspace", workspace]);
}

// ── Browser rail ─────────────────────────────────────────────────────────────
// Typed wrappers over `cmux browser …` (WKWebView). Verified live 2026-06-09:
//   - `browser open <url> --workspace <ws>` splits a browser pane into the
//     workspace and prints `OK surface=surface:N pane=pane:N placement=split`.
//   - `wait` exits non-zero on timeout ("Error: timeout: …") — callers treat
//     that as FAIL (fail closed).
//   - `errors list`/`console list` print "No browser errors"/"No console
//     entries" when empty (no --json on these verbs in this build).
//   - `state save <path>` dumps the SHARED profile's cookies + storage — live
//     session credentials. Callers own tightening file modes (see
//     commands/browser-state.ts); this layer just runs the verb.
// Network mocking / viewport emulation / tracing are listed in help but return
// not_supported on WKWebView — not wrapped, don't promise them.

let cachedBrowserSupported: boolean | undefined;

/** True iff this cmux advertises the browser rail (cached). Fail-safe: any
 *  error resolving capabilities reads as "unsupported" so callers degrade with
 *  a clear message instead of crashing mid-verify. */
export function browserSupported(): boolean {
  if (cachedBrowserSupported !== undefined) return cachedBrowserSupported;
  try {
    const caps = cmuxJson<{ methods?: string[] }>(["capabilities"]);
    const m = new Set(caps.methods ?? []);
    cachedBrowserSupported = m.has("browser.open_split") && m.has("browser.wait");
  } catch {
    cachedBrowserSupported = false;
  }
  return cachedBrowserSupported;
}

export interface BrowserSurface {
  surfaceRef: string;
  surfaceId: string; // UUID — stable across ref renumbering, used for all ops
  paneRef: string;
}

/**
 * Open a browser surface as a split pane in a workspace and resolve its stable
 * UUID (the `OK surface=… pane=…` line only carries refs, which renumber).
 */
export function browserOpen(url: string, workspace: string): BrowserSurface {
  const out = cmux(["browser", "open", url, "--workspace", workspace, "--focus", "false"]);
  const surface = out.match(/surface=(surface:\d+)/)?.[1];
  const pane = out.match(/pane=(pane:\d+)/)?.[1];
  if (!surface || !pane) throw new Error(`could not parse browser surface from cmux output: ${JSON.stringify(out)}`);
  const info = cmuxJson<PaneSurfacesResponse>([
    "list-pane-surfaces", "--workspace", workspace, "--pane", pane, "--id-format", "both", "--json",
  ]);
  const s = info.surfaces.find((x) => x.type === "browser") ?? info.surfaces.find((x) => x.ref === surface);
  if (!s) throw new Error(`browser surface ${surface} not found in ${workspace} pane ${pane}`);
  return { surfaceRef: s.ref, surfaceId: s.id, paneRef: pane };
}

function browser(surface: string, args: string[]): string {
  return cmux(["browser", "--surface", surface, ...args]);
}

/** Navigate an existing browser surface. */
export function browserNavigate(surface: string, url: string): void {
  browser(surface, ["goto", url]);
}

/** Wait for a load state; false on timeout/error (callers fail closed). */
export function browserWaitLoaded(surface: string, timeoutMs: number): boolean {
  try {
    browser(surface, ["wait", "--load-state", "complete", "--timeout-ms", String(timeoutMs)]);
    return true;
  } catch {
    return false;
  }
}

export function browserGetUrl(surface: string): string {
  return browser(surface, ["get", "url"]);
}

/** Full visible page text (body). Some pages break rich snapshots; plain text
 *  is the robust fallback per the WKWebView footguns. */
export function browserGetText(surface: string): string {
  return browser(surface, ["get", "text", "--selector", "body"]);
}

/** Page JS errors. Empty list ⇒ this build prints "No browser errors". */
export function browserErrors(surface: string): string[] {
  const out = browser(surface, ["errors", "list"]);
  if (!out || /^no browser errors/i.test(out)) return [];
  return out.split("\n").filter((l) => l.trim());
}

/** Console entries. Empty list ⇒ this build prints "No console entries". */
export function browserConsole(surface: string): string[] {
  const out = browser(surface, ["console", "list"]);
  if (!out || /^no console entries/i.test(out)) return [];
  return out.split("\n").filter((l) => l.trim());
}

/** Reset console + error buffers so a verify only judges ITS navigation. */
export function browserClearLogs(surface: string): void {
  try {
    browser(surface, ["console", "clear"]);
    browser(surface, ["errors", "clear"]);
  } catch {
    // best-effort — a fresh surface starts clean anyway
  }
}

export function browserScreenshot(surface: string, outPath: string): void {
  browser(surface, ["screenshot", "--out", outPath]);
}

/** Dump the shared profile's cookies/storage/tabs to `path`. SENSITIVE: the
 *  file holds live session cookies — the caller must chmod it (see
 *  commands/browser-state.ts, which owns the 600/700 policy). */
export function browserStateSave(surface: string, path: string): void {
  browser(surface, ["state", "save", path]);
}

export function browserStateLoad(surface: string, path: string): void {
  browser(surface, ["state", "load", path]);
}

/** Seed the cmux browser profile with cookies imported from a desktop browser
 *  (e.g. chrome/safari), optionally scoped to one domain. Non-interactive. */
export function browserImport(opts: { from: string; domain?: string }): string {
  const args = ["browser", "import", "--non-interactive", "--from", opts.from];
  if (opts.domain) args.push("--domain", opts.domain);
  return cmux(args);
}

/** Open cmux's visual diff panel for a repo/worktree branch vs a base ref.
 *  No capability entry exists for `diff` (CLI-side verb) — callers catch
 *  CmuxError and degrade with a clear message. */
export function openDiffPanel(opts: { cwd: string; base: string; title?: string; workspace?: string }): void {
  const args = ["diff", "--branch", "--cwd", opts.cwd, "--base", opts.base, "--no-focus"];
  if (opts.title) args.push("--title", opts.title);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  cmux(args);
}

/** Open a markdown file in cmux's formatted viewer panel. */
export function openMarkdownPanel(path: string, opts: { workspace?: string } = {}): void {
  const args = ["markdown", "open", path, "--focus", "false"];
  if (opts.workspace) args.push("--workspace", opts.workspace);
  cmux(args);
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

// ── Mission-control surfaces (sidebar groups, colors, log, atomic layout) ────
// Verified live (cmux 0.64.12, 2026-06-09):
//   - `workspace-group create --name N --from <ws>` creates a NEW anchor
//     workspace (the group header) and adds <ws> as a member — so fleet OWNS
//     the anchor and worker kills can never dissolve the group (the documented
//     anchor-dissolve footgun).
//   - `new-workspace --layout '<json>'` creates every pane in ONE call; pane
//     enumeration (list-panes) follows the layout tree depth-first; each
//     surface's `command` is typed+submitted by cmux itself.
//   - `workspace-action`/`workspace-group` gate on `cmux capabilities` methods
//     ("workspace.action", "workspace.group.*"); `log` and `--layout` are
//     CLI-side, so they gate on the cached help text like wait-for/pipe-pane.

let cachedMethods: Set<string> | undefined;

/** The RPC methods this cmux advertises (cached). Fail-safe: unreachable ⇒ ∅. */
function capabilityMethods(): Set<string> {
  if (!cachedMethods) {
    try {
      const caps = cmuxJson<{ methods?: string[] }>(["capabilities"]);
      cachedMethods = new Set(caps.methods ?? []);
    } catch {
      cachedMethods = new Set();
    }
  }
  return cachedMethods;
}

/** True iff this cmux supports workspace context-menu actions (set-color etc.). */
export function workspaceActionsSupported(): boolean {
  return capabilityMethods().has("workspace.action");
}

/** True iff this cmux supports sidebar workspace groups. */
export function workspaceGroupsSupported(): boolean {
  return capabilityMethods().has("workspace.group.create") && capabilityMethods().has("workspace.group.add");
}

/** True iff `new-workspace` accepts `--layout <json>` (atomic grid spawn). */
export function layoutSupported(): boolean {
  return /^\s*new-workspace\b.*--layout/m.test(helpText());
}

/** True iff this cmux build lists the sidebar `log` verb. */
export function logVerbSupported(): boolean {
  return helpListsVerb(helpText(), "log");
}

/** Set a workspace's sidebar color (named color or #RRGGBB). */
export function setWorkspaceColor(workspace: string, color: string): void {
  cmux(["workspace-action", "--action", "set-color", "--workspace", workspace, "--color", color]);
}

/** Set a workspace's sidebar description line. */
export function setWorkspaceDescription(workspace: string, description: string): void {
  cmux(["workspace-action", "--action", "set-description", "--workspace", workspace, "--description", description]);
}

/** Append a line to a workspace's sidebar activity log. */
export function workspaceLog(
  message: string,
  opts: { level?: "info" | "progress" | "success" | "warning" | "error"; source?: string; workspace?: string } = {},
): void {
  const args = ["log"];
  if (opts.level) args.push("--level", opts.level);
  if (opts.source) args.push("--source", opts.source);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  args.push("--", message);
  cmux(args);
}

export interface WorkspaceGroup {
  ref: string;
  name: string;
  anchorRef: string;
  memberRefs: string[];
}

interface WorkspaceGroupListResponse {
  groups?: { ref?: string; name?: string; anchor_workspace_ref?: string; member_workspace_refs?: string[] }[];
}

/** List the sidebar workspace groups (refs, not UUIDs — cmux's list shape). */
export function listWorkspaceGroups(): WorkspaceGroup[] {
  const { groups } = cmuxJson<WorkspaceGroupListResponse>(["workspace-group", "list", "--json"]);
  return (groups ?? []).flatMap((g) =>
    g.ref && g.name !== undefined
      ? [{ ref: g.ref, name: g.name ?? "", anchorRef: g.anchor_workspace_ref ?? "", memberRefs: g.member_workspace_refs ?? [] }]
      : [],
  );
}

/** Create a sidebar group seeded with `from` workspaces; returns the group ref.
 *  cmux creates a fresh anchor workspace named after the group — fleet owns it. */
export function createWorkspaceGroup(name: string, from: string[]): string {
  const args = ["workspace-group", "create", "--name", name];
  if (from.length) args.push("--from", from.join(","));
  const out = cmux(args);
  const m = out.match(/workspace_group:\d+/);
  if (!m) throw new Error(`could not parse workspace_group ref from cmux output: ${JSON.stringify(out)}`);
  return m[0];
}

/** Add a workspace to an existing group. */
export function addWorkspaceToGroup(group: string, workspace: string): void {
  cmux(["workspace-group", "add", "--group", group, "--workspace", workspace]);
}

/** Remove a workspace from whatever group holds it. */
export function removeWorkspaceFromGroup(workspace: string): void {
  cmux(["workspace-group", "remove", "--workspace", workspace]);
}

/** Delete a group AND close every workspace inside it (cmux semantics). Callers
 *  must verify the group is empty-but-for-the-anchor first — destructive. */
export function deleteWorkspaceGroup(group: string): void {
  cmux(["workspace-group", "delete", group]);
}

// ── Atomic layout spawn ──────────────────────────────────────────────────────

export interface LayoutPane {
  pane: { surfaces: { type: "terminal"; command?: string }[] };
}
export interface LayoutSplit {
  direction: "horizontal" | "vertical";
  split: number;
  children: [LayoutNode, LayoutNode];
}
export type LayoutNode = LayoutPane | LayoutSplit;

/** Create a workspace with a full predefined split tree in ONE call; each
 *  surface's `command` is launched by cmux. Returns the workspace ref. */
export function newWorkspaceLayout(opts: { name: string; cwd: string; layout: LayoutNode; focus?: boolean }): string {
  const out = cmux([
    "new-workspace",
    "--name",
    opts.name,
    "--cwd",
    opts.cwd,
    "--layout",
    JSON.stringify(opts.layout),
    "--focus",
    opts.focus ? "true" : "false",
  ]);
  return parseRef(out, "workspace");
}
