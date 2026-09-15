import { definePlugin } from "@repo/plugins";
import { retainTool } from "./tools/retain/index.ts";
import { recallTool } from "./tools/recall/index.ts";
import { reflectTool } from "./tools/reflect/index.ts";
import { listMemoriesTool } from "./tools/list-memories/index.ts";

/**
 * Agent Hindsight: long-term memory for the agent through a Hindsight
 * server. Ships the `hindsight_retain`, `hindsight_recall`,
 * `hindsight_reflect`, and `hindsight_list` tools, plus the settings that
 * configure them — the server's Base URL, an optional API key, and the
 * default bank. A blank Base URL disables the tools and they say so.
 */
export const agentHindsight = definePlugin({
  id: "agent-hindsight",
  name: "Agent Hindsight",
  description:
    "Long-term memory for the agent through a Hindsight server (retain, recall, reflect).",
  settings: [
    {
      kind: "string",
      key: "baseUrl",
      label: "Base URL",
      description:
        "Base URL of the Hindsight server. Blank disables the tools.",
      placeholder: "http://localhost:8888",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return null;
        let url: URL;
        try {
          url = new URL(trimmed);
        } catch {
          return "needs a scheme and host, e.g. http://localhost:8888";
        }
        return url.protocol === "http:" || url.protocol === "https:"
          ? (url.hostname ? null : "needs a host, e.g. http://localhost:8888")
          : "needs an http(s) scheme, e.g. http://localhost:8888";
      },
    },
    {
      kind: "string",
      key: "apiKey",
      label: "API key",
      description:
        "Optional bearer token for a Hindsight server that requires auth (Hindsight Cloud). Leave blank for a local server without auth.",
      placeholder: "hs_...",
      secret: true,
      validate: (value) =>
        /\s/.test(value)
          ? "no spaces: a key is a single token"
          : null,
    },
    {
      kind: "string",
      key: "bankId",
      label: "Bank",
      description:
        "The memory bank the tools store to and read from.",
      placeholder: "assistant",
      validate: (value) =>
        /^[\w.-]*$/.test(value)
          ? null
          : "bank ids are letters, digits, dots, dashes and underscores, e.g. 'assistant'",
    },
  ],
  tools: [retainTool, recallTool, reflectTool, listMemoriesTool],
});

export default agentHindsight;

export { retainTool } from "./tools/retain/index.ts";
export { recallTool } from "./tools/recall/index.ts";
export { reflectTool } from "./tools/reflect/index.ts";
export { listMemoriesTool } from "./tools/list-memories/index.ts";
export { connectHindsight, resolveBank, toError } from "./hindsight.ts";