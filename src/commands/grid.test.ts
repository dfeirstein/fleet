// Unit tests for the atomic-grid layout builder: the --layout JSON must place
// every pane's command at the right depth-first position (that order is how
// created panes are zipped back to minted agent ids — a mismatch would attach
// registry entries to the wrong panes). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGridLayout, parseGrid } from "./grid.js";
import type { LayoutNode, LayoutPane } from "../cmux.js";

/** Depth-first flatten of a layout tree → each pane's command (or undefined). */
function flatten(node: LayoutNode): (string | undefined)[] {
  if ("pane" in node) return [node.pane.surfaces[0]?.command];
  return node.children.flatMap(flatten);
}

function isPane(node: LayoutNode): node is LayoutPane {
  return "pane" in node;
}

test("2x2: horizontal split of two vertical columns, equal halves, commands in column-major order", () => {
  const cmds = ["c1", "c2", "c3", "c4"];
  const root = buildGridLayout(2, 2, cmds);
  assert.ok(!isPane(root));
  if (isPane(root)) return;
  assert.equal(root.direction, "horizontal");
  assert.equal(root.split, 0.5);
  for (const col of root.children) {
    assert.ok(!isPane(col));
    if (!isPane(col)) {
      assert.equal(col.direction, "vertical");
      assert.equal(col.split, 0.5);
      assert.ok(col.children.every(isPane));
    }
  }
  // Depth-first order is exactly the commands array (col 0 top→bottom, col 1 …).
  assert.deepEqual(flatten(root), cmds);
});

test("3x1: a chain of three panes with equal-share binary splits (1/3 then 1/2)", () => {
  const cmds = ["a", "b", "c"];
  const root = buildGridLayout(3, 1, cmds);
  assert.ok(!isPane(root));
  if (isPane(root)) return;
  assert.equal(root.direction, "horizontal");
  assert.equal(root.split, 1 / 3); // first column takes a third…
  const restNode = root.children[1];
  assert.ok(!isPane(restNode));
  if (!isPane(restNode)) assert.equal(restNode.split, 0.5); // …the remainder splits in half
  assert.deepEqual(flatten(root), cmds);
});

test("idle panes (no task): surfaces carry NO command key", () => {
  const root = buildGridLayout(2, 1, [undefined, undefined]);
  assert.deepEqual(flatten(root), [undefined, undefined]);
  // and the key is genuinely absent, not command:undefined (cmux JSON hygiene)
  if (!isPane(root)) {
    const first = root.children[0];
    if (isPane(first)) assert.ok(!("command" in first.pane.surfaces[0]!));
  }
});

test("task panes: each pane keeps ITS OWN launch line (per-pane agent ids)", () => {
  const cmds = ["FLEET_AGENT_ID=a claude 'task'", "FLEET_AGENT_ID=b claude 'task'"];
  assert.deepEqual(flatten(buildGridLayout(1, 2, cmds)), cmds);
});

test("command-count mismatch is rejected", () => {
  assert.throws(() => buildGridLayout(2, 2, ["only-one"]), /needs 4 commands/);
});

test("parseGrid still enforces shape and the pane cap", () => {
  assert.deepEqual(parseGrid("3x2"), { cols: 3, rows: 2 });
  assert.throws(() => parseGrid("5x2"), /grid too large/);
  assert.throws(() => parseGrid("2by2"), /bad grid spec/);
});
