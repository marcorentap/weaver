/**
 * Registry mapping an inference endpoint's hostname to a known provider,
 * so settings can show that provider's own fields without asking the user
 * to say twice which provider they're using. Adding a new provider is the
 * only step needed to support one: `SettingsPage.tsx` renders `fields`
 * generically off `detectProvider`, and the main process reads the same
 * field keys back out of `providerSettings` (see `main/ipc/agent.ts`'s
 * `openRouterTuning`) to build that provider's own request tuning.
 *
 * Shared between the renderer (settings UI) and the main process (request
 * building), so both read one definition instead of drifting apart.
 */

export type ProviderFieldOption = { value: string; label: string };

export type ProviderField = {
  /** Key under `Settings.aiProviderSettings[providerId]`. */
  key: string;
  label: string;
  description: string;
  placeholder?: string;
  /** Fixed choices, cyclable like a settings `option` row. Free text when
   *  omitted. */
  options?: readonly ProviderFieldOption[];
};

export type ProviderDef = {
  id: string;
  name: string;
  /** Endpoint hostnames that identify this provider. */
  hosts: readonly string[];
  fields: readonly ProviderField[];
};

const OPENROUTER: ProviderDef = {
  id: "openrouter",
  name: "OpenRouter",
  hosts: ["openrouter.ai"],
  fields: [
    {
      key: "only",
      label: "Only providers",
      description:
        "Comma-separated provider slugs to restrict routing to, e.g. deepinfra,together. Blank allows any.",
      placeholder: "deepinfra,together",
    },
    {
      key: "sort",
      label: "Sort providers by",
      description: "Routing preference among the providers allowed above.",
      options: [
        { value: "", label: "Default" },
        { value: "price", label: "Price" },
        { value: "throughput", label: "Throughput" },
        { value: "latency", label: "Latency" },
      ],
    },
    {
      key: "thinkingLevel",
      label: "Thinking level",
      description:
        "Reasoning effort a thinking-capable model spends before answering. Support and accepted values vary by model; some reject a value they don't support instead of ignoring it. Leave on Default to omit the field entirely.",
      options: [
        { value: "", label: "Default" },
        { value: "off", label: "Off" },
        { value: "minimal", label: "Minimal" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra high" },
      ],
    },
  ],
};

const PROVIDERS: readonly ProviderDef[] = [OPENROUTER];

/** The provider `endpoint`'s hostname belongs to, or null when it is blank,
 *  unparseable, or matches none registered above. */
export function detectProvider(endpoint: string): ProviderDef | null {
  let host: string;
  try {
    host = new URL(endpoint.trim()).hostname;
  } catch {
    return null;
  }
  return PROVIDERS.find((provider) => provider.hosts.includes(host)) ?? null;
}
