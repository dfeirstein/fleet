// `fleet currency [--cwd P]` — resolve the CURRENT version of every major
// dependency, plus current LLM model IDs, from authoritative live sources, and
// cache them with provenance (source URL + fetch date) in .claude-docs/. This is
// the engine behind "never trust the training cutoff": facts come from the npm /
// PyPI registries and a curated provider map, not from the model's memory.
//
// Mostly deterministic and token-free — a registry lookup, not an inference. A
// 7-day TTL means only missing/stale facts are re-fetched, so it's cheap to rerun.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  claudeDocsDir,
  currencyJsonPath,
  versionsMdPath,
  CURRENCY_TTL_DAYS,
} from "../project-memory.js";

export interface CurrencyEntry {
  name: string;
  kind: "npm" | "pypi" | "model";
  pinned?: string; // what the project currently declares (manifest range, cleaned)
  latest?: string; // what the authoritative source reports
  source: string; // provenance URL
  fetchedAt: string; // ISO date this fact was resolved
  note?: string;
}

interface CurrencyCache {
  generatedAt: string;
  ttlDays: number;
  entries: CurrencyEntry[];
}

// Curated provider map for LLM model IDs. There is no universal registry for
// "the latest model", so this is the source of truth — kept here, refreshed
// against the provider's docs. Update when a provider ships a new model.
const MODEL_REGISTRY: CurrencyEntry[] = [
  { name: "claude-opus-4-8", kind: "model", latest: "claude-opus-4-8", note: "Anthropic — Opus 4.8 (most capable)", source: "https://docs.anthropic.com/en/docs/about-claude/models", fetchedAt: "" },
  { name: "claude-sonnet-4-6", kind: "model", latest: "claude-sonnet-4-6", note: "Anthropic — Sonnet 4.6", source: "https://docs.anthropic.com/en/docs/about-claude/models", fetchedAt: "" },
  { name: "claude-haiku-4-5-20251001", kind: "model", latest: "claude-haiku-4-5-20251001", note: "Anthropic — Haiku 4.5", source: "https://docs.anthropic.com/en/docs/about-claude/models", fetchedAt: "" },
];

const today = (): string => new Date().toISOString().slice(0, 10);

function isFresh(entry: CurrencyEntry | undefined, ttlDays: number): boolean {
  if (!entry?.fetchedAt) return false;
  const age = (Date.now() - new Date(entry.fetchedAt).getTime()) / 86_400_000;
  return Number.isFinite(age) && age < ttlDays;
}

/** Strip an npm/PyPI range to a bare version for display (^1.2.3 -> 1.2.3). */
function cleanRange(range: string): string {
  return range.replace(/^[\^~>=<\s]+/, "").trim();
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function latestNpm(name: string): Promise<string | undefined> {
  try {
    const data = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as { version?: string };
    return data.version;
  } catch {
    return undefined;
  }
}

async function latestPypi(name: string): Promise<string | undefined> {
  try {
    const data = (await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)) as { info?: { version?: string } };
    return data.info?.version;
  } catch {
    return undefined;
  }
}

