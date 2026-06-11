// `fleet spawn` — create a worker: open a cmux workspace, launch Claude Code in
// it (via cmux's --command, under the orchestrator's Max-plan session), and
// register it in the fleet.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  newWorkspace,
  newSplit,
  listGridCells,
  closeWorkspace,
  closeSurface,
  workspaceExists,
  waitForTerminal,
  readScreen,
  waitForReady,
  submit,
  sendKey,
  submitToClaude,
  browserOpen,
  browserSupported,
  type Target,
} from "../cmux.js";
import { upsert, remove, patch, listAgents, sessionId, type Agent } from "../registry.js";
import { ensureWorkerGrouped } from "../sidebar.js";
import { appendOutcome } from "../outcomes.js";
import { refreshCapture } from "../capture-log.js";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { repoRoot, currentBranch, addWorktree } from "../git.js";

// Worker permission posture:
//   auto  — autonomous, but a classifier vetoes dangerous actions (default).
//   gated — prompts for approval on every risky action (force default mode).
//   yolo  — no checks at all (--dangerously-skip-permissions); sandbox only.
export type PermMode = "auto" | "gated" | "yolo";

export interface SpawnOptions {
  task: string;
  cwd: string;
  label?: string;
  model: string;
  mode: PermMode;
  command?: string; // override the launched program (testing / non-claude agents)
  launch: boolean; // false = open a bare shell, don't launch anything
  autostart: boolean; // false = launch the program but don't pass the task prompt
  worktree: boolean; // true = isolate the worker in a git worktree on its own branch
  branch?: string; // override the worktree branch name
  standalone: boolean; // true = force a fresh workspace, skip same-project grouping
  /** Open a companion browser pane in the worker's workspace at spawn (url, or
   *  true for about:blank) and record its surface id for Captain screenshots. */
  withBrowser?: string | true;
  /** Stop condition (`--done '<check>'`): the daemon runs this in the worker's
   *  dir on stable-idle — pass auto-attaches proof, fail re-dispatches with the
   *  output (bounded by doneMaxLoops). Needs the daemon running. */
  doneCheck?: string;
  /** Max re-dispatches for `--done` (default 3); exhaustion escalates loudly. */
  doneMaxLoops?: number;
}

export const SPAWN_DEFAULTS = {
  model: "opus",
  mode: "auto" as PermMode, // autonomous + classifier-guarded; --yolo / --gated opt out
  launch: true,
  autostart: true,
  worktree: false,
  standalone: false,
};

// Same-project workers share one cmux workspace as split panes, up to this many
// live panes; the next worker for that project spills into a fresh workspace.
const MAX_PANES_PER_WORKSPACE = 4;

/** The project a directory belongs to: its git repo root, or the dir itself. */
function projectKey(cwd: string): string {
  return repoRoot(cwd) ?? cwd;
}

/** The project an existing worker belongs to (worktree workers map to their origin repo). */
function agentProject(a: Agent): string {
  return a.worktree?.repo ?? repoRoot(a.cwd) ?? a.cwd;
}

/**
 * Find a live, same-project workspace that still exists and holds fewer than
 * MAX_PANES_PER_WORKSPACE workers — the agents sharing it, so the caller can
 * split a new pane in. Returns undefined when a fresh workspace is needed.
 */
function findGroupWorkspace(key: string): Agent[] | undefined {
  const live = listAgents().filter((a) => a.status !== "dead" && agentProject(a) === key);
  const groups = new Map<string, Agent[]>();
  for (const a of live) {
    const wsId = a.workspaceId ?? a.workspace;
    const g = groups.get(wsId);
    if (g) g.push(a);
    else groups.set(wsId, [a]);
  }
  for (const agents of groups.values()) {
    if (agents.length >= MAX_PANES_PER_WORKSPACE) continue;
    // A --standalone worker owns its workspace exclusively (kill closes the whole
    // workspace), so it's never a join target — splitting siblings into it would
    // let an owner-kill take them down. grid/grouped members are ownerless.
    if (agents.some((a) => a.ownsWorkspace)) continue;
    const rep = agents[0]!;
    if (workspaceExists(rep.workspaceId ?? rep.workspace)) return agents;
  }
  return undefined;
}

function branchSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
}

/** Escape a string for safe inclusion inside single quotes in a POSIX shell. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function newAgentId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * The first `--dangerously-skip-permissions` launch shows a one-time
 * "Bypass Permissions mode" accept dialog (default highlighted: "No, exit").
 * Without this, a --yolo worker stalls instead of starting. Poll briefly and
 * select "Yes, I accept" (option 2) if the dialog appears.
 */
