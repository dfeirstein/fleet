// `fleet grid <cols>x<rows>` — the split-screen swarm from the demo video: one
// cmux workspace tiled into a grid of panes, a Claude Code worker in each, all
// sharing the workspace's filesystem.
import { randomBytes } from "node:crypto";
import {
  newWorkspace,
  newSplit,
  listGridCells,
  waitForTerminal,
  submit,
  sendKey,
  type Target,
} from "../cmux.js";
import { upsert, type Agent } from "../registry.js";
import { buildClaudeCommand, acceptBypassDialog, type PermMode } from "./spawn.js";

export interface GridOptions {
  cols: number;
  rows: number;
  cwd: string;
  labelPrefix: string;
  model: string;
  mode: PermMode;
  task: string; // shared task for every pane; empty = launch idle workers
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

export function grid(opts: GridOptions): Agent[] {
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
  //    during splitting).
  const cells = listGridCells(wsRef);

  // 4. Launch a worker in each pane and register it as a shared-workspace agent.
  const launchedTask = opts.task.trim();
  const command = buildClaudeCommand(opts.model, launchedTask, launchedTask.length > 0, opts.mode);
  const agents: Agent[] = [];
  cells.forEach((cell, i) => {
    const target: Target = { workspace: cell.workspaceId, surface: cell.surfaceId };
    waitForTerminal(target);
    submit(target, command);
    if (command.length > 200) sendKey(target, "Enter"); // paste-collapse guard
    if (opts.mode === "yolo") acceptBypassDialog(target);

    const agentId = newAgentId();
    const agent: Agent = {
      agentId,
      label: `${opts.labelPrefix}-${i + 1}`,
      workspace: wsRef,
      surface: cell.surfaceRef,
      workspaceId: cell.workspaceId,
      surfaceId: cell.surfaceId,
      cwd: opts.cwd,
      model: opts.model,
      mode: opts.mode,
      task: launchedTask,
      ownsWorkspace: false, // shared — workspace closes when the last member is killed
      status: "running",
      spawnedAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
    };
    upsert(agent);
    agents.push(agent);
  });

  return agents;
}
