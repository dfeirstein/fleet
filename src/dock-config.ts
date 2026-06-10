// JSONC-tolerant read/merge for a project's cmux Dock config (`.cmux/dock.json`).
//
// `fleet setup --dock` pins the fleet control panel — a live `fleet watch` and
// the cmux Feed TUI — into the right sidebar. The merge is pure (testable) and
// preserves every user-defined control: fleet-owned entries are matched by id
// and refreshed in place; everything else keeps its content and order.
// Mirrors the cmux.json `--hotkey` merge pattern (see cmux-config.ts).
import { join } from "node:path";

export interface DockControl {
  id: string;
  title: string;
  command: string;
  [key: string]: unknown; // user extras (cwd, height, env) survive the merge
}

/** The controls fleet pins. `fleet watch --no-until-idle` keeps watching (a
 *  control that exits the moment the fleet idles would be an empty pane). */
export const FLEET_DOCK_CONTROLS: DockControl[] = [
  { id: "fleet-watch", title: "Fleet", command: "fleet watch --no-until-idle" },
  { id: "fleet-feed", title: "Feed", command: "cmux feed tui --opentui" },
];

/** A project's dock config path: `<projectRoot>/.cmux/dock.json`. */
export function dockConfigPath(projectRoot: string): string {
  return join(projectRoot, ".cmux", "dock.json");
}

/**
 * Merge the fleet controls into a parsed dock config WITHOUT touching any other
 * key or control. Pure: returns a new object. Idempotent — re-running refreshes
 * the fleet-owned entries (matched by id) and appends missing ones at the end.
 */
export function mergeDockControls(config: Record<string, unknown>): Record<string, unknown> {
  const prev = config.controls;
  const controls: Record<string, unknown>[] = Array.isArray(prev)
    ? prev.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    : [];
  const merged = [...controls];
  for (const fleet of FLEET_DOCK_CONTROLS) {
    const at = merged.findIndex((c) => c.id === fleet.id);
    if (at >= 0) merged[at] = { ...merged[at], ...fleet };
    else merged.push({ ...fleet });
  }
  return { ...config, controls: merged };
}
