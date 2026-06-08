// `fleet skill-audit` — garbage-collection for the captured-skill library
// (design Move 7). Unpruned LLM-authored libraries drift net-negative and
// degrade retrieval, so captured skills must DECAY, not just accrete. This scans
// captured skills (those carrying capture frontmatter) and flags ones to retire:
// quarantined skills, and stale provisional skills that were never promoted.
//
// Report-only by default; `--apply` flips stale-unused provisional skills to
// quarantined. Retirement is reversible — the originating trajectory is still in
// the outcome log, so a skill can be re-derived.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const STALE_DAYS = 14;

export interface SkillAuditRow {
  name: string;
  status: string;
  ageDays: number | null;
  reuseCount: number;
  recommendation: "keep" | "verify" | "retire";
  note: string;
}

function skillsDir(): string {
  return fileURLToPath(new URL("../../skills/", import.meta.url));
}

/** Parse the YAML-ish frontmatter into a flat string map (capture writes simple key: value lines). */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1").trim();
  }
  return out;
}

function ageDays(iso?: string): number | null {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return Number.isFinite(d) ? Math.floor(d) : null;
}

export function skillAudit(opts: { apply?: boolean } = {}): { rows: SkillAuditRow[]; changed: string[] } {
  const dir = skillsDir();
  const rows: SkillAuditRow[] = [];
  const changed: string[] = [];
  if (!existsSync(dir)) return { rows, changed };

  for (const name of readdirSync(dir)) {
    const path = join(dir, name, "SKILL.md");
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const fm = frontmatter(text);
    // Only audit CAPTURED skills (curated ones like `fleet` have no status field).
    if (!fm.status || !fm.capturedAt) continue;

    const age = ageDays(fm.capturedAt);
    const reuseCount = Number(fm.reuseCount ?? "0") || 0;
    let recommendation: SkillAuditRow["recommendation"] = "keep";
    let note = "";

    if (fm.status === "quarantined") {
      recommendation = "retire";
      note = "failed its check — fix + re-verify or remove";
    } else if (fm.status === "provisional") {
      if (age !== null && age >= STALE_DAYS && reuseCount === 0) {
        recommendation = "retire";
        note = `provisional ${age}d, never reused → quarantine candidate`;
      } else {
        recommendation = "verify";
        note = "provisional — gate with `--verify` or promote on real reuse";
      }
    } else {
      note = `active (${reuseCount} reuse${reuseCount === 1 ? "" : "s"})`;
    }

    rows.push({ name, status: fm.status, ageDays: age, reuseCount, recommendation, note });

    // --apply: quarantine stale-unused provisional skills (reversible).
    if (opts.apply && recommendation === "retire" && fm.status === "provisional") {
      writeFileSync(path, text.replace(/^status:\s*provisional\s*$/m, "status: quarantined"));
      changed.push(name);
    }
  }
  return { rows, changed };
}
