// Pure decision logic for the `fleet captain` / `fleet orchestrate` command:
// flag validation, the no-name `--resume` error, the resume-command choice
// (`--resume <id>` vs `--continue`), and the in-pane manual relaunch recipe.
//
// Extracted from cli.ts/orchestrate.ts so the safety rules (issues #36, #37)
// are unit-testable without spawning cmux workspaces. Kept dependency-free.

/** Flags the captain/orchestrate path accepts; anything else is rejected so an
 *  unknown flag (e.g. `--help` typo, `--continue`) can't spawn a stray Captain. */
export const KNOWN_CAPTAIN_FLAGS = new Set([
  "resume",
  "split",
  "no-daemon",
  "model",
  "command",
  "close-origin",
  "print",
  "help",
  "h",
]);

/** Flag keys not in the known set. Empty array = all flags recognized. */
export function unknownCaptainFlags(flagKeys: string[]): string[] {
  return flagKeys.filter((k) => !KNOWN_CAPTAIN_FLAGS.has(k));
}

export const CAPTAIN_HELP = `fleet captain|orchestrate [name] [options] — appoint/steer a Fleet Captain

  fleet captain <name>            Appoint a fresh Captain in a new badged workspace
  fleet captain <name> --resume   Re-appoint an EXISTING Captain, keeping her conversation
  fleet captain --split           Add a fresh sibling Captain in a split pane (2×2 quadrant)

Options:
  --resume                Re-appoint an existing Captain (requires an explicit <name>)
  --split                 Spawn a fresh sibling Captain in a split pane of the focused workspace
  --model <model>         Pin the Captain's model (e.g. claude-fable-5)
  --no-daemon             Don't ensure the shared heartbeat daemon
  --command <cmd>         Override the launched program (testing / non-claude)
  --close-origin          (--split) close the origin runner tab after splitting
  --print                 (--resume) print the in-pane manual relaunch command; touch nothing
  -h, --help              Show this help`;

/** A live Captain on record (name + fleet session) — what the no-name resume
 *  error lists so the user can pick one. */
export interface CaptainListing {
  name: string;
  session: string;
}

/**
 * The error for a bare `--resume` with no name (#36): it must NOT default to
 * "Captain" (that forked the live Captain's conversation). List the live
 * captains and the exact command to resume each.
 */
export function noNameResumeError(live: CaptainListing[]): string {
  const head = `--resume needs an explicit Captain name (it must not default to "Captain" — that forks a live conversation).`;
  if (live.length === 0) {
    return `${head}\nNo live captains found. Start one with \`fleet captain <name>\`.`;
  }
  const lines = live.map((c) => `  fleet captain ${c.name} --resume   (fleet session "${c.session}")`);
  return `${head}\nLive captains — resume one explicitly:\n${lines.join("\n")}`;
}

/**
 * Choose the resume argument for the launched `claude` command. With a resolved
 * session id, target it exactly (`--resume <id>`); without one, fall back to
 * `--continue` but return a loud warning — `--continue` resolves the most recent
 * conversation in the cwd, which forks the wrong one when Captains share $HOME.
 * Returns the arg with a trailing space so it slots straight into the command.
 */
export function captainResumeArg(sessionId: string | undefined): { arg: string; warning?: string } {
  if (sessionId) return { arg: `--resume '${sessionId}' ` };
  return {
    arg: "--continue ",
    warning:
      "no Claude session id on record for this Captain — falling back to `claude --continue`, " +
      "which resumes the MOST RECENT conversation in this directory. When multiple Claude sessions " +
      "share the cwd (all Captains launch in $HOME) this can fork the WRONG conversation. " +
      "Resume by id once the session is recorded (it lands in the durable map after the Captain runs).",
  };
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_/.:=@%^+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The in-pane manual relaunch recipe (#36 bonus): the command to Ctrl-C the
 * Captain pane and relaunch in place — the path that worked in the incident,
 * versus detached automation (which hits the cmux socket broken-pipe bug, #41).
 * Uses `--resume <id>` when known, else `--continue` with the same caveat baked
 * in as a comment so a pasted recipe still warns.
 */
export function inPaneResumeRecipe(opts: {
  session: string;
  cwd: string;
  sessionId?: string;
  promptPath: string;
  model?: string;
}): string {
  const resumeArg = opts.sessionId ? `--resume ${shellQuote(opts.sessionId)}` : "--continue";
  const parts = [
    `cd ${shellQuote(opts.cwd)} &&`,
    `exec env FLEET_SESSION=${shellQuote(opts.session)}`,
    "claude",
    resumeArg,
    `--remote-control ${shellQuote(opts.session)}`,
  ];
  if (opts.model) parts.push(`--model ${shellQuote(opts.model)}`);
  parts.push(`--append-system-prompt-file ${shellQuote(opts.promptPath)}`);
  const cmd = parts.join(" ");
  if (opts.sessionId) return cmd;
  return `# WARNING: no session id on record — \`--continue\` may resume the wrong conversation if Captains share this cwd.\n${cmd}`;
}
