// Unit tests for the registry's per-session mutation lock (S1) and the
// field-preservation guarantee it exists for. The registry path derives from
// HOME + FLEET_SESSION, so each test points both at a fresh tmp dir.
// Run with `npm test`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRegistryLock,
  releaseRegistryLock,
  upsert,
  patch,
  getAgent,
  remove,
  type Agent,
} from "./registry.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fleet-registry-"));
  process.env.HOME = home; // homedir() honors $HOME on POSIX
  process.env.FLEET_SESSION = "lock-test";
  mkdirSync(join(home, ".fleet"), { recursive: true });
});

const lockPath = () => join(home, ".fleet", "lock-test.lock");

// Tight timings so contention tests don't stall the suite.
const FAST = { retryMs: 5, staleMs: 200, waitBudgetMs: 60 };

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: "a1",
    label: "worker",
    workspace: "workspace:1",
    surface: "surface:1",
    cwd: "/tmp",
    model: "default",
    mode: "auto",
    task: "test task",
    ownsWorkspace: true,
    status: "running",
    spawnedAt: "2026-06-09T00:00:00.000Z",
    lastDispatchAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

test("acquire creates the lock with our pid; release removes it", () => {
  assert.equal(acquireRegistryLock(lockPath(), FAST), true);
  assert.equal(readFileSync(lockPath(), "utf8"), String(process.pid));
  releaseRegistryLock(lockPath());
  assert.equal(existsSync(lockPath()), false);
});

test("a live foreign holder blocks acquisition until the wait budget runs out", () => {
  // ppid is a real, live process that isn't us — an unbreakable fresh lock.
  writeFileSync(lockPath(), String(process.ppid));
  assert.equal(acquireRegistryLock(lockPath(), FAST), false);
  assert.equal(readFileSync(lockPath(), "utf8"), String(process.ppid)); // untouched
});

test("a dead holder's lock is broken and re-acquired", () => {
  const child = spawnSync(process.execPath, ["-e", ""]); // exits immediately
  assert.ok(child.pid && child.pid > 0);
  writeFileSync(lockPath(), String(child.pid));
  assert.equal(acquireRegistryLock(lockPath(), FAST), true);
  assert.equal(readFileSync(lockPath(), "utf8"), String(process.pid));
});

test("a lock older than staleMs is broken even if its holder pid is alive", () => {
  writeFileSync(lockPath(), String(process.ppid));
  const old = (Date.now() - 1_000) / 1000; // seconds, 1s > staleMs of 200ms
  utimesSync(lockPath(), old, old);
  assert.equal(acquireRegistryLock(lockPath(), FAST), true);
});

test("release does not remove a lock owned by someone else", () => {
  writeFileSync(lockPath(), String(process.ppid));
  releaseRegistryLock(lockPath());
  assert.equal(existsSync(lockPath()), true);
});

test("patch preserves unrelated fields across writers (the S1 lost update)", () => {
  upsert(agent({ proofs: [{ kind: "test", ref: "npm test", attachedAt: "2026-06-09T01:00:00.000Z" }] }));
  // Writer A: daemon status beat. Writer B: send() dispatch stamp.
  patch("a1", { status: "idle", lastSeen: "2026-06-09T02:00:00.000Z" });
  patch("a1", { lastDispatchAt: "2026-06-09T03:00:00.000Z" });
  const a = getAgent("a1");
  assert.ok(a);
  assert.equal(a.status, "idle");
  assert.equal(a.lastSeen, "2026-06-09T02:00:00.000Z");
  assert.equal(a.lastDispatchAt, "2026-06-09T03:00:00.000Z");
  assert.equal(a.proofs?.length, 1); // not clobbered by either patch
});

test("mutators release the lock when done (no leftover blocks the next write)", () => {
  upsert(agent());
  assert.equal(existsSync(lockPath()), false);
  patch("a1", { status: "dead" });
  remove("a1");
  assert.equal(existsSync(lockPath()), false);
  assert.equal(getAgent("a1"), undefined);
});

test("patch on an unknown agent is a no-op and still releases the lock", () => {
  patch("nope", { status: "dead" });
  assert.equal(existsSync(lockPath()), false);
  assert.equal(getAgent("nope"), undefined);
});
