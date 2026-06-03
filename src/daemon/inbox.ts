// Routine daemon → orchestrator messages. The orchestrator reads this at the
// start of a turn (see the fleet skill); the daemon appends to it for non-urgent
// items (digests, rate-limit notes). Urgent items are injected directly instead.
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { daemonDir, inboxPath } from "./config.js";

export function appendInbox(message: string): void {
  mkdirSync(daemonDir(), { recursive: true });
  const stamp = new Date().toISOString().slice(11, 19);
  appendFileSync(inboxPath(), `- [${stamp}] ${message}\n`);
}

export function readInbox(): string {
  return existsSync(inboxPath()) ? readFileSync(inboxPath(), "utf8") : "";
}

export function clearInbox(): void {
  if (existsSync(inboxPath())) writeFileSync(inboxPath(), "");
}
