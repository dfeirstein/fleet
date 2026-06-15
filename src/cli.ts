#!/usr/bin/env tsx
// fleet — Claude-Code-driven multi-agent orchestrator on cmux.
// Phase 0–1 surface: spawn, read, send, status, kill.
import { resolve } from "node:path";
import { spawn, SPAWN_DEFAULTS, type SpawnOptions } from "./commands/spawn.js";
import { grid, parseGrid, type GridOptions } from "./commands/grid.js";
import { read, readBrowserScreenshot } from "./commands/read.js";
import { send } from "./commands/send.js";
import { snapshot, renderTable } from "./commands/status.js";
import { kill, killAll, reviewBranches } from "./commands/kill.js";
import { watch, WATCH_DEFAULTS } from "./commands/watch.js";
import { resume } from "./commands/resume.js";
import { gc, type GcItemKind } from "./commands/gc.js";
import { orchestrate, captainSplit, liveCaptains, captainResumeRecipe } from "./commands/orchestrate.js";
import { unknownCaptainFlags, noNameResumeError, normalizeCaptainArgs, CAPTAIN_HELP } from "./commands/captain-args.js";
import { setup } from "./commands/setup.js";
import { update } from "./commands/update.js";
import { doctor } from "./commands/doctor.js";
import { verify } from "./commands/verify.js";
import { verifyVisual } from "./commands/verify-visual.js";
import { saveState, loadState } from "./commands/browser-state.js";
import { review } from "./commands/review.js";
import { done } from "./commands/done.js";
import { bootstrap } from "./commands/bootstrap.js";
import { currency } from "./commands/currency.js";
import { auditDocs } from "./commands/audit-docs.js";
import { readOutcomes, readAllOutcomeLines } from "./outcomes.js";
import { gainReport } from "./outcomes-gain.js";
import { digest, renderDigests } from "./commands/digest.js";
import { recall } from "./commands/recall.js";
import { profile } from "./commands/profile.js";
import { renderState, setObjective, addDecision, addRisk, clearTransient } from "./commands/state.js";
import { skillAudit } from "./commands/skill-audit.js";
import { reflect } from "./commands/reflect.js";
import { capture } from "./commands/capture.js";
import { objective } from "./commands/objective.js";
import { daemonStart, daemonStop, daemonStatus, daemonRun } from "./commands/daemon.js";
import { logMilestone } from "./commands/log.js";
import { notifyOrchestrator } from "./commands/notify.js";
import { prompts } from "./commands/prompts.js";
import { reply } from "./commands/reply.js";
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

/** Collect every occurrence of a repeatable flag (`--proof a --proof b`), since
 *  the base parser keeps only the last value. Handles `--flag v` and `--flag=v`. */
