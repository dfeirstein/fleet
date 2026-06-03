// `fleet setup` — idempotent self-installer: put `fleet` on PATH and the skill
// where Claude Code discovers it. Re-runnable after `git pull`.
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";

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

export function setup(): void {
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

  console.log("\nNext:  fleet doctor   then   fleet orchestrate <name>");
}
