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
