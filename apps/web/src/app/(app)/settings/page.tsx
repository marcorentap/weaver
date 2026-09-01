"use client";

import { Button } from "@/components/ui/button";
import { LINE_NUMBER_OPTIONS, useSettings } from "@/lib/settings";

export default function SettingsPage() {
  const { settings, hydrated, setLineNumber } = useSettings();

  return (
    <div className="space-y-1 p-4">
      <h1 className="font-semibold">Settings</h1>

      <section className="space-y-1 pt-1">
        <h2 className="text-muted-foreground">Appearance</h2>
        <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="font-medium">Line number</p>
            <p className="text-muted-foreground">
              Show each block&apos;s position in the left gutter of chat.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {LINE_NUMBER_OPTIONS.map((option) => (
              <Button
                key={option.value}
                size="xs"
                variant={
                  settings.lineNumber === option.value ? "default" : "outline"
                }
                disabled={!hydrated}
                onClick={() => setLineNumber(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}