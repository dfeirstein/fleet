// Worker output capture (P2b) — the digest's source for the TRUE final report.
//
// cmux's `pipe-pane` is a ONE-SHOT dump of a pane's text (screen + scrollback)
// through a shell command — verified against the live binary 2026-06-09; it is
// NOT tmux's continuous stream. So "continuous capture" is refresh-on-touch:
// fleet re-dumps a worker's pane at the moments it already touches the worker
// (spawn, `fleet done`, digest) into `~/.fleet/<session>/capture/<agentId>.log`.
// The dump command caps the file at ~2MB (`tail -c`) and lands atomically
// (tmp + mv), so readers always see a complete snapshot. Digest prefers this
// file's tail over the live-screen scrape; kill removes the file.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, rmSync, statSync } from "node:fs";
import { pipePaneDump, pipePaneSupported } from "./cmux.js";
import { sessionId, target, type Agent } from "./registry.js";

/** Keep roughly the last 2MB of a worker's output — plenty for a final report. */
export const CAPTURE_CAP_BYTES = 2 * 1024 * 1024;

export function captureDir(): string {
  return join(homedir(), ".fleet", sessionId(), "capture");
}

export function captureFilePath(agentId: string): string {
  return join(captureDir(), `${agentId}.log`);
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command a pipe-pane dump runs: create the capture dir, cap the
 * pane text to the last `capBytes`, write to a pid-unique tmp file, then
 * atomically rename into place. Pure (string in, string out); exported for tests.
 */
export function captureDumpCommand(path: string, capBytes = CAPTURE_CAP_BYTES): string {
  const q = shellSingleQuote;
  const dir = q(dirname(path));
  const file = q(path);
  // `$$` is the dump shell's pid — concurrent dumps can't clobber each other's tmp.
  return `mkdir -p ${dir} && tail -c ${capBytes} > ${file}.$$.tmp && mv ${file}.$$.tmp ${file}`;
}

// Strip ANSI escape sequences (CSI, OSC, and lone two-byte escapes) plus other
// control chars so a tail extracted from raw pane output reads as plain text.
// cmux dumps rendered pane TEXT (observed plain), so this is a safety net.
// eslint-disable-next-line no-control-regex
const ANSI_OR_CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * The last `lines` non-garbage lines of captured pane output: ANSI/control
 * stripped, trailing whitespace removed, trailing blank run dropped. Pure;
 * exported for tests.
 */
export function captureTail(content: string, lines: number): string {
  const clean = content.replace(ANSI_OR_CONTROL, "");
  const all = clean.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(-lines).join("\n").trim();
}

/**
 * Trigger a fresh dump of a worker's pane into its capture file. Best-effort
 * and capability-gated: on a cmux without `pipe-pane` (or any error) this is a
 * no-op and callers fall back to the live-screen scrape, exactly as today.
 * NOTE: the dump lands asynchronously — give it a beat before reading.
 */
export function refreshCapture(agent: Agent): boolean {
  if (!pipePaneSupported()) return false;
  try {
    pipePaneDump(target(agent), captureDumpCommand(captureFilePath(agent.agentId)));
    return true;
  } catch {
    return false;
  }
}

/** The capture file's content + write time (for staleness checks against the
 *  dump request), or undefined when absent/empty/unreadable. */
export function readCapture(agentId: string): { content: string; mtimeMs: number } | undefined {
  try {
    const path = captureFilePath(agentId);
    const content = readFileSync(path, "utf8");
    if (!content.trim()) return undefined;
    return { content, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}

/** Remove a worker's capture file (kill/cleanup). One-shot dumps leave no
 *  persistent pipe to stop — deleting the file is the whole cleanup. */
export function removeCapture(agentId: string): void {
  try {
    rmSync(captureFilePath(agentId), { force: true });
  } catch {
    // best-effort
  }
}
