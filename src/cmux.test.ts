// Unit tests for the input-box region extractor (S7): the cleared-input probe
// in submitToClaude must look only inside the `╭…╰` input box, so echoed
// transcript text can't cause spurious retry-Enters. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputBoxRegion, helpListsVerb, surfaceState, CmuxError } from "./cmux.js";
import type { GridCell } from "./cmux.js";

const MSG = "fix the login bug in auth.ts";

test("text still sitting in the input box is found", () => {
  const screen = [
    "✶ Thinking… (3s · esc to interrupt)",
    "╭──────────────────────────────────╮",
    `│ > ${MSG}                         │`,
    "╰──────────────────────────────────╯",
  ].join("\n");
  assert.ok(inputBoxRegion(screen).includes(MSG));
});

test("echoed transcript text above an EMPTY input box is excluded", () => {
  const screen = [
    `> ${MSG}`, // the submitted prompt, echoed into the transcript
    "⏺ Working on it…",
    "╭──────────────────────────────────╮",
    "│ >                                │",
    "╰──────────────────────────────────╯",
  ].join("\n");
  assert.ok(!inputBoxRegion(screen).includes(MSG));
});

test("a dialog as the last box does not surface earlier input text", () => {
  const screen = [
    "╭──────────────────────────────────╮",
    `│ > ${MSG}                         │`,
    "╰──────────────────────────────────╯",
    "╭─ Permission required ────────────╮",
    "│ Allow Bash? ❯ Yes / No           │",
    "╰──────────────────────────────────╯",
  ].join("\n");
  const region = inputBoxRegion(screen);
  assert.ok(!region.includes(MSG));
  assert.ok(region.includes("Allow Bash?"));
});

test("indented box borders are still recognized", () => {
  const screen = ["  ╭────────╮", `  │ ${MSG} │`, "  ╰────────╯"].join("\n");
  assert.ok(inputBoxRegion(screen).includes(MSG));
});

test("no box on screen falls back to the last 9 lines", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  assert.equal(inputBoxRegion(lines.join("\n")), lines.slice(-9).join("\n"));
});

test("unmatched ╰ (no ╭ above) falls back to the tail", () => {
  const screen = ["some output", "╰──────────╯", MSG].join("\n");
  assert.ok(inputBoxRegion(screen).includes(MSG));
});

// Capability gating for the tmux-compat verbs (wait-for / pipe-pane): they are
// NOT in `cmux capabilities`, so support is decided from the help text.
const HELP_WITH_VERBS = ["  read-screen [...]", "  pipe-pane --command <shell-command> [...]", "  wait-for [-S|--signal] <name> [--timeout <seconds>]"].join("\n");

test("helpListsVerb: detects listed tmux-compat verbs", () => {
  assert.equal(helpListsVerb(HELP_WITH_VERBS, "wait-for"), true);
  assert.equal(helpListsVerb(HELP_WITH_VERBS, "pipe-pane"), true);
});

test("helpListsVerb: an older cmux without the verbs gates OFF (fail-safe)", () => {
  const oldHelp = "  read-screen [...]\n  send [...]";
  assert.equal(helpListsVerb(oldHelp, "wait-for"), false);
  assert.equal(helpListsVerb(oldHelp, "pipe-pane"), false);
  assert.equal(helpListsVerb("", "wait-for"), false); // unreachable cmux → ""
});

test("helpListsVerb: a mid-line mention is not a command listing", () => {
  assert.equal(helpListsVerb("  send <text>  (see also wait-for)", "wait-for"), false);
});

// surfaceState — the tri-state probe under surfaceExists. The bug: surfaceExists
// returned `false` on ANY listGridCells throw, so a transient cmux error read a
// LIVE Captain surface as dead → the daemon self-heal re-stamped onto a doomed
// surface → captain-supervision flapping. Fix: only a genuine `not_found` →
// "absent" (dead); any other throw → "unknown" → surfaceExists KEEPs (fail
// closed). The lister is injected so the classification is testable without cmux.
const TARGET = { workspace: "ws-1", surface: "surf-live" };
const cell = (surfaceId: string): GridCell => ({
  paneRef: "p", surfaceRef: "r", surfaceId, workspaceId: "ws-1", type: "terminal",
});
// surfaceExists's exact derivation, mirrored so each case asserts the boolean too.
const exists = (s: ReturnType<typeof surfaceState>) => s !== "absent";

test("surfaceState: listing includes the surface → present (surfaceExists true)", () => {
  const s = surfaceState(TARGET, () => [cell("surf-other"), cell("surf-live")]);
  assert.equal(s, "present");
  assert.equal(exists(s), true);
});

test("surfaceState: listing succeeds WITHOUT the surface → absent (surfaceExists false)", () => {
  const s = surfaceState(TARGET, () => [cell("surf-other")]);
  assert.equal(s, "absent");
  assert.equal(exists(s), false);
});

test("surfaceState: a transient (non-not_found) throw → unknown (surfaceExists true — THE fix)", () => {
  const s = surfaceState(TARGET, () => {
    throw new CmuxError("busy", ["list-panes"], "Error: invalid_params: Surface is not a terminal");
  });
  assert.equal(s, "unknown");
  assert.equal(exists(s), true); // a flaky probe must NEVER read a live surface as dead
});

test("surfaceState: a not_found throw → absent (surfaceExists false — genuine teardown still reaps)", () => {
  const s = surfaceState(TARGET, () => {
    throw new CmuxError("gone", ["list-panes"], "Error: not_found: Workspace not found");
  });
  assert.equal(s, "absent");
  assert.equal(exists(s), false);
});

test("surfaceState: a non-CmuxError throw → unknown (fail closed on an unexpected error)", () => {
  const s = surfaceState(TARGET, () => {
    throw new Error("ECONNRESET");
  });
  assert.equal(s, "unknown");
  assert.equal(exists(s), true);
});
