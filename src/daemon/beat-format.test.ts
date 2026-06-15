// Pure-formatter tests for the consolidated daemon beat line. node:test; `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBeatLine,
  formatUptime,
  bucketOf,
  countWorkers,
  emptyCounts,
  type CaptainBeatSummary,
  type BeatLineModel,
} from "./beat-format.js";

function cap(session: string, partial: Partial<CaptainBeatSummary> = {}): CaptainBeatSummary {
  return { session, counts: emptyCounts(), actions: {}, ...partial };
}

function model(partial: Partial<BeatLineModel> = {}): BeatLineModel {
  return { beat: 1, uptimeMs: 0, captains: [], at: "14:23:07", ...partial };
}

test("bucketOf maps the 9-status union onto the 7 display buckets", () => {
  assert.equal(bucketOf("running"), "running");
  assert.equal(bucketOf("unknown"), "running"); // booting counts as active
  assert.equal(bucketOf("idle"), "idle");
  assert.equal(bucketOf("undispatched"), "idle"); // spawned, not yet sent
  assert.equal(bucketOf("rate-limited"), "rateLimited");
  assert.equal(bucketOf("blocked-on-you"), "blocked");
  assert.equal(bucketOf("awaiting-input"), "awaitingInput");
  assert.equal(bucketOf("error"), "error");
  assert.equal(bucketOf("dead"), "dead");
});

test("countWorkers tallies a status list into buckets", () => {
  const c = countWorkers(["running", "running", "idle", "unknown", "undispatched", "error"]);
  assert.equal(c.running, 3); // 2 running + 1 unknown
  assert.equal(c.idle, 2); // 1 idle + 1 undispatched
  assert.equal(c.error, 1);
  assert.equal(c.dead, 0);
});

test("two captains with different mixes: both segments present, attributed, only non-zero", () => {
  const line = formatBeatLine(
    model({
      beat: 12,
      uptimeMs: 47 * 60_000,
      captains: [
        cap("yoshi", { counts: { ...emptyCounts(), running: 2, idle: 1 } }),
        cap("yoshi-3", { counts: { ...emptyCounts(), rateLimited: 1, error: 1 } }),
      ],
    }),
  );
  // Captains now lead the line (right after the beat number), uptime trails them.
  assert.match(line, /\[daemon\] beat 12 · yoshi 2r 1i · yoshi-3 1L 1e · 47m/);
  assert.match(line, /yoshi 2r 1i/); // attributed, only non-zero statuses
  assert.match(line, /yoshi-3 1L 1e/);
  assert.ok(!/0[riLbaed]/.test(line), "no zero-count buckets leak into a segment");
  assert.match(line, /· 14:23:07$/);
});

test("captains render oldest-first by declaredAt (the OG Captain leads), regardless of input order", () => {
  // yoshi-3 is newer but listed first in the input (record-load order) — the
  // older yoshi must still lead the rendered line.
  const line = formatBeatLine(
    model({
      captains: [
        cap("yoshi-3", { counts: { ...emptyCounts(), idle: 1 }, declaredAt: "2026-06-15T22:00:00Z" }),
        cap("yoshi", { counts: { ...emptyCounts(), idle: 1 }, declaredAt: "2026-06-11T00:00:00Z" }),
      ],
    }),
  );
  assert.ok(line.indexOf("yoshi 1i") < line.indexOf("yoshi-3 1i"), "older yoshi appears before newer yoshi-3");
});

test("missing declaredAt sorts last, with a deterministic tiebreak on session name", () => {
  const line = formatBeatLine(
    model({
      captains: [
        cap("zelda", {}), // no declaredAt → sorts last
        cap("yoshi", {}), // no declaredAt → sorts last; tiebreak by name before zelda
        cap("link", { declaredAt: "2026-06-11T00:00:00Z" }), // has declaredAt → leads
      ],
    }),
  );
  const iLink = line.indexOf("link idle");
  const iYoshi = line.indexOf("yoshi idle");
  const iZelda = line.indexOf("zelda idle");
  assert.ok(iLink < iYoshi && iLink < iZelda, "the dated captain leads the undated ones");
  assert.ok(iYoshi < iZelda, "undated captains tiebreak by session name (yoshi before zelda)");
});

test("captain segments sit BEFORE the uptime token (a narrow pane clips the time, not a captain)", () => {
  const line = formatBeatLine(
    model({
      beat: 20,
      uptimeMs: 3 * 60_000,
      captains: [
        cap("yoshi", { declaredAt: "2026-06-11T00:00:00Z" }),
        cap("yoshi-3", { declaredAt: "2026-06-15T22:00:00Z" }),
      ],
    }),
  );
  // [daemon] beat 20 · yoshi idle · yoshi-3 idle · 3m · 14:23:07
  assert.equal(line, "[daemon] beat 20 · yoshi idle · yoshi-3 idle · 3m · 14:23:07");
  assert.ok(line.indexOf("yoshi idle") < line.indexOf(" 3m "), "captains precede the uptime");
  assert.ok(line.indexOf(" 3m ") < line.indexOf("14:23:07"), "uptime precedes the timestamp");
});

test("captain with zero workers reads 'idle' (the word), never a bare 0", () => {
  const line = formatBeatLine(model({ captains: [cap("yoshi-3")] }));
  assert.match(line, /yoshi-3 idle/);
  assert.ok(!/yoshi-3 0/.test(line), "no bare 0 for an empty captain");
});

