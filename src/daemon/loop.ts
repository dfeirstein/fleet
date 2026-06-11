// The heartbeat loop (`fleet daemon run`). ONE shared daemon watches ALL live
// Captains: each tick it enumerates them and runs the existing per-Captain
// checks over the SET, routing each session's events to ITS orchestrator.
// Token-free: timers + cmux socket calls + our existing snapshot/notifications.
// Each beat per Captain: reconcile, classify, take bounded auto-actions,
// escalate anything that needs the orchestrator, refresh the sidebar.
import { createHash } from "node:crypto";
import {
  readScreen,
  surfaceExists,
  workspaceExists,
  closeWorkspace,
  streamEvents,
  eventsSupported,
  topSurfaceSamples,
  surfaceHealthEntries,
  surfaceHealthFailure,
  feedRepliesSupported,
  type SurfaceResourceSample,
  type Target,
  type EventStreamHandle,
} from "../cmux.js";
import { FleetEventReactor, eventsCursorFile, type EventFrame, type AckFrame } from "../events.js";
import { listAgents, patch, target, type Agent } from "../registry.js";
import { snapshot } from "../commands/status.js";
import { verify } from "../commands/verify.js";
import { send } from "../commands/send.js";
import { appendOutcome } from "../outcomes.js";
import {
  shouldRunDoneCheck,
  doneLoopOutcome,
  redispatchPrompt,
  exhaustedMessage,
  DONE_STARTUP_GRACE_MS,
} from "../done-loop.js";
import { pendingPromptsFor, type AgentPrompt } from "../commands/prompts.js";
import { windowRemainingMs, replyCommandHint } from "../feed-steering.js";
import { resume } from "../commands/resume.js";
import { acceptBypassDialog } from "../commands/spawn.js";
import { updateSidebar, setHeartbeat } from "../dashboard.js";
import { syncSidebar, sidebarTheme } from "../sidebar.js";
import {
  loadSharedSettings,
  writeSharedState,
  removeSharedState,
  acquireSharedLock,
  releaseSharedLock,
  type DaemonConfig,
  type SharedSettings,
} from "./config.js";
import { loadAllOrchestrators, writeOrchestrator, type OrchestratorRecord } from "../orchestrator-record.js";
import { readHookSessions, type DurableSessionMap } from "../cmux-sessions.js";
import { decideSelfHeal } from "./selfheal.js";
import { routeMessage } from "./channel.js";
import { newMemory, evaluate, evaluateResources, waveCompleteMessage, type DaemonMemory } from "./policy.js";

/** Every Captain whose surface (pane) is still live — the set the daemon watches.
 *  Surface-level, not workspace-level: quadrant siblings share one workspace, so a
 *  workspace check can't tell a closed sibling pane apart from its live neighbors. */
export function liveCaptains(): OrchestratorRecord[] {
  return loadAllOrchestrators().filter(
    (o) => o.workspaceId && o.surfaceId && surfaceExists({ workspace: o.workspaceId, surface: o.surfaceId }),
  );
}

/** Distinct LIVE surfaces in a workspace, from the durable session map, minus
 *  any surface already owned by another Captain record (`exclude`) — so a
 *  quadrant sibling's pane is never a re-match candidate. */
function liveCandidateSurfaces(
  map: DurableSessionMap | undefined,
  workspaceId: string,
  exclude: Set<string>,
): string[] {
  if (!map) return [];
  const out = new Set<string>();
  for (const s of map.sessions) {
    if (s.workspaceId !== workspaceId || !s.surfaceId) continue;
    if (exclude.has(s.surfaceId)) continue;
    if (surfaceExists({ workspace: workspaceId, surface: s.surfaceId })) out.add(s.surfaceId);
  }
  return [...out];
}

/** After ≥2 consecutive unresolvable beats a Captain gets ONE loud warning. */
const SELFHEAL_WARN_BEATS = 2;

/**
 * Self-heal pass over every Captain record (issue #39). Returns the set still
 * worth watching: surfaces that are live PLUS records re-matched to a recovered
 * surface after an in-pane relaunch changed the pane's UUID (the corrected
 * record is persisted so every reader self-corrects). A record that is neither
 * live nor re-matchable for ≥2 consecutive beats gets ONE warning via the
 * escalation channel before it drops out of the watch set — never silence.
 * `unresolved` carries the consecutive-beat count across beats (session-keyed).
 */
