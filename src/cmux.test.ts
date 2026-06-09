// Unit tests for the input-box region extractor (S7): the cleared-input probe
// in submitToClaude must look only inside the `╭…╰` input box, so echoed
// transcript text can't cause spurious retry-Enters. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputBoxRegion } from "./cmux.js";

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