function collectFlag(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === name) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        out.push(v);
        i++;
      }
    } else if (tok.startsWith(`${name}=`)) {
      out.push(tok.slice(name.length + 1));
    }
  }
  return out;
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
    --with-browser [url]   Also open a companion browser pane in the worker's
                           workspace (default about:blank); screenshot it with
                           \`fleet read <agent> --browser-screenshot <out>\`
    --done <check>         Stop condition: when the worker goes stable-idle the
                           daemon runs <check> in its dir — pass auto-attaches
                           proof (judge≠generator), fail re-dispatches the same
                           worker with the failure output (needs the daemon;
                           keep the check fast — it runs inline on the beat)
    --max <N>              Re-dispatch at most N times for --done (default 3);
                           exhaustion escalates loudly, never loops forever

  Default permission mode is 'auto': autonomous, but a classifier blocks
  dangerous actions (deploys, curl|bash, force-push, mass deletes, etc.).

  grid <cols>x<rows> [task...]               Tile one workspace into a grid of
        [--cwd P] [--label N] [--gated|--yolo] worker panes (shared filesystem).
                                             With a task, all panes run it; else
                                             they idle for per-pane 'fleet send'.
                                             One atomic new-workspace --layout call
                                             when supported (legacy splits otherwise).
  read <agent> [--lines N] [--scrollback]   Capture a worker's screen
       [--browser-screenshot <out.png>]     (or screenshot its --with-browser pane)
  send <agent> <text...> [--no-enter]       Steer a worker (types text + Enter)
  status                                     Snapshot fleet table (one sidebar-
                                             snapshot RPC pre-fetches the fleet
                                             where supported; rows show dev-server
                                             ports + PR URLs when known)
  verify <agent> [--check <cmd>]             Independent eval gate (judge≠generator;
                                             a PASSING check auto-attaches as proof)
  verify <agent> --visual <url>              Browser-backed gate: load the page in a
        [--expect-text <t>] [--exact-url]    dedicated surface; FAIL on timeout, page
        [--state <project>]                  errors, off-origin final URL (--exact-url
                                             = exact match), or missing text. Captures
                                             screenshot+console to ~/.fleet/verify-
                                             artifacts; PASS auto-attaches the proof
  browser-state save|load <project>          Save/load the cmux browser session
        [--import --from <browser>           (~/.fleet/browser-states/<project>.json,
         [--domain <d>]] --url <page>        mode 600 — live cookies); --import seeds
                                             from a desktop browser first; save REQUIRES
                                             --url, a reachable http(s) page (the state
                                             collector runs in-page — use your local app)
  review <agent>                             Open review panels for a worker: visual
                                             diff (branch vs base) + latest wave report
  done <agent> --proof <kind:ref> [--proof…] Attach proof-of-work + run the gate
        [--summary "<t>"]                    (test:<cmd>|file:<path>|note:<text>|…;
                                             fails closed — no/failed proof ≠ complete.
                                             A PASS also emits the cmux signal
                                             done-<agentId> — block on it with
                                             'cmux wait-for done-<agentId>')
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
                                             (prefers each worker's capture file —
                                             the true final report — over the screen)
  recall <query...> [--cwd P] [--qmd]        Search the durable store (outcome log +
                                             .claude-docs) via grep; --qmd uses QMD
  profile [--cwd P]                          Write a per-project profile (.claude-docs)
                                             from the outcome log — load it on re-entry
  outcomes [--tail N] [--json]               Show the delegation-outcome log
                                             (the trajectory store; spawn/verify/kill)
  outcomes --gain [--cwd P] [--json]         Per-project gain view: failure rate
                                             bucketed over time, repeat-failure
                                             signal, trend verdict (memory paying off?)
  capture <name> --from <agent>              Promote a worker into a reusable skill
        [--verify <check>]                   gate it: pass→active, fail→quarantined
                                             (no check → provisional)
  skill-audit [--apply]                      Decay GC for captured skills; --apply
                                             quarantines stale-unused provisional ones
  reflect [--session S]                      Scaffold a doctrine-delta proposal from
                                             the outcome log (human-gated; no auto-edit)
  objective <goal...> --done <c>|--verify <c> Loop a worker until a stop condition
        [--cwd P] [--max N] [--model M]       passes (--verify runs it through the
        [--wake-check <cmd>] [--interval <s>]  eval gate in the worker's worktree).
        [--max-ticks <N>] [--no-agent]        --wake-check gates each tick: skip the
                                             spawn ONLY when its last line is
                                             {"wakeAgent":false} — anything else (no
                                             output, parse error, non-zero exit) wakes
                                             (fail-open). --interval sleeps <s> between
                                             ticks (recurring monitor). --no-agent runs
                                             only --done each tick (0 tokens), alerting
                                             the Captain on FAIL. --max-ticks bounds it.
  resume [--apply]                            Reconcile registry vs live cmux
                                             (prune untraceable dead, refresh
                                             refs; after a cmux restart, prints
                                             the exact claude --resume command
                                             for each restorable worker — with
                                             --apply, respawns them in fresh
                                             workspaces with full context)
  gc [--apply]                               Sweep dead-session residue from
                                             ~/.fleet (registry/state/capture/
                                             daemon-state for sessions with no
                                             live Captain AND no live worker).
                                             Lists by default; --apply removes.
                                             Fails closed: anything unverifiable
                                             (cmux unreachable) is kept. Never
                                             touches outcomes logs, briefs,
                                             browser-states, worktrees, or shared
                                             daemon files
  watch [--interval N] [--timeout N]         Poll until the fleet is idle;
                                             prints transitions + sidebar dash
        [--no-until-idle]                    Keep watching (don't exit on idle)
  kill <agent | --all>                       Stop a worker and clean up
                                             (also prunes sidebar-group membership)
  log <message...> [--level <l>] [--source <s>]  Drop a Captain milestone into cmux's
        [--workspace <ws>]                   sidebar activity log (info|progress|
                                             success|warning|error)
  setup [--hotkey] [--dock]                  Link fleet onto PATH + install skill
                                             (--hotkey also binds ⌘⇧Y in cmux.json
                                             → spawn a sibling Captain; --dock pins
                                             fleet watch + cmux feed tui into the
                                             project's .cmux/dock.json)
  doctor                                     Diagnose the install (cmux/PATH/…,
                                             plus install mode: checkout path,
                                             branch, ahead/behind origin/main,
                                             autoupdate on/off)
  update                                      Explicit ff-only pull of main +
                                             npm ci (only if the lockfile moved);
                                             prints the CHANGELOG delta and
                                             restarts the daemon if it's running.
                                             Refuses on a dirty tree / non-main.
                                             (bin/fleet also auto-updates once/24h
                                             on clean main — FLEET_NO_AUTOUPDATE=1
                                             opts out)
  orchestrate|captain [name] [--resume]      Appoint a Fleet Captain — a badged
        [--split] [--model M] [--print]      control-plane workspace you talk to
                                             (--resume re-appoints an EXISTING
                                             Captain by id, keeping her
                                             conversation — needs an explicit
                                             name, never defaults; --resume
                                             --print emits the in-pane manual
                                             relaunch command instead;
                                             --split adds a FRESH sibling Captain
                                             in a split pane of the focused
                                             workspace — up to a 2×2 quadrant;
                                             --model pins the Captain's model,
                                             e.g. claude-opus-4-8)
  daemon <start|stop|status|run>             Always-on supervisor: heartbeat,
                                             stuck/zombie detection, resource
                                             guardrails (sustained-CPU/RSS/health
                                             nudges — never auto-kill; thresholds
                                             in ~/.fleet/daemon/shared-config.json),
                                             escalations
  notify-orchestrator <msg> [--urgent]       Push a message to the orchestrator
                                             (bridge for /schedule routines)
  prompts [agent]                            List pending Feed prompts (permission/
                                             question/plan) with text, options, and
                                             the 120s RPC reply window
  reply <agent> <answer> [--prompt <id>]     Answer a worker's pending prompt via
                                             the Feed RPC (no TUI keystrokes):
                                             permission → allow|deny|always|all|bypass;
                                             question → option # or label (other text
                                             is sent verbatim as the one selection);
                                             plan → approve|reject|auto|ultraplan.
                                             After the 120s window use \`fleet send\`

Agents are matched by id, id-prefix, or label.`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positionals } = parseArgs(rest);

  switch (cmd) {
    case "spawn": {
      const task = positionals.join(" ").trim();
      // `--with-browser [url]`: the optional value means the parser will eat a
      // following bare token — refuse anything that isn't URL-shaped so the
      // task text can't be silently swallowed as a "url".
      const wb = flags["with-browser"];
      if (typeof wb === "string" && !/^(about:|[a-z][a-z0-9+.-]*:\/\/|localhost[:/]?|127\.)/i.test(wb)) {
        return fail(`--with-browser got "${wb.slice(0, 40)}" which doesn't look like a URL — put the task text before the flag, or pass an explicit url`);
      }
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
        withBrowser: flags["with-browser"] === true ? true : str(flags["with-browser"]),
        doneCheck: str(flags.done),
        doneMaxLoops: str(flags.max) ? Number(str(flags.max)) : undefined,
      };
      const agent = spawn(opts);
      console.log(`spawned ${agent.agentId} (${agent.label})`);
      console.log(`  workspace: ${agent.workspace}  surface: ${agent.surface}`);
      console.log(`  cwd: ${agent.cwd}  model: ${agent.model}  mode: ${agent.mode}`);
      if (agent.worktree) console.log(`  worktree: ${agent.worktree.branch}  (off ${agent.worktree.base})`);
      if (agent.doneCheck)
        console.log(
          `  done-check: ${agent.doneCheck}  (daemon runs it on idle; re-dispatch ≤${agent.doneMaxLoops}× on fail)`,
        );
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
      const shot = str(flags["browser-screenshot"]);
      if (shot) {
        console.log(`screenshot → ${readBrowserScreenshot(agent, shot)}`);
        break;
      }
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
      setup({ hotkey: flags.hotkey === true, dock: flags.dock === true });
      break;
    }
    case "log": {
      const msg = positionals.join(" ").trim();
      if (!msg) return fail("log requires a <message>");
      if (logMilestone(msg, { level: str(flags.level), source: str(flags.source), workspace: str(flags.workspace) })) {
        console.log("logged");
      }
      break;
    }
    case "doctor": {
      doctor();
      break;
    }
    case "update": {
      const res = update();
      console.log(res.message);
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case "orchestrate":
    case "captain": {
      // The base parser is greedy — `--resume yoshi` binds yoshi as --resume's
      // value with NO positional. Reclaim it as the name first, so the no-name
      // guard below can't be slipped by flag-before-name ordering (#36/#37 class).
      const { name, flags: cflags } = normalizeCaptainArgs(flags, positionals);
      // #37: --help/-h prints usage and exits; any unknown flag errors with usage
      // instead of spawning a stray Captain (the side effect is a workspace +
      // registry record + daemon-watched session — too costly to do on a typo).
      if (cflags.help === true || rest.includes("-h")) {
        console.log(CAPTAIN_HELP);
        break;
      }
      const unknown = unknownCaptainFlags(Object.keys(cflags));
      if (unknown.length) {
        return fail(`unknown flag(s) for ${cmd}: ${unknown.map((f) => `--${f}`).join(", ")}\n\n${CAPTAIN_HELP}`);
      }
      if (cflags.split === true) {
        const rec = captainSplit({ daemon: cflags["no-daemon"] !== true, command: str(cflags.command), closeOrigin: cflags["close-origin"] === true, model: str(cflags.model) });
        console.log(`⚓ Sibling Captain "${rec.name}" is live in a new pane of ${rec.workspaceRef} (fleet session "${rec.session}").`);
        console.log(`Its workers run in session "${rec.session}" — inspect with: FLEET_SESSION=${rec.session} fleet status`);
        break;
      }
      // #36: a bare --resume must NOT default to "Captain" (that forked a live
      // Captain's conversation). Error and list the live captains to resume.
      if (cflags.resume === true && !name) {
        return fail(noNameResumeError(liveCaptains()));
      }
      // #36 bonus: --print emits the in-pane manual relaunch recipe, touching no
      // cmux state (the Ctrl-C-and-relaunch path that worked in the incident).
      if (cflags.print === true) {
        if (cflags.resume !== true) return fail("--print applies only with --resume");
        if (!name) return fail("--print requires an explicit Captain <name>");
        console.log(captainResumeRecipe(name));
        break;
      }
      const rec = orchestrate(name || "Captain", { daemon: cflags["no-daemon"] !== true, resume: cflags.resume === true, model: str(cflags.model) });
      console.log(`⚓ Fleet Captain "${rec.name}" is live in ${rec.workspaceRef} (fleet session "${rec.session}").`);
      console.log(`Switch to the "⚓ ${rec.name}" workspace in cmux and talk to the Captain.`);
      console.log(`Its workers run in session "${rec.session}" — inspect with: FLEET_SESSION=${rec.session} fleet status`);
      break;
    }
    case "verify": {
      const agent = positionals[0];
      if (!agent) return fail("verify requires an <agent>");
      if (flags.visual !== undefined) {
        const url = str(flags.visual);
        if (!url) return fail("verify --visual requires a <url>");
        const { pass, output } = verifyVisual(agent, url, {
          expectText: str(flags["expect-text"]),
          exactUrl: flags["exact-url"] === true,
          state: str(flags.state),
        });
        if (output) console.log(output);
        console.log(pass ? "PASS" : "FAIL");
        if (!pass) process.exitCode = 1;
        break;
      }
      const { pass, output } = verify(agent, str(flags.check));
      if (output) console.log(output);
      console.log(pass ? "PASS" : "FAIL");
      if (!pass) process.exitCode = 1;
      break;
    }
    case "browser-state": {
      const sub = positionals[0];
      const project = positionals[1];
      if (!sub || !project || (sub !== "save" && sub !== "load")) {
        return fail("browser-state <save|load> <project> [--import --from <browser> [--domain <d>]]");
      }
      if (sub === "save") {
        const importFrom = flags.import === true ? str(flags.from) : undefined;
        if (flags.import === true && !importFrom) return fail("browser-state --import requires --from <browser> (e.g. chrome, safari)");
        const url = str(flags.url);
        if (!url) return fail("browser-state save requires --url <reachable http(s) page> (the state collector runs in-page; point it at your local app)");
        const path = saveState(project, { importFrom, domain: str(flags.domain), url });
        console.log(`saved browser state → ${path} (mode 600 — holds live session cookies, keep it out of repos)`);
      } else {
        const path = loadState(project);
        console.log(`loaded browser state from ${path} into the shared cmux browser profile`);
      }
      break;
    }
    case "review": {
      const agent = positionals[0];
      if (!agent) return fail("review requires an <agent>");
      const { opened, notes } = review(agent);
      for (const o of opened) console.log(`opened ${o}`);
      for (const n of notes) console.log(`· ${n}`);
      if (opened.length === 0) process.exitCode = 1;
      break;
    }
    case "done": {
      const agent = positionals[0];
      if (!agent) return fail("done requires an <agent>");
      const specs = collectFlag(rest, "--proof");
      const { result, attached } = done(agent, specs, str(flags.summary));
      console.log(`attached ${attached} proof(s)${result.proofRefs.length ? `: ${result.proofRefs.join(", ")}` : ""}`);
      const mark = result.verdict === "complete" ? "✓" : result.verdict === "done-without-proof" ? "⚠" : "✗";
      console.log(`${mark} ${result.verdict}${result.detail ? ` — ${result.detail}` : ""}`);
      if (result.verdict !== "complete") process.exitCode = 1;
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
      if (res.currencyState === "ok") {
        console.log(
          res.staleCurrency.length
            ? `\ncurrency: ${res.staleCurrency.length} fact(s) stale → run \`fleet currency\`: ${res.staleCurrency.slice(0, 8).join(", ")}${res.staleCurrency.length > 8 ? "…" : ""}`
            : `\ncurrency: all facts fresh`,
        );
      }
      if (res.coverage) {
        const c = res.coverage;
        console.log(`\nverification coverage: ${c.verified}/${c.total} claims checked (${c.percent}%)`);
        for (const u of c.unverified) console.log(`  ⚠ ${u.file}:${u.line} (${u.marker}) — ${u.text}`);
      }
      // The gate contract stays visible: soft-pass cases are stated, and a FAIL
      // always says why (inconclusive = FAIL — the gate fails closed). Warnings
      // (unverified memory) lower quality but never hard-fail by themselves.
      for (const note of res.gateNotes) console.log(`\n${note}`);
      for (const warning of res.warnings) console.log(`\n⚠ ${warning}`);
      console.log(`\naudit-docs: ${res.pass ? "PASS" : "FAIL"}`);
      for (const reason of res.failReasons) console.log(`  ✗ ${reason}`);
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
      if (flags.gain === true) {
        // Cross-session, per-project aggregation (the gain view). --cwd P scopes
        // to one project (resolved to an absolute path to match recorded cwds).
        const cwd = str(flags.cwd) ? resolve(str(flags.cwd)!) : undefined;
        const report = gainReport(readAllOutcomeLines(), { cwd });
        if (flags.json === true) {
          console.log(JSON.stringify(report, null, 2));
          break;
        }
        if (report.projects.length === 0) {
          console.log(
            cwd
              ? `no outcomes logged for ${cwd} yet`
              : "no outcomes logged yet (spawn/verify/kill a worker to populate the log)",
          );
          if (report.malformed > 0) console.log(`⚠ ${report.malformed} malformed log line(s) skipped`);
          break;
        }
        for (const p of report.projects) {
          console.log(`\n${p.project}`);
          console.log(`  trend: ${p.verdict}`);
          for (const b of p.buckets) {
            const rate = b.failureRate === null ? "  —  " : `${String(Math.round(b.failureRate * 100)).padStart(3)}%`;
            console.log(
              `  ${b.key}  fail-rate ${rate}  (${b.fails} fail / ${b.completes} complete, ${b.delegations} delegated)`,
            );
          }
          if (p.repeatFailures.length > 0) {
            console.log(`  repeat failures (same label │ check seen ≥2×; exact normalized-text match, not semantic):`);
            for (const rf of p.repeatFailures) {
              console.log(`    ${rf.count}×  ${rf.signature}  [${rf.dates.join(", ")}]`);
            }
          }
        }
        console.log(`\nbuckets are UTC calendar days; failure rate = fails / (fails + completes).`);
        if (report.malformed > 0) console.log(`⚠ ${report.malformed} malformed log line(s) skipped`);
        break;
      }
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
      const noAgent = flags["no-agent"] === true;
      // --no-agent never spawns a worker; the --done check IS the monitor, so it
      // must be present (a --verify-only monitor has no worker to verify). Check
      // this BEFORE the generic --done/--verify check so the message is precise.
      if (noAgent && !str(flags.done)) {
        return fail('objective --no-agent requires --done "<check>" (no worker is spawned)');
      }
      // The wake-check gates a WORKER spawn; --no-agent never spawns one, so the
      // combo is incompatible (and silently suppresses the monitor if allowed).
      if (noAgent && str(flags["wake-check"])) {
        return fail("objective --no-agent and --wake-check are incompatible (--no-agent has no worker to gate)");
      }
      // --no-agent has no worker to verify, so it always monitors the inline
      // --done check (any --verify is ignored); otherwise --verify routes the
      // stop-condition through the eval gate against the worker.
      const viaVerify = !noAgent && str(flags.verify) != null;
      const doneCheck = noAgent ? str(flags.done) : str(flags.verify) ?? str(flags.done);
      if (!doneCheck) return fail('objective requires --done "<check>" or --verify "<check>"');
      const intervalStr = str(flags.interval);
      const intervalSec = intervalStr != null ? Number(intervalStr) : undefined;
      // Reject non-positive too: objective() treats 0/negative as "unset" and
      // silently falls back to defaults — an explicit bad value must error loud.
      if (intervalSec != null && (!Number.isFinite(intervalSec) || intervalSec <= 0)) {
        return fail("objective --interval must be a positive number (seconds)");
      }
      const maxTicksStr = str(flags["max-ticks"]);
      const maxTicks = maxTicksStr != null ? Number(maxTicksStr) : undefined;
      // Reject non-positive too: --max-ticks 0 would otherwise read as "unset"
      // and silently run the default (e.g. 50) — a silent unbounded fallback.
      if (maxTicks != null && (!Number.isFinite(maxTicks) || maxTicks <= 0)) {
        return fail("objective --max-ticks must be a positive number");
      }
      const res = objective(goal, doneCheck, {
        cwd: str(flags.cwd) ?? process.cwd(),
        maxIterations: str(flags.max) ? Number(str(flags.max)) : 3,
        model: str(flags.model),
        viaVerify,
        wakeCheck: str(flags["wake-check"]),
        intervalSec,
        noAgent,
        maxTicks,
      });
      console.log(`objective ${res.done ? "DONE" : "NOT met"} after ${res.iterations} iteration(s)`);
      if (!res.done) process.exitCode = 1;
      break;
    }
    case "resume": {
      const { rows, pruned, offers, skipped } = resume({ apply: flags.apply === true });
      if (pruned.length) {
        console.log(`pruned ${pruned.length} dead:`);
        for (const p of pruned) console.log(`  ☠ ${p}`);
      }
      for (const s of skipped) console.log(`⚠ skipped ${s.label} (${s.agentId}): ${s.note}`);
      for (const o of offers) {
        const caveat = o.restorable ? "" : "  [cmux marks this session not-restorable — claude --resume usually still works]";
        if (o.respawned) {
          console.log(`↻ respawned ${o.label} (${o.agentId}) in ${o.respawned} — resuming its claude session${caveat}`);
        } else {
          console.log(`↻ ${o.label} (${o.agentId}) is resumable:  (cd ${o.cwd} && ${o.command})${caveat}`);
        }
      }
      if (offers.some((o) => !o.respawned)) {
        console.log(`re-run \`fleet resume --apply\` to respawn the resumable worker(s) above`);
      }
      console.log(renderTable(rows));
      break;
    }
    case "gc": {
      const { apply, reachable, plans, removed } = gc({ apply: flags.apply === true });
      const remove = plans.filter((p) => p.action === "remove");
      const keep = plans.filter((p) => p.action === "keep");
      if (!reachable) {
        console.log("⚠ cmux unreachable — every session is unverifiable; nothing will be removed (fail closed)");
      }
      const kindLabel: Record<GcItemKind, string> = {
        registry: "registry",
        state: "state",
        "capture-dir": "capture dir",
        "daemon-state": "daemon state",
        "daemon-state-tmp": "daemon state .tmp",
      };
      for (const p of keep) console.log(`• ${p.session} — keep: ${p.reason}`);
      if (!remove.length) {
        console.log(remove.length === plans.length ? "" : "nothing to remove — no dead sessions");
      }
      for (const p of remove) {
        const verb = apply ? "removed" : "would remove";
        console.log(`☠ ${p.session} — ${p.reason} (${verb} ${p.items.length} item(s)):`);
        for (const it of p.items) console.log(`    ${kindLabel[it.kind]}: ${it.path}`);
      }
      if (apply) console.log(`removed ${removed.length} path(s) across ${remove.length} dead session(s)`);
      else if (remove.length) console.log(`re-run \`fleet gc --apply\` to remove the ${remove.length} dead session(s) above`);
      break;
    }
    case "watch": {
      await watch({
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
    case "prompts": {
      console.log(prompts(positionals[0]));
      break;
    }
    case "reply": {
      const agent = positionals[0];
      if (!agent) return fail("reply requires an <agent> and <answer>");
      const answer = positionals.slice(1).join(" ");
      if (!answer) return fail("reply requires an <answer> (see `fleet prompts`)");
      console.log(reply(agent, answer, str(flags.prompt)));
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
