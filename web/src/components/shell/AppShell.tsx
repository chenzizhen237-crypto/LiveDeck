// LiveDeck shell: no sidebar or navbar. The floating island handles platform,
// category, search and open rooms; the follow trigger sits top-right; the
// player opens as a full-window overlay underneath the island.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "@/router";
import { AnimatePresence } from "framer-motion";

import { DynamicIsland } from "@/components/livedeck/DynamicIsland";
import { FollowTrigger } from "@/components/livedeck/FollowPopover";
import { CategoryPopover } from "@/components/livedeck/CategoryPopover";
import { SearchModal } from "@/components/livedeck/SearchModal";
import { PerfHud } from "@/components/livedeck/PerfHud";
import { PlatformMark } from "@/components/livedeck/primitives";
import { PlaybackMonitorHost } from "@/components/metrics/PlaybackMonitorHost";
import { CommandPaletteHost } from "@/components/command/CommandPalette";
import { useRegisterCommands, type Command } from "@/services/commands";
import { LayoutGrid, Search } from "lucide-react";
import { SplitPickBanner, SplitView } from "@/components/split/SplitView";
import { SplitProvider, useSplit } from "@/state/split/SplitProvider";
import { PlayerOverlayHost, PlayerOverlayProvider, usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useCategories, type CategoryItem, type UiPlatform } from "@/state/category/CategoryProvider";

/** Platform marks as palette icons. */
const PLATFORM_ICONS: Record<UiPlatform, Command["icon"]> = {
  douyu: ({ size = 15 }) => <PlatformMark platform="douyu" size={size} />,
  huya: ({ size = 15 }) => <PlatformMark platform="huya" size={size} />,
  douyin: ({ size = 15 }) => <PlatformMark platform="douyin" size={size} />,
  bilibili: ({ size = 15 }) => <PlatformMark platform="bilibili" size={size} />
};

const ROUTES: Record<UiPlatform, string> = { douyu: "/", douyin: "/douyin/", huya: "/huya/", bilibili: "/bilibili/" };

function platformFromPath(pathname: string): UiPlatform {
  if (pathname.startsWith("/douyin")) return "douyin";
  if (pathname.startsWith("/huya")) return "huya";
  if (pathname.startsWith("/bilibili")) return "bilibili";
  return "douyu";
}

/** Lets the page report scroll so the island can switch to its compact state. */
const ShellScrollContext = createContext<(top: number) => void>(() => {});
export const useShellScroll = () => useContext(ShellScrollContext);

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <PlayerOverlayProvider>
      <SplitProvider>
        <Shell>{children}</Shell>
      </SplitProvider>
    </PlayerOverlayProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const overlay = usePlayerOverlay();
  const split = useSplit();
  const categories = useCategories();
  // Split view covers the page unless the user is out picking a room for it.
  const splitShown = split.open && !split.picking;
  const platform = platformFromPath(pathname);
  const [scrolled, setScrolled] = useState(false);
  const [panel, setPanel] = useState<"categories" | "search" | null>(null);

  const onScroll = useCallback((top: number) => setScrolled(top > 120), []);
  useEffect(() => setScrolled(false), [platform]);

  // ⌘K / Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPanel((p) => (p === "search" ? null : "search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goPlatform = useCallback(
    (p: UiPlatform) => {
      if (overlay.isOpen) overlay.closePlayer();
      if (p !== platform) router.push(ROUTES[p]);
    },
    [overlay, platform, router]
  );

  const pickCategory = useCallback(
    (p: UiPlatform, item: CategoryItem) => {
      categories.select(p, item);
      setPanel(null);
      goPlatform(p);
    },
    [categories, goPlatform]
  );

  const scrollCtx = useMemo(() => onScroll, [onScroll]);

  // Command palette: app-wide navigation lives here.
  const shellCommands = useMemo<Command[]>(
    () => [
      { id: "app.search", group: "app", order: 1, title: "搜索主播、直播间或分类", icon: Search, keys: ["⌘", "K"], keywords: ["search", "find", "搜索"], run: () => setPanel("search") },
      { id: "app.categories", group: "app", order: 3, title: "浏览分类", icon: LayoutGrid, keywords: ["category", "分类"], run: () => setPanel("categories") },
      ...(["douyu", "huya", "douyin", "bilibili"] as const).map((p, i) => ({
        id: `app.platform.${p}`,
        group: "app" as const,
        order: 10 + i,
        title: `切换到${{ douyu: "斗鱼", huya: "虎牙", douyin: "抖音", bilibili: "B 站" }[p]}`,
        icon: PLATFORM_ICONS[p],
        keys: ["⌘", String(i + 1)],
        bind: { code: `Digit${i + 1}`, meta: true },
        keywords: [p],
        run: () => goPlatform(p)
      }))
    ],
    [goPlatform]
  );
  useRegisterCommands("shell", shellCommands);

  return (
    <div className="ld-root fixed inset-0 overflow-hidden font-sans">
      {/* macOS overlay title bar: keep the top strip draggable */}
      <div className="fixed inset-x-0 top-0 z-[550] h-7" data-tauri-drag-region />

      <ShellScrollContext.Provider value={scrollCtx}>
        <main className="h-full">{children}</main>
      </ShellScrollContext.Provider>

      {split.open ? <SplitView /> : null}
      <SplitPickBanner />
      <PlayerOverlayHost />

      <DynamicIsland
        platform={platform}
        compact={scrolled}
        playerOpen={overlay.isOpen || splitShown}
        onPlatformChange={goPlatform}
        onOpenCategories={() => setPanel("categories")}
        onOpenSearch={() => setPanel("search")}
      />
      {!overlay.isOpen && !splitShown ? <FollowTrigger /> : null}

      <PerfHud />
      <PlaybackMonitorHost />
      <CommandPaletteHost />

      <AnimatePresence>
        {panel === "categories" ? <CategoryPopover key="cat" platform={platform} onClose={() => setPanel(null)} onPick={pickCategory} /> : null}
        {panel === "search" ? <SearchModal key="search" onClose={() => setPanel(null)} onPickCategory={pickCategory} /> : null}
      </AnimatePresence>
    </div>
  );
}
