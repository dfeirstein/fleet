// The Fleet event reactor — the push side of the event-driven Captain (F1).
//
// cmux's event stream (src/cmux.ts `streamEvents`) delivers a flat NDJSON feed of
// every fleet activity. This module turns that feed into per-worker live state:
//   - a PURE classifier (`frameToSignal`) maps one observation → a worker signal
//     (the unit-tested core), and
//   - a stateful `FleetEventReactor` that learns session↔workspace attribution,
//     enriches redacted notification/feed frames via RPC, tracks each worker's
//     live status, and fires a transition callback the daemon/watch react to.
//
// Two facts from the real stream shape the design (see the plan §1):
//   1. notification/feed EVENT payloads are redacted — a frame says "something
//      changed on workspace X"; the content must be pulled via notification.list
//      / feed.list. So the model is push-triggered PULL, not pure push.
//   2. feed items key on `workstream_id` (= claude `session_id`), NOT
//      `workspace_id`. We learn `session_id → workspace_id` from agent.hook
//      frames (which carry both) to attribute a feed/question item to a worker.
import { homedir } from "node:os";
import { join } from "node:path";
import { cmuxJson } from "./cmux.js";
import { listNotifications, latestByWorkspace, TURN_END, type CmuxNotification } from "./notifications.js";
import type { AgentStatus } from "./registry.js";

export type { CmuxNotification } from "./notifications.js";

/** Durable cursor for the shared daemon (resume exactly where it left off). */
export function eventsCursorFile(): string {
  return join(homedir(), ".fleet", "events.seq");
}

// ── Wire shapes (real captures, cmux 0.64.12 (92)) ──────────────────────────

/** A cmux event envelope (identical across categories; payload varies). */
export interface EventFrame {
  type?: string; // "event"
  category?: string; // agent | feed | notification | sidebar | workspace
  name?: string; // e.g. "agent.hook.PreToolUse", "feed.item.received"
  seq?: number;
  workspace_id?: string | null;
  surface_id?: string | null;
  source?: string;
  occurred_at?: string;
  payload?: Record<string, unknown>;
}

/** The subscription ack frame (first line unless --no-ack). */
export interface AckFrame {
  type?: string; // "ack"
  resume?: {
    after_seq?: number | null;
    gap?: boolean;
    gap_reason?: string;
    latest_seq?: number;
    next_seq?: number;
  };
}

/** A `feed.list` item (the blocked-on-you / stop source). */
export interface FeedItem {
  id?: string;
  kind?: string; // question | sessionStart | stop | toolResult | toolUse | userPrompt | permission | exitPlan
  status?: string; // telemetry | pending | expired
  source?: string;
  cwd?: string;
  workstream_id?: string; // = claude session_id ("claude-<uuid>")
  question_prompt?: string;
}

// ── Classification ──────────────────────────────────────────────────────────

export type BlockedKind = "question" | "permission" | "plan" | "waiting";

export interface Blocked {
  kind: BlockedKind;
  promptHint?: string;
}

/** A worker-state signal derived from one observation. */
export interface Signal {
  /** A status this observation implies (undefined = no state change). */
  status?: Extract<AgentStatus, "running" | "idle" | "blocked-on-you">;
  blocked?: Blocked;
  /** Reactor should skip this frame entirely (our own sidebar echoes / focus). */
  ignore?: boolean;
  /** A redacted event frame: pull this RPC and re-classify the enriched record. */
  enrich?: "notification" | "feed";
}

/** The three classifiable observations: an event frame, an enriched
 *  notification, or an enriched feed item. */
export type Observation =
  | { type: "event"; frame: EventFrame }
  | { type: "notification"; notif: CmuxNotification }
  | { type: "feed"; item: FeedItem };

// "Completed in <dir>" and "Waiting / waiting for your input" BOTH mean the turn
// ENDED → idle. Blocked-on-you is sourced from the FEED (a pending question/
// permission/plan), NOT the notification: Claude fires "Waiting" at every
// turn-end, not only when truly blocked, so the notification can't distinguish.
// The phrase list itself (TURN_END) is shared with src/notifications.ts.

const BLOCK_KINDS: Record<string, BlockedKind> = {
  question: "question",
  permission: "permission",
  permissionRequest: "permission", // the kind live 0.64.12 actually emits (probed 2026-06-10)
  plan: "plan",
  exitPlan: "plan",
  exit_plan: "plan",
};

/**
 * Pure classifier: one observation → a worker signal. The unit-tested core of
 * the reactor — no I/O, no clock, no cmux. (Redacted notification/feed event
 * frames resolve to `enrich`, which the reactor satisfies by pulling RPC and
 * re-classifying the enriched record back through here.)
 */
