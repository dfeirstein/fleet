// `fleet update` — explicit, foreground sibling of the bin/fleet auto-updater.
// Pulls main ff-only, reinstalls deps only when the lockfile moved, prints the
// CHANGELOG section headers gained, and restarts the daemon if it's running so
// the supervisor runs current code. Refuses on a dirty tree or non-main branch.
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { currentBranch, hasChanges, headSha, shortSha, fetchBranch, pullFfOnly, changedFiles, addedLines } from "../git.js";
import { lockfileChanged } from "../autoupdate.js";
import { sharedDaemonRunning } from "../daemon/config.js";
import { daemonStop, daemonStart } from "./daemon.js";

/** The fleet checkout root (src/commands/update.ts → ../../). */
function repoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
}

export interface UpdateResult {
  ok: boolean;
  message: string;
}

export function update(): UpdateResult {
  const repo = repoRoot();

  const branch = currentBranch(repo);
  if (branch !== "main") {
    return { ok: false, message: `refusing to update: on branch '${branch}', not main (switch to main or pull manually)` };
  }
  if (hasChanges(repo)) {
    return { ok: false, message: "refusing to update: working tree has uncommitted changes (commit/stash them first)" };
  }

  console.log("fleet update — fetching origin/main…");
  if (!fetchBranch(repo, "origin", "main")) {
    return { ok: false, message: "could not reach origin (offline?) — nothing changed" };
  }

  const old = headSha(repo);
  try {
    pullFfOnly(repo, "origin", "main");
  } catch (err) {
    return { ok: false, message: `ff-only pull failed (history diverged?): ${(err as Error).message}` };
  }
  const next = headSha(repo);

  if (old && next && old === next) {
    return { ok: true, message: "already current — no update available" };
  }

  console.log(`updated ${shortSha(old)} → ${shortSha(next)}`);

  // CHANGELOG delta: the date/section headers gained between the two HEADs.
  const headers = addedLines(repo, old, next, "CHANGELOG.md").filter((l) => /^#{2,3}\s/.test(l));
  if (headers.length) {
    console.log("\nCHANGELOG since your last version:");
    for (const h of headers) console.log(`  ${h}`);
    console.log("");
  }

  // Reinstall deps only when the pull actually moved the lockfile.
  if (lockfileChanged(changedFiles(repo, old, next))) {
    console.log("package-lock.json changed — running npm ci…");
    try {
      execFileSync("npm", ["ci", "--silent"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
    } catch {
      return { ok: false, message: "updated code, but `npm ci` failed — fix deps before running fleet" };
    }
  }

  // Keep the always-on supervisor on current code.
  if (sharedDaemonRunning()) {
    console.log("daemon is running — restarting it on the new code…");
    daemonStop();
    daemonStart();
  }

  return { ok: true, message: `fleet is now current at ${shortSha(next)}` };
}
