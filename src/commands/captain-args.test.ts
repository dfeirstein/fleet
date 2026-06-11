import { test } from "node:test";
import assert from "node:assert/strict";
import {
  unknownCaptainFlags,
  noNameResumeError,
  captainResumeArg,
  inPaneResumeRecipe,
} from "./captain-args.js";

test("unknownCaptainFlags: known flags pass, unknown rejected", () => {
  assert.deepEqual(unknownCaptainFlags(["resume", "split", "no-daemon", "model", "command", "close-origin", "print"]), []);
  assert.deepEqual(unknownCaptainFlags(["help"]), []);
  assert.deepEqual(unknownCaptainFlags(["h"]), []);
  // #37: an unknown flag (the kind that used to spawn a stray Captain) is flagged.
  assert.deepEqual(unknownCaptainFlags(["continue"]), ["continue"]);
  assert.deepEqual(unknownCaptainFlags(["resume", "bogus", "model"]), ["bogus"]);
});

test("noNameResumeError: never says to default; lists live captains with exact commands", () => {
  const msg = noNameResumeError([
    { name: "yoshi", session: "yoshi" },
    { name: "yoshi-2", session: "yoshi-2" },
  ]);
  // #36: must steer AWAY from defaulting to "Captain".
  assert.match(msg, /must not default to "Captain"/);
  assert.match(msg, /fleet captain yoshi --resume/);
  assert.match(msg, /fleet captain yoshi-2 --resume/);
  assert.match(msg, /yoshi-2/);
});

test("noNameResumeError: no live captains points at fresh start", () => {
  const msg = noNameResumeError([]);
  assert.match(msg, /No live captains/);
  assert.match(msg, /fleet captain <name>/);
});

test("captainResumeArg: with id targets --resume <id>, no warning", () => {
  const { arg, warning } = captainResumeArg("abc-123");
  assert.equal(arg, "--resume 'abc-123' ");
  assert.equal(warning, undefined);
});

test("captainResumeArg: without id falls back to --continue with a loud warning", () => {
  const { arg, warning } = captainResumeArg(undefined);
  assert.equal(arg, "--continue ");
  assert.ok(warning);
  // The warning must name the fork hazard so the user understands the risk.
  assert.match(warning!, /--continue/);
  assert.match(warning!, /WRONG conversation|wrong conversation/i);
});

test("inPaneResumeRecipe: with id builds the exact in-pane relaunch, no cmux", () => {
  const recipe = inPaneResumeRecipe({
    session: "yoshi",
    cwd: "/Users/doug",
    sessionId: "abc-123",
    promptPath: "/Users/doug/.fleet/orchestrator-prompt-yoshi.md",
  });
  assert.match(recipe, /^cd \/Users\/doug &&/);
  assert.match(recipe, /exec env FLEET_SESSION=yoshi/);
  assert.match(recipe, /claude --resume abc-123/);
  assert.match(recipe, /--remote-control yoshi/);
  assert.match(recipe, /--append-system-prompt-file \/Users\/doug\/.fleet\/orchestrator-prompt-yoshi\.md/);
  // It must not start a fresh conversation comment when the id is known.
  assert.doesNotMatch(recipe, /^#/);
});

test("inPaneResumeRecipe: without id uses --continue and carries the warning comment", () => {
  const recipe = inPaneResumeRecipe({
    session: "yoshi",
    cwd: "/Users/doug",
    promptPath: "/p.md",
  });
  assert.match(recipe, /^# WARNING:/);
  assert.match(recipe, /claude --continue/);
});

test("inPaneResumeRecipe: shell-quotes paths with spaces", () => {
  const recipe = inPaneResumeRecipe({
    session: "yoshi",
    cwd: "/Users/doug with space",
    sessionId: "id",
    promptPath: "/p ath.md",
  });
  assert.match(recipe, /cd '\/Users\/doug with space'/);
  assert.match(recipe, /--append-system-prompt-file '\/p ath\.md'/);
});

test("inPaneResumeRecipe: includes --model when given", () => {
  const recipe = inPaneResumeRecipe({
    session: "yoshi",
    cwd: "/u",
    sessionId: "id",
    promptPath: "/p.md",
    model: "claude-fable-5",
  });
  assert.match(recipe, /--model claude-fable-5/);
});
