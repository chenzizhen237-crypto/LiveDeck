import { useEffect } from "react";
import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useSettings } from "../../stores/settings";
import { useProxyBase } from "../../hooks/useProxyBase";

export function AppShell() {
  const theme = useSettings((s) => s.theme);
  useProxyBase(); // warm the proxy base so images can render synchronously

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="flex h-full gap-2 p-2">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-panel">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
