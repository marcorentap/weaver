/**
 * Registry mapping an inference endpoint's hostname to a known provider,
 * so settings can show that provider's own fields without asking the user
 * to say twice which provider they're using. Adding a new provider is the
 * only step needed to support one: `SettingsPage.tsx` renders `fields`
 * generically off `detectProvider`, and the main process reads the same
 * field keys back out of `providerSettings` (see `main/ipc/agent.ts`'s
 * `providerTuning`) to build that provider's own request tuning.
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
      description: "Comma-separated provider slugs. Blank allows any.",
      placeholder: "deepinfra,together",
    },
    {
      key: "sort",
      label: "Sort providers by",
      description: "Routing preference.",
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
      description: "Reasoning effort. Support varies by model.",
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

const SAIL: ProviderDef = {
  id: "sail",
  name: "Sail",
  hosts: ["api.sailresearch.com"],
  fields: [
    {
      key: "thinkingLevel",
      label: "Reasoning effort",
      description: "Reasoning effort. Support varies by model.",
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
    {
      key: "completionWindow",
      label: "Completion window",
      description:
        "Trade latency for lower token cost. Not every model supports every window; see docs.sailresearch.com/pricing.",
      options: [
        { value: "", label: "Default (ASAP)" },
        { value: "balanced", label: "Balanced" },
        { value: "flex", label: "Flex" },
      ],
    },
  ],
};

const PROVIDERS: readonly ProviderDef[] = [OPENROUTER, SAIL];

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
