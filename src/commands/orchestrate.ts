// `fleet orchestrate [name]` / `fleet captain [name] [--split]` — declare a cmux
// workspace as A Fleet Captain (the control plane). A Captain is a ROLE pinned to
// a workspace, not a directory: it sits in its own workspace and delegates into
// any project.
//
// `--split` spawns a FRESH sibling Captain in a split pane of the CURRENT
// Captain's workspace, so you're not blocked when one Captain is busy. Up to 4
// Captains per family = a 2×2 quadrant; each is fully independent (own
// session/registry/daemon).
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  newWorkspace,
  newSplit,
  listSurfaces,
  listGridCells,
  closeWorkspace,
  closeSurface,
  surfaceExists,
  focusedWorkspace,
  waitForTerminal,
  submit,
  cmux,
} from "../cmux.js";
import {
  loadOrchestrator,
  loadAllOrchestrators,
  orchestratorPath,
  orchestratorSession,
  type OrchestratorRecord,
} from "../orchestrator-record.js";
import { readHookSessions, findSession } from "../cmux-sessions.js";
import {
  captainResumeArg,
  inPaneResumeRecipe,
  type CaptainListing,
} from "./captain-args.js";
import { chooseCaptainSlot } from "./captain-slot.js";
import { ensureSharedDaemon } from "./daemon.js";

/** Max Captains per family — a 2×2 quadrant. */
const QUADRANT_CAP = 4;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orchestrator";
}

function fleetDir(): string {
  return join(homedir(), ".fleet");
}

/** Compose the per-Captain doctrine system prompt and return its file path. */
function writePromptFile(name: string, session: string): string {
  const baseDoctrine = readFileSync(
    fileURLToPath(new URL("../../skills/fleet/orchestrator-doctrine.md", import.meta.url)),
    "utf8",
  );
  const promptPath = join(fleetDir(), `orchestrator-prompt-${session}.md`);
  writeFileSync(
    promptPath,
    `You are "${name}", the Fleet Captain — the orchestrator of this cmux fleet. ` +
      `Your fleet runs under session "${session}".\n\n${baseDoctrine}`,
  );
  return promptPath;
}

/** Every Captain on record whose pane is still live (surface-level — quadrant
 *  siblings share a workspace). Drives the no-name `--resume` listing (#36). */
export function liveCaptains(): CaptainListing[] {
  return loadAllOrchestrators()
    .filter((o) => surfaceExists({ workspace: o.workspaceId, surface: o.surfaceId }))
    .map((o) => ({ name: o.name, session: o.session }));
}

/** Resolve a Captain's Claude session id for `--resume`: the stamped record value
 *  first, else the durable map via the prior pane's surface (the unique lane —
 *  the cwd lane is ambiguous since Captains share $HOME). undefined → caller
 *  falls back to `--continue` with a warning. */
function resolveSessionId(prev: OrchestratorRecord): string | undefined {
  if (prev.sessionId) return prev.sessionId;
  const map = readHookSessions();
  if (!map) return undefined;
  const sess = findSession(map, { surfaceId: prev.surfaceId, workspaceId: prev.workspaceId });
  return sess?.sessionId;
}

/**
 * `fleet captain <name> --resume --print` (#36 bonus): the in-pane manual relaunch
 * command, WITHOUT touching cmux — for when the user Ctrl-Cs the Captain pane and
 * relaunches in place. Resolves the session id the same way `--resume` does, and
 * rewrites the prompt file so the recipe points at current doctrine.
 */
export function captainResumeRecipe(name: string): string {
  const session = slug(name);
  const prev = loadOrchestrator(session);
  if (!prev) {
    throw new Error(`no Captain "${name}" on record (fleet session "${session}") — nothing to resume`);
  }
  const promptPath = writePromptFile(name, session);
  return inPaneResumeRecipe({
    session,
    cwd: homedir(),
    sessionId: resolveSessionId(prev),
    promptPath,
  });
}

