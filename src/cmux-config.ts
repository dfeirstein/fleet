// JSONC-tolerant read/merge for the user's cmux config (`~/.config/cmux/cmux.json`).
//
// cmux config is JSONC (it ships with `//` comments and may have trailing
// commas). We need to add ONE action — the ⌘⇧Y "spawn sibling Captain" binding —
// without clobbering any other key (sidebarAppearance, shortcuts, …). The merge
// is factored into a pure function so it can be exercised against a temp file
// (there is no test runner; see .claude-docs/verification.md). Zero new deps.
import { homedir } from "node:os";
import { join } from "node:path";

/** Canonical path of the user's cmux config. */
export function cmuxConfigPath(): string {
  return join(homedir(), ".config", "cmux", "cmux.json");
}

/** The action fleet installs: bind ⌘⇧Y to spawn a sibling Captain in a split pane. */
export const SPAWN_CAPTAIN_ACTION_ID = "fleet.spawnCaptain";
export const SPAWN_CAPTAIN_ACTION = {
  type: "command",
  command: "fleet captain --split",
  shortcut: "cmd+shift+y",
} as const;

/** A minimal, valid config when the user has none yet (mirrors cmux's template). */
export function emptyCmuxConfig(): Record<string, unknown> {
  return {
    $schema: "https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json",
    schemaVersion: 1,
  };
}

/**
 * Strip `//` and block comments and trailing commas from JSONC, respecting
 * string literals (so a `//` or comma inside a string is left untouched), then
 * JSON.parse. Tolerant enough for hand-edited cmux configs; not a full JSON5.
 */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // copy the escaped char verbatim so an escaped quote doesn't end the string
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    // not in string/comment
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  // Remove trailing commas: a comma followed by only whitespace then } or ].
  const cleaned = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned) as Record<string, unknown>;
}

/**
 * Merge the spawn-Captain action into a parsed config WITHOUT touching any other
 * key. Pure: returns a new object, leaves `config` untouched. Idempotent —
 * running it again just re-sets the same action (no duplication).
 */
export function mergeSpawnCaptainAction(config: Record<string, unknown>): Record<string, unknown> {
  const prevActions = config.actions;
  const actions: Record<string, unknown> =
    prevActions && typeof prevActions === "object" && !Array.isArray(prevActions)
      ? { ...(prevActions as Record<string, unknown>) }
      : {};
  actions[SPAWN_CAPTAIN_ACTION_ID] = { ...SPAWN_CAPTAIN_ACTION };
  return { ...config, actions };
}
