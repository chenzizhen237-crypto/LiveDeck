// The floating island (Island motion page in LiveDeck UI.nib).
//   Browse: D · Expanded at scroll 0, C · Compact once the page scrolls.
//   Player: A · Rest (thin line) → B · Peek on hover → D · Expanded on click.
//   Capsules widen on hover (E); more than 4 rooms collapse into "+N" (H).
//   Notifications (F, e.g. a followed streamer went live) take over briefly.

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ChevronDown, LayoutGrid, Play, Search, Volume2, X } from "lucide-react";

import { Avatar, Kbd, PLATFORM_META, PLATFORMS, PlatformMark } from "./primitives";
import { useActiveStreams, type ActiveStreamer } from "@/state/activeStreams/ActiveStreamsProvider";
import { useCategories, type UiPlatform } from "@/state/category/CategoryProvider";
import { useOpenRoom } from "@/hooks/useOpenRoom";
import { useIsland } from "./IslandProvider";

const SPRING = { type: "spring" as const, stiffness: 420, damping: 34 };
const MAX_CAPSULES = 4;

export function DynamicIsland({
  platform,
  compact,
  playerOpen,
  onPlatformChange,
  onOpenCategories,
  onOpenSearch
}: {
  platform: UiPlatform;
  compact: boolean;
  playerOpen: boolean;
  onPlatformChange: (p: UiPlatform) => void;
  onOpenCategories: () => void;
  onOpenSearch: () => void;
}) {
  const island = useIsland();
  const [platformMenu, setPlatformMenu] = useState(false);
  // Player-mode reveal: rest → peek (hover) → expanded (click).
  const [reveal, setReveal] = useState<"rest" | "peek" | "open">("rest");
  const hideTimer = useRef<number | null>(null);

  useEffect(() => setReveal("rest"), [playerOpen]);

  const scheduleHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setReveal("rest"), 2000);
  };

  const notification = island.notifications[0];
  const state = notification ? "notify" : playerOpen ? reveal : compact ? "compact" : "open";

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[600] flex justify-center"
      onMouseLeave={() => playerOpen && reveal !== "rest" && scheduleHide()}
    >
      {/* Hover strip that wakes the island while a stream is playing */}
      {playerOpen && reveal === "rest" ? (
        <div className="pointer-events-auto absolute inset-x-0 top-0 h-8" onMouseEnter={() => setReveal("peek")} />
      ) : null}

      <m.div
        layout
        transition={SPRING}
        className={`pointer-events-auto relative mt-4 flex items-center border border-line-strong bg-glass text-fg shadow-float backdrop-blur-2xl ${
          state === "rest" ? "border-transparent bg-transparent shadow-none backdrop-blur-none" : ""
        }`}
        style={{ borderRadius: state === "notify" ? 28 : 999 }}
        onMouseEnter={() => hideTimer.current && window.clearTimeout(hideTimer.current)}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {state === "rest" ? (
            <m.div key="rest" layout className="h-1 w-24 rounded-full bg-white/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          ) : state === "peek" ? (
            <PeekContent key="peek" onClick={() => setReveal("open")} />
          ) : state === "notify" ? (
            <NotifyContent key="notify" />
          ) : (
            <m.div
              key="full"
              layout
              className="flex items-center gap-1 p-1.5"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            >
              <PlatformSwitcher
                platform={platform}
                compact={state === "compact"}
                open={platformMenu}
                setOpen={setPlatformMenu}
                onChange={(p) => {
                  setPlatformMenu(false);
                  onPlatformChange(p);
                }}
              />
              <Separator />
              <CategoryTrigger platform={platform} onClick={onOpenCategories} />
              <button
                type="button"
                onClick={onOpenSearch}
                className="flex h-9 items-center gap-2 rounded-full bg-hover px-3 text-fg-3 transition-colors hover:text-fg"
                aria-label="搜索"
              >
                <Search size={15} />
                {state !== "compact" ? (
                  <>
                    <span className="text-[13px] font-medium">搜索</span>
                    <Kbd>⌘K</Kbd>
                  </>
                ) : null}
              </button>
              <Capsules compact={state === "compact"} />
            </m.div>
          )}
        </AnimatePresence>
      </m.div>
    </div>
  );
}

function Separator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-line-strong" />;
}

function PlatformSwitcher({
  platform,
  compact,
  open,
  setOpen,
  onChange
}: {
  platform: UiPlatform;
  compact: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onChange: (p: UiPlatform) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-9 items-center gap-2 rounded-full px-3 transition-colors hover:bg-hover"
      >
        <PlatformMark platform={platform} />
        {!compact ? <span className="text-sm font-extrabold">{PLATFORM_META[platform].name}</span> : null}
        <ChevronDown size={14} className={`text-fg-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {open ? (
          <m.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            className="absolute top-full left-0 mt-3 w-44 rounded-2xl border border-line-strong bg-elevated p-1.5 shadow-pop backdrop-blur-xl"
          >
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange(p)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-colors hover:bg-hover ${
                  p === platform ? "bg-selected text-accent" : "text-fg"
                }`}
              >
                <PlatformMark platform={p} />
                {PLATFORM_META[p].name}
              </button>
            ))}
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function CategoryTrigger({ platform, onClick }: { platform: UiPlatform; onClick: () => void }) {
  const categories = useCategories();
  const selected = categories.selected(platform);
  return (
    <button type="button" onClick={onClick} className="flex h-9 items-center gap-2 rounded-full px-3.5 transition-colors hover:bg-hover">
      <LayoutGrid size={15} className="text-accent" />
      <span className="max-w-[120px] truncate text-sm font-bold">{selected?.title ?? "全部分类"}</span>
      <ChevronDown size={14} className="text-fg-3" />
    </button>
  );
}

