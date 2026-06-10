// `fleet review <agent>` — open the Captain's review surfaces for a worker:
// cmux's visual diff panel (the worker's branch vs its base) and, when the
// latest wave digest captured this worker, the report in cmux's markdown
// viewer. Read-only affordance; degrades with a clear message per panel.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { focusedWorkspace, openDiffPanel, openMarkdownPanel } from "../cmux.js";
import { resolveAgent, type Agent } from "../registry.js";
import { CLAUDE_DOCS_DIR } from "../project-memory.js";

/** The newest wave file digest wrote for this worker, if any (digest names wave
 *  dirs by ISO stamp, so lexicographic max = latest). */
export function latestWaveReport(agent: Agent): string | undefined {
  const wavesDir = join(agent.worktree?.repo ?? agent.cwd, CLAUDE_DOCS_DIR, "waves");
  const file = `${agent.label.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`;
  try {
    const waves = readdirSync(wavesDir).sort().reverse();
    for (const w of waves) {
      const candidate = join(wavesDir, w, file);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // no waves dir yet
  }
  return undefined;
}

export function review(idOrLabel: string): { opened: string[]; notes: string[] } {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);

  const opened: string[] = [];
  const notes: string[] = [];
  // When the Captain runs inside cmux, $CMUX_WORKSPACE_ID places the panels in
  // its own workspace; from outside, fall back to the focused workspace.
  const workspace = process.env.CMUX_WORKSPACE_ID ?? focusedWorkspace()?.id;

  if (!agent.worktree) {
    notes.push(`${agent.label} has no worktree/branch — nothing to diff (spawn with --worktree for reviewable branches)`);
  } else if (!existsSync(agent.worktree.path)) {
    notes.push(`worktree ${agent.worktree.path} is gone (killed?) — branch ${agent.worktree.branch} may still exist in ${agent.worktree.repo}`);
  } else {
    try {
      openDiffPanel({
        cwd: agent.worktree.path,
        base: agent.worktree.base,
        title: `fleet review: ${agent.label} (${agent.worktree.branch} vs ${agent.worktree.base})`,
        workspace,
      });
      opened.push(`diff: ${agent.worktree.branch} vs ${agent.worktree.base}`);
    } catch (err) {
      notes.push(`could not open diff panel: ${(err as Error).message}`);
    }
  }

  const report = latestWaveReport(agent);
  if (!report) {
    notes.push(`no wave report for ${agent.label} yet — run \`fleet digest\` to capture one`);
  } else {
    try {
      openMarkdownPanel(report, { workspace });
      opened.push(`report: ${report}`);
    } catch (err) {
      notes.push(`could not open report panel: ${(err as Error).message}`);
    }
  }

  return { opened, notes };
}
