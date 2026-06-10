// `fleet resume` — reconcile the registry against live cmux after an
// orchestrator restart. Refresh stale display refs from stable UUIDs, drop
// workers whose workspace is gone, and re-classify the survivors. Also the
// daemon's boot step.
//
// Restart-proofing: after a cmux restart every workspace UUID is gone, but
// cmux's durable session map (~/.cmuxterm/claude-hook-sessions.json) still
// holds each worker's claude session + sanitized launch argv. For a vanished
// worker with a restorable trace we print the exact `claude --resume`
// invocation (and respawn it in a fresh workspace with --apply) instead of
// silently pruning it; only workers with NO trace in either place are pruned.
import { existsSync } from "node:fs";
import { listAgents, getAgent, patch, remove, type Agent } from "../registry.js";
import { cmuxJson, newWorkspace } from "../cmux.js";
import { snapshot, type FleetRow } from "./status.js";
import {
  readHookSessions,
  findSession,
  resumeCommand,
  type DurableSessionMap,
} from "../cmux-sessions.js";

interface WorkspaceList {
  workspaces?: { id?: string; ref?: string }[];
}

/** Refresh each agent's workspace ref from its UUID (refs renumber over time). */
function refreshRefs(): void {
  let refByUuid = new Map<string, string>();
  try {
    const { workspaces } = cmuxJson<WorkspaceList>(["rpc", "workspace.list"]);
    for (const w of workspaces ?? []) {
      if (w.id && w.ref) refByUuid.set(w.id, w.ref);
    }
  } catch {
    return; // can't reach cmux; leave refs as-is
  }
  for (const a of listAgents()) {
    const ref = a.workspaceId ? refByUuid.get(a.workspaceId) : undefined;
    if (ref && ref !== a.workspace) patch(a.agentId, { workspace: ref });
  }
}

// ── The reconcile decision matrix (pure; node:test) ──────────────────────────

export interface ReconcileCandidate {
  agentId: string;
  label: string;
  /** Worker's cmux workspace still exists (the snapshot's dead check). */
  alive: boolean;
  surfaceId?: string;
  workspaceId?: string;
  /** cwd candidates to trace by, strongest first (worktree path, then cwd). */
  cwds: (string | undefined)[];
}

export type ReconcileDecision =
  | { agentId: string; label: string; action: "keep" }
  | {
      agentId: string;
      label: string;
      action: "resume";
      sessionId: string;
      command: string;
      cwd?: string;
      /** cmux's own restore flag — display caveat only. `claude --resume` works
       *  off the transcript regardless (verified live: an actively-RUNNING
       *  node-backed worker carries isRestorable:false on cmux 0.64.12, so
       *  gating on the flag would prune exactly the workers most worth
       *  resuming — the ones mid-run at crash time). */
      restorable: boolean;
    }
  | { agentId: string; label: string; action: "prune"; note: string }
  | { agentId: string; label: string; action: "skip"; note: string };

/**
 * Decide each registered agent's fate against the durable session map:
 *   registered + alive               → keep (today's behavior)
 *   registered + gone + traced       → resume (exact `claude --resume` argv)
 *   registered + gone + untraceable  → prune (no unambiguous trace anywhere)
 *   gone + trace COLLISION           → skip (see the post-pass below)
 *   gone + trace LIVE on a kept agent → skip (the session is already running)
 * Unregistered durable sessions are not fleet's — ignored entirely.
 */
export function planReconcile(
  candidates: ReconcileCandidate[],
  durable: DurableSessionMap | undefined,
): ReconcileDecision[] {
  const decisions: ReconcileDecision[] = candidates.map((c) => {
    if (c.alive) return { agentId: c.agentId, label: c.label, action: "keep" };
    const sess = durable
      ? findSession(durable, { surfaceId: c.surfaceId, workspaceId: c.workspaceId, cwds: c.cwds })
      : undefined;
    if (!sess) {
      return {
        agentId: c.agentId,
        label: c.label,
        action: "prune",
        // "unambiguous": findSession also returns nothing when MULTIPLE
        // sessions match a workspace/cwd lane — absent and ambiguous both
        // land here, so don't claim "no trace".
        note: "no live workspace and no unambiguous trace in cmux's durable session map",
      };
    }
    return {
      agentId: c.agentId,
      label: c.label,
      action: "resume",
      sessionId: sess.sessionId,
      command: resumeCommand(sess),
      cwd: sess.cwd,
      restorable: sess.isRestorable !== false,
    };
  });

  // Fail-closed post-pass: per-candidate matching can still collide ACROSS
  // agents — grid siblings share one workspaceId, and if a sibling's own
  // session never reached the durable map (undispatched, or its entry was
  // skipped as corrupt), the workspace lane sees exactly ONE session and hands
  // it to BOTH agents. A durable session belongs to exactly one pane, so a
  // duplicate assignment means at least one match is wrong; don't pick a
  // winner — demote every collider to skip.
  const claims = new Map<string, number>();
  for (const d of decisions) {
    if (d.action === "resume") claims.set(d.sessionId, (claims.get(d.sessionId) ?? 0) + 1);
  }
  // Alive agents claim too: `keep` decisions carry no sessionId, so a dead
  // sibling sharing a cwd can uniquely match a session that is in fact LIVE in
  // another pane and draw a resume offer for it (issue #23). Resolve each kept
  // agent's session from the durable map; unresolvable kept agents simply
  // contribute no claim. Keeps are never demoted — only colliding offers are.
  const liveClaims = new Map<string, string>(); // sessionId → live agent's id
  if (durable) {
    for (const c of candidates) {
      if (!c.alive) continue;
      const sess = findSession(durable, {
        surfaceId: c.surfaceId,
        workspaceId: c.workspaceId,
        cwds: c.cwds,
      });
      if (!sess) continue;
      // A cwd-lane fallthrough can mis-attribute a SIBLING's session to the
      // kept agent (the kept agent's own session never reached the map). If
      // the record names a surface/workspace and the kept agent's differs,
      // the attribution is contradicted — not evidence the session is live
      // on this agent, so it must not demote anyone else's resume.
      if (sess.surfaceId && c.surfaceId && sess.surfaceId !== c.surfaceId) continue;
      if (sess.workspaceId && c.workspaceId && sess.workspaceId !== c.workspaceId) continue;
      liveClaims.set(sess.sessionId, c.agentId);
    }
  }
  return decisions.map((d) => {
    if (d.action !== "resume") return d;
    // The live-collision message wins over the generic duplicate-claim one:
    // "already live on agent X" tells the user exactly where the session is.
    const liveAgent = liveClaims.get(d.sessionId);
    if (liveAgent) {
      return {
        agentId: d.agentId,
        label: d.label,
        action: "skip" as const,
        note: `durable session ${d.sessionId} is already live on agent ${liveAgent} — not resuming it elsewhere (fail closed)`,
      };
    }
    const n = claims.get(d.sessionId) ?? 0;
    if (n > 1) {
      return {
        agentId: d.agentId,
        label: d.label,
        action: "skip" as const,
        note: `durable session ${d.sessionId} matched ${n} registered agents — ambiguous, resuming none (fail closed)`,
      };
    }
    return d;
  });
}

