// `fleet transcript-search "<query>"` — keyword search over the EPISODIC memory
// layer: the raw Claude Code transcripts under ~/.claude/projects. This is the gap
// `recall` leaves — recall greps ~/.fleet + .claude-docs only and never reads the
// transcripts. Like recall, the search runs OUTSIDE the window (ripgrep/grep) and
// returns only the matching turns, never the whole 1.9 GB store.
//
// Default scope = the current project's slug (cwd → slug); --all-projects is the
// explicit cross-project widen (Captain-only, may surface other projects' secrets).
// Secrets are redacted in output; every hit is dated so its age (and staleness) is
// visible. Semantic (QMD) is a separate wave — --semantic exits with a notice here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Root of the episodic store: one dir per project slug, one *.jsonl per session. */
export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export type SearchSource = "ripgrep" | "grep" | "none";

export interface TranscriptHit {
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string; // ISO-8601 Z
  role: string; // user | assistant | …
  text: string; // matched conversational text — flattened, redacted, windowed
}

export interface SearchResult {
  source: SearchSource;
  scope: "project" | "all-projects";
  slug: string;
  root: string; // the dir actually searched
  noStore: boolean; // slug dir absent → "no transcripts for <slug>"
  hits: TranscriptHit[];
}

export interface SearchOptions {
  cwd?: string;
  project?: string; // explicit slug override
  since?: string; // ISO date / datetime — filters on record timestamp
  role?: string; // user | assistant — filters on message.role
  allProjects?: boolean;
  perFileCap?: number;
  overallCap?: number;
}

const DEFAULT_PER_FILE = 3;
const DEFAULT_OVERALL = 40;

/**
 * Map an absolute cwd to its Claude-Code project slug. VERIFIED against the live
 * store (2026-06-16): the rule replaces EVERY non-alphanumeric char with `-`, not
 * just `/`. e.g. `/Users/x/.fleet/wt` → `-Users-x--fleet-wt` (the `.` becomes a
 * second `-`). The spec example `/Users/x/fleet-desktop` has no dots so it reads as
 * "slashes only", but a dotted path proves the broader rule — get this wrong and the
 * slug dir simply won't be found.
 */