export function reconcileLiveCaptains(
  unresolved: Map<string, number>,
  settings: SharedSettings,
): OrchestratorRecord[] {
  const records = loadAllOrchestrators().filter((o) => o.workspaceId && o.surfaceId);
  const map = readHookSessions();
  const live: OrchestratorRecord[] = [];
  const seen = new Set<string>();

  for (const o of records) {
    seen.add(o.session);
    const surfaceLive = surfaceExists({ workspace: o.workspaceId, surface: o.surfaceId });
    const wsExists = surfaceLive || workspaceExists(o.workspaceId);
    // Surfaces other live-or-not records already claim in this workspace — never
    // re-stamp onto a sibling Captain's pane.
    const owned = new Set(
      records.filter((r) => r !== o && r.workspaceId === o.workspaceId).map((r) => r.surfaceId),
    );
    const candidateSurfaces =
      surfaceLive || !wsExists ? [] : liveCandidateSurfaces(map, o.workspaceId, owned);
    const decision = decideSelfHeal({ surfaceLive, workspaceExists: wsExists, candidateSurfaces });

    switch (decision.action) {
      case "keep":
        unresolved.delete(o.session);
        live.push(o);
        break;
      case "rematch": {
        unresolved.delete(o.session);
        const healed: OrchestratorRecord = { ...o, surfaceId: decision.surfaceId };
        try {
          writeOrchestrator(healed);
          console.log(
            `[daemon] self-heal: re-stamped ${o.name} surface ${o.surfaceId.slice(0, 8)} → ${decision.surfaceId.slice(0, 8)} (in-pane relaunch)`,
          );
        } catch (e) {
          console.error(`[daemon] self-heal write failed (${o.session}): ${(e as Error).message}`);
        }
        live.push(healed);
        break;
      }
      case "unresolved": {
        const n = (unresolved.get(o.session) ?? 0) + 1;
        unresolved.set(o.session, n);
        if (n === SELFHEAL_WARN_BEATS) {
          const text = `Captain ${o.name} surface ${o.surfaceId.slice(0, 8)} is gone and couldn't be re-matched (${decision.reason}) — supervision stopped. Re-declare with \`fleet captain\` or re-stamp its record.`;
          const delivery = routeMessage(configForCaptain(o, settings), text, true);
          console.log(`[daemon] ${delivery} (self-heal unresolved): ${text}`);
        }
        break; // not watched
      }
    }
  }

  // Forget counts for records that vanished entirely (a fresh warning re-arms).
  for (const s of [...unresolved.keys()]) if (!seen.has(s)) unresolved.delete(s);
  return live;
}

/** Build a per-Captain DaemonConfig from its record + the shared tunables. */
function configForCaptain(o: OrchestratorRecord, s: SharedSettings): DaemonConfig {
  return {
    orchestrator: { workspace: o.workspaceId, surface: o.surfaceId },
    session: o.session,
    heartbeatSec: s.heartbeatSec,
    stuckMinutes: s.stuckMinutes,
    alertCooldownSec: s.alertCooldownSec,
    proactive: s.proactive,
    cpuHogPercent: s.cpuHogPercent,
    cpuHogBeats: s.cpuHogBeats,
    memHogMb: s.memHogMb,
    sidebarColors: s.sidebarColors,
    sidebarLabels: s.sidebarLabels,
  };
}

// ── Resource telemetry sampling (capability-gated; shared across Captains) ──
// `cmux top --all` and `surface-health` describe GLOBAL state while beat() runs
// per Captain, so both are memoized: one top sweep per beat-burst, one health
// listing per workspace per HEALTH_TTL_MS. Unsupported/failed calls memoize as
// undefined — the guardrail no-ops and the beat is byte-identical to today.
const TOP_TTL_MS = 1_000;
const HEALTH_TTL_MS = 30_000;
let topMemo: { at: number; samples: Map<string, SurfaceResourceSample> | undefined } | undefined;
const healthMemo = new Map<string, { at: number; entries: ReturnType<typeof surfaceHealthEntries> }>();

function sampledTop(now: number): Map<string, SurfaceResourceSample> | undefined {
  if (!topMemo || now - topMemo.at >= TOP_TTL_MS) topMemo = { at: now, samples: topSurfaceSamples() };
  return topMemo.samples;
}

