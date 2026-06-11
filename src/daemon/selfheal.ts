// Daemon self-heal decision (issue #39). An in-pane Captain relaunch (Ctrl-C →
// `claude --resume`) changes the pane's surface UUID, so the orchestrator
// record's surfaceId goes stale and the shared daemon's surfaceExists filter
// silently drops a LIVE Captain ("watching 0 Captains" with no error).
//
// This is the PURE decision: given whether the record's own surface is still
// live, whether its workspace still exists, and the live candidate surfaces in
// that workspace (already filtered to exclude siblings' surfaces by the caller),
// decide whether to keep watching, re-stamp the record to a recovered surface,
// or treat it as unresolvable (escalate, then stop watching). All cmux/durable-
// map reads happen in the caller; this module is dependency-free and tested.
//
// Fail closed: an ambiguous match (more than one candidate) re-stamps NOTHING —
// a wrong re-stamp would point the daemon at a sibling's pane.

export interface SelfHealInputs {
  /** The record's current surface still exists (the happy path). */
  surfaceLive: boolean;
  /** The record's workspace still exists. A closed Captain's workspace is gone. */
  workspaceExists: boolean;
  /** Distinct live surfaces in the workspace NOT already owned by another Captain
   *  record — the re-match candidates. */
  candidateSurfaces: string[];
}

export type SelfHealDecision =
  | { action: "keep" }
  | { action: "rematch"; surfaceId: string }
  | { action: "unresolved"; reason: string };

/** Decide a Captain record's fate this beat. Pure — see SelfHealInputs. */
export function decideSelfHeal(i: SelfHealInputs): SelfHealDecision {
  if (i.surfaceLive) return { action: "keep" };
  if (!i.workspaceExists) return { action: "unresolved", reason: "workspace gone" };
  const candidates = [...new Set(i.candidateSurfaces.filter((s) => s))];
  if (candidates.length === 1) return { action: "rematch", surfaceId: candidates[0]! };
  if (candidates.length === 0) return { action: "unresolved", reason: "no live session in workspace" };
  return { action: "unresolved", reason: "ambiguous match" };
}
