// `fleet spawn` — create a worker: open a cmux workspace, launch Claude Code in
// it (via cmux's --command, under the orchestrator's Max-plan session), and
// register it in the fleet.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  newWorkspace,
  waitForTerminal,
  closeWorkspace,
  readScreen,
  submit,
  submitToClaude,
  type Target,
} from "../cmux.js";
import { upsert, remove, type Agent } from "../registry.js";
import { appendOutcome } from "../outcomes.js";
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
}

export const SPAWN_DEFAULTS = {
  model: "opus",
  mode: "auto" as PermMode, // autonomous + classifier-guarded; --yolo / --gated opt out
  launch: true,
  autostart: true,
  worktree: false,
};

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
/** Wait until the Claude Code TUI is up and idle at its prompt. */
export function waitForClaudeReady(target: Target, timeoutMs = 30000): boolean {
  const ready = /auto mode on|bypass permissions on|accept edits on|\? for shortcuts|esc to interrupt/i;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let screen = "";
    try {
      screen = readScreen(target, 30);
    } catch {
      /* not ready */
    }
    if (ready.test(screen)) return true;
    execFileSync("sleep", ["0.4"]);
  }
  return false;
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

  // Launch a SHORT claude command (no task) so it reliably runs via cmux
  // --command. A long task baked into the launch line gets mangled by the
  // shell's bracketed-paste on boot; we send the task after the TUI is ready.
  const command = opts.launch
    ? (opts.command ?? buildClaudeCommand(opts.model, "", false, opts.mode))
    : undefined;

  // Create the workspace and let cmux launch the program in its terminal.
  const ws = newWorkspace({ name: label, cwd: workerCwd, command, focus: false });

  // Register immediately so the worker is tracked even if boot fails — a
  // created-but-unregistered workspace would be an untrackable orphan.
  const agent: Agent = {
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
    ownsWorkspace: true,
    worktree,
    status: "running",
    spawnedAt: new Date().toISOString(),
    lastDispatchAt: new Date().toISOString(),
  };
  upsert(agent);

  // Block until the terminal is live so callers can immediately read/steer it.
  // If it never boots, tear the workspace down rather than leak it.
  try {
    waitForTerminal({ workspace: ws.workspaceId, surface: ws.surfaceId });
  } catch (err) {
    try {
      closeWorkspace(ws.workspaceId);
    } catch {
      // best-effort cleanup
    }
    remove(agentId);
    throw err;
  }

  const t: Target = { workspace: ws.workspaceId, surface: ws.surfaceId };

  // Clear the one-time bypass-permissions dialog so --yolo workers don't stall.
  if (opts.launch && opts.mode === "yolo") {
    acceptBypassDialog(t);
  }

  // Dispatch the task once the TUI is ready (guarded against paste-collapse).
  // Skipped for --no-autostart and the raw --command override.
  if (opts.launch && opts.autostart && opts.task && !opts.command) {
    const task = worktree
      ? `${opts.task}\n\n(You are working in an isolated git worktree on branch ${worktree.branch}. Commit your changes to this branch when you finish so they can be reviewed and merged.)`
      : opts.task;
    if (waitForClaudeReady(t)) submitToClaude(t, task);
  }

  // Trajectory store: record the delegation (Move 1). Best-effort.
  appendOutcome({
    event: "spawn",
    agentId: agent.agentId,
    label: agent.label,
    objective: opts.task,
    cwd: workerCwd,
    worktreeBranch: worktree?.branch,
    model: opts.model,
    mode: opts.mode,
  });

  return agent;
}
