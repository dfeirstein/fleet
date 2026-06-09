// `fleet setup` — idempotent self-installer: put `fleet` on PATH and the skill
// where Claude Code discovers it. Re-runnable after `git pull`.
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { reloadConfig } from "../cmux.js";
import {
  cmuxConfigPath,
  emptyCmuxConfig,
  parseJsonc,
  mergeSpawnCaptainAction,
  SPAWN_CAPTAIN_ACTION,
} from "../cmux-config.js";

function repoRoot(): string {
  // src/commands/setup.ts → ../../ = repo root
  return fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

type LinkResult = "linked" | "already" | "relinked" | "conflict";

function link(target: string, linkPath: string): LinkResult {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (isSymlink(linkPath)) {
    try {
      if (readlinkSync(linkPath) === target) return "already";
    } catch {
      /* fall through */
    }
    unlinkSync(linkPath);
    symlinkSync(target, linkPath);
    return "relinked";
  }
  if (existsSync(linkPath)) return "conflict"; // a real file/dir is in the way
  symlinkSync(target, linkPath);
  return "linked";
}

function report(what: string, where: string, r: LinkResult): void {
  if (r === "conflict") {
    console.log(`  ⚠ ${what}: ${where} already exists (not a symlink) — remove it and re-run \`fleet setup\` to enable auto-updates, or leave it as a copy.`);
  } else {
    console.log(`  ✓ ${what} ${r === "already" ? "(already linked)" : "→ " + where}`);
  }
}

/** Timestamp suffix for the config backup, safe in a filename. */
function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Install the cmux-native ⌘⇧Y "spawn sibling Captain" binding into the user's
 * cmux.json. Backs up first, merges JSONC-safely (preserving every other key),
 * is idempotent, then best-effort `cmux reload-config`. Opt-in via `--hotkey`.
 */
function installHotkey(): void {
  const path = cmuxConfigPath();
  console.log("\nhotkey  (⌘⇧Y → fleet captain --split)");

  let config: Record<string, unknown>;
  if (existsSync(path)) {
    const backup = `${path}.${backupStamp()}.bak`;
    copyFileSync(path, backup);
    console.log(`  ✓ backed up → ${backup}`);
    try {
      config = parseJsonc(readFileSync(path, "utf8"));
    } catch (err) {
      console.log(`  ⚠ could not parse ${path} as JSONC (${(err as Error).message}). Left it untouched; backup kept.`);
      return;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    config = emptyCmuxConfig();
    console.log(`  ✓ no cmux.json yet — creating ${path}`);
  }

  const merged = mergeSpawnCaptainAction(config);
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  console.log(`  ✓ bound ${SPAWN_CAPTAIN_ACTION.shortcut} → \`${SPAWN_CAPTAIN_ACTION.command}\` in actions.fleet.spawnCaptain`);

  if (reloadConfig()) {
    console.log("  ✓ cmux reload-config applied (no restart needed)");
  } else {
    console.log("  ⚠ couldn't reach cmux to reload-config — restart cmux or run `cmux reload-config` to pick it up");
  }
  console.log("  ↳ ⌘⇧Y spawns a sibling Captain in a split pane. cmux asks to trust the command on first use.");
  console.log("  ↳ Change the key by editing actions.fleet.spawnCaptain.shortcut in your cmux.json.");
}

export function setup(opts: { hotkey?: boolean } = {}): void {
  const root = repoRoot();
  const home = homedir();
  console.log("fleet setup");

  report("fleet on PATH", join(home, ".local", "bin", "fleet"), link(join(root, "bin", "fleet"), join(home, ".local", "bin", "fleet")));
  report("skill", join(home, ".claude", "skills", "fleet"), link(join(root, "skills", "fleet"), join(home, ".claude", "skills", "fleet")));

  const localBin = join(home, ".local", "bin");
  if (!(process.env.PATH ?? "").split(":").includes(localBin)) {
    console.log(`  ⚠ ${localBin} is not on your PATH. Add this to your shell profile (~/.zshrc or ~/.bashrc):`);
    console.log(`        export PATH="$HOME/.local/bin:$PATH"`);
  }

  if (opts.hotkey) installHotkey();

  console.log("\nNext:  fleet doctor   then   fleet orchestrate <name>");
}