export function frameToSignal(obs: Observation): Signal {
  switch (obs.type) {
    case "event":
      return classifyEvent(obs.frame);
    case "notification":
      return classifyNotification(obs.notif);
    case "feed":
      return classifyFeed(obs.item);
  }
}

function classifyEvent(f: EventFrame): Signal {
  const cat = f.category ?? "";
  // Our own dashboard writes (sidebar) and focus changes (workspace) are not
  // worker state — reacting to sidebar echoes would self-trigger a loop.
  if (cat === "sidebar" || cat === "workspace") return { ignore: true };
  if (cat === "notification") return { enrich: "notification" };
  // Tool activity in the feed means the worker is running; a pending block is
  // only visible in the enriched feed.list, so pull it too (it may override).
  if (cat === "feed") return { status: "running", enrich: "feed" };
  if (cat === "agent") {
    const name = f.name ?? "";
    if (/PreToolUse|PostToolUse/.test(name)) return { status: "running" };
    if (/\bStop\b/.test(name)) return { status: "idle" }; // bonus accelerator (decision #5)
    if (/Notification/.test(name)) return { enrich: "notification" };
    return {};
  }
  return {};
}

function classifyNotification(n: CmuxNotification): Signal {
  const text = `${n.subtitle ?? ""} ${n.body ?? ""}`;
  if (TURN_END.test(text)) return { status: "idle" };
  return {};
}