function sampledHealthFailure(a: { workspaceId?: string; surfaceId?: string }, now: number): string | undefined {
  if (!a.workspaceId || !a.surfaceId) return undefined;
  let memo = healthMemo.get(a.workspaceId);
  if (!memo || now - memo.at >= HEALTH_TTL_MS) {
    memo = { at: now, entries: surfaceHealthEntries(a.workspaceId) };
    healthMemo.set(a.workspaceId, memo);
  }
  return surfaceHealthFailure(memo.entries, a.surfaceId);
}

/** Run `fn` with FLEET_SESSION pinned to `session` so the registry/inbox the
 *  per-Captain checks read & route to are THIS Captain's, then restore. */
function withSession<T>(session: string, fn: () => T): T {
  const prev = process.env.FLEET_SESSION;
  process.env.FLEET_SESSION = session;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FLEET_SESSION;
    else process.env.FLEET_SESSION = prev;
  }
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function isBypassDialog(screen: string): boolean {
  return /Bypass Permissions mode/i.test(screen) && /Yes, I accept/i.test(screen);
}

/**
 * `fleet spawn --done` driver: on a worker's stable-idle, run its done-check
 * once per turn via the shared eval gate (`verify` — judge ≠ generator, runs in
 * the worker's dir and auto-attaches a proof on pass). On fail, re-dispatch the
 * SAME worker with the failure output (bounded by doneMaxLoops); on exhaustion,
 * escalate loudly and stop — never an infinite loop, never re-dispatching a
 * worker that isn't cleanly idle (shouldRunDoneCheck gates on status "idle", so
 * blocked-on-you/awaiting-input/error are excluded by construction).
 *
 * Runs INLINE on the beat: keep done-checks fast (the loop-engineering point is
 * a cheap external check), since a slow one blocks the shared daemon's beat.
 */
export function runDoneLoop(a: Agent, mem: DaemonMemory, cfg: DaemonConfig, now: number): void {
  if (!a.doneCheck) return;
  // Per-turn bookkeeping keyed by the dispatch we'd check. A new dispatch
  // (re-dispatch or `fleet send`) resets sawActive/checked → a fresh check.
  let st = mem.doneLoop[a.agentId];
  if (!st || st.dispatchAt !== a.lastDispatchAt) {
    st = { dispatchAt: a.lastDispatchAt, sawActive: false, checked: false };
    mem.doneLoop[a.agentId] = st;
  }
  if (a.status === "running" || a.status === "unknown" || a.status === "rate-limited") st.sawActive = true;

  const graceElapsed = now - Date.parse(a.lastDispatchAt) > DONE_STARTUP_GRACE_MS;
  if (
    !shouldRunDoneCheck({
      hasCheck: true,
      status: a.status,
      exhausted: a.doneLoopExhausted === true,
      sawActive: st.sawActive,
      graceElapsed,
      alreadyChecked: st.checked,
    })
  ) {
    return;
  }
  st.checked = true; // once per turn, even if the check itself errors

  // Run the stop-condition through the shared eval gate (verify): it executes
  // the check in the worker's worktree/cwd and, on pass, auto-attaches the proof
  // — the Captain's `fleet verify` habit, on the daemon's beat.
  const { pass, output } = verify(a.agentId, a.doneCheck);
  const loopCount = a.doneLoopCount ?? 0;
  const maxLoops = a.doneMaxLoops ?? 3;

  switch (doneLoopOutcome(pass, loopCount, maxLoops)) {
    case "pass":
      console.log(`[daemon] --done check passed for ${a.label} — proof attached`);
      return;
    case "redispatch": {
      const attempt = loopCount + 1;
      try {
        send(a.agentId, redispatchPrompt(a.doneCheck, output, attempt));
        patch(a.agentId, { doneLoopCount: attempt });
        console.log(`[daemon] --done check failed for ${a.label} — re-dispatched (${attempt}/${maxLoops})`);
      } catch (e) {
        // A send() throw is a transient steering hiccup (cmux/PTY), not a failed
        // WORK attempt: revert the per-turn check flag so the NEXT beat retries
        // the re-dispatch instead of stalling idle forever. Without this, checked
        // stays true with lastDispatchAt unadvanced → shouldRunDoneCheck never
        // fires again, and the done-no-proof nudge is suppressed for --done
        // workers, so BOTH safety nets go silent. It doesn't consume a --max
        // budget (doneLoopCount only bumps on a successful send), and the retry
        // is naturally bounded — an unreachable worker classifies dead/non-idle
        // and drops out of the idle gate.
        st.checked = false;
        console.error(`[daemon] --done re-dispatch failed for ${a.label} (retry next beat): ${(e as Error).message}`);
      }
      return;
    }
    case "exhausted": {
      // Loud, never silent, never auto-retried again (doneLoopExhausted gates it off).
      patch(a.agentId, { doneLoopExhausted: true });
      const text = exhaustedMessage(a.label, a.doneCheck, maxLoops, output);
      const delivery = routeMessage(cfg, text, true);
      console.log(`[daemon] ${delivery} (--done exhausted): ${text}`);
      appendOutcome({
        event: "verify",
        agentId: a.agentId,
        label: a.label,
        verdict: "fail",
        check: a.doneCheck,
        cwd: a.worktree?.path ?? a.cwd,
      });
      return;
    }
  }
}

