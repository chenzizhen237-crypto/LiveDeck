// Follow trigger (top-right) + popover (Desktop 04). Live streamers sort first,
// platform chips filter, refresh fans out with limited concurrency, and a
// streamer that flips to LIVE raises an island notification.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Loader2, RotateCw, SunMoon, UsersRound } from "lucide-react";

import { Avatar, IconButton, PLATFORM_META, PLATFORMS } from "./primitives";
import { useIsland } from "./IslandProvider";
import { useFollow, type FollowedStreamer } from "@/state/follow/FollowProvider";
import { useTheme } from "@/state/theme/ThemeProvider";
import { useOpenRoom } from "@/hooks/useOpenRoom";
import { useImageProxy } from "@/hooks/useImageProxy";
import { refreshOne } from "@/services/followRefresh";
import type { UiPlatform } from "@/state/category/CategoryProvider";

const CONCURRENCY = 2;
const key = (s: FollowedStreamer) => `${s.platform}:${s.id}`;
const toUi = (p: FollowedStreamer["platform"]) => p.toLowerCase() as UiPlatform;

export function FollowTrigger() {
  const follow = useFollow();
  const [open, setOpen] = useState(false);
  const liveCount = follow.followedStreamers.filter((s) => s.liveStatus === "LIVE").length;

  return (
    <div className="fixed top-4 right-4 z-[600]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="关注列表"
        className={`relative grid size-11 place-items-center rounded-[14px] border bg-glass text-fg shadow-float backdrop-blur-2xl transition-colors ${
          open ? "border-focus" : "border-line-strong hover:bg-elevated"
        }`}
      >
        <UsersRound size={18} />
        {liveCount > 0 ? (
          <span className="absolute -top-1.5 -right-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-live px-1 text-[10px] font-extrabold text-white ring-2 ring-[var(--ld-bg-app)]">
            {liveCount}
          </span>
        ) : null}
      </button>
      <FollowRefresher />
      <AnimatePresence>{open ? <FollowPopover onClose={() => setOpen(false)} /> : null}</AnimatePresence>
    </div>
  );
}

/** Shared refresh state so the popover can show progress even after reopening. */
const refreshBus = {
  running: false,
  pending: new Set<string>(),
  listeners: new Set<() => void>(),
  emit() {
    this.listeners.forEach((l) => l());
  }
};

function useRefresh() {
  const follow = useFollow();
  const island = useIsland();
  const { ensureProxyStarted } = useImageProxy();
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    refreshBus.listeners.add(l);
    return () => void refreshBus.listeners.delete(l);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshBus.running) return;
    const list = follow.followedStreamers;
    refreshBus.running = true;
    list.forEach((s) => refreshBus.pending.add(key(s)));
    refreshBus.emit();
    if (list.some((s) => s.platform === "HUYA" || s.platform === "BILIBILI")) await ensureProxyStarted();

    let idx = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
        while (idx < list.length) {
          const s = list[idx++];
          try {
            const patch = await refreshOne(s);
            follow.updateStreamer(s.platform, s.id, patch);
            if (s.liveStatus === "OFFLINE" && patch.liveStatus === "LIVE") {
              island.notify({
                platform: toUi(s.platform),
                roomId: s.id,
                anchorName: patch.nickname ?? s.nickname,
                avatar: patch.avatarUrl ?? s.avatarUrl,
                title: patch.roomTitle ?? s.roomTitle ?? ""
              });
            }
          } catch {
            if (s.liveStatus === "LIVE") follow.updateStreamer(s.platform, s.id, { liveStatus: "UNKNOWN" });
          } finally {
            refreshBus.pending.delete(key(s));
            refreshBus.emit();
          }
        }
      })
    );
    refreshBus.running = false;
    refreshBus.emit();
  }, [ensureProxyStarted, follow, island]);

  return { refresh, running: refreshBus.running, pending: refreshBus.pending };
}

/** Refreshes once shortly after launch, then every 5 minutes. */
function FollowRefresher() {
  const follow = useFollow();
  const { refresh } = useRefresh();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!follow.hydrated || follow.followedStreamers.length === 0) return;
    if (!follow.consumeInitialAutoRefresh()) return;
    const first = window.setTimeout(() => void refreshRef.current(), 1500);
    const every = window.setInterval(() => void refreshRef.current(), 5 * 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow.hydrated, follow.followedStreamers.length]);
  return null;
}

