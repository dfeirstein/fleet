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
  /** Machine-produced `visual` proofs (fleet verify --visual) record what was
   *  checked and the captured evidence. When `artifact` is set, grading checks
   *  THAT file (missing artifact = FAIL, fail closed); a hand-attached
   *  `visual:<path>` (no artifact field) keeps the legacy ref-is-a-file check. */
  url?: string;
  artifact?: string;
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

// Commands that exit 0 while proving nothing — the laziest self-certification
// (`fleet done --proof test:true`). A runnable proof must actually exercise the
// work, so these are rejected at attach time. This is a no-op guard, not a
// relevance judge: `command:` stays an escape hatch the gate runs but cannot judge
// for semantic relevance, so a determined no-op (`command:echo ok`) still slips —
// the guard only blocks the obvious cases.
const TRIVIAL_RUNNABLE: ReadonlySet<string> = new Set(["true", ":", "exit", "exit 0", "echo", "echo ok"]);

function normalizeCmd(ref: string): string {
  return ref.trim().toLowerCase().replace(/;+\s*$/, "").replace(/\s+/g, " ").trim();
}

/** Parse a `<kind:ref>` spec into a (claimed, untrusted) proof artifact. */
export function parseProof(spec: string): ProofArtifact {
  const idx = spec.indexOf(":");
  if (idx < 0) throw new Error(`proof must be <kind:ref>, got "${spec}"`);
  const kind = spec.slice(0, idx) as ProofKind;
  const ref = spec.slice(idx + 1);
  if (!ALL_KINDS.includes(kind)) throw new Error(`unknown proof kind "${kind}" (use ${ALL_KINDS.join("|")})`);
  if (!ref.trim()) throw new Error(`proof "${spec}" has an empty ref`);
  if (RUNNABLE.has(kind) && TRIVIAL_RUNNABLE.has(normalizeCmd(ref))) {
    throw new Error(
      `proof "${spec}" is a no-op that proves nothing — attach a real check ` +
        `(e.g. test:'npm test', command:'./verify.sh') or a file: artifact`,
    );
  }
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
 * Grade a set of proof claims. Fail-closed and judge ≠ generator:
 *   - `note:` is METADATA ONLY — a worker's free text can never self-certify, so
 *     a note never counts toward `complete`. If the only proof(s) attached are
 *     notes (or none), the verdict is `done-without-proof` (flagged, NOT complete).
 *   - A `complete` verdict requires ≥1 CHECKABLE proof — a runnable check that
 *     exits 0, or a static file that is present/non-empty/readable — and EVERY
 *     checkable proof must pass; any failure → `proof-failed`.
 * A note may ACCOMPANY a checkable proof (as a label) but can never stand alone.
 */
export function gateProof(proofs: ProofArtifact[] | undefined, ctx: GateContext): GateResult {
  const list = proofs ?? [];
  const proofRefs = list.map((p) => `${p.kind}:${p.ref}`);

  // Notes are not checkable — only runnable + static-file proofs gate "done".
  const checkable = list.filter((p) => RUNNABLE.has(p.kind) || STATIC_FILE.has(p.kind));
  if (checkable.length === 0) {
    return {
      verdict: "done-without-proof",
      detail: list.length > 0 ? "only note(s) attached — no checkable proof" : "no proof attached",
      proofRefs,
    };
  }

  const run = ctx.runCheck ?? runCheck;
  const failures: string[] = [];
  for (const p of checkable) {
    if (RUNNABLE.has(p.kind)) {
      const { pass, output } = run(ctx.dir, p.ref);
      if (!pass) failures.push(`${p.kind}:${p.ref} → ${firstLine(output) || "failed"}`);
    } else if (p.kind === "visual" && p.artifact) {
      // Machine-produced visual proof: the ref is the verified URL; the graded
      // evidence is the captured artifact. Re-grading after the artifact file
      // vanished is a FAIL (fail closed), not a pass-through.
      const r = checkStaticFile(p.artifact, ctx.dir);
      if (!r.ok) failures.push(`${p.kind}:${p.ref} → artifact ${r.reason} (${p.artifact})`);
    } else {
      const r = checkStaticFile(p.ref, ctx.dir);
      if (!r.ok) failures.push(`${p.kind}:${p.ref} → ${r.reason}`);
    }
  }

  if (failures.length > 0) {
    return { verdict: "proof-failed", detail: failures.join("; "), proofRefs };
  }
  return { verdict: "complete", detail: `${checkable.length} proof(s) verified`, proofRefs };
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
