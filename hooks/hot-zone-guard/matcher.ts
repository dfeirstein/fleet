/**
 * hot-zone-guard — pure decision core.
 *
 * A `PreToolUse` hook is the only *rule* an agent can't ignore (doctrine:
 * "A request is not a rule"). This matcher BLOCKS only **unambiguous**
 * catastrophic patterns — the NEVER-without-a-hard-block tier: force-push to
 * main, `rm -rf` of $HOME / `/`, destructive SQL (DROP DATABASE/TABLE,
 * TRUNCATE), `git reset --hard origin/main`, and writes to obvious secret
 * files. It is deliberately CONSERVATIVE: a false-positive that blocks normal
 * dev is worse than a missed edge, so each rule is narrow and pattern-anchored.
 * This is a STARTER to tune, not a complete policy.
 */

export type GuardDecision =
  | { block: false }
  | { block: true; reason: string };

/** Normalize whitespace so spacing variants don't slip a pattern. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip shell quote chars (incl. mid-token like `"${HOME}"/*`), and `${VAR}` → `$VAR`. */
function unquote(s: string): string {
  return s.replace(/['"]/g, "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "$$$1");
}

// `git` allows global options between the binary and the subcommand
// (`git -C <path> push`, `git -c k=v push`, `git --git-dir=… push`, `-p`, …).
// Tolerate an optional run of such tokens before `push`/`reset`.
const GIT_GLOBAL_OPT = "(?:-[A-Za-z]\\s+\\S+|--[A-Za-z-]+(?:=\\S+)?|-[A-Za-z]+)\\s+";
const GIT_PUSH = new RegExp(`\\bgit\\s+(?:${GIT_GLOBAL_OPT})*push\\b`);
const GIT_RESET_HARD = new RegExp(`\\bgit\\s+(?:${GIT_GLOBAL_OPT})*reset\\s+--hard\\b`);

/** Does the command contain a `git push` (allowing global opts) with a force flag or `+` refspec? */
function isGitPushForce(cmd: string): boolean {
  if (!GIT_PUSH.test(cmd)) return false;
  // --force, --force-with-lease, or a bundled/standalone -f.
  if (/--force(-with-lease)?\b/.test(cmd) || /(^|\s)-[A-Za-z]*f[A-Za-z]*\b/.test(cmd)) return true;
  // A leading `+` on the pushed refspec is a force update (`+main`, `+HEAD:main`,
  // `+refs/heads/main`). Scoped to a refspec touching main so a bare `+` elsewhere can't match.
  return /\s\+(?:[\w./-]+:)?(?:refs\/heads\/)?main\b/.test(cmd);
}

/** Force-push that targets main (named branch, or `origin main`, or HEAD:main). */
function targetsMain(cmd: string): boolean {
  return (
    /\borigin\s+main\b/.test(cmd) ||
    /\bmain\b/.test(cmd) ||
    /:main\b/.test(cmd) ||
    /\bHEAD:main\b/.test(cmd)
  );
}

/** Is `tok` (already unquoted) a catastrophic rm target — home/root or home+immediate glob? */
function isCatastrophicRmTarget(tok: string): boolean {
  // Home root, the / root, and `/*` — plus home + a trailing slash or immediate glob
  // (`$HOME/`, `~/*`, `$HOME/*`). A NAMED subpath like `~/project/dist` stays allowed.
  return /^(?:~|\$HOME|\/|\/\*)$/.test(tok) || /^(?:~|\$HOME)\/\*?$/.test(tok);
}

/** `rm -rf` (any flag order) whose target is $HOME (~ or $HOME) or / root. */
function isCatastrophicRm(cmd: string): boolean {
  // Require an `rm` with both recursive + force somewhere in its flags.
  const rmMatch = cmd.match(/\brm\s+(-[A-Za-z]*\s+)*-?[A-Za-z]*/);
  if (!rmMatch) return false;
  const hasRecursiveForce =
    /\brm\b[^\n|;&]*-[A-Za-z]*r[A-Za-z]*f|\brm\b[^\n|;&]*-[A-Za-z]*f[A-Za-z]*r|\brm\b[^\n|;&]*(-r\b[^\n|;&]*-f\b|-f\b[^\n|;&]*-r\b)/.test(
      cmd,
    );
  if (!hasRecursiveForce) return false;
  // Test each whitespace-separated token of the rm command, unquoting first so
  // `"$HOME"`, `'~'`, `"/"`, `"${HOME}"/*` are caught the same as their bare forms.
  const rmSegment = cmd.slice(rmMatch.index ?? 0).split(/[\n|;&]/)[0] ?? "";
  return rmSegment.split(/\s+/).some((raw) => isCatastrophicRmTarget(unquote(raw)));
}

/** Destructive SQL: DROP DATABASE / DROP TABLE / TRUNCATE (case-insensitive). */
function isDestructiveSql(cmd: string): boolean {
  // Strip SQL block comments (`DROP /*x*/ TABLE`) for the SQL test only, so a
  // comment wedged between keywords can't break the adjacency requirement.
  const s = cmd.replace(/\/\*[\s\S]*?\*\//g, " ");
  return /\bDROP\s+DATABASE\b/i.test(s) || /\bDROP\s+TABLE\b/i.test(s) || /\bTRUNCATE\s+(TABLE\s+)?\w/i.test(s);
}

/** `git reset --hard` against a remote tracking ref (origin/main, upstream/main et al.). */
function isHardResetToRemote(cmd: string): boolean {
  if (!GIT_RESET_HARD.test(cmd)) return false;
  // CONVENTIONAL remote names only — generalizing to any `<word>/<word>` would
  // wrongly block the legitimate local-branch reset `git reset --hard feature/foo`.
  // Also accept `remotes/<name>/…` and `refs/remotes/<name>/…` prefixes.
  return /--hard\s+(?:refs\/)?(?:remotes\/)?(?:origin|upstream|remote|fork)\/\w+/.test(cmd);
}

/** Obvious secret-file targets a Write/Edit/shell redirect must not clobber. */
function isSecretPath(p: string): boolean {
  // macOS default FS is case-insensitive: lowercase the basename so `server.PEM`
  // and `.ENV.local` read as secrets. The `.example`/`.sample`/… allowlist is
  // already case-insensitive, so `.env.EXAMPLE` stays allowed.
  const base = (p.split("/").pop() ?? p).toLowerCase();
  // `.env`, `.env.local`, `.env.production` are secrets — but `.env.example`,
  // `.env.sample`, `.env.template` are checked-in templates, NOT secrets.
  const isEnvSecret = /^\.env(\.[A-Za-z0-9_-]+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base);
  return (
    isEnvSecret ||
    /\.pem$/.test(base) ||
    /^id_rsa($|\.)/.test(base) ||
    /credentials/.test(base)
  );
}

/** Scan a shell command string for any catastrophic pattern. */
function scanCommand(raw: string): GuardDecision {
  const cmd = norm(raw);

  if (isGitPushForce(cmd) && targetsMain(cmd)) {
    return { block: true, reason: "git force-push to main is irreversible history rewrite on the shared branch (hot zone — route to human)." };
  }
  if (isCatastrophicRm(cmd)) {
    return { block: true, reason: "rm -rf of $HOME or / is catastrophic, irreversible data loss." };
  }
  if (isDestructiveSql(cmd)) {
    return { block: true, reason: "DROP DATABASE/TABLE or TRUNCATE is irreversible data destruction (hot zone — route to human)." };
  }
  if (isHardResetToRemote(cmd)) {
    return { block: true, reason: "git reset --hard to a remote ref discards local commits irreversibly." };
  }
  // A shell redirect that writes a secret file (`> .env`, `>> id_rsa`). Check
  // EVERY redirect target (`cmd > log > .env`), and capture single-quoted,
  // double-quoted, or bare paths, unquoting before the secret test (`> '.env'`).
  const redirectRegex = />>?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'|;&]+))/g;
  for (const m of cmd.matchAll(redirectRegex)) {
    const target = m[1] ?? m[2] ?? m[3];
    if (target && isSecretPath(unquote(target))) {
      return { block: true, reason: `writing to secret file "${target}" can leak or clobber credentials (hot zone — route to human).` };
    }
  }
  return { block: false };
}

/**
 * The shape of a Claude Code `PreToolUse` hook payload (only the fields we read).
 * `tool_name` + `tool_input` are stable across the schema.
 */
export interface PreToolUsePayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Decide whether to BLOCK a tool call. Pure: payload in, decision out. */
export function evaluate(payload: PreToolUsePayload): GuardDecision {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};

  // Shell tools — scan the command string.
  if (tool === "Bash" || tool === "BashOutput") {
    const command = typeof input["command"] === "string" ? (input["command"] as string) : "";
    if (command) return scanCommand(command);
  }

  // File-writing tools — block writes to obvious secret files.
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const path = typeof input["file_path"] === "string" ? (input["file_path"] as string) : "";
    if (path && isSecretPath(path)) {
      return { block: true, reason: `writing to secret file "${path}" can leak or clobber credentials (hot zone — route to human).` };
    }
  }

  return { block: false };
}
