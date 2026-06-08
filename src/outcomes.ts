// The delegation-outcome log — Fleet's trajectory store (design Move 1).
//
// An append-only JSON-lines record of what the Captain delegated and what
// happened: one line per lifecycle event (spawn / verify / kill). This is the
// prerequisite the rest of the self-evolution loop gates on — gated capture,
// skill decay, the metacognitive monitor, and doctrine deltas all need a durable
// record of {objective, verdict, cost, lessons}. The registry holds none of this
// (it tracks live state and is mutated/pruned); the log is durable and additive.
//
// Stored at ~/.fleet/<session>.outcomes.jsonl. Writes are best-effort and MUST
// NEVER break the command that produced them.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { sessionId } from "./registry.js";

export type OutcomeEvent = "spawn" | "verify" | "kill";

export interface OutcomeRecord {
  ts: string; // ISO timestamp
  session: string;
  event: OutcomeEvent;
  agentId: string;
  label: string;
  /** The delegated task (recorded at spawn). */
  objective?: string;
  cwd?: string;
  /** Set when the worker ran in an isolated git worktree. */
  worktreeBranch?: string;
  model?: string;
  mode?: string;
  /** verify: the independent eval verdict + the check that produced it. */
  verdict?: "pass" | "fail";
  check?: string;
  /** kill: the worker's final observed status. */
  status?: string;
  /** Reserved: distilled lesson from a wave digest (Move 2 enriches this). */
  lessons?: string;
}

function outcomesPath(session: string): string {
  return join(homedir(), ".fleet", `${session}.outcomes.jsonl`);
}

/**
 * Append one outcome record. `session` defaults to the resolved fleet session
 * (same resolution the registry uses), so records land beside the registry they
 * describe. Best-effort: any failure is swallowed so logging can't break a command.
 */
export function appendOutcome(rec: Omit<OutcomeRecord, "ts" | "session">, session?: string): void {
  try {
    const s = session ?? sessionId();
    const full: OutcomeRecord = { ts: new Date().toISOString(), session: s, ...rec };
    mkdirSync(join(homedir(), ".fleet"), { recursive: true });
    appendFileSync(outcomesPath(s), JSON.stringify(full) + "\n");
  } catch {
    // logging must never break the caller
  }
}

/** Read all outcome records for a session (tolerant of partial/corrupt lines). */
export function readOutcomes(session?: string): OutcomeRecord[] {
  const s = session ?? sessionId();
  const p = outcomesPath(s);
  if (!existsSync(p)) return [];
  const out: OutcomeRecord[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as OutcomeRecord);
    } catch {
      // skip a torn final line
    }
  }
  return out;
}
