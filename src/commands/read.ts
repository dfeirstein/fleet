// `fleet read <agent>` — capture a worker's current screen.
import { readScreen, browserScreenshot } from "../cmux.js";
import { resolveAgent, target } from "../registry.js";

export function read(idOrLabel: string, lines = 50, scrollback = false): string {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  return readScreen(target(agent), lines, scrollback);
}

/** `fleet read <agent> --browser-screenshot <out>` — screenshot the worker's
 *  companion browser pane (spawn --with-browser) so the Captain can see a
 *  worker's app by agent id. */
export function readBrowserScreenshot(idOrLabel: string, outPath: string): string {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  if (!agent.browserSurfaceId) {
    throw new Error(`${agent.label} has no browser pane — spawn it with --with-browser [url]`);
  }
  browserScreenshot(agent.browserSurfaceId, outPath);
  return outPath;
}
