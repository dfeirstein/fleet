// `fleet spawn` — create a worker: open a cmux workspace, launch Claude Code in
// it (via cmux's --command, under the orchestrator's Max-plan session), and
// register it in the fleet.
import { randomBytes } from "node:crypto";
import { newWorkspace, waitForTerminal, closeWorkspace } from "../cmux.js";
import { upsert, remove, type Agent } from "../registry.js";

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
}

export const SPAWN_DEFAULTS = {
  model: "opus",
  mode: "auto" as PermMode, // autonomous + classifier-guarded; --yolo / --gated opt out
  launch: true,
  autostart: true,
};

/** Escape a string for safe inclusion inside single quotes in a POSIX shell. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function newAgentId(): string {
  return randomBytes(4).toString("hex");
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

  const command = opts.launch
    ? (opts.command ?? buildClaudeCommand(opts.model, opts.task, opts.autostart, opts.mode))
    : undefined;

  // Create the workspace and let cmux launch the program in its terminal.
  const ws = newWorkspace({ name: label, cwd: opts.cwd, command, focus: false });

  // Register immediately so the worker is tracked even if boot fails — a
  // created-but-unregistered workspace would be an untrackable orphan.
  const agent: Agent = {
    agentId,
    label,
    workspace: ws.workspaceRef,
    surface: ws.surfaceRef,
    workspaceId: ws.workspaceId,
    surfaceId: ws.surfaceId,
    cwd: opts.cwd,
    model: opts.model,
    mode: opts.mode,
    task: opts.task,
    ownsWorkspace: true,
    status: "running",
    spawnedAt: new Date().toISOString(),
  };
  upsert(agent);

  // Block until the terminal is live so callers can immediately read/steer it.
  // If it never boots, tear the workspace down rather than leak it.
  try {
    waitForTerminal(ws.workspaceId);
  } catch (err) {
    try {
      closeWorkspace(ws.workspaceId);
    } catch {
      // best-effort cleanup
    }
    remove(agentId);
    throw err;
  }

  return agent;
}
