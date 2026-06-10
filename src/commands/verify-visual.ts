// `fleet verify <agent> --visual <url>` — browser-backed verification mode
// (sibling of --check in commands/verify.ts; same judge ≠ generator contract).
//
// The Captain opens a DEDICATED browser surface in a throwaway workspace (never
// a worker's surface — two tasks sharing a surface fight), loads the page, and
// fails closed on: load timeout, a final URL off the requested origin (exact
// match with --exact-url), any page JS error, or missing --expect-text. On
// completion it captures a screenshot + console dump under
// ~/.fleet/verify-artifacts/ as evidence; a PASS auto-attaches a machine
// `visual` proof (url + artifact path — see src/proof.ts), a FAIL never does.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  browserClearLogs,
  browserConsole,
  browserErrors,
  browserGetText,
  browserGetUrl,
  browserNavigate,
  browserOpen,
  browserScreenshot,
  browserStateLoad,
  browserSupported,
  browserWaitLoaded,
  closeWorkspace,
  newWorkspace,
} from "../cmux.js";
import { patch, resolveAgent } from "../registry.js";
import { appendOutcome } from "../outcomes.js";
import type { ProofArtifact } from "../proof.js";
import { resolveStatePath } from "./browser-state.js";

/** Everything the verdict needs, gathered from the live surface. */
export interface VisualEvidence {
  requestedUrl: string;
  finalUrl: string;
  loaded: boolean; // wait --load-state complete succeeded within the timeout
  errors: string[]; // page JS errors (browser errors list)
  pageText: string; // full visible body text
}

export interface VisualRules {
  expectText?: string;
  /** Default URL policy: redirects are allowed WITHIN the requested origin
   *  (scheme+host+port) — a login bounce to another host is a failure, but
   *  `/` → `/home` is not. --exact-url demands the exact final URL instead. */
  exactUrl?: boolean;
}

function origin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The pure pass/fail decision (unit-tested; fail closed on every branch). */
export function visualVerdict(ev: VisualEvidence, rules: VisualRules = {}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!ev.loaded) reasons.push("page never reached load-state complete (timeout) — fail closed");
  if (rules.exactUrl) {
    if (ev.finalUrl !== ev.requestedUrl) reasons.push(`final url ${ev.finalUrl || "(none)"} ≠ requested ${ev.requestedUrl} (--exact-url)`);
  } else {
    const want = origin(ev.requestedUrl);
    const got = origin(ev.finalUrl);
    if (!want || !got || want !== got) {
      reasons.push(`final url ${ev.finalUrl || "(none)"} left the requested origin ${want ?? ev.requestedUrl}`);
    }
  }
  if (ev.errors.length > 0) {
    reasons.push(`${ev.errors.length} page error(s): ${ev.errors.slice(0, 3).join(" | ").slice(0, 200)}`);
  }
  if (rules.expectText && !ev.pageText.includes(rules.expectText)) {
    reasons.push(`expected text not found: "${rules.expectText}"`);
  }
  return { pass: reasons.length === 0, reasons };
}

const LOAD_TIMEOUT_MS = 30_000;

export interface VisualVerifyOptions extends VisualRules {
  /** Load a saved auth state (fleet browser-state save <project>) first. */
  state?: string;
}

export function verifyVisual(
  idOrLabel: string,
  url: string,
  opts: VisualVerifyOptions = {},
): { pass: boolean; output: string } {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  if (!browserSupported()) {
    throw new Error("this cmux build does not advertise the browser rail (capabilities: browser.*) — use --check instead");
  }
  const statePath = opts.state ? resolveStatePath(opts.state) : undefined;

  const artifactDir = join(homedir(), ".fleet", "verify-artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const shotPath = join(artifactDir, `${agent.agentId}-${stamp}.png`);
  const consolePath = join(artifactDir, `${agent.agentId}-${stamp}.console.txt`);

  // Dedicated, throwaway: its own workspace so no worker surface is ever
  // reused, and the finally tears the whole thing down even on a crash.
  const ws = newWorkspace({ name: `verify-${agent.label}`, cwd: homedir(), focus: false });
  const lines: string[] = [];
  try {
    const b = browserOpen("about:blank", ws.workspaceId);
    if (statePath) {
      browserStateLoad(b.surfaceId, statePath);
      lines.push(`state loaded: ${statePath}`);
    }
    browserClearLogs(b.surfaceId); // judge only THIS navigation's errors
    browserNavigate(b.surfaceId, url);
    const loaded = browserWaitLoaded(b.surfaceId, LOAD_TIMEOUT_MS);

    // Evidence gathering is individually guarded: a page that breaks one getter
    // (the js_error footgun) must not crash the verify — it just contributes
    // empty evidence, and the verdict fails closed on what's missing.
    const finalUrl = tryGet(() => browserGetUrl(b.surfaceId)) ?? "";
    const errors = tryGet(() => browserErrors(b.surfaceId)) ?? ["errors list unreadable — fail closed"];
    const pageText = tryGet(() => browserGetText(b.surfaceId)) ?? "";

    const verdict = visualVerdict({ requestedUrl: url, finalUrl, loaded, errors, pageText }, opts);

    // Capture evidence on completion, pass or fail (the artifact is the proof
    // on pass and the debugging trail on fail).
    let shotOk = false;
    try {
      browserScreenshot(b.surfaceId, shotPath);
      shotOk = true;
    } catch {
      // screenshot failed — a pass without an artifact is not attachable
    }
    const consoleLines = tryGet(() => browserConsole(b.surfaceId)) ?? [];
    try {
      writeFileSync(consolePath, [`# fleet verify --visual ${url}`, `final-url: ${finalUrl}`, "", "## console", ...consoleLines, "", "## errors", ...errors].join("\n") + "\n");
    } catch {
      // console dump is best-effort evidence
    }

    const pass = verdict.pass && shotOk;
    lines.push(`url: ${url} → ${finalUrl || "(no final url)"}`);
    if (shotOk) lines.push(`screenshot: ${shotPath}`);
    lines.push(`console: ${consolePath}`);
    for (const r of verdict.reasons) lines.push(`✗ ${r}`);
    if (verdict.pass && !shotOk) lines.push("✗ screenshot capture failed — no artifact, no proof (fail closed)");

    // PASS → auto-attach the machine visual proof (mirrors verify --check's
    // auto-attach); FAIL → never attach.
    if (pass) {
      const proof: ProofArtifact = { kind: "visual", ref: url, url, artifact: shotPath, attachedAt: new Date().toISOString() };
      // REPLACE any prior machine visual proof for the same URL rather than
      // appending: artifact paths are timestamped, gateProof requires EVERY
      // checkable proof to pass, and a cleaned-up old screenshot would flip the
      // agent to proof-failed despite this newer pass. Hand-attached legacy
      // visual proofs (no artifact field) are left alone.
      const others = (agent.proofs ?? []).filter((p) => !(p.kind === "visual" && p.artifact !== undefined && p.url === url));
      patch(agent.agentId, { proofs: [...others, proof] });
      lines.push(`✓ proof attached: visual:${url} (artifact ${shotPath})`);
    }

    appendOutcome({
      event: "verify",
      agentId: agent.agentId,
      label: agent.label,
      verdict: pass ? "pass" : "fail",
      check: `visual:${url}`,
      cwd: agent.worktree?.path ?? agent.cwd,
    });

    return { pass, output: lines.join("\n") };
  } finally {
    try {
      closeWorkspace(ws.workspaceId);
    } catch {
      // already gone
    }
  }
}

function tryGet<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