function FollowPopover({ onClose }: { onClose: () => void }) {
  const follow = useFollow();
  const { toggleLightDark } = useTheme();
  const openRoom = useOpenRoom();
  const { refresh, running, pending } = useRefresh();
  const [filter, setFilter] = useState<UiPlatform | "all">("all");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const trigger = (e.target as HTMLElement).closest("[aria-label='关注列表']");
      if (ref.current && !ref.current.contains(e.target as Node) && !trigger) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const rows = useMemo(() => {
    const list = follow.followedStreamers.filter((s) => filter === "all" || toUi(s.platform) === filter);
    // Live first; keep the user's order within each group.
    return [...list].sort((a, b) => Number(b.liveStatus === "LIVE") - Number(a.liveStatus === "LIVE"));
  }, [filter, follow.followedStreamers]);
  const liveCount = follow.followedStreamers.filter((s) => s.liveStatus === "LIVE").length;
  const present = PLATFORMS.filter((p) => follow.followedStreamers.some((s) => toUi(s.platform) === p));

  return (
    <m.div
      ref={ref}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      style={{ transformOrigin: "top right" }}
      className="absolute top-full right-0 mt-3 flex max-h-[70vh] w-[340px] flex-col overflow-hidden rounded-[20px] border border-line-strong bg-elevated text-fg shadow-pop backdrop-blur-2xl"
    >
      <div className="flex items-center gap-2 px-[18px] pt-[18px] pb-2.5">
        <h3 className="text-lg font-extrabold">关注</h3>
        {liveCount > 0 ? <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">{liveCount} 直播中</span> : null}
        <span className="flex-1" />
        <IconButton label="刷新" size={32} onClick={() => void refresh()}>
          <RotateCw size={15} className={running ? "animate-spin" : ""} />
        </IconButton>
      </div>
      {present.length > 1 ? (
        <div className="flex gap-1.5 px-[18px] pb-2">
          {(["all", ...present] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setFilter(p)}
              className={`rounded-full px-3 py-1 text-xs font-bold transition-colors ${
                filter === p ? "bg-fg text-surface" : "bg-chip text-fg-2 hover:text-fg"
              }`}
            >
              {p === "all" ? "全部" : PLATFORM_META[p].short}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-fg-3">在直播间点击「关注」，主播会出现在这里</p>
        ) : (
          rows.map((s) => {
            const live = s.liveStatus === "LIVE";
            const loading = pending.has(key(s));
            return (
              <button
                key={key(s)}
                type="button"
                onClick={() => {
                  openRoom({ platform: toUi(s.platform), roomId: s.id, anchorName: s.nickname, avatar: s.avatarUrl, title: s.roomTitle, isLive: live });
                  onClose();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-hover ${live ? "" : "opacity-55"}`}
              >
                <span className="relative">
                  <Avatar src={s.avatarUrl} name={s.nickname} platform={toUi(s.platform)} size={40} />
                  <span
                    className={`absolute -right-0.5 -bottom-0.5 size-[11px] rounded-full ring-2 ring-[var(--ld-bg-elevated)] ${live ? "bg-online" : "bg-offline"}`}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-bold">{s.nickname}</span>
                  <span className="block truncate text-[11px] font-medium text-fg-3">{live ? s.roomTitle || "直播中" : "未在直播"}</span>
                </span>
                {loading ? (
                  <Loader2 size={14} className="animate-spin text-fg-3" />
                ) : (
                  <span className="rounded-md bg-chip px-2 py-0.5 text-[11px] font-semibold text-fg-2">{PLATFORM_META[toUi(s.platform)].short}</span>
                )}
              </button>
            );
          })
        )}
      </div>
      <div className="flex items-center justify-between border-t border-line px-[18px] py-2.5">
        <span className="text-[11px] font-semibold text-fg-3">LiveDeck 0.1.0</span>
        <button type="button" onClick={toggleLightDark} aria-label="切换主题" className="text-fg-3 hover:text-fg">
          <SunMoon size={16} />
        </button>
      </div>
    </m.div>
  );
}
