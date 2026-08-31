import { AppShell } from "@/components/app-shell";

// Every tab lives in this group, so the shell (tab bar, mode line, global
// keys) mounts once and survives navigation between tabs.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
