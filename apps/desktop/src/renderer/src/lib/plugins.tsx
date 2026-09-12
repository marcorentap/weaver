import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { PluginListResult } from "@shared/ipc-contract.js";

/**
 * Loaded plugins and their saved setting values — the config that the
 * Settings page shows. It used to live in `SettingsPage`'s own state, so
 * every pane that opened Settings re-ran `plugins:list` plus one settings
 * read per plugin. Now it loads once at app start (module-scope store, same
 * pattern as `lib/settings`), and every Settings pane reads the same
 * already-loaded data.
 */
type Snapshot = {
  list: PluginListResult | null;
  /** One bag of string values per plugin id, loaded from
   *  `weaver.plugins.<id>`. */
  values: Record<string, Record<string, string>>;
  hydrated: boolean;
};

const SERVER_SNAPSHOT: Snapshot = { list: null, values: {}, hydrated: false };
let current: Snapshot = { list: null, values: {}, hydrated: false };
const listeners = new Set<() => void>();

function commit(partial: Partial<Snapshot>) {
  current = { ...current, ...partial };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type PluginsContextValue = {
  plugins: PluginListResult | null;
  values: Record<string, Record<string, string>>;
  hydrated: boolean;
  setValue: (pluginId: string, key: string, value: string) => void;
  setDir: (dir: string) => void;
};

const context = createContext<PluginsContextValue | null>(null);

export function PluginsProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState(SERVER_SNAPSHOT);
  useEffect(() => {
    const unsubscribe = subscribe(() => setSnapshot(current));
    return () => unsubscribe();
  }, []);

  // One fetch of the plugin list and every plugin's setting values, at app
  // start, instead of per Settings pane.
  useEffect(() => {
    void (async () => {
      try {
        const result = await window.api.plugins.list();
        const values: Record<string, Record<string, string>> = {};
        for (const plugin of result.plugins) {
          const raw = await window.api.settings.get(
            `weaver.plugins.${plugin.id}`,
          );
          try {
            const parsed = raw ? (JSON.parse(raw) as unknown) : null;
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              !Array.isArray(parsed)
            ) {
              values[plugin.id] = Object.fromEntries(
                Object.entries(parsed).map(([key, value]) => [
                  key,
                  typeof value === "string" || typeof value === "number"
                    ? String(value)
                    : "",
                ]),
              );
            }
          } catch {
            // Corrupt plugin settings are ignored, same as app settings.
          }
          values[plugin.id] ??= {};
        }
        commit({ list: result, values, hydrated: true });
      } catch {
        commit({ hydrated: true });
      }
    })();
  }, []);

  const value = useMemo<PluginsContextValue>(
    () => ({
      plugins: snapshot.list,
      values: snapshot.values,
      hydrated: snapshot.hydrated,
      /** Persist one plugin setting field and update the local copy. */
      setValue: (pluginId, key, pluginValue) => {
        const next = {
          ...current.values[pluginId],
          [key]: pluginValue,
        };
        commit({ values: { ...current.values, [pluginId]: next } });
        void window.api.settings.set(
          `weaver.plugins.${pluginId}`,
          JSON.stringify(next),
        );
      },
      setDir: (dir) => {
        if (current.list) commit({ list: { ...current.list, dir } });
        void window.api.settings.set("weaver.plugins.dir", dir);
      },
    }),
    [snapshot],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

/** The shared plugin config; the Settings page reads from this instead of
 *  fetching per pane. */
export function usePlugins(): PluginsContextValue {
  const value = useContext(context);
  if (!value) throw new Error("usePlugins outside PluginsProvider");
  return value;
}