function beat(cfg: DaemonConfig, mem: DaemonMemory): void {
  const rows = snapshot(); // reconcile + classify (marks dead)
  // Draw the dashboard + heartbeat on the ORCHESTRATOR's workspace (the daemon's
  // own CMUX_WORKSPACE_ID is the daemon pane, not where the user is watching).
  const orchWs = cfg.orchestrator.workspace;
  updateSidebar(rows, orchWs);
  setHeartbeat(rows, orchWs);

  const now = Date.now();
  const stuckThreshMs = cfg.stuckMinutes * 60_000;
  const cooldownMs = cfg.alertCooldownSec * 1000;
  const agents = listAgents();
  // One resource sweep for the whole beat (undefined on older cmux → guardrail off).
  const top = sampledTop(now);

  // RPC steering: pending Feed prompts (oldest first), so a blocked nudge can
  // carry the prompt summary + the exact `fleet reply` command. SURFACING only
  // — the daemon never auto-answers a prompt. Capability-gated + best-effort:
  // without the feed RPCs (or with cmux unreachable) nudges render as before.
  let prompts: AgentPrompt[] = [];
  if (feedRepliesSupported()) {
    try {
      prompts = pendingPromptsFor(agents);
    } catch {
      /* cmux unreachable this tick — nudge without prompt detail */
    }
  }

  // Mission control: sync each worker WORKSPACE's sidebar color + description
  // to its classified state (snapshot() above refreshed agent statuses).
  // On-change-only via the per-Captain paint fingerprints; capability-gated.
  mem.sidebarPaint = syncSidebar(agents, sidebarTheme({ colors: cfg.sidebarColors, labels: cfg.sidebarLabels }), mem.sidebarPaint);

  for (const a of agents) {
    if (a.status === "dead") continue;
    const t: Target = target(a);
    let screen = "";
    try {
      screen = readScreen(t, 40);
    } catch {
      // unreadable this tick — skip
    }

    // Bounded auto-action: clear a stuck --yolo bypass dialog instead of escalating.
    if (isBypassDialog(screen)) {
      try {
        acceptBypassDialog(t);
        console.log(`[daemon] auto-cleared bypass dialog for ${a.label}`);
      } catch {
        /* ignore */
      }
      continue;
    }

    // Stuck detection: track how long a running worker's screen is unchanged.
    const hash = sha1(screen);
    const prev = mem.screenSince[a.agentId];
    if (!prev || prev.hash !== hash) mem.screenSince[a.agentId] = { hash, since: now };
    const stuckMs = now - mem.screenSince[a.agentId]!.since;

    // `fleet spawn --done` loop: on stable-idle, run the stop-condition and
    // pass→attach-proof / fail→re-dispatch / exhausted→escalate. Owns the idle
    // of a --done worker, so the doneNoProof nudge below is suppressed for it.
    runDoneLoop(a, mem, cfg, now);

    // Feature 3 diagnostic: an idle worker that attached no proof is a
    // done-without-proof candidate. Cheap (registry only) — the runnable gate
    // stays in `fleet done`/`digest`, never on the daemon's timer. A --done
    // worker's idle is the loop's to grade (above), so it's excluded here.
    const doneNoProof = a.status === "idle" && (a.proofs?.length ?? 0) === 0 && !a.doneCheck;
    const myPrompts = prompts.filter((p) => p.agent.agentId === a.agentId);
    const oldest = myPrompts[0]?.prompt;
    const pendingPrompt = oldest
      ? {
          kind: oldest.kind,
          hint: oldest.prompt.length > 120 ? oldest.prompt.slice(0, 117) + "..." : oldest.prompt,
          secondsLeft: Math.max(0, Math.ceil(windowRemainingMs(oldest.createdAt, now) / 1000)),
          replyCmd: replyCommandHint(oldest.kind, a.agentId, oldest.requestId),
          morePending: myPrompts.length - 1,
        }
      : undefined;
    const msg = evaluate(
      { agentId: a.agentId, label: a.label, status: a.status, stuckMs, doneNoProof, pendingPrompt },
      mem,
      now,
      cooldownMs,
      stuckThreshMs,
    );
    if (msg) {
      const delivery = routeMessage(cfg, msg.text, msg.urgent);
      console.log(`[daemon] ${delivery}${msg.urgent ? " (urgent)" : ""}: ${msg.text}`);
    }

    // Resource guardrails: sustained CPU / RSS breach / surface-health failure
    // → Captain nudge, NEVER an auto-kill. Capability-gated end to end: on a
    // cmux without system.top / surface.health both inputs are undefined and
    // evaluateResources never fires.
    const rmsg = evaluateResources(
      a,
      a.surfaceId ? top?.get(a.surfaceId) : undefined,
      sampledHealthFailure(a, now),
      mem,
      now,
      cooldownMs,
      cfg,
    );
    if (rmsg) {
      const delivery = routeMessage(cfg, rmsg.text, rmsg.urgent);
      console.log(`[daemon] ${delivery} (guardrail): ${rmsg.text}`);
    }
  }

  // Forget tracking for agents that are gone.
  for (const id of Object.keys(mem.screenSince)) {
    if (!agents.find((a) => a.agentId === id)) delete mem.screenSince[id];
  }
  for (const id of Object.keys(mem.cpuHighBeats)) {
    if (!agents.find((a) => a.agentId === id)) delete mem.cpuHighBeats[id];
  }
  for (const id of Object.keys(mem.lastResourceAlert)) {
    if (!agents.find((a) => a.agentId === id)) delete mem.lastResourceAlert[id];
  }
  for (const id of Object.keys(mem.doneLoop)) {
    if (!agents.find((a) => a.agentId === id)) delete mem.doneLoop[id];
  }

  // Idle initiative: when a wave that was running settles into SUSTAINED
  // all-idle (stable-idle dwell, B2 — never a single beat: one misattributed
  // notification used to announce "wave complete" mid-task), fire ONE proactive
  // wake-prompt offering the next step. Re-arms when a new worker starts.
  const live = agents.filter((a) => a.status !== "dead");
  // "active" includes "unknown" (booting/indeterminate) so a wave isn't declared
  // complete while a worker is still starting up, and "rate-limited" (mid-task,
  // waiting out a limit — S4).
  const anyActive = live.some(
    (a) => a.status === "running" || a.status === "unknown" || a.status === "rate-limited",
  );
  if (anyActive) mem.waveActive = true;
  const quiesced = mem.idleDwell.beat(
    !anyActive && live.length > 0,
    live.map((a) => a.lastDispatchAt),
    now,
  );
  if (cfg.proactive && quiesced && mem.waveActive) {
    const text = waveCompleteMessage(live);
    const delivery = routeMessage(cfg, text, true); // urgent → inject when idle, else inbox
    console.log(`[daemon] ${delivery} (wave-complete): ${text}`);
    mem.waveActive = false;
  }

  console.log(`[daemon] beat · ${agents.length} agents · ${new Date().toISOString().slice(11, 19)}`);
}

