// Minimal hash router. The app has four channel routes and one standalone
// player route, so a library isn't worth it. Hash URLs (#/huya/) keep working
// when Tauri's asset protocol reloads the page, which path URLs wouldn't.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type Location = { pathname: string; search: string };

function readLocation(): Location {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const q = raw.indexOf("?");
  return { pathname: q === -1 ? raw : raw.slice(0, q) || "/", search: q === -1 ? "" : raw.slice(q) };
}

type RouterValue = Location & { push: (to: string) => void; replace: (to: string) => void; back: () => void };

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [loc, setLoc] = useState<Location>(readLocation);

  useEffect(() => {
    const onChange = () => setLoc(readLocation());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const push = useCallback((to: string) => {
    window.location.hash = to;
  }, []);
  const replace = useCallback((to: string) => {
    window.history.replaceState(null, "", `#${to}`);
    setLoc(readLocation());
  }, []);
  const back = useCallback(() => window.history.back(), []);

  const value = useMemo(() => ({ ...loc, push, replace, back }), [back, loc, push, replace]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouterContext() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("router hooks must be used within RouterProvider");
  return ctx;
}

export function usePathname() {
  return useRouterContext().pathname;
}

export function useSearchParams() {
  const { search } = useRouterContext();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useRouter() {
  const { push, replace, back } = useRouterContext();
  return useMemo(() => ({ push, replace, back }), [back, push, replace]);
}