export function orchestrate(name: string, opts: { daemon?: boolean; resume?: boolean; model?: string } = {}): OrchestratorRecord {
  mkdirSync(fleetDir(), { recursive: true });
  const session = slug(name);

  // Per-session: note (and re-point) only if THIS session already has a Captain.
  const prev = loadOrchestrator(session);
  if (prev) {
    console.log(`note: re-pointing Captain "${prev.name}" (was in ${prev.workspaceRef}).`);
  }

  const promptPath = writePromptFile(name, session);

  // Launch the interactive Captain (a Claude session) in a new focused, badged
  // workspace. FLEET_SESSION pins the fleet to its own named registry, so its
  // workers are isolated from other sessions regardless of cwd.
  //
  // --resume re-appoints an EXISTING Captain without losing her context. Resolve
  // the recorded Claude session id and target it exactly (`claude --resume <id>`);
  // only when no id is resolvable fall back to `--continue` (most-recent-in-cwd),
  // which forked the live Captain's conversation in the #36 incident — so warn
  // loudly there. The (possibly updated) doctrine prompt re-applies on top either way.
  let resumeArg = "";
  let resolvedSessionId: string | undefined;
  if (opts.resume) {
    resolvedSessionId = prev ? resolveSessionId(prev) : undefined;
    const r = captainResumeArg(resolvedSessionId);
    resumeArg = r.arg;
    if (r.warning) console.warn(`⚠ ${r.warning}`);
  }
  // --model pins the Captain to a specific model (e.g. claude-opus-4-8); omitted → user default.
  const mdl = opts.model ? `--model '${opts.model}' ` : "";
  // Every Captain launches with Remote Control on, named for its session, so the
  // user can talk to any Captain (yoshi, yoshi-2, …) from the Claude mobile app.
  const command = `FLEET_SESSION=${session} claude --remote-control '${session}' ${mdl}${resumeArg}--append-system-prompt-file '${promptPath}'`;

  // Resuming a Captain that shares its workspace with live siblings (a quadrant):
  // resume IN-PLACE. Closing the whole workspace would nuke the siblings, and a
  // fresh workspace would pop the resumed Captain out of the quadrant. Instead,
  // close only the prev Captain's own pane (frees its conversation file) and split
  // a new pane in the SAME workspace off a live sibling.
  if (opts.resume && prev?.workspaceId && prev.surfaceId) {
    const siblings = loadAllOrchestrators().filter(
      (o) =>
        o.session !== session &&
        o.workspaceId === prev.workspaceId &&
        o.surfaceId !== prev.surfaceId &&
        surfaceExists({ workspace: o.workspaceId, surface: o.surfaceId }),
    );
    if (siblings.length > 0) {
      try {
        closeSurface({ workspace: prev.workspaceId, surface: prev.surfaceId });
      } catch {
        // already gone — fine
      }
      return launchInSplit(prev.workspaceId, "right", siblings[0]!.surfaceId, name, session, command, {
        daemon: opts.daemon,
        sessionId: resolvedSessionId,
      });
    }
  }

  // Solo resume (Captain owns its workspace): close the whole prior workspace FIRST
  // so its process releases the conversation file — `claude --continue` must be the
  // only process on that session, or the shared history file can corrupt.
  if (opts.resume && prev?.workspaceId) {
    try {
      closeWorkspace(prev.workspaceId);
    } catch {
      // already gone — fine
    }
  }

  const ws = newWorkspace({ name: `⚓ ${name}`, cwd: homedir(), command, focus: true });

  const record: OrchestratorRecord = {
    name,
    session,
    workspaceId: ws.workspaceId,
    surfaceId: ws.surfaceId,
    workspaceRef: ws.workspaceRef,
    declaredAt: new Date().toISOString(),
    // Stamped on a resume that resolved an id (so the next resume keeps it); a
    // fresh Captain's id is unknown at spawn — it lands in the durable map after
    // the session runs and is resolved on a later --resume.
    sessionId: resolvedSessionId,
  };
  writeFileSync(orchestratorPath(session), JSON.stringify(record, null, 2));

  // Badge the workspace so it's visibly the control plane in the sidebar.
  badgeCaptain(ws.workspaceId, undefined, name);

  // Ensure the ONE shared daemon is running — it watches ALL live Captains
  // (this one included, auto-discovered next tick) and routes each one's
  // escalations to its own orchestrator. No per-Captain daemon.
  if (opts.daemon !== false) {
    try {
      ensureSharedDaemon();
    } catch (e) {
      console.error(`note: could not ensure shared daemon: ${(e as Error).message}`);
    }
  }

  return record;
}