/** Collect declared deps from a project's manifests (best-effort, no TOML lib). */
function readManifests(cwd: string): { npm: Record<string, string>; pypi: Record<string, string> } {
  const npm: Record<string, string> = {};
  const pypi: Record<string, string> = {};

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      Object.assign(npm, pkg.dependencies ?? {}, pkg.devDependencies ?? {});
    } catch {
      // unreadable manifest — skip npm
    }
  }

  const req = join(cwd, "requirements.txt");
  if (existsSync(req)) {
    for (const line of readFileSync(req, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9._-]+)\s*(?:==|>=|~=)\s*([0-9][^\s;#]*)/);
      if (m) pypi[m[1]!] = m[2]!;
    }
  }
  const pyproject = join(cwd, "pyproject.toml");
  if (existsSync(pyproject)) {
    for (const line of readFileSync(pyproject, "utf8").split("\n")) {
      const m = line.match(/^\s*"?([A-Za-z0-9._-]+)"?\s*(?:[=~>]=?\s*"?|\s*=\s*"[\^~>=]*)\s*([0-9][^\s",;#]*)/);
      if (m && !line.includes("python")) pypi[m[1]!] = m[2]!;
    }
  }

  return { npm, pypi };
}

function renderVersionsMd(cache: CurrencyCache): string {
  const pkgs = cache.entries.filter((e) => e.kind !== "model");
  const models = cache.entries.filter((e) => e.kind === "model");
  const lines: string[] = [
    `# Current stack — resolved versions`,
    ``,
    `Generated ${cache.generatedAt} · TTL ${cache.ttlDays}d · refresh with \`fleet currency\`.`,
    `Do not edit by hand; do not trust your training cutoff over this table.`,
    ``,
    `| package | pinned | latest | drift | source |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const e of pkgs.sort((a, b) => a.name.localeCompare(b.name))) {
    const drift = e.pinned && e.latest && cleanRange(e.pinned) !== e.latest ? "⬆ update" : e.latest ? "current" : "?";
    lines.push(`| ${e.name} | ${e.pinned ?? "—"} | ${e.latest ?? "?"} | ${drift} | [${hostOf(e.source)}](${e.source}) |`);
  }
  if (models.length) {
    lines.push(``, `## Current LLM model IDs`, ``, `| model ID | provider note | source |`, `| --- | --- | --- |`);
    for (const e of models) lines.push(`| \`${e.name}\` | ${e.note ?? ""} | [${hostOf(e.source)}](${e.source}) |`);
  }
  lines.push(``);
  return lines.join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "source";
  }
}

export interface CurrencyResult {
  entries: CurrencyEntry[];
  drift: CurrencyEntry[]; // packages where pinned !== latest
  refetched: number; // how many facts were resolved live this run
  jsonPath: string;
  versionsPath: string;
}

/**
 * Resolve + cache current versions/model-IDs for the project at `cwd`.
 * Honors the TTL: facts resolved within `ttlDays` are reused, not re-fetched.
 */
export async function currency(opts: { cwd: string; ttlDays?: number; force?: boolean }): Promise<CurrencyResult> {
  const ttlDays = opts.ttlDays ?? CURRENCY_TTL_DAYS;
  const jsonPath = currencyJsonPath(opts.cwd);

  // Load prior cache so we only re-fetch stale/missing facts.
  let prior: CurrencyCache | undefined;
  if (existsSync(jsonPath)) {
    try {
      prior = JSON.parse(readFileSync(jsonPath, "utf8")) as CurrencyCache;
    } catch {
      prior = undefined;
    }
  }
  const priorByKey = new Map((prior?.entries ?? []).map((e) => [`${e.kind}:${e.name}`, e]));

  const { npm, pypi } = readManifests(opts.cwd);
  const entries: CurrencyEntry[] = [];
  let refetched = 0;

  const resolve = async (name: string, kind: "npm" | "pypi", pinned: string): Promise<void> => {
    const key = `${kind}:${name}`;
    const cached = priorByKey.get(key);
    if (!opts.force && isFresh(cached, ttlDays)) {
      entries.push({ ...cached!, pinned }); // keep resolved latest, refresh pinned from manifest
      return;
    }
    const latest = kind === "npm" ? await latestNpm(name) : await latestPypi(name);
    refetched++;
    entries.push({
      name,
      kind,
      pinned,
      latest,
      source: kind === "npm" ? `https://www.npmjs.com/package/${name}` : `https://pypi.org/project/${name}/`,
      fetchedAt: today(),
      note: latest ? undefined : "unresolved (registry lookup failed)",
    });
  };

  // Resolve npm + pypi deps with bounded concurrency.
  const tasks: Array<() => Promise<void>> = [
    ...Object.entries(npm).map(([n, v]) => () => resolve(n, "npm", v)),
    ...Object.entries(pypi).map(([n, v]) => () => resolve(n, "pypi", v)),
  ];
  const CONCURRENCY = 8;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + CONCURRENCY).map((t) => t()));
  }

  // Model IDs from the curated provider map (stamped today; refreshed on TTL like the rest).
  for (const m of MODEL_REGISTRY) {
    const cached = priorByKey.get(`model:${m.name}`);
    entries.push(isFresh(cached, ttlDays) && !opts.force ? cached! : { ...m, fetchedAt: today() });
  }

  const cache: CurrencyCache = { generatedAt: today(), ttlDays, entries };

  mkdirSync(claudeDocsDir(opts.cwd), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(cache, null, 2) + "\n");
  const versionsPath = versionsMdPath(opts.cwd);
  writeFileSync(versionsPath, renderVersionsMd(cache));

  const drift = entries.filter((e) => e.kind !== "model" && e.pinned && e.latest && cleanRange(e.pinned) !== e.latest);
  return { entries, drift, refetched, jsonPath, versionsPath };
}
