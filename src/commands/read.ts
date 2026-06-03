// `fleet read <agent>` — capture a worker's current screen.
import { readScreen } from "../cmux.js";
import { resolveAgent, target } from "../registry.js";

export function read(idOrLabel: string, lines = 50, scrollback = false): string {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  return readScreen(target(agent), lines, scrollback);
}
