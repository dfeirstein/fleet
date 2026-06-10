// Pure logic for RPC steering (`fleet prompts` / `fleet reply`): normalize
// feed.list items into pending prompts, the 120s reply-window math, prompt
// selection (single / --prompt <id>), and answer-shape validation per prompt
// kind. No I/O, no clock, no cmux — unit-tested with node:test.
import type { FeedPromptItem, PermissionReplyMode, ExitPlanReplyMode } from "./cmux.js";

export type PromptKind = "permission" | "question" | "plan";

/** The Feed hook semaphore waits at most 120s for a reply; after that the item
 *  expires and the worker falls back to its in-TUI prompt (docs/feed.md,
 *  verified live: pending → expired at created_at + 120s exactly). */
export const REPLY_WINDOW_MS = 120_000;

const PROMPT_KINDS: Record<string, PromptKind> = {
  permission: "permission",
  permissionRequest: "permission",
  question: "question",
  plan: "plan",
  exitPlan: "plan",
  exit_plan: "plan",
};

export interface PromptOption {
  label: string;
  description?: string;
}

export interface PendingPrompt {
  requestId: string;
  kind: PromptKind;
  cwd?: string;
  createdAt?: string;
  /** The human-readable ask (question text / tool + input / plan title). */
  prompt: string;
  options: PromptOption[];
  multiSelect: boolean;
  /** >1 questions in one item — fleet reply refuses these (answer in the pane). */
  multiQuestion: boolean;
}

/** A pending, replyable prompt from a raw feed item — or undefined for
 *  telemetry / resolved / expired items and items missing a request_id. */
export function toPendingPrompt(item: FeedPromptItem): PendingPrompt | undefined {
  if (item.status !== "pending") return undefined;
  const kind = PROMPT_KINDS[item.kind ?? ""];
  if (!kind || !item.request_id) return undefined;
  const toolText = item.tool_name
    ? `${item.tool_name}${item.tool_input ? `: ${item.tool_input}` : ""}`
    : undefined;
  const prompt = (item.question_prompt ?? item.text ?? toolText ?? item.title ?? kind)
    .replace(/\s+/g, " ")
    .trim();
  return {
    requestId: item.request_id,
    kind,
    cwd: item.cwd,
    createdAt: item.created_at,
    prompt,
    options: (item.question_options ?? []).flatMap((o) =>
      o.label ? [{ label: o.label, description: o.description }] : [],
    ),
    multiSelect: item.question_multi_select === true,
    multiQuestion: (item.questions?.length ?? 0) > 1,
  };
}

/** Milliseconds left in the 120s reply window; <= 0 means the RPC path is gone
 *  (the prompt fell back to TUI-only — `fleet send`). Unparseable/missing
 *  created_at reads as expired (fail closed — don't promise a reply window). */
export function windowRemainingMs(createdAt: string | undefined, nowMs: number): number {
  if (!createdAt) return 0;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  return REPLY_WINDOW_MS - (nowMs - t);
}

/** Oldest-first (missing created_at sorts last — least likely still in window). */
export function oldestFirst(prompts: PendingPrompt[]): PendingPrompt[] {
  return [...prompts].sort((a, b) => (a.createdAt ?? "￿").localeCompare(b.createdAt ?? "￿"));
}

/**
 * Pick the prompt to answer. Exactly one pending → that one. Multiple pending
 * without --prompt → refuse (ambiguous; answering "the oldest" silently could
 * grant the wrong permission). --prompt matches a request_id exactly or by
 * unique prefix.
 */
export function selectPrompt(
  prompts: PendingPrompt[],
  promptId?: string,
): { prompt?: PendingPrompt; error?: string } {
  if (prompts.length === 0) return { error: "no pending prompts" };
  if (promptId) {
    const hits = prompts.filter((p) => p.requestId === promptId || p.requestId.startsWith(promptId));
    if (hits.length === 1) return { prompt: hits[0] };
    return {
      error:
        hits.length === 0
          ? `no pending prompt matching --prompt ${promptId}`
          : `--prompt ${promptId} matches ${hits.length} prompts — use more of the id`,
    };
  }
  if (prompts.length > 1) {
    return { error: `${prompts.length} prompts pending — disambiguate with --prompt <request-id>` };
  }
  return { prompt: prompts[0] };
}

/** A validated reply, ready for the matching cmux wrapper. */
export type ReplyAction =
  | { method: "feed.permission.reply"; mode: PermissionReplyMode }
  | { method: "feed.question.reply"; selections: string[] }
  | { method: "feed.exit_plan.reply"; mode: ExitPlanReplyMode };

const PERMISSION_ANSWERS: Record<string, PermissionReplyMode> = {
  allow: "once",
  yes: "once",
  once: "once",
  always: "always",
  all: "all",
  bypass: "bypass",
  deny: "deny",
  no: "deny",
};

const PLAN_ANSWERS: Record<string, ExitPlanReplyMode> = {
  approve: "manual", // conservative approve: allow the plan, keep edit approvals
  manual: "manual",
  auto: "autoAccept",
  ultraplan: "ultraplan",
  reject: "deny",
  deny: "deny",
};

/**
 * Validate an answer against the prompt's kind:
 *   permission → allow|deny|always|all|bypass (allow = Once);
 *   question   → an option index ("0", "1", …) or option text (label match
 *                preferred; otherwise the text passes through as-is);
 *   plan       → approve|reject|auto|manual|ultraplan.
 */
export function parseAnswer(prompt: PendingPrompt, answer: string): { action?: ReplyAction; error?: string } {
  const a = answer.trim();
  if (!a) return { error: "empty answer" };
  switch (prompt.kind) {
    case "permission": {
      const mode = PERMISSION_ANSWERS[a.toLowerCase()];
      if (!mode) return { error: `a permission prompt takes allow|deny|always|all|bypass (got "${answer}")` };
      return { action: { method: "feed.permission.reply", mode } };
    }
    case "question": {
      if (prompt.multiQuestion) {
        return { error: "multi-question prompt — answer it in the worker's pane (or `fleet send`)" };
      }
      if (/^\d+$/.test(a)) {
        const idx = Number(a);
        const opt = prompt.options[idx];
        if (!opt) {
          return { error: `option ${idx} out of range (prompt has options 0-${prompt.options.length - 1})` };
        }
        return { action: { method: "feed.question.reply", selections: [opt.label] } };
      }
      // Text answer: snap to a label when one matches (the RPC keys on labels);
      // otherwise pass the text through (free-form answer).
      const byLabel = prompt.options.find((o) => o.label.toLowerCase() === a.toLowerCase());
      return { action: { method: "feed.question.reply", selections: [byLabel?.label ?? a] } };
    }
    case "plan": {
      const mode = PLAN_ANSWERS[a.toLowerCase()];
      if (!mode) return { error: `a plan prompt takes approve|reject|auto|manual|ultraplan (got "${answer}")` };
      return { action: { method: "feed.exit_plan.reply", mode } };
    }
  }
}

/** The ready-to-run reply command a Captain can paste (daemon nudges, status). */
export function replyCommandHint(kind: PromptKind, agentRef: string): string {
  switch (kind) {
    case "permission":
      return `fleet reply ${agentRef} allow|deny`;
    case "question":
      return `fleet reply ${agentRef} <option #>`;
    case "plan":
      return `fleet reply ${agentRef} approve|reject`;
  }
}
