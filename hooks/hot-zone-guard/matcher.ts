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

/** Does the command contain a `git push` with a force flag? */
function isGitPushForce(cmd: string): boolean {
  if (!/\bgit\s+push\b/.test(cmd)) return false;
  // --force, --force-with-lease, or a bundled/standalone -f.
  return /--force(-with-lease)?\b/.test(cmd) || /(^|\s)-[A-Za-z]*f[A-Za-z]*\b/.test(cmd);
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
  // Dangerous targets: bare ~, ~/, $HOME, /, /* — but NOT ~/something or a path.
  return /\brm\b[^\n|;&]*\s(~|~\/|\$HOME|\/|\/\*)(\s|$)/.test(cmd);
}

/** Destructive SQL: DROP DATABASE / DROP TABLE / TRUNCATE (case-insensitive). */
function isDestructiveSql(cmd: string): boolean {
  return /\bDROP\s+DATABASE\b/i.test(cmd) || /\bDROP\s+TABLE\b/i.test(cmd) || /\bTRUNCATE\s+(TABLE\s+)?\w/i.test(cmd);
}

/** `git reset --hard` against a remote tracking ref (origin/main et al.). */
function isHardResetToRemote(cmd: string): boolean {
  return /\bgit\s+reset\s+--hard\s+origin\/\w+/.test(cmd);
}

/** Obvious secret-file targets a Write/Edit/shell redirect must not clobber. */
function isSecretPath(p: string): boolean {
  const base = p.split("/").pop() ?? p;
  // `.env`, `.env.local`, `.env.production` are secrets — but `.env.example`,
  // `.env.sample`, `.env.template` are checked-in templates, NOT secrets.
  const isEnvSecret = /^\.env(\.[A-Za-z0-9_-]+)?$/.test(base) && !/\.(example|sample|template|dist)$/i.test(base);
  return (
    isEnvSecret ||
    /\.pem$/.test(base) ||
    /^id_rsa($|\.)/.test(base) ||
    /credentials/i.test(base)
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
  // A shell redirect that writes a secret file (`> .env`, `>> id_rsa`).
  const redirectTarget = cmd.match(/>>?\s*("?)([^\s"|;&]+)\1/);
  if (redirectTarget && redirectTarget[2] && isSecretPath(redirectTarget[2])) {
    return { block: true, reason: `writing to secret file "${redirectTarget[2]}" can leak or clobber credentials (hot zone — route to human).` };
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