/** Wait until the Claude Code TUI is up and idle at its prompt. Delegates to the
 *  shared readiness gate (cmux.waitForReady → events.classifyScreenReadiness) so
 *  spawn and send key off ONE heuristic, never parallel ones (issue #38). */
export function waitForClaudeReady(target: Target, timeoutMs = 30000): boolean {
  return waitForReady(target, timeoutMs) === "ready";
}

export function acceptBypassDialog(target: Target): boolean {
  for (let i = 0; i < 15; i++) {
    let screen = "";
    try {
      screen = readScreen(target, 30);
    } catch {
      // terminal not ready yet
    }
    if (/Bypass Permissions mode/i.test(screen) && /Yes, I accept/i.test(screen)) {
      submit(target, "2"); // select option 2 and confirm
      return true;
    }
    // Already past the dialog (status bar shows the mode, or it's working).
    if (/bypass permissions on|esc to interrupt/i.test(screen)) return false;
    execFileSync("sleep", ["0.4"]);
  }
  return false;
}

/**
 * The proof-gate instruction appended to every dispatched brief (B3): tells the
 * worker, with its concrete agent id, how to attach proof when it finishes.
 * Shared by spawn (post-ready dispatch) and grid (task baked into the launch line).
 */
export function proofInstruction(agentId: string): string {
  return `(When you finish, prove it: run \`fleet done ${agentId} --proof test:'<command that verifies your work>'\` — or --proof file:<path> for a produced artifact. A note:'…' proof is metadata only and never satisfies the gate. FLEET_SESSION and FLEET_AGENT_ID are exported in your environment, so the command works as-is.)`;
}

/**
 * The full launch line for a worker: FLEET_SESSION + FLEET_AGENT_ID env exports
 * ahead of the claude command, so a bare `fleet done <agentId> --proof …` run
 * INSIDE the worker resolves this fleet's registry (sessionId() prefers
 * FLEET_SESSION). Without it, a worktree worker's git-toplevel hash derives a
 * different (empty) session. Shared by spawn and grid.
 */
export function buildWorkerLaunchCommand(
  agentId: string,
  model: string,
  task: string,
  autostart: boolean,
  mode: PermMode,
): string {
  const envPrefix = `FLEET_SESSION=${shellSingleQuote(sessionId())} FLEET_AGENT_ID=${agentId} `;
  return envPrefix + buildClaudeCommand(model, task, autostart, mode);
}

/** Build the Claude Code launch command line for a worker. */
export function buildClaudeCommand(model: string, task: string, autostart: boolean, mode: PermMode): string {
  const parts = ["claude"];
  // Permission posture. Auto mode needs Opus 4.6+/Sonnet 4.6; on an unsupported
  // model Claude Code reports it unavailable and falls back to prompting.
  if (mode === "yolo") parts.push("--dangerously-skip-permissions");
  else if (mode === "auto") parts.push("--permission-mode", "auto");
  else parts.push("--permission-mode", "default"); // gated: force prompts even if user default is auto
  if (model) parts.push("--model", model);
  // Passing the prompt as a positional makes Claude auto-run it on boot.
  if (autostart && task) parts.push(shellSingleQuote(task));
  return parts.join(" ");
}

