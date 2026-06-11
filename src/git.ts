// Minimal git worktree helpers — used to isolate parallel writers so workers on
// the same repo don't clobber each other. Each isolated worker gets its own
// worktree on a `fleet/<label>` branch; branches are left for review/merge.
import { execFileSync } from "node:child_process";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The git toplevel for a directory, or undefined if it isn't a repo. */
export function repoRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

export function currentBranch(repo: string): string {
  try {
    return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return "HEAD";
  }
}

/** Create a worktree at `path` on a new branch off current HEAD. */
export function addWorktree(repo: string, path: string, branch: string): void {
  git(repo, ["worktree", "add", path, "-b", branch]);
}

/** Remove a worktree (branch is preserved for review). */
export function removeWorktree(repo: string, path: string): void {
  try {
    git(repo, ["worktree", "remove", path, "--force"]);
  } catch {
    // already gone / locked — best effort
  }
}

/** Fails CLOSED: a `git status` error reports "changes present", so a caller
 *  (kill) never force-removes a tree whose state can't be confirmed clean. */
export function hasChanges(worktree: string): boolean {
  try {
    return git(worktree, ["status", "--porcelain"]).length > 0;
  } catch {
    return true;
  }
}

/** Stage + commit everything in a worktree so nothing is lost on teardown. */
export function commitAll(worktree: string, message: string): void {
  try {
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", message]);
  } catch {
    // nothing to commit / commit failed — best effort
  }
}

// ── Update-channel helpers (used by `fleet update` + doctor's install report) ──

/** Resolved HEAD sha, or "" if it can't be read. */
export function headSha(repo: string): string {
  try {
    return git(repo, ["rev-parse", "HEAD"]);
  } catch {
    return "";
  }
}

/** Short sha for display. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Fetch a single branch with a bounded network time (abort if the transfer
 * stalls under 1KB/s for 5s) so an offline/slow remote can't hang the command.
 * Returns true on success.
 */
export function fetchBranch(repo: string, remote = "origin", branch = "main"): boolean {
  try {
    execFileSync("git", ["-C", repo, "fetch", "--quiet", remote, branch], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "5" },
    });
    return true;
  } catch {
    return false;
  }
}

/** Ahead/behind counts of HEAD relative to `upstream` (e.g. "origin/main"). */
export function aheadBehind(repo: string, upstream: string): { ahead: number; behind: number } | undefined {
  try {
    const out = git(repo, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behind, ahead] = out.split(/\s+/).map((n) => Number(n));
    if (behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) return undefined;
    return { ahead, behind };
  } catch {
    return undefined;
  }
}

/** Fast-forward pull of a single branch. Throws on conflict / non-ff. */
export function pullFfOnly(repo: string, remote = "origin", branch = "main"): void {
  git(repo, ["pull", "--ff-only", "--quiet", remote, branch]);
}

/** Repo-relative paths that differ between two revisions. */
export function changedFiles(repo: string, from: string, to: string): string[] {
  try {
    return git(repo, ["diff", "--name-only", from, to]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Added lines in a file's diff between two revisions (without the leading "+"). */
export function addedLines(repo: string, from: string, to: string, file: string): string[] {
  try {
    return git(repo, ["diff", `${from}..${to}`, "--", file])
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1));
  } catch {
    return [];
  }
}
