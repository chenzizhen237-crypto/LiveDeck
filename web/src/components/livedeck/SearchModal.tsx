// ⌘K search (Desktop 05): followed first, then anchors from each platform's
// search, then categories. Arrow keys move, Enter opens, ⌘F toggles follow.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { m } from "framer-motion";
import { Search, Star, UserMinus, UserPlus } from "lucide-react";

import { Avatar, Kbd, LiveBadge, PLATFORM_META } from "./primitives";
import { searchAnchors, type SearchAnchorResult } from "@/services/search";
import { useFollow } from "@/state/follow/FollowProvider";
import { useCategories, type CategoryItem, type UiPlatform } from "@/state/category/CategoryProvider";
import { useOpenRoom } from "@/hooks/useOpenRoom";

type Item =
  | { kind: "room"; key: string; platform: UiPlatform; roomId: string; name: string; sub: string; avatar: string; live: boolean; followed: boolean }
  | { kind: "category"; key: string; platform: UiPlatform; item: CategoryItem };

const toEnum = (p: UiPlatform) => p.toUpperCase() as "DOUYU" | "DOUYIN" | "HUYA" | "BILIBILI";

export function SearchModal({ onClose, onPickCategory }: { onClose: () => void; onPickCategory: (p: UiPlatform, c: CategoryItem) => void }) {
  const follow = useFollow();
  const categories = useCategories();
  const openRoom = useOpenRoom();
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<SearchAnchorResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Debounced cross-platform anchor search.
  useEffect(() => {
    const kw = q.trim();
    if (!kw) {
      setRemote([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      const results = await Promise.allSettled((["douyu", "huya", "bilibili"] as const).map((p) => searchAnchors(p, kw)));
      if (!alive) return;
      setRemote(results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
      setLoading(false);
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [q]);

  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const isFollowed = (p: UiPlatform, id: string) => follow.isFollowed(toEnum(p), id);
    const followed: Item[] = follow.followedStreamers
      .filter((s) => !kw || s.nickname.toLowerCase().includes(kw) || s.id.includes(kw) || (s.roomTitle ?? "").toLowerCase().includes(kw))
      .slice(0, 5)
      .map((s) => {
        const p = s.platform.toLowerCase() as UiPlatform;
        return { kind: "room", key: `f:${p}:${s.id}`, platform: p, roomId: s.id, name: s.nickname, sub: `${PLATFORM_META[p].short} · ${s.roomTitle || "已关注"}`, avatar: s.avatarUrl, live: s.liveStatus === "LIVE", followed: true };
      });
    const anchors: Item[] = remote
      .filter((r) => !isFollowed(r.platform, r.roomId))
      .slice(0, 8)
      .map((r) => ({ kind: "room", key: `a:${r.platform}:${r.roomId}`, platform: r.platform, roomId: r.roomId, name: r.userName, sub: `房间 ${r.roomId} · ${r.liveStatus ? r.roomTitle : "未在直播"}`, avatar: r.avatar, live: r.liveStatus, followed: false }));
    // A bare number is most likely a room id: offer it on every platform.
    const byId: Item[] = /^\d{3,}$/.test(kw)
      ? (["douyu", "huya", "douyin", "bilibili"] as const).map((p) => ({ kind: "room", key: `id:${p}:${kw}`, platform: p, roomId: kw, name: `${PLATFORM_META[p].name} ${kw}`, sub: "按房间号打开", avatar: "", live: false, followed: isFollowed(p, kw) }))
      : [];
    const cats: Item[] = kw
      ? (["douyu", "huya", "douyin", "bilibili"] as const)
          .flatMap((p) => categories.groups(p).flatMap((g) => g.items).filter((c) => c.title.toLowerCase().includes(kw)).map((c) => ({ kind: "category" as const, key: `c:${p}:${c.id}`, platform: p, item: c })))
          .slice(0, 6)
      : [];
    return [
      { title: "已关注", items: followed },
      { title: "房间号", items: byId },
      { title: "主播", items: anchors },
      { title: "分类", items: cats }
    ].filter((g) => g.items.length > 0);
  }, [categories, follow, q, remote]);

  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setActive(0), [q]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === "category") onPickCategory(it.platform, it.item);
    else openRoom({ platform: it.platform, roomId: it.roomId, anchorName: it.name, avatar: it.avatar, isLive: it.live });
    onClose();
  };

  const toggleFollow = (it: Item) => {
    if (it.kind !== "room") return;
    if (it.followed) follow.unfollowStreamer(toEnum(it.platform), it.roomId);
    else
      follow.followStreamer({ id: it.roomId, platform: toEnum(it.platform), nickname: it.name, avatarUrl: it.avatar, currentRoomId: it.roomId, liveStatus: it.live ? "LIVE" : "OFFLINE" });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "f" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (flat[active]) toggleFollow(flat[active]);
    }
  };

  let idx = -1;
  return (
    <div className="fixed inset-0 z-[700] flex items-start justify-center px-4 pt-[14vh]" onKeyDown={onKey}>
      <m.button type="button" aria-label="关闭" className="absolute inset-0 bg-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <m.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        className="relative flex w-full max-w-[720px] flex-col overflow-hidden rounded-[20px] border border-line-strong bg-elevated text-fg shadow-pop backdrop-blur-2xl"
      >
        <div className="flex items-center gap-3 px-5 py-[18px]">
          <Search size={20} className="text-fg-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索主播、房间号或分类…"
            className="flex-1 bg-transparent text-lg font-medium outline-none placeholder:text-fg-3"
          />
          {loading ? <span className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> : null}
          <Kbd>ESC</Kbd>
        </div>
        <div className="h-px bg-line" />
        <div className="max-h-[56vh] overflow-y-auto p-2">
          {groups.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-fg-3">{q.trim() ? (loading ? "正在搜索全平台…" : "没有匹配结果") : "输入主播名、房间号或分类名"}</p>
          ) : (
            groups.map((g) => (
              <div key={g.title}>
                <p className="px-2.5 pt-2.5 pb-1 text-[11px] font-bold tracking-wider text-fg-3">{g.title}</p>
                {g.items.map((it) => {
                  idx += 1;
                  const i = idx;
                  const on = i === active;
                  return (
                    <div
                      key={it.key}
                      role="option"
                      aria-selected={on}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(it)}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 ${on ? "bg-selected" : ""}`}
                    >
                      {it.kind === "category" ? (
                        <span className="grid size-9 place-items-center rounded-full bg-chip text-fg-3">
                          <Star size={15} />
                        </span>
                      ) : (
                        <Avatar src={it.avatar} name={it.name} platform={it.platform} size={36} />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-bold">{it.kind === "category" ? it.item.title : it.name}</span>
                          {it.kind === "room" && it.live ? <LiveBadge /> : null}
                          {it.kind === "room" && it.followed ? <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">已关注</span> : null}
                          <span className="rounded-md bg-chip px-2 py-0.5 text-[11px] font-semibold text-fg-2">{PLATFORM_META[it.platform].short}</span>
                        </span>
                        <span className="block truncate text-xs font-medium text-fg-3">{it.kind === "category" ? it.item.cate1Title : it.sub}</span>
                      </span>
                      {on ? (
                        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-fg-3">
                          打开 <Kbd>↵</Kbd>
                        </span>
                      ) : it.kind === "room" ? (
                        <button
                          type="button"
                          aria-label={it.followed ? "取消关注" : "关注"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFollow(it);
                          }}
                          className="grid size-8 place-items-center rounded-full bg-chip text-fg-3 hover:text-accent"
                        >
                          {it.followed ? <UserMinus size={14} /> : <UserPlus size={14} />}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-line px-5 py-2.5 text-[11px] font-medium text-fg-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> 选择
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> 打开
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>⌘F</Kbd> 关注
          </span>
        </div>
      </m.div>
    </div>
  );
}
