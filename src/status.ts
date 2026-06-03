// Heuristic status detection from a worker's terminal screen.
//
// This is the FALLBACK inspection path (Phase 3 adds a deterministic hook-based
// "done" signal). For Phase 1 it gives `fleet status` a useful live read.
import type { AgentStatus } from "./registry.js";
import { readScreen } from "./cmux.js";

const RATE_LIMIT = /(rate limit|usage limit|limit reached|too many requests|429)/i;
const ERROR = /(error:|fatal|panic|exception|command not found|permission denied)/i;
// Claude Code shows a working spinner / "esc to interrupt" hint while running.
const RUNNING = /(esc to interrupt|✻|✢|·\s*\w+ing|thinking|working|running)/i;
// An idle Claude Code TUI presents its prompt box ("> ") waiting for input.
const IDLE_PROMPT = /(│\s*>|^\s*>\s*$|\?\s*for shortcuts|bypass permissions)/im;
// A blocking yes/no permission or choice dialog.
const AWAITING = /(\(y\/n\)|❯\s*1\.|do you want to proceed|allow this)/i;

export function classifyScreen(screen: string): AgentStatus {
  const tail = screen.split("\n").slice(-40).join("\n");
  if (RATE_LIMIT.test(tail)) return "rate-limited";
  if (AWAITING.test(tail)) return "awaiting-input";
  if (RUNNING.test(tail)) return "running";
  if (ERROR.test(tail)) return "error";
  if (IDLE_PROMPT.test(tail)) return "idle";
  return "unknown";
}

/** Read a worker's screen and classify it. Returns "dead" if it's gone. */
export function probeStatus(workspace: string, lines = 40): { status: AgentStatus; screen: string } {
  try {
    const screen = readScreen(workspace, lines);
    return { status: classifyScreen(screen), screen };
  } catch {
    return { status: "dead", screen: "" };
  }
}
