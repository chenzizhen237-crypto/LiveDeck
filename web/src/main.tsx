import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { platform as osPlatform } from "@tauri-apps/plugin-os";

import "./styles/globals.css";
import { Providers } from "@/components/providers/Providers";
import { AppShell } from "@/components/shell/AppShell";
import { MotionProvider } from "@/components/motion/MotionProvider";
import { ChannelPage } from "@/components/livedeck/ChannelPage";
import { RouterProvider, usePathname } from "@/router";
import type { UiPlatform } from "@/state/category/CategoryProvider";

const StandalonePlayer = lazy(() => import("@/screens/StandalonePlayer").then((m) => ({ default: m.StandalonePlayer })));

const CHANNELS: Record<string, UiPlatform> = { "/": "douyu", "/douyin/": "douyin", "/huya/": "huya", "/bilibili/": "bilibili" };

function Routes() {
  const pathname = usePathname();
  const path = pathname.endsWith("/") ? pathname : `${pathname}/`;
  if (path === "/player/") {
    return (
      <Suspense fallback={null}>
        <StandalonePlayer />
      </Suspense>
    );
  }
  const platform = CHANNELS[path === "//" ? "/" : path] ?? "douyu";
  // key: each channel keeps its own scroll and list state, as separate Next pages did.
  return <ChannelPage key={platform} platform={platform} />;
}

// CSS uses this to keep chrome clear of the macOS traffic lights (overlay title bar).
try {
  document.documentElement.dataset.os = osPlatform();
} catch {
  // not running inside Tauri (plain browser dev)
}

createRoot(document.getElementById("root")!).render(
  <RouterProvider>
    <Providers>
      <MotionProvider>
        <AppShell>
          <Routes />
        </AppShell>
      </MotionProvider>
    </Providers>
  </RouterProvider>
);
