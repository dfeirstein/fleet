// `fleet status` — the Fleet Dashboard. Merges the registry with a live cmux
// read so the orchestrator sees real state, not just what it last recorded.
import { listAgents, patch, handle, target, type Agent, type AgentStatus } from "../registry.js";
import { workspaceExists, sidebarSnapshot, type WorkspaceSidebarInfo } from "../cmux.js";
import { probeStatus } from "../status.js";
import { listNotifications, indexNotifications, notificationFor, turnEnded, type CmuxNotification } from "../notifications.js";
import { pendingBlocks, type PendingBlock } from "../events.js";
import { realCwd } from "./prompts.js";
import { doneSignalFresh } from "../quiescence.js";

const ICON: Record<string, string> = {
  running: "●",
  idle: "◉",
  "awaiting-input": "◍",
  "blocked-on-you": "◍",
  "rate-limited": "⏳",
  undispatched: "⚠",
  error: "✗",
  dead: "☠",
  unknown: "◌",
};

export interface FleetRow {
  agentId: string;
  label: string;
  workspace: string;
  surface: string;
  model: string;
  status: string;
  task: string;
  /** Cheap proof flag for the done-without-proof diagnostic (no gate execution):
   *  "none" = idle with nothing attached; "claimed" = idle with proof(s). */
  proof?: "none" | "claimed";
  /** The pending Feed prompt kind behind a blocked-on-you row (question/
   *  permission/plan) — answerable via `fleet reply` while in the 120s window. */
  blockedKind?: string;
  /** When the worker was last given work — the stable-idle dwell (watch/daemon)
   *  refuses to declare quiescence while any dispatch is this fresh. */
  lastDispatchAt: string;
  /** Snapshot enrichment (cheap wins from the one-RPC sidebar snapshot):
   *  dev-server ports + PR URLs for the worker's workspace, where present. */
  ports?: string[];
  prUrls?: string[];
}

/** What the one-RPC sidebar snapshot pre-fetched for one worker. The snapshot
 *  is an OPTIMIZATION of how data is fetched, never a classification input:
 *  `exists` is `true` only when the snapshot positively lists the workspace —
 *  `undefined` (snapshot unavailable, worker has no UUID, or workspace simply
 *  absent: the RPC may be scoped to one window) means the caller must run the
 *  live existence check exactly as before. Never `false`. */
export interface SnapshotPrefetch {
  exists: true | undefined;
  ports: string[];
  prUrls: string[];
}

/** Pure snapshot→row mapping decision (the unit-tested core of the
 *  snapshot-first path). */
export function prefetchFromSnapshot(
  workspaceId: string | undefined,
  sidebar: Map<string, WorkspaceSidebarInfo> | undefined,
): SnapshotPrefetch {
  const ws = workspaceId ? sidebar?.get(workspaceId) : undefined;
  if (!ws) return { exists: undefined, ports: [], prUrls: [] };
  return { exists: true, ports: ws.listeningPorts, prUrls: ws.pullRequestUrls };
}

/**
 * Pure classification of one live worker (the unit-tested core of snapshot()).
 * Precedence: a screen rate-limit/error wins (no clean event exists); else a
 * feed-confirmed block → blocked-on-you; else a screen y/n dialog →
 * awaiting-input; else a LIVE SPINNER → running — the screen is direct evidence
 * the worker is mid-turn, so it beats any turn-end notification (which may be a
 * sibling pane's broadcast or a stale frame — B1) AND the done-signal (a worker
 * that called `fleet done` is still mid-turn until its screen settles); else a
 * current-turn done-signal → authoritatively idle (the deterministic fast path
 * — upgrades an ambiguous post-turn screen that inference would leave
 * "unknown"); else a fresh turn-end notification → idle; else whatever the
 * screen says. Workers that never call `fleet done` resolve via inference
 * exactly as before.
 */
export function classifyLive(input: {
  probe: AgentStatus;
  hasBlock: boolean;
  notif: CmuxNotification | undefined;
  lastDispatchAt: string;
  /** True when a gate-verified `fleet done` stamp belongs to the current turn
   *  (see doneSignalFresh in quiescence.ts). Intentionally NOT capability-gated
   *  (unlike the cmux signal emission in done.ts): the stamp is registry-only —
   *  zero cmux dependency — and safe on any build because it sits BELOW live
   *  screen evidence in the precedence, so it can only settle an ambiguous
   *  quiet screen, never contradict a visible one. */
  doneSignal?: boolean;
}): AgentStatus {
  const { probe, hasBlock, notif, lastDispatchAt, doneSignal } = input;
  if (probe === "rate-limited" || probe === "error") return probe;
  if (hasBlock) return "blocked-on-you";
  if (probe === "awaiting-input") return "awaiting-input";
  if (probe === "running") return "running";
  if (doneSignal) return "idle";
  if (turnEnded(notif, lastDispatchAt)) return "idle";
  return probe;
}

/** Reconcile + classify every agent. Updates the registry as a side effect.
 *  Completion is taken from cmux's notification feed when available (a
 *  deterministic "turn finished" signal), falling back to the screen heuristic. */
