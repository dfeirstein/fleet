// `fleet state` — the Captain's memory blocks (design Move 6).
//
// A long-lived manager must keep its window lean, so the ONLY project-specific
// content allowed resident is a small set of capped, structured blocks — not an
// accreting transcript. `fleet state` renders these blocks; after a `/compact`
// (or at high occupancy) the Captain reloads them to restore its manager state
// while the raw residue stays dropped. This is "prune state", not "summarize
// prose" — structured, so there's no summarization drift.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { sessionId, listAgents } from "../registry.js";

interface CaptainState {
  activeObjective?: string;
  openDecisions: string[];
  risks: string[];
  updatedAt?: string;
}

// Hard caps keep the resident footprint bounded (empirical, adjust as needed).
const MAX_OBJECTIVE = 280;
const MAX_ITEMS = 8;
const MAX_ITEM = 160;

function statePath(session: string): string {
  return join(homedir(), ".fleet", `${session}.state.json`);
}

function load(session: string): CaptainState {
  const p = statePath(session);
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as Partial<CaptainState>;
      return { openDecisions: [], risks: [], ...s };
    } catch {
      // corrupt — start fresh rather than crash
    }
  }
  return { openDecisions: [], risks: [] };
}

function save(session: string, st: CaptainState): void {
  st.updatedAt = new Date().toISOString();
  mkdirSync(join(homedir(), ".fleet"), { recursive: true });
  writeFileSync(statePath(session), JSON.stringify(st, null, 2));
}

const cap = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM);

export function setObjective(text: string, session = sessionId()): void {
  const st = load(session);
  st.activeObjective = text.replace(/\s+/g, " ").trim().slice(0, MAX_OBJECTIVE);
  save(session, st);
}

export function addDecision(text: string, session = sessionId()): void {
  const st = load(session);
  st.openDecisions = [...st.openDecisions, cap(text)].slice(-MAX_ITEMS);
  save(session, st);
}

export function addRisk(text: string, session = sessionId()): void {
  const st = load(session);
  st.risks = [...st.risks, cap(text)].slice(-MAX_ITEMS);
  save(session, st);
}

/** Clear the transient blocks (decisions + risks); keep the active objective. */
export function clearTransient(session = sessionId()): void {
  const st = load(session);
  st.openDecisions = [];
  st.risks = [];
  save(session, st);
}

/**
 * Render the memory blocks as the compact context the Captain reloads after a
 * compaction. The fleet roster is derived LIVE from the registry, not stored.
 */
export function renderState(session = sessionId()): string {
  const st = load(session);
  const roster = listAgents()
    .filter((a) => a.status !== "dead")
    .map((a) => `- ${a.label} [${a.status}] ${(a.task || "").replace(/\s+/g, " ").slice(0, 60)}`);

  const lines = [`## Captain state — ${session}`, ``];
  lines.push(`**active objective:** ${st.activeObjective ?? "_(none set — `fleet state objective \"…\"`)_"}`, ``);
  lines.push(`### fleet roster (${roster.length})`, roster.length ? roster.join("\n") : "_(no live workers)_", ``);
  lines.push(`### open decisions`, st.openDecisions.length ? st.openDecisions.map((d) => `- ${d}`).join("\n") : "_(none)_", ``);
  lines.push(`### risks`, st.risks.length ? st.risks.map((r) => `- ${r}`).join("\n") : "_(none)_", ``);
  return lines.join("\n");
}
