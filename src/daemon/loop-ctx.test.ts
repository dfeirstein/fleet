// Unit test for the context-guard apply seam (loop.ts): given a CtxDecision,
// assert it routes a /compact to the RIGHT pane — the worker's own pane for
// `compact:"worker"`, the orchestrator pane for `compact:"captain"` (never the
// worker), and a message through the channel. Stubs the cmux/channel seams so no
// real pane is touched. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCtxDecision, type CtxApplyDeps } from "./loop.js";
import { DAEMON_DEFAULTS, type DaemonConfig } from "./config.js";
import type { Target } from "../cmux.js";

const ORCH: Target = { workspace: "ws-captain", surface: "sf-captain" };
const WORKER: Target = { workspace: "ws-worker", surface: "sf-worker" };
const CFG: DaemonConfig = { ...DAEMON_DEFAULTS, orchestrator: ORCH, session: "cliff" };

function spyDeps() {
  const sends: { t: Target; text: string }[] = [];
  const routes: { text: string; urgent: boolean }[] = [];
  const deps: CtxApplyDeps = {
    submit: (t, text) => {
      sends.push({ t, text });
      return "submitted";
    },
    route: (_cfg, text, urgent) => {
      routes.push({ text, urgent });
      return "injected";
    },
  };
  return { sends, routes, deps };
}

test("compact:'worker' sends /compact to the WORKER pane, not the orchestrator", () => {
  const { sends, deps } = spyDeps();
  applyCtxDecision(CFG, { compact: "worker" }, "w1", WORKER, deps);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]!.t, WORKER);
  assert.equal(sends[0]!.text, "/compact");
});

test("compact:'captain' sends /compact to the ORCHESTRATOR pane (ignores any worker target)", () => {
  const { sends, deps } = spyDeps();
  applyCtxDecision(CFG, { compact: "captain" }, "captain", WORKER, deps);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]!.t, ORCH);
});

test("a message routes through the channel; no message → no route", () => {
  const { routes, sends, deps } = spyDeps();
  applyCtxDecision(CFG, { message: { text: "at 70%", urgent: true } }, "captain", undefined, deps);
  assert.equal(sends.length, 0);
  assert.deepEqual(routes, [{ text: "at 70%", urgent: true }]);
});

test("compact:'worker' with no worker target is a safe no-op (never sends to the orchestrator)", () => {
  const { sends, deps } = spyDeps();
  applyCtxDecision(CFG, { compact: "worker" }, "w1", undefined, deps);
  assert.equal(sends.length, 0);
});
