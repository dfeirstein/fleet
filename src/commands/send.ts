// `fleet send <agent> <text>` — steer a worker mid-flight (types text + Enter).
import { submit, sendText } from "../cmux.js";
import { resolveAgent, handle } from "../registry.js";

export function send(idOrLabel: string, text: string, withEnter = true): void {
  const agent = resolveAgent(idOrLabel);
  if (!agent) throw new Error(`no agent matching "${idOrLabel}" (try \`fleet status\`)`);
  if (withEnter) submit(handle(agent), text);
  else sendText(handle(agent), text);
}
