// Unit tests for the capture-file pure logic (P2b): tail extraction from raw
// pane dumps and the size-capped, atomic dump command construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureTail, captureDumpCommand, CAPTURE_CAP_BYTES } from "./capture-log.js";

test("captureTail: returns the last N lines, trimmed", () => {
  const content = ["one", "two", "three", "four"].join("\n");
  assert.equal(captureTail(content, 2), "three\nfour");
});

test("captureTail: drops the trailing blank run and trailing whitespace", () => {
  const content = "report line   \nfinal verdict\n\n   \n\n";
  assert.equal(captureTail(content, 5), "report line\nfinal verdict");
});

test("captureTail: strips ANSI escapes and control chars", () => {
  const content = "\x1b[32m✓ PASS\x1b[0m\n\x1b]0;title\x07done: all 3 proofs verified\x07";
  assert.equal(captureTail(content, 5), "✓ PASS\ndone: all 3 proofs verified");
});

test("captureTail: shorter content than N comes back whole", () => {
  assert.equal(captureTail("only line", 12), "only line");
});

test("captureDumpCommand: caps with tail -c, writes a pid-unique tmp, renames atomically", () => {
  const cmd = captureDumpCommand("/home/u/.fleet/s/capture/abc.log");
  assert.ok(cmd.includes(`tail -c ${CAPTURE_CAP_BYTES} `));
  assert.ok(cmd.includes("mkdir -p '/home/u/.fleet/s/capture'"));
  assert.ok(cmd.includes("> '/home/u/.fleet/s/capture/abc.log'.$$.tmp"));
  assert.ok(cmd.includes("&& mv '/home/u/.fleet/s/capture/abc.log'.$$.tmp '/home/u/.fleet/s/capture/abc.log'"));
});

test("captureDumpCommand: single-quotes survive a path with spaces and quotes", () => {
  const cmd = captureDumpCommand("/tmp/we ird'dir/x.log", 1024);
  assert.ok(cmd.includes("'/tmp/we ird'\\''dir'"));
  assert.ok(cmd.includes("tail -c 1024 "));
});
