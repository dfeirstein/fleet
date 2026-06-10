// `fleet prompts [agent]` — list pending Feed prompts (permission / question /
// plan-approval) across the fleet, with the text/options and how much of the
// 120s RPC reply window is left. The listing half of RPC steering; `fleet
// reply` answers them. Content comes from the `feed.list` RPC (event-stream
// payloads are redacted — see .claude-docs/event-stream.md); items are
// attributed to workers by cwd, like the status blocked-on-you lane.
import { realpathSync } from "node:fs";
import { feedRepliesSupported, feedList } from "../cmux.js";
import { listAgents, resolveAgent, type Agent } from "../registry.js";
import {
  toPendingPrompt,
  oldestFirst,
  windowRemainingMs,
  replyCommandHint,
  type PendingPrompt,
} from "../feed-steering.js";

export interface AgentPrompt {
  agent: Agent;
  prompt: PendingPrompt;
}

export function assertFeedRepliesSupported(): void {
  if (!feedRepliesSupported()) {
    throw new Error(
      "feed reply RPCs not supported by this cmux — answer prompts in the worker's pane or via `fleet send`",
    );
  }
}

/** Symlink-proof path identity: feed items report the RESOLVED cwd (e.g.
 *  /private/tmp/x for a worker spawned in /tmp/x), so raw string compare
 *  against the registry cwd misses. Best-effort — a vanished path compares raw. */
export function realCwd(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Pending prompts attributed to the given agents (oldest first). */
export function pendingPromptsFor(agents: Agent[]): AgentPrompt[] {
  const prompts = oldestFirst(feedList().flatMap((i) => toPendingPrompt(i) ?? []));
  const out: AgentPrompt[] = [];
  for (const p of prompts) {
    const cwd = realCwd(p.cwd);
    const agent = agents.find(
      (a) => !!cwd && (cwd === realCwd(a.cwd) || cwd === realCwd(a.worktree?.path)),
    );
    if (agent) out.push({ agent, prompt: p });
  }
  return out;
}

export function renderPrompts(rows: AgentPrompt[], nowMs: number): string {
  if (rows.length === 0) return "No pending prompts — nothing is blocked on a Feed reply.";
  const lines: string[] = [];
  for (const { agent, prompt } of rows) {
    const left = windowRemainingMs(prompt.createdAt, nowMs);
    const window =
      left > 0
        ? `${Math.ceil(left / 1000)}s left in the reply window`
        : "window CLOSED — TUI-only, use `fleet send`";
    lines.push(`◍ ${agent.agentId}  ${agent.label}  ${prompt.kind}  (${window})`);
    lines.push(`   ${prompt.prompt.length > 200 ? prompt.prompt.slice(0, 197) + "..." : prompt.prompt}`);
    prompt.options.forEach((o, i) => lines.push(`     [${i}] ${o.label}`));
    lines.push(`   answer: ${replyCommandHint(prompt.kind, agent.agentId)}   (prompt id ${prompt.requestId})`);
  }
  lines.push("", `${rows.length} pending prompt(s)`);
  return lines.join("\n");
}

/** The command: list pending prompts for the fleet (or one agent). */
export function prompts(idOrLabel?: string): string {
  assertFeedRepliesSupported();
  let agents = listAgents();
  if (idOrLabel) {
    const agent = resolveAgent(idOrLabel);
    if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
    agents = [agent];
  }
  return renderPrompts(pendingPromptsFor(agents), Date.now());
}
