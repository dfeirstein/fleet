#!/usr/bin/env tsx
// fleet — Claude-Code-driven multi-agent orchestrator on cmux.
// Phase 0–1 surface: spawn, read, send, status, kill.
import { spawn, SPAWN_DEFAULTS, type SpawnOptions } from "./commands/spawn.js";
import { grid, parseGrid, type GridOptions } from "./commands/grid.js";
import { read } from "./commands/read.js";
import { send } from "./commands/send.js";
import { snapshot, renderTable } from "./commands/status.js";
import { kill, killAll, reviewBranches } from "./commands/kill.js";
import { watch, WATCH_DEFAULTS } from "./commands/watch.js";
import { resume } from "./commands/resume.js";
import { orchestrate, captainSplit } from "./commands/orchestrate.js";
import { setup } from "./commands/setup.js";
import { doctor } from "./commands/doctor.js";
import { verify } from "./commands/verify.js";
import { bootstrap } from "./commands/bootstrap.js";
import { currency } from "./commands/currency.js";
import { auditDocs } from "./commands/audit-docs.js";
import { readOutcomes } from "./outcomes.js";
import { digest, renderDigests } from "./commands/digest.js";
import { recall } from "./commands/recall.js";
import { profile } from "./commands/profile.js";
import { renderState, setObjective, addDecision, addRisk, clearTransient } from "./commands/state.js";
import { skillAudit } from "./commands/skill-audit.js";
import { reflect } from "./commands/reflect.js";
import { capture } from "./commands/capture.js";
import { objective } from "./commands/objective.js";
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
                         Same-project workers share one workspace as split panes
                         (cap 4); the next spills to a fresh workspace.
    --cwd <path>           Working directory (default: cwd)
    --label <name>         Workspace/agent label
    --model <model>        Model for the worker (default: ${SPAWN_DEFAULTS.model})
    --gated                Prompt on every risky action (forces default mode)
    --yolo                 No safety checks (--dangerously-skip-permissions)
    --worktree [--branch B] Isolate in a git worktree on its own branch
    --standalone           Force a fresh workspace; skip same-project grouping
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
  verify <agent> [--check <cmd>]             Independent eval gate (judge≠generator)
  bootstrap [--cwd P] [--force]              Give a project strong durable memory
                                             (CLAUDE.md + .claude-docs via a scribe)
  currency [--cwd P] [--force]               Resolve latest versions/model-IDs from
                                             live sources into .claude-docs (TTL-cached)
  audit-docs [--cwd P] [--min N]             Score CLAUDE.md + flag stale currency
                                             (eval gate; exits non-zero on fail)
  state [objective|decision|risk "<t>"]      The Captain's memory blocks (capped);
        [clear]                              no args renders them; reload after /compact
  digest                                     Capture live workers' output to disk
                                             (.claude-docs/.../waves) + return digests
  recall <query...> [--cwd P] [--qmd]        Search the durable store (outcome log +
                                             .claude-docs) via grep; --qmd uses QMD
  profile [--cwd P]                          Write a per-project profile (.claude-docs)
                                             from the outcome log — load it on re-entry
  outcomes [--tail N] [--json]               Show the delegation-outcome log
                                             (the trajectory store; spawn/verify/kill)
  capture <name> --from <agent>              Promote a worker into a reusable skill
        [--verify <check>]                   gate it: pass→active, fail→quarantined
                                             (no check → provisional)
  skill-audit [--apply]                      Decay GC for captured skills; --apply
                                             quarantines stale-unused provisional ones
  reflect [--session S]                      Scaffold a doctrine-delta proposal from
                                             the outcome log (human-gated; no auto-edit)
  objective <goal...> --done <c>|--verify <c> Loop a worker until a stop condition
        [--cwd P] [--max N] [--model M]       passes (--verify runs it through the
                                             eval gate in the worker's worktree)
  resume                                      Reconcile registry vs live cmux
                                             (prune dead, refresh refs)
  watch [--interval N] [--timeout N]         Poll until the fleet is idle;
                                             prints transitions + sidebar dash
        [--no-until-idle]                    Keep watching (don't exit on idle)
  kill <agent | --all>                       Stop a worker and clean up
  setup [--hotkey]                           Link fleet onto PATH + install skill
                                             (--hotkey also binds ⌘⇧Y in cmux.json
                                             → spawn a sibling Captain)
  doctor                                     Diagnose the install (cmux/PATH/…)
  orchestrate|captain [name] [--resume]      Appoint a Fleet Captain — a badged
        [--split]                            control-plane workspace you talk to
                                             (--resume re-appoints an existing
                                             Captain, keeping her conversation;
                                             --split adds a FRESH sibling Captain
                                             in a split pane of the focused
                                             workspace — up to a 2×2 quadrant)
  daemon <start|stop|status|run>             Always-on supervisor: heartbeat,
                                             stuck/zombie detection, escalations
  notify-orchestrator <msg> [--urgent]       Push a message to the orchestrator
                                             (bridge for /schedule routines)

Agents are matched by id, id-prefix, or label.`;

async function main(): Promise<void> {
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
        worktree: flags.worktree === true,
        branch: str(flags.branch),
        standalone: flags.standalone === true,
      };
      const agent = spawn(opts);
      console.log(`spawned ${agent.agentId} (${agent.label})`);
      console.log(`  workspace: ${agent.workspace}  surface: ${agent.surface}`);
      console.log(`  cwd: ${agent.cwd}  model: ${agent.model}  mode: ${agent.mode}`);
      if (agent.worktree) console.log(`  worktree: ${agent.worktree.branch}  (off ${agent.worktree.base})`);
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
        worktree: flags.worktree === true,
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
    case "setup": {
      setup({ hotkey: flags.hotkey === true });
      break;
    }
    case "doctor": {
      doctor();
      break;
    }
    case "orchestrate":
    case "captain": {
      if (flags.split === true) {
        const rec = captainSplit({ daemon: flags["no-daemon"] !== true, command: str(flags.command) });
        console.log(`⚓ Sibling Captain "${rec.name}" is live in a new pane of ${rec.workspaceRef} (fleet session "${rec.session}").`);
        console.log(`Its workers run in session "${rec.session}" — inspect with: FLEET_SESSION=${rec.session} fleet status`);
        break;
      }
      const name = positionals.join(" ").trim() || "Captain";
      const rec = orchestrate(name, { daemon: flags["no-daemon"] !== true, resume: flags.resume === true });
      console.log(`⚓ Fleet Captain "${rec.name}" is live in ${rec.workspaceRef} (fleet session "${rec.session}").`);
      console.log(`Switch to the "⚓ ${rec.name}" workspace in cmux and talk to the Captain.`);
      console.log(`Its workers run in session "${rec.session}" — inspect with: FLEET_SESSION=${rec.session} fleet status`);
      break;
    }
    case "verify": {
      const agent = positionals[0];
      if (!agent) return fail("verify requires an <agent>");
      const { pass, output } = verify(agent, str(flags.check));
      if (output) console.log(output);
      console.log(pass ? "PASS" : "FAIL");
      if (!pass) process.exitCode = 1;
      break;
    }
    case "bootstrap": {
      const { agent, skipped } = bootstrap({
        cwd: str(flags.cwd) ?? process.cwd(),
        model: str(flags.model),
        force: flags.force === true,
      });
      if (skipped) {
        console.log(skipped);
      } else if (agent) {
        console.log(`scribe spawned ${agent.agentId} (${agent.label}) in ${agent.cwd}`);
        console.log(`  workspace: ${agent.workspace}  surface: ${agent.surface}`);
        console.log(`watch it with \`fleet watch\`; it will write CLAUDE.md + .claude-docs/ and report back.`);
      }
      break;
    }
    case "currency": {
      const res = await currency({
        cwd: str(flags.cwd) ?? process.cwd(),
        force: flags.force === true,
      });
      const pkgs = res.entries.filter((e) => e.kind !== "model").length;
      const models = res.entries.filter((e) => e.kind === "model").length;
      console.log(`currency: ${pkgs} package(s), ${models} model ID(s) — ${res.refetched} resolved live this run`);
      if (res.drift.length) {
        console.log(`drift (pinned → latest):`);
        for (const e of res.drift) console.log(`  ${e.name}: ${e.pinned} → ${e.latest}`);
      } else {
        console.log(`no version drift detected`);
      }
      console.log(`wrote ${res.versionsPath}`);
      break;
    }
    case "audit-docs": {
      const res = auditDocs({
        cwd: str(flags.cwd) ?? process.cwd(),
        minScore: str(flags.min) ? Number(str(flags.min)) : undefined,
      });
      if (res.report) console.log(res.report.trimEnd());
      if (res.currencyChecked) {
        console.log(
          res.staleCurrency.length
            ? `\ncurrency: ${res.staleCurrency.length} fact(s) stale → run \`fleet currency\`: ${res.staleCurrency.slice(0, 8).join(", ")}${res.staleCurrency.length > 8 ? "…" : ""}`
            : `\ncurrency: all facts fresh`,
        );
      } else {
        console.log(`\ncurrency: no cache — run \`fleet currency\` to resolve versions/model-IDs`);
      }
      console.log(`\naudit-docs: ${res.pass ? "PASS" : "FAIL"}`);
      if (!res.pass) process.exitCode = 1;
      break;
    }
    case "digest": {
      const { waveId, digests } = digest();
      console.log(renderDigests(waveId, digests));
      const wrote = digests.filter((d) => d.wavePath).length;
      console.log(`captured ${wrote}/${digests.length} worker(s) to disk under .claude-docs/.../waves/${waveId}/`);
      break;
    }
    case "skill-audit": {
      const { rows, changed } = skillAudit({ apply: flags.apply === true });
      if (rows.length === 0) {
        console.log("no captured skills to audit");
      } else {
        for (const r of rows) {
          const age = r.ageDays === null ? "?" : `${r.ageDays}d`;
          console.log(`${r.recommendation.toUpperCase().padEnd(7)} ${r.name.padEnd(20)} [${r.status}, ${age}, ${r.reuseCount} reuse]  ${r.note}`);
        }
        if (changed.length) console.log(`\nquarantined ${changed.length}: ${changed.join(", ")}`);
        else if (flags.apply !== true) console.log(`\n(report only — re-run with --apply to quarantine 'retire' provisional skills)`);
      }
      break;
    }
    case "reflect": {
      const { path, spawns, fails } = reflect(str(flags.session));
      console.log(`scaffolded doctrine-delta proposal from ${spawns} delegation(s), ${fails} verify failure(s):`);
      console.log(`  ${path}`);
      console.log(`fill it in and adopt via PR review — it changes no doctrine. See docs/doctrine-deltas/README.md`);
      break;
    }
    case "state": {
      const sub = positionals[0];
      const rest = positionals.slice(1).join(" ").trim();
      if (!sub) {
        console.log(renderState());
      } else if (sub === "objective" && rest) {
        setObjective(rest);
        console.log("objective set");
      } else if (sub === "decision" && rest) {
        addDecision(rest);
        console.log("decision added");
      } else if (sub === "risk" && rest) {
        addRisk(rest);
        console.log("risk added");
      } else if (sub === "clear") {
        clearTransient();
        console.log("cleared decisions + risks (objective kept)");
      } else {
        return fail('state: `fleet state` | `state objective|decision|risk "<text>"` | `state clear`');
      }
      break;
    }
    case "recall": {
      const query = positionals.join(" ").trim();
      if (!query) return fail('recall requires a "<query>"');
      const res = recall(query, { cwd: str(flags.cwd) ?? process.cwd(), qmd: flags.qmd === true });
      if (res.source === "none") {
        console.log("nothing to recall yet (no ~/.fleet or .claude-docs store)");
      } else if (res.hits.length === 0) {
        console.log(`no matches for "${query}" (via ${res.source})`);
      } else {
        console.log(`${res.hits.length} hit(s) for "${query}" via ${res.source}:`);
        for (const h of res.hits) console.log(`  ${h}`);
      }
      break;
    }
    case "profile": {
      const path = profile({ cwd: str(flags.cwd) ?? process.cwd() });
      console.log(`wrote ${path}`);
      break;
    }
    case "outcomes": {
      const all = readOutcomes(str(flags.session));
      const n = str(flags.tail) ? Number(str(flags.tail)) : 20;
      const rows = all.slice(-n);
      if (flags.json === true) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log("no outcomes logged yet (spawn/verify/kill a worker to populate the log)");
      } else {
        for (const r of rows) {
          const when = r.ts.slice(5, 16).replace("T", " ");
          const detail =
            r.event === "verify" ? `${r.verdict ?? "?"} (${r.check ?? ""})`
            : r.event === "kill" ? `status=${r.status ?? "?"}`
            : (r.objective ?? "").replace(/\s+/g, " ").slice(0, 60);
          console.log(`${when}  ${r.event.padEnd(6)}  ${r.label.padEnd(16)}  ${detail}`);
        }
        console.log(`\n${all.length} record(s) total`);
      }
      break;
    }
    case "capture": {
      const name = positionals[0];
      const from = str(flags.from);
      if (!name || !from) return fail('capture requires <name> --from <agent>');
      const { path, status, verifyOutput } = capture(name, from, str(flags.verify));
      if (verifyOutput) console.log(verifyOutput);
      console.log(`captured → ${path}  [status: ${status}]`);
      if (status === "provisional") console.log("  gate it with --verify <check>, or promote on verified real reuse, before trusting it.");
      if (status === "quarantined") process.exitCode = 1;
      break;
    }
    case "objective": {
      const goal = positionals.join(" ").trim();
      if (!goal) return fail("objective requires a <goal>");
      // --verify routes the stop-condition through the eval gate (`fleet verify`,
      // run in the worker's cwd/worktree); --done runs it inline in --cwd.
      const viaVerify = str(flags.verify) != null;
      const doneCheck = str(flags.verify) ?? str(flags.done);
      if (!doneCheck) return fail('objective requires --done "<check>" or --verify "<check>"');
      const res = objective(goal, doneCheck, {
        cwd: str(flags.cwd) ?? process.cwd(),
        maxIterations: str(flags.max) ? Number(str(flags.max)) : 3,
        model: str(flags.model),
        viaVerify,
      });
      console.log(`objective ${res.done ? "DONE" : "NOT met"} after ${res.iterations} iteration(s)`);
      if (!res.done) process.exitCode = 1;
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
      reviewBranches.length = 0;
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
      if (reviewBranches.length) {
        console.log(`branches left for review/merge: ${reviewBranches.join(", ")}`);
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

main().catch((err) => {
  if (err instanceof CmuxError) {
    console.error(`fleet: ${err.message}`);
  } else {
    console.error(`fleet: ${(err as Error).message}`);
  }
  process.exitCode = 1;
});
