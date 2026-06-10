// Unit tests for the sidebar state machine: state→color/description mapping
// (incl. the idle-with/without-proof split and worst-state-wins aggregation for
// shared workspaces) and the on-change-only diff. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paintState,
  workspacePaint,
  diffPaints,
  sidebarTheme,
  SIDEBAR_COLORS,
  type Paint,
} from "./sidebar.js";

const theme = sidebarTheme();

test("state→color: the mission-control lamp defaults", () => {
  const color = (status: string, hasProof = false) =>
    workspacePaint([{ status, label: "w", task: "t", hasProof }], theme).color;
  assert.equal(color("running"), "#22c55e"); // green
  assert.equal(color("idle", true), "#9ca3af"); // grey — idle + proof ✓
  assert.equal(color("idle", false), "#f59e0b"); // amber — idled WITHOUT clearing the gate
  assert.equal(color("awaiting-input"), "#f59e0b"); // amber
  assert.equal(color("blocked-on-you"), "#f59e0b"); // amber
  assert.equal(color("error"), "#ef4444"); // red
  assert.equal(color("undispatched"), "#ef4444"); // red
  assert.equal(color("rate-limited"), "#4C8DFF"); // blue
});

test("paintState refines idle by the proof gate", () => {
  assert.equal(paintState({ status: "idle", hasProof: true }), "idle");
  assert.equal(paintState({ status: "idle", hasProof: false }), "idle-no-proof");
  assert.equal(paintState({ status: "running", hasProof: false }), "running");
});

test("single-worker description: label + truncated task", () => {
  const long = "x".repeat(100);
  const p = workspacePaint([{ status: "running", label: "w", task: long, hasProof: false }], theme);
  assert.ok(p.description.startsWith("running — "));
  assert.ok(p.description.length < 80);
  assert.ok(p.description.endsWith("…"));
  // taskless idle pane: just the label
  const idle = workspacePaint([{ status: "idle", label: "w", task: "", hasProof: true }], theme);
  assert.equal(idle.description, "idle ✓");
});

test("shared workspace: worst state wins the lamp; description counts members", () => {
  const p = workspacePaint(
    [
      { status: "running", label: "a", task: "t", hasProof: false },
      { status: "running", label: "b", task: "t", hasProof: false },
      { status: "blocked-on-you", label: "c", task: "t", hasProof: false },
    ],
    theme,
  );
  assert.equal(p.color, "#f59e0b"); // the blocked member outranks the runners
  assert.equal(p.description, "1 blocked on you · 2 running");
});

test("error outranks blocked outranks rate-limited outranks running", () => {
  const w = (status: string) => ({ status, label: "w", task: "", hasProof: false });
  assert.equal(workspacePaint([w("running"), w("error"), w("blocked-on-you")], theme).color, "#ef4444");
  assert.equal(workspacePaint([w("rate-limited"), w("blocked-on-you")], theme).color, "#f59e0b");
  assert.equal(workspacePaint([w("rate-limited"), w("running")], theme).color, "#4C8DFF");
});

test("on-change-only: first sync paints, unchanged repaints nothing, a change repaints once", () => {
  const paint: Paint = { color: "#22c55e", description: "running — t" };
  const first = diffPaints(new Map([["ws-1", paint]]), {});
  assert.equal(first.changed.length, 1);

  const second = diffPaints(new Map([["ws-1", paint]]), first.next);
  assert.equal(second.changed.length, 0); // same state → no cmux writes

  const idle: Paint = { color: "#9ca3af", description: "idle ✓ — t" };
  const third = diffPaints(new Map([["ws-1", idle]]), second.next);
  assert.equal(third.changed.length, 1);
  assert.deepEqual(third.changed[0], { workspace: "ws-1", paint: idle });
});

test("diff drops fingerprints of vanished workspaces (no stale memory growth)", () => {
  const paint: Paint = { color: "#22c55e", description: "running" };
  const { next } = diffPaints(new Map([["ws-2", paint]]), { "ws-gone": "old|fp" });
  assert.deepEqual(Object.keys(next), ["ws-2"]);
});

test("theme overrides merge over defaults (partial config keeps the rest)", () => {
  const t = sidebarTheme({ colors: { running: "Olive" }, labels: { running: "busy" } });
  assert.equal(t.colors.running, "Olive");
  assert.equal(t.colors.error, SIDEBAR_COLORS.error); // untouched default
  const p = workspacePaint([{ status: "running", label: "w", task: "", hasProof: false }], t);
  assert.equal(p.color, "Olive");
  assert.equal(p.description, "busy");
});