export function runLoop(): void {
  // Single-instance guard: only the loop that wins the lock runs. A loser (e.g. a
  // racing `--split` spawned a second daemon workspace) closes its own pane and
  // exits, so we never double-watch the fleet.
  if (!acquireSharedLock()) {
    console.log("[daemon] another shared daemon already holds the lock — exiting");
    const myWs = process.env.CMUX_WORKSPACE_ID;
    if (myWs) {
      try {
        closeWorkspace(myWs);
      } catch {
        /* ignore — orphan pane is cosmetic */
      }
    }
    process.exit(0);
  }

  const settings = loadSharedSettings();
  const mems = new Map<string, DaemonMemory>(); // per-Captain memory (session-keyed)
  const resumed = new Set<string>(); // sessions already reconciled once
  const selfHealUnresolved = new Map<string, number>(); // session → consecutive unresolvable beats (#39)
  const startedAt = new Date().toISOString();
  const daemonWorkspace = process.env.CMUX_WORKSPACE_ID;
  let ticks = 0;
  let lastBeatMs = 0;
  let stopping = false;
  const MIN_BEAT_MS = 1500; // debounce bursts (an event + a tick firing together)

  function doBeat(): void {
    if (stopping) return;
    const now = Date.now();
    if (now - lastBeatMs < MIN_BEAT_MS) return;
    lastBeatMs = now;
    ticks++;

    const captains = reconcileLiveCaptains(selfHealUnresolved, settings);
    const liveSessions = new Set(captains.map((c) => c.session));
    for (const o of captains) {
      const cfg = configForCaptain(o, settings);
      let mem = mems.get(o.session);
      if (!mem) {
        mem = newMemory();
        mems.set(o.session, mem);
      }
      withSession(o.session, () => {
        // Reconcile the registry against live cmux once when a Captain is first
        // adopted (auto-discovered Captains get the same startup reconcile).
        if (!resumed.has(o.session)) {
          resumed.add(o.session);
          try {
            resume();
          } catch (e) {
            console.error(`[daemon] resume failed (${o.session}): ${(e as Error).message}`);
          }
        }
        try {
          beat(cfg, mem!);
        } catch (e) {
          console.error(`[daemon] beat error (${o.session}): ${(e as Error).message}`);
        }
      });
    }

    // Drop memory + resume-state for Captains that closed (workspace gone).
    for (const s of [...mems.keys()]) if (!liveSessions.has(s)) mems.delete(s);
    for (const s of [...resumed]) if (!liveSessions.has(s)) resumed.delete(s);

    writeSharedState({
      pid: process.pid,
      startedAt,
      lastBeatAt: new Date().toISOString(),
      ticks,
      daemonWorkspace,
      watching: [...liveSessions],
    });
    console.log(
      `[daemon] beat · ${captains.length} captains · ${new Date().toISOString().slice(11, 19)}`,
    );
  }

  console.log(`[daemon] boot · shared · watching all live Captains · event-driven + ${settings.heartbeatSec}s tick`);
  doBeat();

  // Fast path: drive a FleetEventReactor off cmux's full event stream. Any
  // interesting frame (agent activity, a feed pending block, a completion
  // notification) triggers a debounced doBeat() — so we react in ~1s instead of
  // waiting for the next tick. A durable cursor (~/.fleet/events.seq) resumes
  // exactly where a restart left off; an ack gap forces one full reconcile.
  // Capability-gated: an older cmux without events.stream falls back to the
  // periodic tick below (today's poll behavior), no regression.
  let events: EventStreamHandle | undefined;
  function startEventStream(): void {
    if (stopping) return;
    if (!eventsSupported()) {
      console.log("[daemon] events.stream unavailable — tick-driven polling only");
      return;
    }
    const reactor = new FleetEventReactor({
      onGap: () => {
        console.log("[daemon] event gap — full reconcile");
        doBeat();
      },
    });
    // Warm the cold session↔workspace map from cmux's durable hook-sessions
    // file, so feed attribution works before the first live agent.hook frame.
    const warmed = reactor.warmSessionMap();
    if (warmed) console.log(`[daemon] warmed session map from durable hook-sessions (${warmed} session(s))`);
    try {
      events = streamEvents({
        cursorFile: eventsCursorFile(),
        onAck: (a) => reactor.handleAck(a as AckFrame),
        onFrame: (f) => {
          if (reactor.handleFrame(f as EventFrame)) doBeat();
        },
        onExit: () => {
          events = undefined;
          if (!stopping) {
            console.error("[daemon] event stream dropped; reconnecting in 3s");
            setTimeout(startEventStream, 3000);
          }
        },
      });
    } catch (e) {
      console.error(`[daemon] could not start event stream: ${(e as Error).message}`);
    }
  }
  startEventStream();

  // Slow path: periodic tick for the sidebar pulse, stuck/zombie detection (the
  // absence of events), and a safety net.
  const timer = setInterval(doBeat, settings.heartbeatSec * 1000);

  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    try {
      events?.stop();
    } catch {
      /* ignore */
    }
    releaseSharedLock();
    removeSharedState();
    console.log("[daemon] stopped");
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // The interval + event stream keep the process alive.
}