export function snapshot(): FleetRow[] {
  const rows: FleetRow[] = [];
  // Surface-keyed so a sibling pane's "Completed" can't be attributed here (B1).
  const notifs = indexNotifications(listNotifications());
  // The event-sourced blocked-on-you lane: feed pending question/permission/plan
  // items, attributed to a worker by cwd (the one-shot reconcile has no session
  // map). Empty/unsupported cmux → [] → the screen heuristic's awaiting-input
  // remains the fallback for the same lane (decision #2).
  const blocks = pendingBlocks();
  // Snapshot-first: ONE sidebar.snapshot call pre-fetches per-workspace data
  // (existence + ports/PR enrichment) for the whole fleet. Strictly a fetch
  // optimization — the classifier's inputs are unchanged: the snapshot has no
  // screen-equivalent data, so every live worker keeps its screen read, and a
  // workspace ABSENT from the snapshot falls back to the live existence check
  // (absence is never treated as death). Unsupported cmux → undefined → the
  // per-agent path below runs byte-identically to before.
  const sidebar = sidebarSnapshot();
  let existenceReads = 0;
  let screenReads = 0;
  for (const a of listAgents()) {
    const pre = prefetchFromSnapshot(a.workspaceId, sidebar);
    let status: string = a.status;
    const block = agentBlock(a, blocks);
    const exists = pre.exists ?? (existenceReads++, workspaceExists(handle(a)));
    if (!exists) {
      status = "dead";
    } else if (a.status === "undispatched") {
      // spawn never delivered the brief — the pane sits at an empty prompt the
      // probe would misread as idle. Sticky until a real dispatch (`fleet send`
      // patches status back to running).
      status = "undispatched";
    } else {
      screenReads++;
      status = classifyLive({
        probe: probeStatus(target(a)).status,
        hasBlock: !!block,
        notif: notificationFor(notifs, a.surfaceId, a.workspaceId ?? a.workspace),
        lastDispatchAt: a.lastDispatchAt,
        doneSignal: doneSignalFresh(a.doneSignalAt, a.lastDispatchAt),
      });
    }
    patch(a.agentId, { status: status as never, lastSeen: new Date().toISOString() });
    // Done-without-proof diagnostic: an idle worker that attached no proof hasn't
    // cleared the gate. Cheap (registry-only) — the gate that RUNS proofs lives
    // in `fleet done` / `fleet digest`, not on the status poll.
    const proof = status === "idle" ? ((a.proofs?.length ?? 0) > 0 ? "claimed" : "none") : undefined;
    rows.push({
      agentId: a.agentId,
      label: a.label,
      workspace: a.workspace,
      surface: a.surface,
      model: a.model,
      status,
      task: a.task,
      proof,
      blockedKind: status === "blocked-on-you" ? block?.kind : undefined,
      lastDispatchAt: a.lastDispatchAt,
      ports: pre.ports.length ? pre.ports : undefined,
      prUrls: pre.prUrls.length ? pre.prUrls : undefined,
    });
  }
  if (process.env.FLEET_DEBUG) {
    // Reads-per-beat telemetry (stderr — stdout stays parseable): before the
    // snapshot path this was existence=N screen=N; with it, existence drops to
    // the snapshot misses. Compare via FLEET_NO_SNAPSHOT=1.
    console.error(
      `[status] reads-per-beat: agents=${rows.length} snapshot=${sidebar ? 1 : 0} existence=${existenceReads} screen=${screenReads}`,
    );
  }
  return rows;
}

/** A pending feed block belongs to a worker if its cwd matches the worker's
 *  cwd or its worktree path (feed items carry the claude session's RESOLVED
 *  cwd, so compare symlink-proof — /tmp vs /private/tmp). */
function agentBlock(a: Agent, blocks: PendingBlock[]): PendingBlock | undefined {
  return blocks.find((b) => {
    const cwd = realCwd(b.cwd);
    return !!cwd && (cwd === realCwd(a.cwd) || cwd === realCwd(a.worktree?.path));
  });
}

export function renderTable(rows: FleetRow[]): string {
  if (rows.length === 0) return "No agents in the fleet. Spawn one with `fleet spawn`.";
  const lines = rows.map((r) => {
    const icon = ICON[r.status] ?? "◌";
    const id = r.agentId.padEnd(8);
    const label = r.label.padEnd(16).slice(0, 16);
    const ws = r.workspace.padEnd(12);
    const model = r.model.padEnd(7);
    const st = r.status.padEnd(14);
    const flag =
      r.status === "undispatched"
        ? "⚠ brief NOT dispatched — fleet send it "
        : r.blockedKind
          ? `◍ ${r.blockedKind} pending — fleet reply `
          : r.proof === "none"
            ? "⚠ done (no proof) "
            : "";
    const task = r.task.length > 50 ? r.task.slice(0, 47) + "..." : r.task;
    // Snapshot enrichment: dev-server ports + PR URLs, where the one-RPC
    // sidebar snapshot had them (absent on older cmux — column just omitted).
    const extras = [
      r.ports?.length ? `⇡${r.ports.join(",")}` : "",
      ...(r.prUrls ?? []),
    ].filter(Boolean);
    const extra = extras.length ? `  ${extras.join(" · ")}` : "";
    return `${icon} ${id} ${label} ${ws} ${model} ${st} ${flag}${task}${extra}`;
  });
  const active = rows.filter((r) => r.status === "running").length;
  const header = `  ${"id".padEnd(8)} ${"label".padEnd(16)} ${"workspace".padEnd(12)} ${"model".padEnd(7)} ${"status".padEnd(14)} task`;
  return [header, ...lines, "", `${rows.length} agents · ${active} active`].join("\n");
}
