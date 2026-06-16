import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugForCwd,
  redactSecrets,
  parseHit,
  rankHits,
  buildContext,
  fmtDate,
  type TranscriptHit,
} from "./transcript-search.js";

/** Build one transcript JSONL line. `content` may be a string or a block array. */
function line(rec: Record<string, unknown>): string {
  return JSON.stringify(rec);
}
function turn(over: Partial<{ sessionId: string; uuid: string; parentUuid: string | null; timestamp: string; role: string; content: unknown }>): string {
  return line({
    type: over.role === "assistant" ? "assistant" : "user",
    sessionId: over.sessionId ?? "sess-aaaa",
    uuid: over.uuid ?? "uuid-0001",
    parentUuid: "parentUuid" in over ? over.parentUuid : null,
    timestamp: over.timestamp ?? "2026-06-15T10:00:00.000Z",
    cwd: "/Users/x/proj",
    message: { role: over.role ?? "user", content: over.content ?? "hello world" },
  });
}

// ── slug derivation ───────────────────────────────────────────────────────────
test("slugForCwd: plain path → slashes become dashes", () => {
  assert.equal(slugForCwd("/Users/x/fleet-desktop"), "-Users-x-fleet-desktop");
});
test("slugForCwd: dotted path → every non-alphanumeric becomes a dash (the real rule)", () => {
  // `.fleet` → `--fleet`: the `/` AND the `.` both map to `-`. This is the gotcha
  // the spec's dot-free example hides — verified against the live store.
  assert.equal(slugForCwd("/Users/x/.fleet/wt"), "-Users-x--fleet-wt");
});

// ── redaction ─────────────────────────────────────────────────────────────────
test("redactSecrets: labeled key/value keeps the key, masks the value", () => {
  assert.equal(redactSecrets("export API_KEY=abcd1234efgh now"), "export API_KEY=‹redacted› now");
  assert.match(redactSecrets('{"password":"hunter2xyz"}'), /password":"‹redacted›/);
  assert.match(redactSecrets("aws_secret_access_key: AKQ8sjkdfh23"), /aws_secret_access_key: ‹redacted›/);
});
test("redactSecrets: bare provider token shapes are masked anywhere", () => {
  assert.equal(redactSecrets("here is sk-ABCDEFGHIJ0123456789 ok"), "here is ‹redacted› ok");
  assert.match(redactSecrets("token ghp_ABCDEFGHIJKLMNOPQRSTUVWX12 end"), /‹redacted›/);
  assert.match(redactSecrets("jwt eyJhbGciOiJ.eyJzdWIiO1.aBcDeF12"), /‹redacted›/);
});
test("redactSecrets: ordinary prose is left untouched", () => {
  const s = "we decided to use the engine trio and verify with rg";
  assert.equal(redactSecrets(s), s);
});

// ── parse / extract ───────────────────────────────────────────────────────────
test("parseHit: string-content user turn → hit with fields + windowed text", () => {
  const h = parseHit(turn({ content: "we should search CMUX_PARITY before answering" }), "cmux_parity");
  assert.ok(h);
  assert.equal(h!.role, "user");
  assert.equal(h!.sessionId, "sess-aaaa");
  assert.equal(h!.uuid, "uuid-0001");
  assert.match(h!.text, /CMUX_PARITY/);
});
test("parseHit: assistant array content — only text blocks are searched", () => {
  const content = [
    { type: "thinking", thinking: "internal note about engine trio" },
    { type: "text", text: "The engine trio is resolved." },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
  ];
  const h = parseHit(turn({ role: "assistant", content }), "engine trio");
  assert.ok(h);
  assert.match(h!.text, /engine trio is resolved/i);
});
test("parseHit: match only in a thinking block is dropped (noise, not conversation)", () => {
  const content = [{ type: "thinking", thinking: "secret_plan engine trio" }, { type: "text", text: "done" }];
  assert.equal(parseHit(turn({ role: "assistant", content }), "engine trio"), null);
});
test("parseHit: match only in tool_use is dropped", () => {
  const content = [{ type: "tool_use", name: "Bash", input: { command: "grep engine trio" } }];
  assert.equal(parseHit(turn({ role: "assistant", content }), "engine trio"), null);
});
test("parseHit: --role filter drops the other role", () => {
  assert.equal(parseHit(turn({ role: "assistant", content: "engine trio" }), "engine trio", { role: "user" }), null);
  assert.ok(parseHit(turn({ role: "user", content: "engine trio" }), "engine trio", { role: "user" }));
});
test("parseHit: --since filter drops older records, keeps newer", () => {
  const sinceMs = Date.parse("2026-06-14");
  const older = turn({ timestamp: "2026-06-10T00:00:00.000Z", content: "engine trio" });
  const newer = turn({ timestamp: "2026-06-15T00:00:00.000Z", content: "engine trio" });
  assert.equal(parseHit(older, "engine trio", { sinceMs }), null);
  assert.ok(parseHit(newer, "engine trio", { sinceMs }));
});
test("parseHit: a ripgrep `path:{json}` prefix is stripped before parsing", () => {
  const raw = `/Users/x/.claude/projects/-slug/sess.jsonl:${turn({ content: "engine trio decision" })}`;
  const h = parseHit(raw, "engine trio");
  assert.ok(h);
  assert.match(h!.text, /engine trio/);
});
test("parseHit: secrets in the matched text are redacted in the hit", () => {
  const h = parseHit(turn({ content: "ran export API_KEY=topsecret1234 to engine trio" }), "engine trio");
  assert.ok(h);
  assert.match(h!.text, /API_KEY=‹redacted›/);
  assert.doesNotMatch(h!.text, /topsecret1234/);
});
test("parseHit: malformed JSON and non-conversation records return null", () => {
  assert.equal(parseHit("not json at all", "x"), null);
  assert.equal(parseHit(line({ type: "file-history-snapshot", messageId: "m" }), "x"), null);
});