test("a captain's lone idle worker renders '1i', distinct from the empty-captain 'idle'", () => {
  const line = formatBeatLine(model({ captains: [cap("yoshi", { counts: { ...emptyCounts(), idle: 1 } })] }));
  assert.match(line, /yoshi 1i/);
});

test("actions present (self-heal + redispatch + wave) → actions segment renders", () => {
  const line = formatBeatLine(
    model({
      captains: [
        cap("yoshi", {
          counts: { ...emptyCounts(), running: 1 },
          actions: { selfHeal: 1, redispatch: 1, waveComplete: true },
        }),
      ],
    }),
  );
  assert.match(line, /⚡ self-heal 1 · redispatch 1 · wave✓/);
});

test("actions all zero → actions segment absent (steady-state stays clean)", () => {
  const line = formatBeatLine(model({ captains: [cap("yoshi", { counts: { ...emptyCounts(), running: 1 } })] }));
  assert.ok(!line.includes("⚡"), "quiet beat carries no actions segment");
});

test("actions roll up across captains (sum + any-wave)", () => {
  const line = formatBeatLine(
    model({
      captains: [
        cap("a", { actions: { redispatch: 1, alerts: 1 } }),
        cap("b", { actions: { redispatch: 2, donePass: 1, doneExhausted: 1 } }),
      ],
    }),
  );
  assert.match(line, /redispatch 3/); // 1 + 2
  assert.match(line, /done-pass 1/);
  assert.match(line, /done-exhausted 1/);
  assert.match(line, /alert 1/);
});

test("telemetry: spinning/high-cpu → 'cpu …⚠'; unhealthy → 'surface⚠'; clean → absent", () => {
  const spin = formatBeatLine(
    model({ captains: [cap("yoshi", { counts: { ...emptyCounts(), running: 1 }, spinning: true, cpuMaxPct: 142.4 })] }),
  );
  assert.match(spin, /cpu 142%⚠/); // rounded

  const sick = formatBeatLine(model({ captains: [cap("yoshi", { unhealthy: true })] }));
  assert.match(sick, /surface⚠/);

  // A cpuMaxPct without spinning is NOT notable — no telemetry segment.
  const calm = formatBeatLine(
    model({ captains: [cap("yoshi", { counts: { ...emptyCounts(), running: 1 }, cpuMaxPct: 30 })] }),
  );
  assert.ok(!calm.includes("⚠"), "a non-spinning cpu sample is not flagged");
  assert.ok(!calm.includes("cpu"), "no cpu telemetry on a calm beat");
});

test("empty fleet → 'no captains'", () => {
  const line = formatBeatLine(model({ beat: 3, uptimeMs: 8_000 }));
  assert.equal(line, "[daemon] beat 3 · no captains · 8s · 14:23:07");
});

test("long fleet (>6 captains) → '+N more', and no captain is silently dropped", () => {
  const captains = Array.from({ length: 8 }, (_, i) => cap(`c${i}`, { counts: { ...emptyCounts(), idle: 1 } }));
  const line = formatBeatLine(model({ captains }));
  assert.match(line, /\+2 more/); // 8 - 6 shown
  // Every captain accounted for: 6 rendered segments + the 2 in "+2 more" = 8.
  const shown = captains.filter((c) => line.includes(`${c.session} `)).length;
  const more = Number(/\+(\d+) more/.exec(line)?.[1]);
  assert.equal(shown + more, 8, "tail count covers exactly the captains not shown");
  assert.equal(shown, 6);
});

test("color gating: non-TTY (default) emits NO ANSI escape codes", () => {
  const line = formatBeatLine(
    model({
      captains: [
        cap("yoshi", {
          counts: { ...emptyCounts(), error: 1 },
          spinning: true,
          cpuMaxPct: 200,
          unhealthy: true,
          actions: { alerts: 2 },
        }),
        cap("z", { beatError: true }),
      ],
    }),
  );
  assert.ok(!line.includes("\x1b"), "piped/default output is clean monochrome");
});

test("color on: ANSI present, and stripping it yields the same monochrome text", () => {
  const m = model({ beat: 9, uptimeMs: 90_000, captains: [cap("yoshi", { unhealthy: true })] });
  const colored = formatBeatLine(m, { color: true });
  const plain = formatBeatLine(m, { color: false });
  assert.ok(colored.includes("\x1b"), "color:true emits ANSI");
  assert.equal(colored.replace(/\x1b\[[0-9]*m/g, ""), plain, "stripped ANSI == monochrome");
});

test("errored captain is rendered, not dropped", () => {
  const line = formatBeatLine(model({ captains: [cap("yoshi", { counts: { ...emptyCounts(), running: 1 } }), cap("z", { beatError: true })] }));
  assert.match(line, /yoshi 1r/);
  assert.match(line, /z ✗beat-error/);
});

test("uptime formats across s / m / h", () => {
  assert.equal(formatUptime(8_000), "8s");
  assert.equal(formatUptime(59_000), "59s");
  assert.equal(formatUptime(47 * 60_000), "47m");
  assert.equal(formatUptime(60 * 60_000), "1h");
  assert.equal(formatUptime(2 * 3_600_000 + 13 * 60_000), "2h13m");
  assert.equal(formatUptime(-5), "0s"); // clamps negatives
});

test("beat number appears in the head", () => {
  assert.match(formatBeatLine(model({ beat: 42, captains: [cap("yoshi")] })), /\[daemon\] beat 42 ·/);
});