function Capsules({ compact }: { compact: boolean }) {
  const active = useActiveStreams();
  const openRoom = useOpenRoom();
  if (active.streamers.length === 0) return null;

  const isCurrent = (s: ActiveStreamer) => s.platform === active.current?.platform && s.roomId === active.current?.roomId;
  const others = active.streamers.filter((s) => !isCurrent(s));
  const current = active.current;
  const visibleOthers = compact ? [] : others.slice(0, MAX_CAPSULES - 1);
  const overflow = others.length - visibleOthers.length;

  return (
    <>
      <Separator />
      <div className="flex items-center gap-1">
        {current ? <PlayingCapsule s={current} compact={compact} onOpen={() => openRoom(current)} onClose={() => active.remove(current.platform, current.roomId)} /> : null}
        {visibleOthers.map((s) => (
          <IdleCapsule key={`${s.platform}:${s.roomId}`} s={s} onOpen={() => openRoom(s)} onClose={() => active.remove(s.platform, s.roomId)} />
        ))}
        {overflow > 0 && !compact ? (
          <span className="grid h-[30px] place-items-center rounded-full bg-chip px-2.5 text-xs font-extrabold text-fg-2">+{overflow}</span>
        ) : null}
      </div>
    </>
  );
}

function Equalizer() {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden>
      {[0, 0.2, 0.1].map((d, i) => (
        <span
          key={i}
          className="h-full w-[2px] origin-bottom rounded-full bg-accent"
          style={{ animation: `ld-eq 0.9s ${d}s ease-in-out infinite` }}
        />
      ))}
    </span>
  );
}

function PlayingCapsule({ s, compact, onOpen, onClose }: { s: ActiveStreamer; compact: boolean; onOpen: () => void; onClose: () => void }) {
  return (
    <m.div layout className="flex items-center gap-2.5 rounded-full bg-selected py-[3px] pr-2.5 pl-[3px]">
      <button type="button" onClick={onOpen} className="rounded-full p-[2px] ring-[1.5px] ring-accent" aria-label={`回到 ${s.anchorName}`}>
        <Avatar src={s.avatar} name={s.anchorName} platform={s.platform} size={26} />
      </button>
      {!compact ? (
        <>
          <button type="button" onClick={onOpen} className="flex flex-col text-left leading-tight">
            <span className="max-w-[110px] truncate text-xs font-bold">{s.anchorName}</span>
            <span className="text-[10px] font-medium text-fg-3">正在播放</span>
          </button>
          <Equalizer />
          <Volume2 size={14} className="text-fg-3" />
          <button type="button" onClick={onClose} className="text-fg-3 hover:text-live" aria-label="关闭">
            <X size={14} />
          </button>
        </>
      ) : null}
    </m.div>
  );
}

function IdleCapsule({ s, onOpen, onClose }: { s: ActiveStreamer; onOpen: () => void; onClose: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <m.div
      layout
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`flex items-center gap-2 rounded-full ${hover ? "bg-hover py-[3px] pr-2.5 pl-[3px]" : ""}`}
    >
      <button type="button" onClick={onOpen} className="relative" aria-label={`切换到 ${s.anchorName}`}>
        <Avatar src={s.avatar} name={s.anchorName} platform={s.platform} size={30} />
        <span className={`absolute -right-0.5 -bottom-0.5 size-[9px] rounded-full ring-2 ring-[var(--ld-bg-surface)] ${s.isLive ? "bg-online" : "bg-offline"}`} />
      </button>
      <AnimatePresence initial={false}>
        {hover ? (
          <m.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-2 overflow-hidden whitespace-nowrap"
          >
            <button type="button" onClick={onOpen} className="flex flex-col text-left leading-tight">
              <span className="max-w-[110px] truncate text-xs font-bold">{s.anchorName}</span>
              <span className="text-[10px] font-medium text-fg-3">点击切换</span>
            </button>
            <Play size={13} className="text-accent" />
            <button type="button" onClick={onClose} className="text-fg-3 hover:text-live" aria-label="关闭">
              <X size={13} />
            </button>
          </m.div>
        ) : null}
      </AnimatePresence>
    </m.div>
  );
}

function PeekContent({ onClick }: { onClick: () => void }) {
  const active = useActiveStreams();
  return (
    <m.button
      layout
      type="button"
      onClick={onClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex items-center gap-1.5 px-3.5 py-[7px]"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-live" />
      <span className="text-[10px] font-extrabold tracking-[0.15em]">LIVE</span>
      {active.current ? <span className="max-w-[160px] truncate text-[11px] font-semibold text-fg-2">· {active.current.anchorName}</span> : null}
    </m.button>
  );
}

function NotifyContent() {
  const island = useIsland();
  const openRoom = useOpenRoom();
  const n = island.notifications[0];
  if (!n) return null;
  return (
    <m.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex items-center gap-3 p-2.5"
    >
      <span className="relative">
        <Avatar src={n.avatar} name={n.anchorName} platform={n.platform} size={44} />
        <span className="absolute -right-1 -bottom-1 rounded bg-live px-1 text-[8px] font-extrabold text-white">LIVE</span>
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-extrabold">{n.anchorName} 开播了</span>
        <span className="max-w-[220px] truncate text-[11px] font-medium text-fg-3">{n.title || PLATFORM_META[n.platform].name}</span>
      </span>
      <button
        type="button"
        onClick={() => {
          island.dismiss(n.id);
          openRoom(n);
        }}
        className="ml-4 flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-bold text-on-accent"
      >
        <Play size={13} /> 观看
      </button>
      <button type="button" onClick={() => island.dismiss(n.id)} className="text-fg-3 hover:text-fg" aria-label="忽略">
        <X size={14} />
      </button>
    </m.div>
  );
}
