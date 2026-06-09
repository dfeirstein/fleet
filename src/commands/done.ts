// `fleet done <agent> --proof <kind:ref> [--proof …] [--summary "…"]`
//
// Attach proof-of-work claim(s) to a worker's registry record (a CLAIM —
// untrusted), then run the independent proof gate and report the verdict. The
// SAME gate (src/proof.ts) is wired into passive done-detection (digest/daemon),
// so attaching here and idling later converge on one verdict.
import { resolveAgent, patch, type Agent } from "../registry.js";
import { parseProof, gateAgentProof, proofState, type GateResult } from "../proof.js";
import { appendOutcome } from "../outcomes.js";

export interface DoneResult {
  agent: Agent;
  result: GateResult;
  attached: number;
}

export function done(idOrLabel: string, specs: string[], summary?: string): DoneResult {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);

  const fresh = specs.map(parseProof);
  if (summary && fresh.length > 0) fresh[fresh.length - 1]!.summary = summary;
  const proofs = [...(agent.proofs ?? []), ...fresh];
  patch(agent.agentId, { proofs });

  const updated: Agent = { ...agent, proofs };
  const result = gateAgentProof(updated);
  const state = proofState(result.verdict);

  // Honest trajectory store: a `complete` event is written ONLY when the gate
  // verifies. A missing/failed gate logs a verify-fail so the audit trail never
  // shows an unproven completion as done (decision #6).
  if (result.verdict === "complete") {
    appendOutcome({
      event: "complete",
      agentId: agent.agentId,
      label: agent.label,
      status: agent.status,
      cwd: agent.cwd,
      worktreeBranch: agent.worktree?.branch,
      proof: state,
      proofRefs: result.proofRefs,
    });
  } else {
    appendOutcome({
      event: "verify",
      agentId: agent.agentId,
      label: agent.label,
      verdict: "fail",
      check: "proof-gate",
      cwd: agent.cwd,
      proof: state,
      proofRefs: result.proofRefs,
    });
  }

  return { agent: updated, result, attached: fresh.length };
}
