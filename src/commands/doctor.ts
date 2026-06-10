// `fleet doctor` — diagnose an install: prereqs, cmux reachability, PATH, skill,
// orchestrator, daemon. Prints the fix for anything broken.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { cmux } from "../cmux.js";
import { loadOrchestrator } from "../orchestrator-record.js";
import { readSharedState, pidAlive } from "../daemon/config.js";
import { hookSessionsPath, readHookSessions, findSession } from "../cmux-sessions.js";
import { listAgents } from "../registry.js";

function ok(label: string, detail = ""): void {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label: string, fix = ""): void {
  console.log(`  ✗ ${label}${fix ? `  → ${fix}` : ""}`);
}
function info(label: string, detail = ""): void {
  console.log(`  ℹ ${label}${detail ? ` — ${detail}` : ""}`);
}

export function doctor(): void {
  console.log("fleet doctor\n");

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old`, "install Node 18+ (20+ recommended)");

  // cmux
  try {
    const r = cmux(["ping"]);
    if (r.includes("PONG")) ok("cmux reachable");
    else info("cmux responded", r.slice(0, 40));
  } catch {
    bad("cmux not reachable", "install + launch the cmux app (https://cmux.com)");
  }

  // fleet on PATH
  const home = homedir();
  const localBin = join(home, ".local", "bin");
  const binLink = join(localBin, "fleet");
  const onPath = (process.env.PATH ?? "").split(":").includes(localBin);
  if (!existsSync(binLink)) bad("fleet not linked", "run: ./install.sh  (or  fleet setup)");
  else if (!onPath) bad("fleet linked but ~/.local/bin not on PATH", 'add: export PATH="$HOME/.local/bin:$PATH"');
  else ok("fleet on PATH");

  // skill
  if (existsSync(join(home, ".claude", "skills", "fleet"))) ok("fleet skill installed");
  else bad("fleet skill not installed", "run: fleet setup");

  // cmux durable session map (restart-proof fleets: warm map + resume --apply)
  const hsPath = hookSessionsPath();
  const durable = readHookSessions();
  if (!durable) {
    info(
      "cmux durable session map absent/unreadable",
      `${hsPath} — restart-proof resume unavailable (fleet behaves as before)`,
    );
  } else {
    let age = "age unknown";
    try {
      const mins = Math.round((Date.now() - statSync(hsPath).mtimeMs) / 60_000);
      age = mins < 60 ? `updated ${mins}m ago` : mins < 48 * 60 ? `updated ${Math.round(mins / 60)}h ago` : `STALE (updated ${Math.round(mins / 1440)}d ago)`;
    } catch {
      /* statable a moment ago — keep "age unknown" */
    }
    const agents = listAgents();
    const traced = agents.filter((a) =>
      findSession(durable, { surfaceId: a.surfaceId, workspaceId: a.workspaceId, cwds: [a.worktree?.path, a.cwd] }),
    ).length;
    ok(
      "cmux durable session map",
      `${durable.sessions.length} session(s), ${age} · ${traced}/${agents.length} fleet worker(s) traceable`,
    );
  }

  // orchestrator
  const orch = loadOrchestrator();
  if (orch) info(`orchestrator: ${orch.name}`, `${orch.workspaceRef} · session "${orch.session}"`);
  else info("no orchestrator declared", "run: fleet orchestrate <name>");

  // daemon (the ONE shared supervisor watching all Captains)
  const st = readSharedState();
  if (st && pidAlive(st.pid)) {
    info("daemon running", `pid ${st.pid}, ${st.ticks} beats, watching ${st.watching.length} Captain(s)`);
  } else {
    info("daemon not running", "started automatically by `fleet orchestrate`");
  }
}