function classifyFeed(item: FeedItem): Signal {
  const kind = item.kind ?? "";
  if (item.status === "pending") {
    const bk = BLOCK_KINDS[kind];
    if (bk) {
      const hint = (item.question_prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
      return { status: "blocked-on-you", blocked: { kind: bk, promptHint: hint } };
    }
  }
  if (kind === "stop") return { status: "idle" };
  if (kind === "toolUse" || kind === "toolResult") return { status: "running" };
  return {};
}

// ── Pending-block helpers (used by the poll-fallback reconcile in status.ts) ──

/** Read raw `feed.list` items (best-effort; never throws). */
export function listFeedItems(): FeedItem[] {
  try {
    return cmuxJson<{ items?: FeedItem[] }>(["rpc", "feed.list"]).items ?? [];
  } catch {
    return [];
  }
}

export interface PendingBlock {
  kind: BlockedKind;
  cwd?: string;
  workstreamId?: string;
  promptHint?: string;
}

/** Every blocked-on-you feed item (pending question/permission/plan). The poll
 *  path attributes these to a worker by `cwd`; the reactor by the session map. */
export function pendingBlocks(items?: FeedItem[]): PendingBlock[] {
  const list = items ?? listFeedItems();
  const out: PendingBlock[] = [];
  for (const item of list) {
    if (item.status !== "pending") continue;
    const sig = frameToSignal({ type: "feed", item });
    if (sig.status === "blocked-on-you" && sig.blocked) {
      out.push({
        kind: sig.blocked.kind,
        cwd: item.cwd,
        workstreamId: item.workstream_id,
        promptHint: sig.blocked.promptHint,
      });
    }
  }
  return out;
}

// ── The reactor ──────────────────────────────────────────────────────────────

export interface WorkerLiveState {
  workspaceId: string;
  status: Extract<AgentStatus, "running" | "idle" | "blocked-on-you">;
  blocked?: Blocked;
  lastFrameSeq?: number;
  lastChange: number;
}

/** Injectable I/O so the reactor's enrich path is unit-testable without cmux. */
export interface ReactorDeps {
  listNotifications: () => CmuxNotification[];
  listFeedItems: () => FeedItem[];
}

export interface ReactorOptions {
  /** Fired when a worker's tracked status (or block kind) changes. */
  onTransition?: (workspaceId: string, prev: AgentStatus | undefined, next: WorkerLiveState) => void;
  /** Fired when an ack reports a gap (cursor older than the retained log) —
   *  the consumer does ONE full reconcile, then resumes streaming. */
  onGap?: () => void;
  deps?: Partial<ReactorDeps>;
}

/**
 * Maintains per-worker live state from the cmux event stream. Holds a
 * `Map<workspaceId, WorkerLiveState>` plus a `Map<sessionId, workspaceId>`
 * learned from agent.hook frames (so feed items keyed on `workstream_id` can be
 * attributed to a fleet worker). Pure classification is delegated to
 * `frameToSignal`; this class owns attribution, enrichment, and transitions.
 */
export class FleetEventReactor {
  private states = new Map<string, WorkerLiveState>();
  private sessionToWorkspace = new Map<string, string>();
  private readonly deps: ReactorDeps;

  constructor(private readonly opts: ReactorOptions = {}) {
    this.deps = {
      listNotifications: opts.deps?.listNotifications ?? listNotifications,
      listFeedItems: opts.deps?.listFeedItems ?? listFeedItems,
    };
  }

  /** Handle one ack frame. Returns true if a gap reconcile was requested. */
  handleAck(ack: AckFrame): boolean {
    if (ack?.resume?.gap) {
      this.opts.onGap?.();
      return true;
    }
    return false;
  }

  /**
   * Handle one event frame. Returns true if the frame was "interesting" (worth
   * a re-evaluation by the consumer) — i.e. not an ignored sidebar/focus echo.
   */
  handleFrame(frame: EventFrame): boolean {
    if (!frame || frame.type !== "event") return false;
    this.learnSession(frame);

    const sig = frameToSignal({ type: "event", frame });
    if (sig.ignore) return false;

    let interesting = false;
    if (sig.status) {
      this.apply(frame.workspace_id ?? undefined, sig.status, sig.blocked, frame.seq);
      interesting = true;
    }
    if (sig.enrich === "notification") {
      this.enrichNotifications(frame.workspace_id ?? undefined);
      interesting = true;
    }
    if (sig.enrich === "feed") {
      this.enrichFeed(frame.workspace_id ?? undefined);
      interesting = true;
    }
    return interesting;
  }

  getState(workspaceId: string): WorkerLiveState | undefined {
    return this.states.get(workspaceId);
  }

  allStates(): WorkerLiveState[] {
    return [...this.states.values()];
  }

  /** The workspace a claude session maps to (learned from agent.hook frames). */
  sessionWorkspace(sessionId: string): string | undefined {
    return this.sessionToWorkspace.get(sessionId);
  }

  /** Drop a worker's tracked state (e.g. when it dies / is killed). */
  forget(workspaceId: string): void {
    this.states.delete(workspaceId);
  }

  private learnSession(frame: EventFrame): void {
    if (frame.category !== "agent") return;
    const sid = frame.payload?.["session_id"];
    const ws = frame.workspace_id;
    if (typeof sid === "string" && typeof ws === "string") {
      this.sessionToWorkspace.set(sid, ws);
    }
  }

  private enrichNotifications(target?: string): void {
    // ⚠ WORKSPACE-keyed attribution — this re-imports bug B1 for any consumer
    // of reactor STATE: same-project workers share one workspace as split
    // panes, so one sibling's "Completed" marks every sibling idle here.
    // Today that's harmless because daemon/watch use the reactor only as a
    // reconcile TRIGGER (snapshot() re-classifies with surface-keyed
    // attribution + probe precedence). If you ever read getState()/allStates()
    // as truth, switch this to surface-keyed attribution first (see
    // indexNotifications/notificationFor in src/notifications.ts).
    const latest = latestByWorkspace(this.deps.listNotifications());
    const workspaces = target ? [target] : [...latest.keys()];
    for (const ws of workspaces) {
      const n = latest.get(ws);
      if (!n) continue;
      const sig = frameToSignal({ type: "notification", notif: n });
      if (sig.status) this.apply(ws, sig.status, sig.blocked);
    }
  }

  private enrichFeed(target?: string): void {
    for (const block of pendingBlocks(this.deps.listFeedItems())) {
      const ws = block.workstreamId ? this.sessionToWorkspace.get(block.workstreamId) : undefined;
      const workspaceId = ws ?? target;
      if (!workspaceId) continue; // can't attribute yet — next reconcile / agent frame
      this.apply(workspaceId, "blocked-on-you", { kind: block.kind, promptHint: block.promptHint });
    }
  }

  private apply(
    workspaceId: string | undefined,
    status: Extract<AgentStatus, "running" | "idle" | "blocked-on-you">,
    blocked: Blocked | undefined,
    seq?: number,
  ): void {
    if (!workspaceId) return;
    const prev = this.states.get(workspaceId);
    const changed = !prev || prev.status !== status || prev.blocked?.kind !== blocked?.kind;
    const next: WorkerLiveState = {
      workspaceId,
      status,
      blocked,
      lastFrameSeq: seq ?? prev?.lastFrameSeq,
      lastChange: changed ? Date.now() : prev?.lastChange ?? Date.now(),
    };
    this.states.set(workspaceId, next);
    if (changed) this.opts.onTransition?.(workspaceId, prev?.status, next);
  }
}
