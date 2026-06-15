#!/usr/bin/env -S npx tsx
/**
 * hot-zone-guard — `PreToolUse` hook entry point.
 *
 * Reads the hook payload JSON from stdin, runs the pure `evaluate()` matcher,
 * and — on a catastrophic match — emits a `deny` decision so Claude Code BLOCKS
 * the tool call before it runs. A clean call exits 0 with no output (allow).
 *
 * Fails OPEN by design: unreadable/garbage stdin exits 0. This guard exists to
 * stop the *unambiguous* catastrophic cases; it must never wedge a session on a
 * parse error. (Contrast with fleet's own gates, which fail CLOSED — this is a
 * convenience guard layered UNDER the human, not the authoritative gate.)
 */
import { evaluate, type PreToolUsePayload } from "./matcher.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: PreToolUsePayload;
  try {
    payload = JSON.parse(raw) as PreToolUsePayload;
  } catch {
    process.exit(0); // unparseable → allow (fail open).
  }

  const decision = evaluate(payload);
  if (!decision.block) process.exit(0);

  // Block: emit the PreToolUse deny decision Claude Code understands, and a
  // human-readable reason on stderr.
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `hot-zone-guard BLOCKED: ${decision.reason}`,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stderr.write(`hot-zone-guard BLOCKED: ${decision.reason}\n`);
  process.exit(0);
}

void main();
