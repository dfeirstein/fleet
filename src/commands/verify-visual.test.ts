// Unit tests for the visual-verdict decision matrix (pure; the browser calls
// themselves verify by typecheck + the documented manual smoke). Fail closed
// on every branch: timeout, off-origin URL, page errors, missing text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visualVerdict, type VisualEvidence } from "./verify-visual.js";

function ok(overrides: Partial<VisualEvidence> = {}): VisualEvidence {
  return {
    requestedUrl: "http://127.0.0.1:8377/index.html",
    finalUrl: "http://127.0.0.1:8377/index.html",
    loaded: true,
    errors: [],
    pageText: "Fleet Browser Rail OK\n\nhello from the smoke page",
    ...overrides,
  };
}

test("clean load, same url, no errors → PASS", () => {
  const v = visualVerdict(ok());
  assert.equal(v.pass, true);
  assert.deepEqual(v.reasons, []);
});

test("load timeout → FAIL (fail closed), even if everything else looks fine", () => {
  const v = visualVerdict(ok({ loaded: false }));
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(" "), /load-state complete/);
});

test("same-origin redirect is allowed by default ( / → /home )", () => {
  const v = visualVerdict(ok({ finalUrl: "http://127.0.0.1:8377/home" }));
  assert.equal(v.pass, true);
});

test("cross-origin redirect → FAIL (login bounce to another host)", () => {
  const v = visualVerdict(ok({ finalUrl: "https://auth.example.com/login" }));
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(" "), /left the requested origin/);
});

test("--exact-url demands the exact final URL (same-origin redirect now fails)", () => {
  assert.equal(visualVerdict(ok({ finalUrl: "http://127.0.0.1:8377/home" }), { exactUrl: true }).pass, false);
  assert.equal(visualVerdict(ok(), { exactUrl: true }).pass, true);
});

test("empty/unparsable final url → FAIL (no silent pass when get url broke)", () => {
  assert.equal(visualVerdict(ok({ finalUrl: "" })).pass, false);
  assert.equal(visualVerdict(ok({ finalUrl: "not a url" })).pass, false);
});

test("any page error → FAIL, errors quoted in the reason", () => {
  const v = visualVerdict(ok({ errors: ["[error] Error: boom"] }));
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(" "), /boom/);
});

test("--expect-text present in page → PASS; absent → FAIL", () => {
  assert.equal(visualVerdict(ok(), { expectText: "Fleet Browser Rail OK" }).pass, true);
  const v = visualVerdict(ok(), { expectText: "Checkout complete" });
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(" "), /expected text not found/);
});

test("multiple failures all reported (timeout + errors + missing text)", () => {
  const v = visualVerdict(ok({ loaded: false, errors: ["[error] x"], pageText: "" }), { expectText: "hi" });
  assert.equal(v.pass, false);
  assert.equal(v.reasons.length, 3);
});
