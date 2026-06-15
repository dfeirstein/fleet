// Pure slot/family decision for `fleet captain --split` — which family a fresh
// sibling Captain joins and which session name it takes. Extracted from
// orchestrate.ts so the two safety rules are unit-testable without cmux (repo
// convention: captain-args.ts + its node:test).
//
// The bugs this guards against (the ⌘⇧Y hotkey runs `fleet captain --split` in a
// cmux runner tab with NO FLEET_SESSION):
//   1. Wrong family — deriving family from `orchestratorSession()` returns
//      DEFAULT_SESSION ("yoshi") regardless of which Captain owns the workspace
//      being split, so a mario Captain's split was named yoshi/yoshi-2. Anchor the
//      family on the records that OWN the target workspace `ws` instead (quadrant
//      siblings share one workspace, so they define the family).
//   2. Clone / record clobber — when the live-sibling count under-counts the real
//      owner (wrong family, or a transient surfaceExists miss), the slot pick
//      collapses to the bare family name and clobbers the live owner's record (an
//      exact clone; the shared daemon then sees one record for two panes). A hard
//      uniqueness guard re-probes liveness for the chosen session and refuses any
//      name whose record is still live, bumping the slot until free — so a clone is
//      impossible even on a flaky probe.

/** The family a session belongs to: its name with any `-N` sibling suffix stripped. */
export function familyOf(session: string): string {
  return session.replace(/-\d+$/, "");
}

/**
 * Re-point STALE-but-recoverable Captain records to their live workspace cell
 * before the slot decision — the missing sibling of PR #59's guard. chooseCaptainSlot
 * decides liveness via `isLive(record.surfaceId)`, but a Captain relaunched in-pane
 * (or hit by durable-map lag) carries a stale `surfaceId`, so a LIVE Captain reads
 * as not-live: the slot collapses to the bare family name and `--split` clobbers its
 * record with a clone. Reconciling first makes `isLive` accurate so the uniqueness
 * guard can do its job.
 *
 * Mirrors `decideSelfHeal`'s fail-closed rule exactly: a record whose own surface is
 * dead but whose workspace has EXACTLY ONE live cell not already owned by another
 * live-surfaced record is re-stamped to that cell; zero or ambiguous (>1) candidates
 * leave the record untouched (don't guess — the slot logic then treats it as not-live,
 * correct when the Captain is genuinely gone, and the daemon self-heal escalates).
 *
 * Pure — cmux liveness + cell listing are injected. Returns the SAME records in order
 * (never reorders/drops); only a recovered `surfaceId` is rewritten. Callers persist
 * any re-stamp via `writeOrchestrator` so the on-disk record self-corrects too.
 */
export function reconcileStaleRecords(input: {
  records: CaptainSlotRecord[];
  liveCells: (workspaceId: string) => string[];
  isLive: (r: { workspaceId: string; surfaceId: string }) => boolean;
}): CaptainSlotRecord[] {
  const { records, liveCells, isLive } = input;
  return records.map((r) => {
    if (isLive(r)) return r; // surface already live → unchanged (the happy path).
    // Live cells in r's workspace NOT already claimed by another LIVE-surfaced record
    // (never re-stamp onto a sibling Captain's pane).
    const claimed = new Set(
      records.filter((o) => o !== r && o.workspaceId === r.workspaceId && isLive(o)).map((o) => o.surfaceId),
    );
    const candidates = [...new Set(liveCells(r.workspaceId).filter((s) => s && !claimed.has(s)))];
    if (candidates.length === 1) return { ...r, surfaceId: candidates[0]! };
    return r; // zero or ambiguous → fail closed.
  });
}

/** The quadrant index of a session within its family: base is #1, `-N` siblings are N. */
export function indexOf(session: string, family: string): number {
  if (session === family) return 1;
  const m = new RegExp(`^${family}-(\\d+)$`).exec(session);
  return m ? Number(m[1]) : 0;
}

/** The fields chooseCaptainSlot needs from an orchestrator record. */
export interface CaptainSlotRecord {
  session: string;
  workspaceId: string;
  surfaceId: string;
}

/**
 * Decide the family + session name for a fresh `--split` sibling. Pure — cmux
 * liveness is injected via `isLive`. Throws when the quadrant is full.
 *
 * - family: anchored on the Captain(s) whose record owns the target workspace
 *   `ws`; falls back to `fallbackSession`'s family only when NO record owns `ws`.
 * - session: the lowest free slot among the family's LIVE siblings (surface-level
 *   liveness — a closed pane frees its slot), then a hard uniqueness guard
 *   re-probes and refuses any session whose record is still live, so an
 *   under-counted live set can never clobber a live Captain's record.
 */
export function chooseCaptainSlot(input: {
  records: CaptainSlotRecord[];
  ws: string;
  fallbackSession: string;
  isLive: (r: { workspaceId: string; surfaceId: string }) => boolean;
  cap: number;
}): { family: string; session: string } {
  const { records, ws, fallbackSession, isLive, cap } = input;

  // A. Anchor family on the records owning the TARGET workspace, not env.
  const owners = records.filter((o) => o.workspaceId === ws);
  const family = owners.length ? familyOf(owners[0]!.session) : familyOf(fallbackSession);

  // Count the family's LIVE Captains (surface-level, not workspace-level: siblings
  // share one workspace, so a workspace check would keep counting a closed pane).
  const live = records.filter((o) => familyOf(o.session) === family && isLive(o));
  if (live.length >= cap) throw quadrantFull(cap);

  // Lowest free slot (base is #1; siblings -2..-cap).
  const taken = new Set(live.map((o) => indexOf(o.session, family)));
  let n = 1;
  while (taken.has(n)) n++;
  let session = n === 1 ? family : `${family}-${n}`;

  // B. Hard uniqueness guard: never recycle a name onto a Captain whose pane is
  // still live (the clone bug) even if the live-count under-counted it above.
  while (true) {
    const existing = records.find((r) => r.session === session);
    if (!existing || !isLive(existing)) break;
    n++;
    if (n > cap) throw quadrantFull(cap);
    session = `${family}-${n}`;
  }

  return { family, session };
}

function quadrantFull(cap: number): Error {
  return new Error(`Quadrant full (${cap} Captains) — close one first.`);
}
