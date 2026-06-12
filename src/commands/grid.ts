// `fleet grid <cols>x<rows>` — the split-screen swarm from the demo video: one
// cmux workspace tiled into a grid of panes, a Claude Code worker in each, all
// sharing the workspace's filesystem.
//
// Spawn is ATOMIC when the cmux build supports `new-workspace --layout`: ONE
// call creates the whole pane tree with each worker's launch command baked into
// its surface — no split races, no partial grids. Older builds (or a failed
// layout call) fall back to the legacy sequential-split loop.
import { randomBytes } from "node:crypto";
import {
  newWorkspace,
  newWorkspaceLayout,
  layoutSupported,
  closeWorkspace,
  newSplit,
  listGridCells,
  waitForTerminal,
  submit,
  sendKey,
  type LayoutNode,
  type LayoutPane,
  type GridCell,
  type Target,
} from "../cmux.js";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { upsert, sessionId, type Agent } from "../registry.js";
import { ensureWorkerGrouped } from "../sidebar.js";
import { buildWorkerLaunchCommand, proofInstruction, contextDisciplineClause, acceptBypassDialog, type PermMode } from "./spawn.js";
import { repoRoot, currentBranch, addWorktree } from "../git.js";

export interface GridOptions {
  cols: number;
  rows: number;
  cwd: string;
  labelPrefix: string;
  model: string;
  mode: PermMode;
  task: string; // shared task for every pane; empty = launch idle workers
  worktree: boolean; // isolate each pane in its own git worktree/branch
}

function bslug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
}

const MAX_CELLS = 9;

/** Parse "2x2" / "3x1" → { cols, rows }. */
export function parseGrid(spec: string): { cols: number; rows: number } {
  const m = spec.match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`bad grid spec "${spec}" — use <cols>x<rows>, e.g. 2x2`);
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols < 1 || rows < 1) throw new Error("grid dimensions must be >= 1");
  if (cols * rows > MAX_CELLS) throw new Error(`grid too large (${cols * rows} > ${MAX_CELLS} panes)`);
  return { cols, rows };
}

function newAgentId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Build the `--layout` JSON for a cols×rows grid: a horizontal chain of
 * columns, each a vertical chain of panes, every node an equal-share binary
 * split (3 children ⇒ 1/3 then 1/2 of the remainder). `commands[i]` lands in
 * the pane at FLATTENED index i, where flattening is depth-first / column-major
 * (col 0 top→bottom, then col 1, …) — verified live to be exactly the order
 * `list-panes` enumerates the created panes, so callers can zip cells back to
 * commands by index. Pure; exported for tests.
 */
export function buildGridLayout(cols: number, rows: number, commands: (string | undefined)[]): LayoutNode {
  if (commands.length !== cols * rows) {
    throw new Error(`layout needs ${cols * rows} commands, got ${commands.length}`);
  }
  const pane = (i: number): LayoutPane => ({
    pane: { surfaces: [{ type: "terminal" as const, ...(commands[i] ? { command: commands[i] } : {}) }] },
  });
  const chain = (nodes: LayoutNode[], direction: "horizontal" | "vertical"): LayoutNode => {
    if (nodes.length === 1) return nodes[0]!;
    return {
      direction,
      split: 1 / nodes.length,
      children: [nodes[0]!, chain(nodes.slice(1), direction)],
    };
  };
  const columns: LayoutNode[] = [];
  for (let c = 0; c < cols; c++) {
    const panes: LayoutNode[] = [];
    for (let r = 0; r < rows; r++) panes.push(pane(c * rows + r));
    columns.push(chain(panes, "vertical"));
  }
  return chain(columns, "horizontal");
}

/** Everything decided about one pane BEFORE any cmux call, shared by the atomic
 *  and legacy paths so a layout failure can fall back without re-minting ids or
 *  re-creating worktrees. */
interface CellPlan {
  agentId: string;
  label: string;
  cwd: string;
  worktree: Agent["worktree"];
  /** The full launch line typed into the pane (env exports + claude [+ task]). */
  command: string;
  task: string; // the dispatched brief (proof-note included), "" for idle panes
}

function planCells(opts: GridOptions): CellPlan[] {
  const launchedTask = opts.task.trim();
  const repo = opts.worktree ? repoRoot(opts.cwd) : undefined;
  if (opts.worktree && !repo) console.error(`warning: ${opts.cwd} is not a git repo — ignoring --worktree`);
  const plans: CellPlan[] = [];
  for (let i = 0; i < opts.cols * opts.rows; i++) {
    const label = `${opts.labelPrefix}-${i + 1}`;
    // The id is minted BEFORE the launch line so the worker's env exports and
    // proof instruction can name it concretely.
    const agentId = newAgentId();

    // Per-pane worktree isolation (each on its own branch off current HEAD).
    let worktree: Agent["worktree"];
    let cellTask = launchedTask;
    let cwd = opts.cwd;
    if (repo) {
      const branch = `fleet/${bslug(label)}`;
      const path = join(homedir(), ".fleet", "worktrees", `${basename(repo)}-${bslug(label)}`);
      addWorktree(repo, path, branch);
      worktree = { path, branch, base: currentBranch(repo), repo };
      cwd = path;
      if (cellTask) cellTask += `\n\n(Isolated git worktree on branch ${branch}; commit your work to it when done.)`;
    }

    // Same B3 wiring as spawn: a dispatched task carries the proof instruction,
    // and the launch line exports FLEET_SESSION/FLEET_AGENT_ID so `fleet done`
    // resolves from inside the pane. Idle panes (no task) get the env exports
    // too — their brief arrives later via `fleet send`.
    if (cellTask) cellTask += `\n\n${proofInstruction(agentId)}\n\n${contextDisciplineClause()}`;
    const claudeCmd = buildWorkerLaunchCommand(agentId, opts.model, cellTask, cellTask.length > 0, opts.mode);
    const command = worktree ? `cd '${worktree.path}' && ${claudeCmd}` : claudeCmd;
    plans.push({ agentId, label, cwd, worktree, command, task: launchedTask });
  }
  return plans;
}