export function slugForCwd(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function hasCmd(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// Secret-redaction (spec §4 / inbox redaction ethos): never print the value, only a
// placeholder. Two passes — (1) a labeled key/value (`API_KEY=…`, `"password":"…"`,
// `aws_secret_access_key: …`) keeps the key, masks the value; (2) bare token shapes
// (provider key prefixes, JWTs) get masked wherever they appear, label or not.
const REDACTED = "‹redacted›";
const LABELED_SECRET =
  /\b([A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|apikey|auth|bearer|credential|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s"',}{)]{4,})/gi;
const TOKEN_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic-style secret keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub personal access tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
];

export function redactSecrets(s: string): string {
  let out = s.replace(LABELED_SECRET, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  for (const re of TOKEN_SHAPES) out = out.replace(re, REDACTED);
  return out;
}

/** Flatten a turn's displayable conversational text: a string content verbatim, or
 *  the `text` blocks of an array content. `thinking`/`tool_use`/`tool_result`/`image`
 *  are skipped as noise (spec §2) — so a hit is only emitted when the query is in the
 *  actual conversation, not in a tool payload. */
function conversationalText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Window the flattened text around the (case-insensitive) match, with ellipses. */
function windowAround(flat: string, queryLower: string): string | null {
  const i = flat.toLowerCase().indexOf(queryLower);
  if (i < 0) return null;
  const start = Math.max(0, i - 60);
  const end = Math.min(flat.length, i + queryLower.length + 140);
  let snip = flat.slice(start, end);
  if (start > 0) snip = `…${snip}`;
  if (end < flat.length) snip = `${snip}…`;
  return snip;
}

export interface ParseFilters {
  role?: string;
  sinceMs?: number;
}

/**
 * Parse one matched line into a hit, or null if it should be dropped. Accepts a raw
 * ripgrep/grep line (`path:{json}`) OR a bare JSON line (fixtures/tests) — everything
 * before the first `{` is stripped. Drops non-conversation records, records failing
 * the role/since filters, and matches that land only in thinking/tool_use noise (the
 * query must survive into the displayed conversational text).
 */
export function parseHit(rawLine: string, queryLower: string, filters: ParseFilters = {}): TranscriptHit | null {
  const brace = rawLine.indexOf("{");
  if (brace < 0) return null;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(rawLine.slice(brace)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = rec.message as { role?: unknown; content?: unknown } | undefined;
  if (!message || typeof message.role !== "string") return null;
  const role = message.role;
  if (filters.role && role !== filters.role) return null;

  const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : "";
  if (filters.sinceMs !== undefined) {
    const ms = timestamp ? Date.parse(timestamp) : NaN;
    if (Number.isNaN(ms) || ms < filters.sinceMs) return null;
  }

  const flat = flatten(conversationalText(message.content));
  if (!flat) return null;
  const text = windowAround(flat, queryLower);
  if (text === null) return null; // match was in thinking/tool_use/role — not conversation

  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
  if (!sessionId) return null;
  const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
  const parentUuid = typeof rec.parentUuid === "string" ? rec.parentUuid : null;
  return { sessionId, uuid, parentUuid, timestamp, role, text: redactSecrets(text) };
}

/** Newest-first, capped per session (≈ per file) then overall, so output stays
 *  scannable on a hot query. */
export function rankHits(hits: TranscriptHit[], opts: { perFileCap?: number; overallCap?: number } = {}): TranscriptHit[] {
  const perFileCap = opts.perFileCap ?? DEFAULT_PER_FILE;
  const overallCap = opts.overallCap ?? DEFAULT_OVERALL;
  const sorted = [...hits].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const perFile = new Map<string, number>();
  const seen = new Set<string>(); // dedup duplicate JSONL records (same turn, re-stamped)
  const out: TranscriptHit[] = [];
  for (const h of sorted) {
    if (out.length >= overallCap) break;
    const key = `${h.sessionId}:${h.uuid}`;
    if (seen.has(key)) continue;
    const n = perFile.get(h.sessionId) ?? 0;
    if (n >= perFileCap) continue;
    seen.add(key);
    perFile.set(h.sessionId, n + 1);
    out.push(h);
  }
  return out;
}

function runRipgrepOrGrep(query: string, root: string, perFileCap: number): { source: SearchSource; lines: string[] } {
  const useRg = hasCmd("rg");
  if (!useRg && !hasCmd("grep")) {
    throw new Error("neither ripgrep (rg) nor grep is on PATH — install one to search transcripts");
  }
  const bin = useRg ? "rg" : "grep";
  // Give the parser headroom over the display cap: many matched lines are filtered
  // out (noise blocks / role / since), so cap rg well above perFileCap.
  const rgMax = String(Math.max(perFileCap * 4, 12));
  const args = useRg
    ? ["-F", "-i", "--no-heading", "-H", "--max-count", rgMax, "-g", "*.jsonl", "--", query, root]
    : ["-F", "-i", "-r", "--include=*.jsonl", "--", query, root];
  try {
    const out = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 128 * 1024 * 1024,
    });
    return { source: useRg ? "ripgrep" : "grep", lines: out.split("\n").filter(Boolean) };
  } catch {
    // rg/grep exit 1 on no match — treat as empty, not an error.
    return { source: useRg ? "ripgrep" : "grep", lines: [] };
  }
}

/** Keyword tier: ripgrep over the slug's *.jsonl, thin JSON post-parse, redact, rank. */
export function transcriptSearch(query: string, opts: SearchOptions = {}): SearchResult {
  const slug = opts.project ?? slugForCwd(opts.cwd ?? process.cwd());
  const allProjects = opts.allProjects === true;
  const root = allProjects ? PROJECTS_DIR : join(PROJECTS_DIR, slug);
  const scope = allProjects ? "all-projects" : "project";
  if (!existsSync(root)) {
    return { source: "none", scope, slug, root, noStore: true, hits: [] };
  }
  let sinceMs: number | undefined;
  if (opts.since) {
    sinceMs = Date.parse(opts.since);
    if (Number.isNaN(sinceMs)) throw new Error(`--since "${opts.since}" is not a parseable date (try 2026-06-01 or an ISO timestamp)`);
  }
  const perFileCap = opts.perFileCap ?? DEFAULT_PER_FILE;
  const { source, lines } = runRipgrepOrGrep(query, root, perFileCap);
  const queryLower = query.toLowerCase();
  const hits: TranscriptHit[] = [];
  for (const line of lines) {
    const hit = parseHit(line, queryLower, { role: opts.role, sinceMs });
    if (hit) hits.push(hit);
  }
  return { source, scope, slug, root, noStore: false, hits: rankHits(hits, { perFileCap, overallCap: opts.overallCap }) };
}

// ── Context expansion ───────────────────────────────────────────────────────────

export interface ExpandTurn {
  uuid: string;
  role: string;
  timestamp: string;
  text: string; // flattened, redacted
  isHit: boolean;
}

export interface ExpandResult {
  file: string;
  turns: ExpandTurn[];
}

interface TurnRec {
  uuid: string;
  parentUuid: string | null;
  role: string;
  timestamp: string;
  text: string;
}

function turnsFromLines(lines: string[]): TurnRec[] {
  const out: TurnRec[] = [];
  for (const line of lines) {
    const brace = line.indexOf("{");
    if (brace < 0) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line.slice(brace)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = rec.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || typeof message.role !== "string" || typeof rec.uuid !== "string") continue;
    out.push({
      uuid: rec.uuid,
      parentUuid: typeof rec.parentUuid === "string" ? rec.parentUuid : null,
      role: message.role,
      timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
      text: redactSecrets(flatten(conversationalText(message.content))),
    });
  }
  return out;
}

/** Walk the parentUuid chain to print N turns before and after a hit. Pure over the
 *  session's raw lines so it's testable without the live store. */
export function buildContext(lines: string[], uuidPrefix: string, n = 2): ExpandTurn[] {
  const turns = turnsFromLines(lines);
  const byUuid = new Map<string, TurnRec>();
  const firstChildOf = new Map<string, TurnRec>();
  for (const t of turns) byUuid.set(t.uuid, t);
  for (const t of turns) {
    if (t.parentUuid && !firstChildOf.has(t.parentUuid)) firstChildOf.set(t.parentUuid, t);
  }
  const target = turns.find((t) => t.uuid.startsWith(uuidPrefix));
  if (!target) return [];

  const before: TurnRec[] = [];
  let cur: TurnRec | undefined = target;
  while (cur?.parentUuid && before.length < n) {
    const parent = byUuid.get(cur.parentUuid);
    if (!parent) break;
    before.unshift(parent);
    cur = parent;
  }
  const after: TurnRec[] = [];
  cur = target;
  while (cur && after.length < n) {
    const child: TurnRec | undefined = firstChildOf.get(cur.uuid);
    if (!child) break;
    after.push(child);
    cur = child;
  }
  return [...before, target, ...after].map((t) => ({
    uuid: t.uuid,
    role: t.role,
    timestamp: t.timestamp,
    text: t.text,
    isHit: t.uuid === target.uuid,
  }));
}

/** Resolve a session file by id (or id-prefix) within the scope, then expand. */
export function expandContext(
  session: string,
  uuid: string,
  opts: { cwd?: string; project?: string; allProjects?: boolean; n?: number } = {},
): ExpandResult | null {
  const slug = opts.project ?? slugForCwd(opts.cwd ?? process.cwd());
  const roots = opts.allProjects
    ? (existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR).map((d) => join(PROJECTS_DIR, d)) : [])
    : [join(PROJECTS_DIR, slug)];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    let file: string | undefined;
    try {
      const name = readdirSync(dir).find((f) => f.endsWith(".jsonl") && f.startsWith(session));
      if (name) file = join(dir, name);
    } catch {
      continue;
    }
    if (!file) continue;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return { file, turns: buildContext(lines, uuid, opts.n ?? 2) };
  }
  return null;
}

/** Display helper: ISO timestamp → "2026-05-23 13:53" (UTC, minute resolution). */
export function fmtDate(ts: string): string {
  return ts ? ts.slice(0, 16).replace("T", " ") : "????-??-?? ??:??";
}