export function spawn(opts: SpawnOptions): Agent {
  const agentId = newAgentId();
  const label = opts.label || `agent-${agentId}`;

  // Optional isolation: run the worker in its own git worktree on a fresh
  // branch, so parallel writers on the same repo don't clobber each other. The
  // branch is left for review/merge; we never auto-merge.
  let worktree: Agent["worktree"];
  let workerCwd = opts.cwd;
  if (opts.worktree) {
    const repo = repoRoot(opts.cwd);
    if (!repo) {
      console.error(`warning: ${opts.cwd} is not a git repo — ignoring --worktree`);
    } else {
      const branch = opts.branch ?? `fleet/${branchSlug(label)}`;
      const path = join(homedir(), ".fleet", "worktrees", `${basename(repo)}-${branchSlug(label)}-${agentId.slice(0, 4)}`);
      addWorktree(repo, path, branch);
      worktree = { path, branch, base: currentBranch(repo), repo };
      workerCwd = path;
    }
  }

  // Launch a SHORT claude command (no task) so it reliably runs via cmux. A long
  // task baked into the launch line gets mangled by the shell's bracketed-paste
  // on boot; we send the task after the TUI is ready.
  const command = opts.launch
    ? (opts.command ?? buildWorkerLaunchCommand(agentId, opts.model, "", false, opts.mode))
    : undefined;

  // Placement: group with same-project workers as split panes in one workspace
  // (up to MAX_PANES_PER_WORKSPACE), else open a fresh workspace. --standalone
  // forces a fresh workspace and skips grouping.
  const group = opts.standalone ? undefined : findGroupWorkspace(projectKey(opts.cwd));

  let agent: Agent;
  let t: Target;

  if (group) {
    // Add a pane to the shared workspace by splitting a current surface. Balance
    // right-then-down like grid.ts (alternate by the current pane count).
    const rep = group[0]!;
    const wsId = rep.workspaceId ?? rep.workspace;
    const before = listGridCells(wsId);
    const beforeIds = new Set(before.map((c) => c.surfaceId));
    // Split from a TERMINAL pane: once --with-browser panes coexist in the
    // workspace, the last cell may be a browser surface — never split off that.
    const terminals = before.filter((c) => c.type === "terminal");
    const splitFrom = terminals[terminals.length - 1]?.surfaceId ?? rep.surfaceId ?? rep.surface;
    const dir = group.length % 2 === 1 ? "right" : "down";
    // Focus the new pane so its lazily-booted PTY comes up before we wait on it.
    newSplit(dir, { workspace: wsId, surface: splitFrom }, { focus: true });
    const cell = listGridCells(wsId).find((c) => !beforeIds.has(c.surfaceId));
    if (!cell) throw new Error(`split in ${wsId} did not produce a new pane`);

    t = { workspace: cell.workspaceId, surface: cell.surfaceId };
    agent = {
      agentId,
      label,
      workspace: rep.workspace, // shared workspace ref
      surface: cell.surfaceRef, // the new pane's surface
      workspaceId: cell.workspaceId,
      surfaceId: cell.surfaceId,
      cwd: workerCwd,
      model: opts.model,
      mode: opts.mode,
      task: opts.task,
      ownsWorkspace: false, // shared — kill closes just this pane while siblings remain
      worktree,
      status: "running",
      spawnedAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
    };
    upsert(agent);

    // The split pane boots lazily; wait for its terminal, then tear down just
    // this pane (not the shared workspace) if it never comes up.
    try {
      waitForTerminal(t);
    } catch (err) {
      try {
        closeSurface(t);
      } catch {
        // best-effort cleanup
      }
      remove(agentId);
      throw err;
    }

    // newSplit opens a bare shell (no --command), so launch the program by
    // typing it. cd into the worker's cwd first — the pane inherits the
    // workspace's cwd, which may differ (worktree, or another project subdir).
    if (command) {
      const launch = `cd ${shellSingleQuote(workerCwd)} && ${command}`;
      submit(t, launch);
      if (launch.length > 200) sendKey(t, "Enter"); // paste-collapse guard
    }
  } else {
    // Create a fresh workspace and let cmux launch the program in its terminal.
    const ws = newWorkspace({ name: label, cwd: workerCwd, command, focus: false });
    t = { workspace: ws.workspaceId, surface: ws.surfaceId };

    // Register immediately so the worker is tracked even if boot fails — a
    // created-but-unregistered workspace would be an untrackable orphan.
    agent = {
      agentId,
      label,
      workspace: ws.workspaceRef,
      surface: ws.surfaceRef,
      workspaceId: ws.workspaceId,
      surfaceId: ws.surfaceId,
      cwd: workerCwd,
      model: opts.model,
      mode: opts.mode,
      task: opts.task,
      // Only a --standalone worker owns its workspace exclusively. A groupable
      // first-in-project worker stays ownerless so when siblings later split in,
      // killing it closes just its pane (kill.ts's last-member rule then closes
      // the workspace once empty) — exactly the grid.ts model.
      ownsWorkspace: opts.standalone,
      worktree,
      status: "running",
      spawnedAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
    };
    upsert(agent);

    // Block until the terminal is live so callers can immediately read/steer it.
    // If it never boots, tear the workspace down rather than leak it.
    try {
      waitForTerminal(t);
    } catch (err) {
      try {
        closeWorkspace(ws.workspaceId);
      } catch {
        // best-effort cleanup
      }
      remove(agentId);
      throw err;
    }

    // Mission control: put the fresh worker workspace into the session's
    // sidebar group (grouped spawns above join a workspace already in it).
    // Best-effort + capability-gated — never blocks a spawn.
    ensureWorkerGrouped(sessionId(), ws.workspaceId);
  }

  // Stop condition (--done): record the check + loop bounds on the agent so the
  // daemon drives it on stable-idle (run check → pass attaches proof, fail
  // re-dispatches, exhausted escalates). loopCount starts at 0 (spawn is the
  // first attempt; --done bounds the RE-dispatches). One patch site, both
  // placement branches above already upserted the agent.
  if (opts.doneCheck) {
    agent.doneCheck = opts.doneCheck;
    agent.doneMaxLoops = opts.doneMaxLoops ?? 3;
    agent.doneLoopCount = 0;
    patch(agentId, { doneCheck: agent.doneCheck, doneMaxLoops: agent.doneMaxLoops, doneLoopCount: 0 });
  }

  // Companion browser pane (--with-browser). Opened AFTER the terminal surface
  // is captured and registered, so `target()` keeps resolving the WORKER
  // TERMINAL — the browser pane is recorded separately as browserSurfaceId and
  // is never a read/send target (see registry.ts). Best-effort: a worker
  // without its preview pane is still a working worker.
  if (opts.withBrowser) {
    const url = typeof opts.withBrowser === "string" ? opts.withBrowser : "about:blank";
    try {
      if (!browserSupported()) throw new Error("cmux build has no browser rail (capabilities: browser.*)");
      const b = browserOpen(url, t.workspace);
      agent.browserSurfaceId = b.surfaceId;
      patch(agentId, { browserSurfaceId: b.surfaceId });
    } catch (err) {
      console.error(`warning: --with-browser pane not opened for ${label}: ${(err as Error).message}`);
    }
  }

  // Wire output capture (P2b): take the first pipe-pane dump into
  // ~/.fleet/<session>/capture/<agentId>.log now that the pane is live, so the
  // capture file exists from spawn. Refreshed again at `fleet done` and digest
  // (cmux's pipe-pane is a one-shot dump, not a stream — see capture-log.ts).
  // Best-effort + capability-gated: failure never blocks a spawn. Targets the
  // TERMINAL surface explicitly, so the --with-browser pane never confuses it.
  refreshCapture(agent);

  // Clear the one-time bypass-permissions dialog so --yolo workers don't stall.
  if (opts.launch && opts.mode === "yolo") {
    acceptBypassDialog(t);
  }

  // Dispatch the task once the TUI is ready (guarded against paste-collapse).
  // Skipped for --no-autostart and the raw --command override.
  let dispatched = true;
  if (opts.launch && opts.autostart && opts.task && !opts.command) {
    const worktreeNote = worktree
      ? `(You are working in an isolated git worktree on branch ${worktree.branch}. Commit your changes to this branch when you finish so they can be reviewed and merged.)\n\n`
      : "";
    // Engage the proof-of-work gate: every worker is told, concretely, how to
    // attach proof when it finishes (B3 — the gate shipped but nothing invoked it).
    const task = `${opts.task}\n\n${worktreeNote}${proofInstruction(agentId)}`;
    if (waitForClaudeReady(t)) {
      // The ready→submit path is verified too: a paste-collapsed brief that
      // never leaves the input box was fail-open before (the live "autostart
      // silently dropped" failure — issue #30).
      const submit = submitToClaude(t, task);
      if (submit === "failed") {
        dispatched = false;
        agent.status = "undispatched";
        patch(agentId, { status: "undispatched" });
        console.error(
          `⚠ ${label} (${agentId}): the task brief never left the worker's input box — NOT submitted.\n` +
            `  Inspect with: fleet read ${agentId} — the brief may still be sitting in the box\n` +
            `  (submit it from the pane), or clear it and re-dispatch with: fleet send ${agentId} "<task>"`,
        );
      } else if (submit === "not-ready") {
        // TUI regressed off its prompt between the ready check and the submit —
        // brief NOT typed (issue #38). Record undispatched so the Captain knows.
        dispatched = false;
        agent.status = "undispatched";
        patch(agentId, { status: "undispatched" });
        console.error(
          `⚠ ${label} (${agentId}): Claude TUI was not ready at dispatch — the task brief was NOT submitted.\n` +
            `  Re-dispatch with: fleet send ${agentId} "<task>"`,
        );
      } else if (submit === "unverified") {
        console.error(
          `⚠ ${label} (${agentId}): could not verify the brief was submitted (screen unreadable) —\n` +
            `  confirm the worker is running with: fleet read ${agentId}`,
        );
      }
    } else {
      // Fail LOUDLY (S3): the worker is idling with no brief — recording it as
      // a normal running spawn would leave the Captain believing it's working.
      dispatched = false;
      agent.status = "undispatched";
      patch(agentId, { status: "undispatched" });
      console.error(
        `⚠ ${label} (${agentId}): Claude TUI never became ready — the task brief was NOT dispatched.\n` +
          `  The worker has no work. Re-dispatch with: fleet send ${agentId} "<task>"`,
      );
    }
  }

  // Trajectory store: record the delegation (Move 1). Best-effort. A failed
  // dispatch is recorded as such, not as a successful delegation.
  appendOutcome({
    event: "spawn",
    agentId: agent.agentId,
    label: agent.label,
    objective: opts.task,
    cwd: workerCwd,
    worktreeBranch: worktree?.branch,
    model: opts.model,
    mode: opts.mode,
    ...(dispatched ? {} : { status: "undispatched" }),
  });

  return agent;
}