/**
 * `fleet captain --split` — spawn a FRESH sibling Captain in a split pane of the
 * CURRENT Captain's workspace. No inherited conversation, no initial task: just
 * an idle Captain ready for input. Refuses past a 4-Captain quadrant.
 */
export function captainSplit(opts: { daemon?: boolean; command?: string; closeOrigin?: boolean; model?: string } = {}): OrchestratorRecord {
  mkdirSync(fleetDir(), { recursive: true });

  // Target workspace: the calling pane's ($CMUX_WORKSPACE_ID) if run from inside
  // one, else the FOCUSED cmux workspace — so a global hotkey (run outside any
  // pane) still splits the workspace the user is looking at.
  const ws = process.env.CMUX_WORKSPACE_ID ?? focusedWorkspace()?.id;
  if (!ws) {
    throw new Error(
      "--split could not resolve a target workspace (no $CMUX_WORKSPACE_ID and no focused cmux workspace).",
    );
  }

  // Family + slot are a PURE decision (chooseCaptainSlot, tested without cmux).
  // Anchor the family on the records that OWN the target workspace `ws`, NOT on
  // env: the ⌘⇧Y hotkey runs in a runner tab with no FLEET_SESSION, so deriving
  // family from orchestratorSession() always returned DEFAULT_SESSION ("yoshi") —
  // mis-naming the sibling and (when the live-count under-counted the owner)
  // collapsing the slot to the bare family name and CLOBBERING the owner's record
  // with a clone. The hard uniqueness guard inside refuses any session whose record
  // is still live, so a clone is impossible even on a transient surfaceExists miss.
  // Liveness stays surface-level (siblings share a workspace): a closed pane frees
  // its slot.
  const { session: newSession } = chooseCaptainSlot({
    records: loadAllOrchestrators(),
    ws,
    fallbackSession: orchestratorSession(),
    isLive: (r) => surfaceExists({ workspace: r.workspaceId, surface: r.surfaceId }),
    cap: QUADRANT_CAP,
  });
  const newName = newSession;

  // Split the CURRENT workspace, tiling toward a 2×2 quadrant by pane count:
  //   1 pane → split right; 2 → split the left (first) pane down; 3 → split the
  //   right (second) pane down. cmux lists panes top-left → top-right → bottom,
  //   so the positional index is a stable proxy for left/right.
  const cells = listGridCells(ws);
  const count = cells.length;
  const dir: "right" | "down" = count <= 1 ? "right" : "down";
  const fromSurface =
    count <= 1
      ? cells[0]?.surfaceId ?? process.env.CMUX_SURFACE_ID
      : count === 2
        ? cells[0]!.surfaceId
        : cells[1]!.surfaceId;

  // The split pane boots lazily (bare shell, no --command) — `launchInSplit` waits
  // for it, then launches a FRESH Captain by typing the command. `--command`
  // overrides the program for testing (e.g. `sleep 600`) so the flow runs without
  // real Claude.
  const promptPath = writePromptFile(newName, newSession);
  const mdl = opts.model ? `--model '${opts.model}' ` : "";
  const command =
    opts.command ??
    `FLEET_SESSION=${newSession} claude --remote-control '${newSession}' ${mdl}--append-system-prompt-file '${promptPath}'`;
  const record = launchInSplit(ws, dir, fromSurface, newName, newSession, command, { daemon: opts.daemon });

  // Hotkey path: cmux opens a throwaway runner tab (`newTabInCurrentPane`) to run
  // this command, while the split above is the real new Captain pane. Close that
  // origin surface so the user is left with exactly the new pane — no leftover tab.
  // (Manual `fleet captain --split` from a real terminal omits --close-origin, so
  // it never closes the terminal the user is typing in.) Done last; this surface is
  // the one we're running in, so the process ends with the close.
  if (opts.closeOrigin && process.env.CMUX_SURFACE_ID) {
    try {
      closeSurface({ workspace: ws, surface: process.env.CMUX_SURFACE_ID });
    } catch {
      // best-effort — a leftover tab is cosmetic, never fail the spawn over it
    }
  }

  return record;
}

