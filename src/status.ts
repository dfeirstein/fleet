// Heuristic status detection from a worker's terminal screen.
//
// This is the FALLBACK inspection path (a deterministic hook-based "done"
// signal is a later phase). It classifies the live Claude Code TUI.
import type { AgentStatus, Agent } from "./registry.js";
import { target } from "./registry.js";
import { readScreen, isGone, type Target } from "./cmux.js";

const RATE_LIMIT = /(rate limit|usage limit|limit reached|too many requests|429)/i;
const ERROR = /(error:|fatal|panic|uncaught|command not found|permission denied)/i;
// A blocking yes/no permission or choice dialog (including the bypass warning).
const AWAITING =
  /(\(y\/n\)|❯\s*1\.|do you want to proceed|allow this|bypass permissions mode\b.*\n|no, exit)/i;
// Claude is actively working: the interrupt hint, an elapsed timer ("(34s ·",
// "(12m 11s ·" — minute/hour forms included), or a spinner line: a glyph at
// line START + a gerund verb with a MANDATORY ellipsis + a timer ("✶
// Razzmatazzing… 12m 11s"). Claude Code's spinner verbs are open-ended, so
// this is structural, not a verb whitelist — but the anchor and the ellipsis
// are load-bearing: summary prose like "* Updating the config took 12s" or
// "· Building finished in 32s" must NOT classify running (a false `running`
// is sticky post-B1: it beats turn-end notifications). Same reason for not
// matching bare words like "running" ("1 shell still running").
const WORKING =
  /(esc to interrupt|\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·|^\s*[✶✻✢✳✽◐◓◑◒·*]\s*\w+ing(?:…|\.{3})[^\n]*?\b(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b|…\s*\(\d+)/im;
// An idle Claude Code TUI presents its prompt box waiting for input.
const IDLE_PROMPT = /(❯\s*$|\?\s*for shortcuts|bypass permissions on|auto mode on|accept edits on)/im;

export function classifyScreen(screen: string): AgentStatus {
  if (screen.trim().length === 0) return "unknown"; // blank/transient read
  const tail = screen.split("\n").slice(-30).join("\n");
  if (RATE_LIMIT.test(tail)) return "rate-limited";
  if (AWAITING.test(tail)) return "awaiting-input";
  if (WORKING.test(tail)) return "running";
  if (IDLE_PROMPT.test(tail)) return "idle";
  if (ERROR.test(tail)) return "error";
  return "unknown";
}

/** Read a worker's terminal and classify it. Fails CLOSED on a read error: only
 *  cmux's `not_found` machine code (the surface is genuinely gone) yields "dead";
 *  ANY other failure — busy socket, EAGAIN, a transient cmux hiccup — is
 *  indeterminate → "unknown" → KEEP under supervision (CLAUDE.md existence-probe
 *  rule), so a flaky read never silently drops a live worker from the wave digest
 *  or lets `watch --until-idle` declare quiescence early. The reader is injectable
 *  for tests. */
export function probeStatus(
  t: Target,
  lines = 30,
  read: (t: Target, lines?: number) => string = readScreen,
): { status: AgentStatus; screen: string } {
  try {
    const screen = read(t, lines);
    return { status: classifyScreen(screen), screen };
  } catch (e) {
    return { status: isGone(e) ? "dead" : "unknown", screen: "" };
  }
}

/** Convenience: probe an agent record. */
export function probeAgent(agent: Agent, lines = 30): { status: AgentStatus; screen: string } {
  return probeStatus(target(agent), lines);
}
