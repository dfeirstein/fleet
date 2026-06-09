// The proof-of-work gate on "done" (Feature 3).
//
// Fleet's old "done" signal was "idle == done" — a worker that stops is recorded
// complete. That logs unproven completions. This gate makes a worker attach a
// PROOF claim (`fleet done --proof <kind:ref>`), then grades it INDEPENDENTLY
// (judge ≠ generator) and FAILS CLOSED:
//   - no proof attached            → done-without-proof (flagged, never complete)
//   - runnable proof fails/errors  → proof-failed
//   - static file missing/empty/unreadable → proof-failed
//   - only a passing/present proof → complete
//
// The gate never grades itself: runnable proofs are re-run via the existing
// independent runner in commands/verify.ts (`runCheck`), in the worker's
// worktree/cwd — not the worker's self-report.
import { existsSync, statSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Agent } from "./registry.js";
import { runCheck } from "./commands/verify.js";

export type ProofKind = "diff" | "test" | "lint" | "curl" | "visual" | "file" | "command" | "note";

export interface ProofArtifact {
  kind: ProofKind;
  /** A command (runnable kinds) OR a path (static-file kinds) OR text (note). */
  ref: string;
  summary?: string;
  attachedAt: string; // ISO
}

export type ProofVerdict = "complete" | "done-without-proof" | "proof-failed";

export interface GateResult {
  verdict: ProofVerdict;
  detail: string;
  proofRefs: string[];
}

// Runnable kinds are executed independently; static-file kinds must exist +
// be non-empty + readable; `note` is a present-iff-non-empty annotation.
const RUNNABLE: ReadonlySet<ProofKind> = new Set(["test", "lint", "curl", "command"]);
const STATIC_FILE: ReadonlySet<ProofKind> = new Set(["diff", "file", "visual"]);
const ALL_KINDS: ProofKind[] = ["diff", "test", "lint", "curl", "visual", "file", "command", "note"];

/** Parse a `<kind:ref>` spec into a (claimed, untrusted) proof artifact. */
export function parseProof(spec: string): ProofArtifact {
  const idx = spec.indexOf(":");
  if (idx < 0) throw new Error(`proof must be <kind:ref>, got "${spec}"`);
  const kind = spec.slice(0, idx) as ProofKind;
  const ref = spec.slice(idx + 1);
  if (!ALL_KINDS.includes(kind)) throw new Error(`unknown proof kind "${kind}" (use ${ALL_KINDS.join("|")})`);
  if (!ref.trim()) throw new Error(`proof "${spec}" has an empty ref`);
  return { kind, ref, attachedAt: new Date().toISOString() };
}

/** Where runnable proofs execute + an injectable independent runner (tests). */
export interface GateContext {
  dir: string;
  runCheck?: (dir: string, cmd: string) => { pass: boolean; output: string };
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 120);
}

function checkStaticFile(ref: string, dir: string): { ok: boolean; reason: string } {
  const path = isAbsolute(ref) ? ref : join(dir, ref);
  try {
    if (!existsSync(path)) return { ok: false, reason: "missing" };
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, reason: "not a file" };
    if (st.size === 0) return { ok: false, reason: "empty" };
    readFileSync(path, "utf8"); // readability probe (throws → unreadable)
    return { ok: true, reason: "present" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Grade a set of proof claims. Fail-closed: any failing/inconclusive proof, or
 * none present, resolves to a non-complete verdict — only when every attached
 * proof passes/exists do we return `complete`.
 */
export function gateProof(proofs: ProofArtifact[] | undefined, ctx: GateContext): GateResult {
  const list = proofs ?? [];
  const proofRefs = list.map((p) => `${p.kind}:${p.ref}`);
  if (list.length === 0) {
    return { verdict: "done-without-proof", detail: "no proof attached", proofRefs };
  }

  const run = ctx.runCheck ?? runCheck;
  const failures: string[] = [];
  let anyUsable = false;

  for (const p of list) {
    if (RUNNABLE.has(p.kind)) {
      const { pass, output } = run(ctx.dir, p.ref);
      if (pass) anyUsable = true;
      else failures.push(`${p.kind}:${p.ref} → ${firstLine(output) || "failed"}`);
    } else if (STATIC_FILE.has(p.kind)) {
      const r = checkStaticFile(p.ref, ctx.dir);
      if (r.ok) anyUsable = true;
      else failures.push(`${p.kind}:${p.ref} → ${r.reason}`);
    } else {
      // note: present iff non-empty text.
      if (p.ref.trim()) anyUsable = true;
      else failures.push(`note → empty`);
    }
  }

  if (failures.length > 0) {
    return { verdict: "proof-failed", detail: failures.join("; "), proofRefs };
  }
  if (!anyUsable) {
    return { verdict: "proof-failed", detail: "no usable proof", proofRefs };
  }
  return { verdict: "complete", detail: `${list.length} proof(s) verified`, proofRefs };
}

/** Convenience: gate a worker using its worktree/cwd as the run dir. */
export function gateAgentProof(agent: Agent): GateResult {
  const dir = agent.worktree?.path ?? agent.cwd;
  return gateProof(agent.proofs, { dir });
}

/** Map a gate verdict to the compact proof state recorded in the outcome log. */
export function proofState(verdict: ProofVerdict): "verified" | "missing" | "failed" {
  return verdict === "complete" ? "verified" : verdict === "done-without-proof" ? "missing" : "failed";
}