/**
 * Split a fresh pane in `workspace` off `fromSurface`, launch `command` in it as a
 * Captain named `name`/`session`, persist the record, badge the pane, and ensure the
 * shared daemon. Returns the new record. Shared by `captainSplit` (fresh sibling) and
 * the in-place `--resume` path — both tile a new Captain pane into an existing
 * workspace, so the split→resolve-new-cell→wait→submit→record→badge→daemon sequence
 * lives here once.
 */
function launchInSplit(
  workspace: string,
  dir: "left" | "right" | "up" | "down",
  fromSurface: string | undefined,
  name: string,
  session: string,
  command: string,
  opts: { daemon?: boolean; sessionId?: string } = {},
): OrchestratorRecord {
  const beforeIds = new Set(listGridCells(workspace).map((c) => c.surfaceId));
  // Focus the new pane so its lazily-booted PTY comes up before we wait on it.
  newSplit(dir, { workspace, surface: fromSurface }, { focus: true });
  const cell = listGridCells(workspace).find((c) => !beforeIds.has(c.surfaceId));
  if (!cell) throw new Error(`split in ${workspace} did not produce a new pane`);

  const target = { workspace: cell.workspaceId, surface: cell.surfaceId };
  const workspaceRef = (() => {
    try {
      return listSurfaces(workspace).workspace_ref;
    } catch {
      return workspace;
    }
  })();

  // Write the record BEFORE launching so the daemon (bound to session) and the
  // launched Claude (whose registry derives from this record) both resolve it.
  const record: OrchestratorRecord = {
    name,
    session,
    workspaceId: cell.workspaceId,
    surfaceId: cell.surfaceId,
    workspaceRef,
    declaredAt: new Date().toISOString(),
    sessionId: opts.sessionId,
  };
  writeFileSync(orchestratorPath(session), JSON.stringify(record, null, 2));

  // Wait for the lazily-booted PTY, then launch by typing the command.
  waitForTerminal(target);
  submit(target, command);

  // Badge just this pane (siblings share the workspace, so don't badge the whole
  // workspace).
  badgeCaptain(cell.workspaceId, cell.surfaceId, name);

  // Ensure the ONE shared daemon is running — a no-op if a sibling already started
  // it (single-instance lock). The new Captain is auto-discovered on the next tick.
  if (opts.daemon !== false) {
    try {
      ensureSharedDaemon();
    } catch (e) {
      console.error(`note: could not ensure shared daemon: ${(e as Error).message}`);
    }
  }

  return record;
}

/** Badge a Captain in the cmux sidebar (workspace-wide, or scoped to a pane). */
function badgeCaptain(workspace: string, surface: string | undefined, name: string): void {
  try {
    const args = [
      "set-status",
      "fleet:role",
      `⚓ FLEET CAPTAIN · ${name}`,
      "--workspace",
      workspace,
      "--color",
      "#a78bfa",
      "--priority",
      "200",
    ];
    if (surface) args.push("--surface", surface);
    cmux(args);
  } catch {
    // badge is decorative
  }
}