// ── ranking / caps ────────────────────────────────────────────────────────────
test("rankHits: newest-first, capped per session then overall", () => {
  const mk = (sessionId: string, ts: string): TranscriptHit => ({ sessionId, uuid: ts, parentUuid: null, timestamp: ts, role: "user", text: "x" });
  const hits = [
    mk("a", "2026-06-01T00:00:00Z"),
    mk("a", "2026-06-03T00:00:00Z"),
    mk("a", "2026-06-02T00:00:00Z"),
    mk("a", "2026-06-04T00:00:00Z"),
    mk("b", "2026-06-05T00:00:00Z"),
  ];
  const ranked = rankHits(hits, { perFileCap: 2, overallCap: 10 });
  assert.equal(ranked[0]!.timestamp, "2026-06-05T00:00:00Z"); // newest first
  assert.equal(ranked.filter((h) => h.sessionId === "a").length, 2); // per-file cap honored
  assert.equal(ranked.length, 3);
  assert.equal(rankHits(hits, { overallCap: 2 }).length, 2); // overall cap honored
});
test("rankHits: duplicate JSONL records (same session+uuid) collapse to one", () => {
  const dup: TranscriptHit = { sessionId: "a", uuid: "u1", parentUuid: null, timestamp: "2026-06-01T00:00:00Z", role: "user", text: "x" };
  const ranked = rankHits([dup, { ...dup }, { ...dup }], { perFileCap: 5, overallCap: 10 });
  assert.equal(ranked.length, 1);
});

// ── context expansion ─────────────────────────────────────────────────────────
test("buildContext: walks the parentUuid chain, N before/after, marks the hit", () => {
  const lines = [
    turn({ uuid: "u1", parentUuid: null, timestamp: "2026-06-15T10:00:00Z", content: "first" }),
    turn({ uuid: "u2", parentUuid: "u1", timestamp: "2026-06-15T10:01:00Z", role: "assistant", content: [{ type: "text", text: "second" }] }),
    turn({ uuid: "u3", parentUuid: "u2", timestamp: "2026-06-15T10:02:00Z", content: "third HIT here" }),
    turn({ uuid: "u4", parentUuid: "u3", timestamp: "2026-06-15T10:03:00Z", role: "assistant", content: [{ type: "text", text: "fourth" }] }),
    turn({ uuid: "u5", parentUuid: "u4", timestamp: "2026-06-15T10:04:00Z", content: "fifth" }),
  ];
  const turns = buildContext(lines, "u3", 1);
  assert.deepEqual(turns.map((t) => t.uuid), ["u2", "u3", "u4"]);
  assert.equal(turns.find((t) => t.isHit)!.uuid, "u3");
});
test("buildContext: an unknown uuid prefix yields no turns", () => {
  assert.deepEqual(buildContext([turn({ uuid: "u1" })], "nope", 2), []);
});

// ── display helper ────────────────────────────────────────────────────────────
test("fmtDate: ISO → minute-resolution display, empty → placeholder", () => {
  assert.equal(fmtDate("2026-05-23T13:53:07.548Z"), "2026-05-23 13:53");
  assert.equal(fmtDate(""), "????-??-?? ??:??");
});
