/**
 * Registry mapping an inference endpoint's hostname to a known provider,
 * so settings can show that provider's own fields and links without
 * asking the user to say twice which provider they're using. Adding a new
 * provider is the only step needed to support one: `SettingsPage.tsx`
 * renders `fields`/`links` generically off `detectProvider`, and the main
 * process reads the same field keys back out of `providerSettings` (see
 * `main/ipc/agent.ts`'s `providerCompat`) to build that provider's own
 * request tuning.
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

export type ProviderLink = { label: string; url: string };

export type ProviderDef = {
  id: string;
  name: string;
  /** Endpoint hostnames that identify this provider. */
  hosts: readonly string[];
  fields: readonly ProviderField[];
  /** External dashboard pages, shown as plain links under this provider's
   *  settings section. Opened through the OS browser (see the main
   *  window's `setWindowOpenHandler`), never loaded in-app. */
  links: readonly ProviderLink[];
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
  ],
  links: [
    {
      label: "Account guardrails",
      url: "https://openrouter.ai/settings/privacy",
    },
    { label: "Usage & credits", url: "https://openrouter.ai/credits" },
    { label: "API keys", url: "https://openrouter.ai/settings/keys" },
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
