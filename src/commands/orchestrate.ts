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
  workspaceExists,
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
import { ensureSharedDaemon } from "./daemon.js";

/** Max Captains per family — a 2×2 quadrant. */
const QUADRANT_CAP = 4;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orchestrator";
}

function fleetDir(): string {
  return join(homedir(), ".fleet");
}

/** The family a session belongs to: its name with any `-N` sibling suffix stripped. */
function familyOf(session: string): string {
  return session.replace(/-\d+$/, "");
}

/** The quadrant index of a session within its family: base is #1, `-N` siblings are N. */
function indexOf(session: string, family: string): number {
  if (session === family) return 1;
  const m = new RegExp(`^${family}-(\\d+)$`).exec(session);
  return m ? Number(m[1]) : 0;
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

export function orchestrate(name: string, opts: { daemon?: boolean; resume?: boolean } = {}): OrchestratorRecord {
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
  // --resume re-appoints an EXISTING Captain without losing her context: `claude
  // --continue` resumes the most recent conversation in this cwd (homedir) and
  // re-applies the (possibly updated) doctrine system prompt on top of it. Use it
  // to adopt new doctrine mid-life; the prior workspace should be closed after.
  const cont = opts.resume ? "--continue " : "";
  // Every Captain launches with Remote Control on, named for its session, so the
  // user can talk to any Captain (yoshi, yoshi-2, …) from the Claude mobile app.
  const command = `FLEET_SESSION=${session} claude --remote-control '${session}' ${cont}--append-system-prompt-file '${promptPath}'`;

  // When resuming, close the previous Captain workspace FIRST so its process
  // releases the conversation file — `claude --continue` must be the only process
  // on that session, or the shared history file can corrupt.
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
export function captainSplit(opts: { daemon?: boolean; command?: string; closeOrigin?: boolean } = {}): OrchestratorRecord {
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

  // Family = the calling session's base name (e.g. yoshi-3 → yoshi). Count the
  // family's LIVE Captains (records whose workspace still exists).
  const family = familyOf(orchestratorSession());
  const live = loadAllOrchestrators().filter(
    (o) => familyOf(o.session) === family && workspaceExists(o.workspaceId),
  );
  if (live.length >= QUADRANT_CAP) {
    throw new Error(`Quadrant full (${QUADRANT_CAP} Captains) — close one first.`);
  }

  // Next name = the lowest free slot (base is #1; siblings -2..-4).
  const taken = new Set(live.map((o) => indexOf(o.session, family)));
  let n = 1;
  while (taken.has(n)) n++;
  const newSession = n === 1 ? family : `${family}-${n}`;
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

  const beforeIds = new Set(cells.map((c) => c.surfaceId));
  // Focus the new pane so its lazily-booted PTY comes up before we wait on it.
  newSplit(dir, { workspace: ws, surface: fromSurface }, { focus: true });
  const cell = listGridCells(ws).find((c) => !beforeIds.has(c.surfaceId));
  if (!cell) throw new Error(`split in ${ws} did not produce a new pane`);

  const target = { workspace: cell.workspaceId, surface: cell.surfaceId };
  const workspaceRef = (() => {
    try {
      return listSurfaces(ws).workspace_ref;
    } catch {
      return ws;
    }
  })();

  // Write the record BEFORE launching so the daemon (bound to newSession) and the
  // launched Claude (whose registry derives from this record) both resolve it.
  const record: OrchestratorRecord = {
    name: newName,
    session: newSession,
    workspaceId: cell.workspaceId,
    surfaceId: cell.surfaceId,
    workspaceRef,
    declaredAt: new Date().toISOString(),
  };
  writeFileSync(orchestratorPath(newSession), JSON.stringify(record, null, 2));

  // The split pane boots lazily (bare shell, no --command) — wait for it, then
  // launch a FRESH Captain by typing the command. `--command` overrides the
  // program for testing (e.g. `sleep 600`) so the flow runs without real Claude.
  waitForTerminal(target);
  const promptPath = writePromptFile(newName, newSession);
  const command =
    opts.command ??
    `FLEET_SESSION=${newSession} claude --remote-control '${newSession}' --append-system-prompt-file '${promptPath}'`;
  submit(target, command);

  // Badge just this pane (siblings share the workspace, so don't badge the whole
  // workspace).
  badgeCaptain(ws, cell.surfaceId, newName);

  // Ensure the ONE shared daemon is running — a no-op if a sibling already
  // started it (single-instance lock), so `--split` never double-starts. The new
  // Captain is auto-discovered on the next tick.
  if (opts.daemon !== false) {
    try {
      ensureSharedDaemon();
    } catch (e) {
      console.error(`note: could not ensure shared daemon: ${(e as Error).message}`);
    }
  }

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
