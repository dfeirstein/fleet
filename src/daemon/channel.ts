// The daemon → orchestrator channel. Urgent messages are injected into the
// orchestrator's pane (start a new turn) but only when it's idle; otherwise
// (and for routine messages) they go to the inbox so we never derail a turn.
import { submit, sendKey, readScreen } from "../cmux.js";
import { classifyScreen } from "../status.js";
import { appendInbox } from "./inbox.js";
import type { DaemonConfig } from "./config.js";

export type Delivery = "injected" | "inboxed";

/** True if the orchestrator session is not mid-turn (safe to inject). */
export function orchestratorIdle(cfg: DaemonConfig): boolean {
  try {
    const screen = readScreen(cfg.orchestrator, 30);
    return classifyScreen(screen) !== "running";
  } catch {
    return false; // can't read it → assume busy, fall back to inbox
  }
}

export function inject(cfg: DaemonConfig, message: string): void {
  const text = `[fleet-daemon] ${message}`;
  submit(cfg.orchestrator, text);
  if (text.length > 200) sendKey(cfg.orchestrator, "Enter"); // paste-collapse guard
}

/** Deliver a message: urgent + orchestrator idle → inject; else inbox. */
export function routeMessage(cfg: DaemonConfig, message: string, urgent: boolean): Delivery {
  if (urgent && orchestratorIdle(cfg)) {
    inject(cfg, message);
    return "injected";
  }
  appendInbox(message);
  return "inboxed";
}
