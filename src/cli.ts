#!/usr/bin/env tsx
// fleet — Claude-Code-driven multi-agent orchestrator on cmux.
// Phase 0–1 surface: spawn, read, send, status, kill.
import { spawn, SPAWN_DEFAULTS, type SpawnOptions } from "./commands/spawn.js";
import { grid, parseGrid, type GridOptions } from "./commands/grid.js";
import { read } from "./commands/read.js";
import { send } from "./commands/send.js";
import { snapshot, renderTable } from "./commands/status.js";
import { kill, killAll } from "./commands/kill.js";
import { watch, WATCH_DEFAULTS } from "./commands/watch.js";
import { resume } from "./commands/resume.js";
import { orchestrate } from "./commands/orchestrate.js";
import { daemonStart, daemonStop, daemonStatus, daemonRun } from "./commands/daemon.js";
import { notifyOrchestrator } from "./commands/notify.js";
import { clearDashboard } from "./dashboard.js";
import { CmuxError } from "./cmux.js";

/** Minimal flag parser: returns { flags, positionals }. Supports --k v and --k=v and --bool. */
function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; positionals: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else {
      positionals.push(tok);
    }
  }
  return { flags, positionals };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const HELP = `fleet — multi-agent orchestrator on cmux

Usage: fleet <command> [options]

Commands:
  spawn <task...>        Launch a Claude Code worker on a task
    --cwd <path>           Working directory (default: cwd)
    --label <name>         Workspace/agent label
    --model <model>        Model for the worker (default: ${SPAWN_DEFAULTS.model})
    --gated                Prompt on every risky action (forces default mode)
    --yolo                 No safety checks (--dangerously-skip-permissions)
    --command <cmd>        Override launched program (testing / non-claude)
    --no-launch            Open a bare shell; don't launch anything
    --no-autostart         Launch Claude but don't auto-send the task prompt

  Default permission mode is 'auto': autonomous, but a classifier blocks
  dangerous actions (deploys, curl|bash, force-push, mass deletes, etc.).

  grid <cols>x<rows> [task...]               Tile one workspace into a grid of
        [--cwd P] [--label N] [--gated|--yolo] worker panes (shared filesystem).
                                             With a task, all panes run it; else
                                             they idle for per-pane 'fleet send'.
  read <agent> [--lines N] [--scrollback]   Capture a worker's screen
  send <agent> <text...> [--no-enter]       Steer a worker (types text + Enter)
  status                                     Snapshot fleet table
  resume                                      Reconcile registry vs live cmux
                                             (prune dead, refresh refs)
  watch [--interval N] [--timeout N]         Poll until the fleet is idle;
                                             prints transitions + sidebar dash
        [--no-until-idle]                    Keep watching (don't exit on idle)
  kill <agent | --all>                       Stop a worker and clean up
  orchestrate [name]                         Declare a new orchestrator workspace
                                             (a badged control plane you talk to)
  daemon <start|stop|status|run>             Always-on supervisor: heartbeat,
                                             stuck/zombie detection, escalations
  notify-orchestrator <msg> [--urgent]       Push a message to the orchestrator
                                             (bridge for /schedule routines)

Agents are matched by id, id-prefix, or label.`;

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positionals } = parseArgs(rest);

  switch (cmd) {
    case "spawn": {
      const task = positionals.join(" ").trim();
      const opts: SpawnOptions = {
        task,
        cwd: str(flags.cwd) ?? process.cwd(),
        label: str(flags.label),
        model: str(flags.model) ?? SPAWN_DEFAULTS.model,
        command: str(flags.command),
        launch: flags["no-launch"] !== true,
        autostart: flags["no-autostart"] !== true,
        mode: flags.yolo === true ? "yolo" : flags.gated === true ? "gated" : SPAWN_DEFAULTS.mode,
      };
      const agent = spawn(opts);
      console.log(`spawned ${agent.agentId} (${agent.label})`);
      console.log(`  workspace: ${agent.workspace}  surface: ${agent.surface}`);
      console.log(`  cwd: ${agent.cwd}  model: ${agent.model}  mode: ${agent.mode}`);
      break;
    }
    case "grid": {
      const spec = positionals[0];
      if (!spec) return fail("grid requires a <cols>x<rows> spec, e.g. `fleet grid 2x2`");
      const { cols, rows } = parseGrid(spec);
      const task = positionals.slice(1).join(" ").trim();
      const opts: GridOptions = {
        cols,
        rows,
        cwd: str(flags.cwd) ?? process.cwd(),
        labelPrefix: str(flags.label) ?? "grid",
        model: str(flags.model) ?? SPAWN_DEFAULTS.model,
        mode: flags.yolo === true ? "yolo" : flags.gated === true ? "gated" : SPAWN_DEFAULTS.mode,
        task,
      };
      const agents = grid(opts);
      console.log(`grid ${cols}x${rows} — ${agents.length} workers in ${agents[0]?.workspace} (mode: ${opts.mode}):`);
      for (const a of agents) console.log(`  ${a.agentId}  ${a.label}  ${a.surface}`);
      if (!task) console.log(`dispatch work with: fleet send <agent> "<task>"`);
      break;
    }
    case "read": {
      const agent = positionals[0];
      if (!agent) return fail("read requires an <agent>");
      const lines = str(flags.lines) ? Number(str(flags.lines)) : 50;
      console.log(read(agent, lines, flags.scrollback === true));
      break;
    }
    case "send": {
      const agent = positionals[0];
      if (!agent) return fail("send requires an <agent> and <text>");
      const text = positionals.slice(1).join(" ");
      if (!text) return fail("send requires <text>");
      send(agent, text, flags["no-enter"] !== true);
      console.log(`sent to ${agent}`);
      break;
    }
    case "status":
    case "ls": {
      console.log(renderTable(snapshot()));
      break;
    }
    case "orchestrate": {
      const name = positionals.join(" ").trim() || "Orchestrator";
      const rec = orchestrate(name);
      console.log(`🎛 Orchestrator "${rec.name}" is live in ${rec.workspaceRef} (fleet session "${rec.session}").`);
      console.log(`Switch to the "🎛 ${rec.name}" workspace in cmux and talk to it to orchestrate.`);
      console.log(`Its workers run in session "${rec.session}" — inspect with: FLEET_SESSION=${rec.session} fleet status`);
      break;
    }
    case "resume": {
      const { rows, pruned } = resume();
      if (pruned.length) console.log(`pruned ${pruned.length} dead: ${pruned.join(", ")}`);
      console.log(renderTable(rows));
      break;
    }
    case "watch": {
      watch({
        untilIdle: flags["no-until-idle"] !== true,
        intervalActive: str(flags.interval) ? Number(str(flags.interval)) : WATCH_DEFAULTS.intervalActive,
        intervalIdle: str(flags.interval) ? Number(str(flags.interval)) : WATCH_DEFAULTS.intervalIdle,
        timeoutSec: str(flags.timeout) ? Number(str(flags.timeout)) : WATCH_DEFAULTS.timeoutSec,
      });
      break;
    }
    case "daemon": {
      const sub = positionals[0];
      if (sub === "start") daemonStart({ proactive: flags["no-proactive"] !== true });
      else if (sub === "stop") daemonStop();
      else if (sub === "status") daemonStatus();
      else if (sub === "run") daemonRun();
      else return fail("daemon <start|stop|status|run>");
      break;
    }
    case "notify-orchestrator": {
      const msg = positionals.join(" ").trim();
      if (!msg) return fail("notify-orchestrator requires a message");
      const delivery = notifyOrchestrator(msg, flags.urgent === true);
      console.log(`${delivery}: ${msg}`);
      break;
    }
    case "kill": {
      if (flags.all === true) {
        const n = killAll();
        clearDashboard();
        console.log(`killed ${n} agent(s)`);
      } else {
        const agent = positionals[0];
        if (!agent) return fail("kill requires an <agent> or --all");
        const a = kill(agent);
        console.log(`killed ${a.agentId} (${a.label})`);
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      fail(`unknown command: ${cmd}`);
  }
}

function fail(msg: string): void {
  console.error(`fleet: ${msg}`);
  process.exitCode = 1;
}

try {
  main();
} catch (err) {
  if (err instanceof CmuxError) {
    console.error(`fleet: ${err.message}`);
  } else {
    console.error(`fleet: ${(err as Error).message}`);
  }
  process.exitCode = 1;
}
