// `fleet digest` — the wave-digest firewall (design Move 2).
//
// When a wave finishes, the Captain must NOT pull raw worker transcripts into
// its own window (that's the context-residue problem). `fleet digest` captures
// each worker's full output to disk under the worker's project
// (.claude-docs/<project>/waves/<id>/<label>.md) and returns only a compact,
// structured digest. The Captain holds the file PATH as a just-in-time retrieval
// handle (use `fleet recall` to pull detail back), never the raw transcript.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readScreen } from "../cmux.js";
import { listAgents, target, type Agent } from "../registry.js";
import { CLAUDE_DOCS_DIR } from "../project-memory.js";
import { appendOutcome } from "../outcomes.js";
import { gateAgentProof, proofState } from "../proof.js";

export interface WorkerDigest {
  agentId: string;
  label: string;
  status: string;
  objective: string;
  project: string;
  wavePath?: string; // file the raw output was written to (handle for recall)
  tail: string; // last few lines — the only worker output that reaches the Captain
  proof?: "verified" | "missing" | "failed"; // the proof-gate verdict at wave close
}

/** The project root a worker belongs to (its worktree repo, else its cwd). */
function projectDir(a: Agent): string {
  return a.worktree?.repo ?? a.cwd;
}

function waveStamp(): string {
  // Plain node context (not a workflow script) — Date is fine here.
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function lastLines(text: string, n: number): string {
  return text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l, i, a) => l || i < a.length - 1).slice(-n).join("\n").trim();
}

/**
 * Capture each live worker's output to a per-project wave file and return
 * compact digests. `agents` defaults to all live (non-dead) workers — typically
 * called at wave-complete to collect results without flooding the Captain.
 */
export function digest(opts: { waveId?: string; agents?: Agent[] } = {}): { waveId: string; digests: WorkerDigest[] } {
  const waveId = opts.waveId ?? waveStamp();
  const agents = (opts.agents ?? listAgents()).filter((a) => a.status !== "dead");
  const digests: WorkerDigest[] = [];

  for (const a of agents) {
    let raw = "";
    try {
      raw = readScreen(target(a), 200, true); // include scrollback for fuller capture
    } catch {
      // worker pane gone / unreadable — digest with status only
    }

    let wavePath: string | undefined;
    if (raw.trim()) {
      const dir = join(projectDir(a), CLAUDE_DOCS_DIR, "waves", waveId);
      try {
        mkdirSync(dir, { recursive: true });
        wavePath = join(dir, `${a.label.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`);
        const header = `# Wave ${waveId} — ${a.label}\n\n- agent: ${a.agentId}\n- status: ${a.status}\n- cwd: ${a.cwd}\n- objective: ${a.task}\n\n---\n\n`;
        writeFileSync(wavePath, header + "```\n" + raw.trimEnd() + "\n```\n");
      } catch {
        wavePath = undefined; // disk write failed — digest still returns the tail
      }
    }

    // Feature 3 — the proof gate on "done". Only a worker that has stopped is a
    // completion candidate; gating to terminal status keeps a still-running
    // worker from re-logging on every digest. The gate then decides whether it's
    // a CLEAN complete: an idle worker whose proof passes → `complete`; an idle
    // worker with missing/failed proof — or a dead/errored one — is recorded with
    // its proof state but NEVER as a clean completion ("idle == done" is dead).
    const terminal = a.status === "idle" || a.status === "dead" || a.status === "error";
    let proof: "verified" | "missing" | "failed" | undefined;
    if (terminal) {
      const gate =
        a.status === "idle"
          ? gateAgentProof(a)
          : { verdict: "proof-failed" as const, proofRefs: (a.proofs ?? []).map((p) => `${p.kind}:${p.ref}`) };
      proof = proofState(gate.verdict);
      if (gate.verdict === "complete") {
        appendOutcome({
          event: "complete",
          agentId: a.agentId,
          label: a.label,
          status: a.status,
          cwd: a.cwd,
          worktreeBranch: a.worktree?.branch,
          wavePath,
          proof,
          proofRefs: gate.proofRefs,
        });
      } else {
        // Unproven done → an auditable verify-fail, not a complete.
        appendOutcome({
          event: "verify",
          agentId: a.agentId,
          label: a.label,
          verdict: "fail",
          check: "proof-gate",
          status: a.status,
          cwd: a.cwd,
          worktreeBranch: a.worktree?.branch,
          wavePath,
          proof,
          proofRefs: gate.proofRefs,
        });
      }
    }

    digests.push({
      agentId: a.agentId,
      label: a.label,
      status: a.status,
      objective: (a.task || "").replace(/\s+/g, " ").slice(0, 140),
      project: projectDir(a),
      wavePath,
      tail: lastLines(raw, 12),
      proof,
    });
  }

  return { waveId, digests };
}

/** Render digests as the compact text the Captain sees (paths, not transcripts). */
export function renderDigests(waveId: string, digests: WorkerDigest[]): string {
  if (digests.length === 0) return "no live workers to digest";
  const lines = [`wave ${waveId} — ${digests.length} worker(s):`, ""];
  for (const d of digests) {
    const proofTag =
      d.proof === "verified" ? "  ✓ complete (proof verified)"
      : d.proof === "missing" ? "  ⚠ done (no proof)"
      : d.proof === "failed" ? "  ✗ proof-failed"
      : "";
    lines.push(`● ${d.label} [${d.status}]${proofTag}  ${d.objective}`);
    if (d.wavePath) lines.push(`  raw → ${d.wavePath}  (pull detail with \`fleet recall\`)`);
    if (d.tail) lines.push(...d.tail.split("\n").map((l) => `  | ${l}`));
    lines.push("");
  }
  return lines.join("\n");
}