function toCandidate(a: Agent, alive: boolean): ReconcileCandidate {
  return {
    agentId: a.agentId,
    label: a.label,
    alive,
    surfaceId: a.surfaceId,
    workspaceId: a.workspaceId,
    cwds: [a.worktree?.path, a.cwd],
  };
}

// ── The command ───────────────────────────────────────────────────────────────

export interface ResumeOffer {
  agentId: string;
  label: string;
  command: string;
  cwd: string;
  /** cmux's restore flag (display caveat only — see ReconcileDecision). */
  restorable: boolean;
  /** Set when --apply respawned it (the new workspace ref). */
  respawned?: string;
}

export interface ResumeResult {
  rows: FleetRow[];
  pruned: string[];
  offers: ResumeOffer[];
  /** Demoted resume collisions (fail closed): kept in the registry as dead,
   *  never offered/respawned — each with the warning to show the user. */
  skipped: { agentId: string; label: string; note: string }[];
}

/** Respawn a resumable worker: fresh workspace running its `claude --resume`,
 *  re-pointing the existing registry entry at the new pane. */
function applyResume(a: Agent, command: string, cwd: string): string {
  const ws = newWorkspace({ name: a.label, cwd, command, focus: false });
  patch(a.agentId, {
    workspace: ws.workspaceRef,
    surface: ws.surfaceRef,
    workspaceId: ws.workspaceId,
    surfaceId: ws.surfaceId,
    ownsWorkspace: true,
    status: "unknown", // the resumed TUI classifies on the next snapshot
  });
  return ws.workspaceRef;
}

export function resume(opts: { apply?: boolean } = {}): ResumeResult {
  refreshRefs();
  const durable = readHookSessions();
  const rows = snapshot(); // classifies; marks vanished workers "dead"
  const decisions = planReconcile(
    rows.map((r) => {
      const a = getAgent(r.agentId);
      return a
        ? toCandidate(a, r.status !== "dead")
        : { agentId: r.agentId, label: r.label, alive: r.status !== "dead", cwds: [] };
    }),
    durable,
  );

  const pruned: string[] = [];
  const offers: ResumeOffer[] = [];
  const skipped: ResumeResult["skipped"] = [];
  for (const d of decisions) {
    if (d.action === "keep") continue;
    if (d.action === "prune") {
      remove(d.agentId);
      pruned.push(`${d.label} (${d.note})`);
      continue;
    }
    if (d.action === "skip") {
      // Stays registered (dead) so a later resume can retry once the durable
      // map disambiguates (e.g. the missing sibling's session gets recorded).
      skipped.push({ agentId: d.agentId, label: d.label, note: d.note });
      continue;
    }
    const a = getAgent(d.agentId);
    if (!a) continue;
    // Resume where the session actually ran if that dir still exists (it is
    // usually the worktree); otherwise fall back to the registered cwd.
    const cwd = d.cwd && existsSync(d.cwd) ? d.cwd : a.cwd;
    const offer: ResumeOffer = {
      agentId: d.agentId,
      label: d.label,
      command: d.command,
      cwd,
      restorable: d.restorable,
    };
    if (opts.apply) {
      try {
        offer.respawned = applyResume(a, d.command, cwd);
      } catch (e) {
        offer.command = `${d.command}  # respawn failed: ${(e as Error).message}`;
      }
    }
    offers.push(offer);
  }
  // Keep the table and the offer lines in agreement: an offered worker shows in
  // the table as "resumable" (or "respawned" after --apply) instead of being
  // filtered out as dead. Display-only — the REGISTRY keeps the truth: still
  // `dead` until --apply respawns it (applyResume patches the live record).
  const offered = new Map(offers.map((o) => [o.agentId, o.respawned ? "respawned" : "resumable"]));
  const skippedIds = new Set(skipped.map((s) => s.agentId));
  const shown = rows
    .map((r) => {
      const display = offered.get(r.agentId);
      return display ? { ...r, status: display } : r;
    })
    // Skipped workers stay visible as dead — the table then agrees with the
    // skip warnings (a row that just vanished would contradict them).
    .filter((r) => r.status !== "dead" || skippedIds.has(r.agentId));
  return { rows: shown, pruned, offers, skipped };
}
