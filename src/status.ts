// Heuristic status detection from a worker's terminal screen.
//
// This is the FALLBACK inspection path (a deterministic hook-based "done"
// signal is a later phase). It classifies the live Claude Code TUI.
import type { AgentStatus, Agent } from "./registry.js";
import { target } from "./registry.js";
import { readScreen, type Target } from "./cmux.js";

const RATE_LIMIT = /(rate limit|usage limit|limit reached|too many requests|429)/i;
const ERROR = /(error:|fatal|panic|uncaught|command not found|permission denied)/i;
// A blocking yes/no permission or choice dialog (including the bypass warning).
const AWAITING =
  /(\(y\/n\)|❯\s*1\.|do you want to proceed|allow this|bypass permissions mode\b.*\n|no, exit)/i;
// Claude is actively working: the interrupt hint, an elapsed timer ("(34s ·",
// "(12m 11s ·" — minute/hour forms included), or a spinner glyph followed by a
// gerund verb AND a timer on the same line ("✶ Razzmatazzing… 12m 11s").
// Claude Code's spinner verbs are open-ended, so this is structural (glyph +
// any *ing word + timer), not a verb whitelist. Deliberately NOT matching bare
// words like "running" — the dev-server status line ("1 shell still running")
// would false-positive.
const WORKING =
  /(esc to interrupt|\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·|[✶✻✢✳✽◐◓◑◒·*]\s*\w+ing(?:…|\.{3})?[^\n]*?\b(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b|…\s*\(\d+)/i;
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

/** Read a worker's terminal and classify it. Returns "dead" if it's gone. */
export function probeStatus(t: Target, lines = 30): { status: AgentStatus; screen: string } {
  try {
    const screen = readScreen(t, lines);
    return { status: classifyScreen(screen), screen };
  } catch {
    return { status: "dead", screen: "" };
  }
}

/** Convenience: probe an agent record. */
export function probeAgent(agent: Agent, lines = 30): { status: AgentStatus; screen: string } {
  return probeStatus(target(agent), lines);
}