/** Register one launched pane and return its Agent record. */
function registerCell(plan: CellPlan, cell: GridCell, wsRef: string, opts: GridOptions): Agent {
  const agent: Agent = {
    agentId: plan.agentId,
    label: plan.label,
    workspace: wsRef,
    surface: cell.surfaceRef,
    workspaceId: cell.workspaceId,
    surfaceId: cell.surfaceId,
    cwd: plan.cwd,
    model: opts.model,
    mode: opts.mode,
    task: plan.task,
    ownsWorkspace: false, // shared — workspace closes when the last member is killed
    worktree: plan.worktree,
    status: "running",
    spawnedAt: new Date().toISOString(),
    lastDispatchAt: new Date().toISOString(),
  };
  upsert(agent);
  return agent;
}

/**
 * Atomic path: ONE `new-workspace --layout` call creates every pane with its
 * worker launch command baked in (cmux types it itself once the PTY boots).
 * Throws if the created grid doesn't match the plan — caller falls back.
 */
function gridViaLayout(opts: GridOptions, plans: CellPlan[]): { wsRef: string; cells: GridCell[] } {
  const layout = buildGridLayout(opts.cols, opts.rows, plans.map((p) => p.command));
  // Focused, like the legacy path: makes the panes' PTYs boot promptly and lets
  // the user watch the swarm.
  const wsRef = newWorkspaceLayout({ name: opts.labelPrefix, cwd: opts.cwd, layout, focus: true });
  // ANY failure past creation (cell enumeration throwing, wrong pane count)
  // must close the layout workspace before the caller falls back, or the
  // legacy path would build a SECOND grid next to the leaked one.
  try {
    const cells = listGridCells(wsRef);
    if (cells.length !== plans.length) {
      throw new Error(`layout produced ${cells.length} panes, expected ${plans.length}`);
    }
    return { wsRef, cells };
  } catch (err) {
    try {
      closeWorkspace(wsRef);
    } catch {
      // best-effort — don't compound the original failure
    }
    throw err;
  }
}

/** Legacy path: sequential splits, then type each worker's launch line. */
function gridViaSplits(opts: GridOptions, plans: CellPlan[]): { wsRef: string; cells: GridCell[] } {
  // 1. Create the (focused) workspace — focus makes the panes' PTYs boot
  //    promptly and lets the user watch the swarm, as in the video.
  const ws = newWorkspace({ name: opts.labelPrefix, cwd: opts.cwd, focus: true });
  const wsRef = ws.workspaceRef;

  // 2. Tile into cols×rows panes: build the top row by splitting right, then
  //    split each column downward for the remaining rows.
  const topRow: string[] = [ws.surfaceRef];
  for (let c = 1; c < opts.cols; c++) {
    topRow.push(newSplit("right", { workspace: wsRef, surface: topRow[c - 1] }));
  }
  for (let c = 0; c < opts.cols; c++) {
    let surface = topRow[c]!;
    for (let r = 1; r < opts.rows; r++) {
      surface = newSplit("down", { workspace: wsRef, surface });
    }
  }

  // 3. Enumerate the resulting panes with stable UUIDs (refs may have shifted
  //    during splitting), then type each worker's launch line in.
  const cells = listGridCells(wsRef);
  cells.forEach((cell, i) => {
    const plan = plans[i];
    if (!plan) return;
    const target: Target = { workspace: cell.workspaceId, surface: cell.surfaceId };
    waitForTerminal(target);
    submit(target, plan.command);
    if (plan.command.length > 200) sendKey(target, "Enter"); // paste-collapse guard
  });
  return { wsRef, cells };
}

export function grid(opts: GridOptions): Agent[] {
  const plans = planCells(opts);

  // Atomic when supported; any layout failure (bad JSON shape on an older
  // build, wrong pane count) closes the partial workspace and falls back to
  // the proven split loop — worktrees/ids in `plans` are reused as-is.
  let wsRef: string;
  let cells: GridCell[];
  if (layoutSupported() && plans.length > 1) {
    try {
      ({ wsRef, cells } = gridViaLayout(opts, plans));
    } catch (err) {
      console.error(`grid: --layout spawn failed (${(err as Error).message}) — falling back to sequential splits`);
      ({ wsRef, cells } = gridViaSplits(opts, plans));
    }
  } else {
    ({ wsRef, cells } = gridViaSplits(opts, plans));
  }

  // Group the swarm under the session's sidebar group (best-effort, gated).
  const wsUuid = cells[0]?.workspaceId;
  if (wsUuid) ensureWorkerGrouped(sessionId(), wsUuid);

  // Register every pane and clear --yolo bypass dialogs. Cell order matches
  // plan order on both paths (layout: depth-first enumeration, verified live;
  // splits: creation order).
  const agents: Agent[] = [];
  cells.forEach((cell, i) => {
    const plan = plans[i];
    if (!plan) return;
    const target: Target = { workspace: cell.workspaceId, surface: cell.surfaceId };
    const agent = registerCell(plan, cell, wsRef, opts);
    if (opts.mode === "yolo") {
      waitForTerminal(target);
      acceptBypassDialog(target);
    }
    agents.push(agent);
  });

  return agents;
}
