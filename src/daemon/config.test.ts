// Regression test for Bug 3 (bughunt 2026-06-13): acquireSharedLock created the
// lock with O_EXCL then wrote the pid in a SEPARATE syscall, leaving an empty-pid
// window. A racing process read "" → pid undefined → skipped the live-owner guard
// → deleted the in-progress lock and won, so TWO shared daemons both passed the
// single-instance guard. The fix: write the pid in one O_EXCL write, and on an
// empty/partial pid WAIT (don't break a fresh lock) unless it has aged out —
// porting registry.ts's hardened guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSharedLock, sharedPidPath, releaseSharedLock } from "./config.js";

function withTempHome(fn: () => void): void {
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "fleet-daemon-"));
  process.env.HOME = home; // redirects fleetHome() → <home>/.fleet
  try {
    mkdirSync(join(home, ".fleet"), { recursive: true });
    fn();
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("acquireSharedLock: a FRESH empty (mid-write) lock is not broken — the racer waits", () => {
  withTempHome(() => {
    // Holder A between O_EXCL create and pid write: the file exists but is empty,
    // and was just created (fresh mtime).
    writeFileSync(sharedPidPath(), "");
    // Racer B must NOT win by deleting A's in-progress lock (that double-starts
    // the shared daemon — the bug).
    assert.equal(acquireSharedLock(), false, "a fresh empty lock blocks the racer (fail closed)");
    assert.ok(existsSync(sharedPidPath()), "A's in-progress lock is preserved, not deleted");
    assert.equal(readFileSync(sharedPidPath(), "utf8"), "", "B did not overwrite it with its own pid");
  });
});

test("acquireSharedLock: a STALE empty lock IS broken so a dead holder never wedges startup", () => {
  withTempHome(() => {
    writeFileSync(sharedPidPath(), "");
    const old = Date.now() / 1000 - 3600; // 1h ago — well past STALE_LOCK_MS
    utimesSync(sharedPidPath(), old, old);
    assert.equal(acquireSharedLock(), true, "an aged-out empty lock is reclaimed");
    assert.equal(readFileSync(sharedPidPath(), "utf8"), String(process.pid), "winner wrote its own pid");
    releaseSharedLock();
  });
});

test("acquireSharedLock: an uncontended claim writes our pid in one shot (no empty window)", () => {
  withTempHome(() => {
    assert.equal(acquireSharedLock(), true);
    assert.equal(readFileSync(sharedPidPath(), "utf8"), String(process.pid), "lock carries the pid immediately");
    releaseSharedLock();
    assert.equal(existsSync(sharedPidPath()), false, "release removes our own lock");
  });
});
