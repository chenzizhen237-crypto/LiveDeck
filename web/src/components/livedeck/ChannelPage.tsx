// Channel screen (Desktop 01/02): breadcrumb, hero category title with favourite,
// Douyu sub-category chips, and the infinite room grid.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Play, RotateCw, Star, Tv, Users } from "lucide-react";

import { Avatar, LiveBadge, PLATFORM_META, PlatformMark } from "./primitives";
import { useCategories, type UiPlatform } from "@/state/category/CategoryProvider";
import { useOpenRoom } from "@/hooks/useOpenRoom";
import { useHuyaLiveRooms } from "@/hooks/liveRooms/useHuyaLiveRooms";
import { useDouyinLiveRooms } from "@/hooks/liveRooms/useDouyinLiveRooms";
import { useBilibiliLiveRooms } from "@/hooks/liveRooms/useBilibiliLiveRooms";
import { useDouyuLiveRooms } from "@/hooks/liveRooms/useDouyuLiveRooms";
import type { CommonStreamer } from "@/platforms/common/streamerTypes";
import { useShellScroll } from "@/components/shell/AppShell";

export function ChannelPage({ platform }: { platform: UiPlatform }) {
  const onScroll = useShellScroll();
  const categories = useCategories();
  const selected = categories.selected(platform);
  const cate3 = platform === "douyu" ? categories.douyuCate3 : null;
  const fav = selected ? categories.isFavorite(platform, selected.id) : false;

  const params = useMemo(() => {
    const href = selected?.id ?? null;
    const parts = href?.split("_") ?? [];
    return {
      huyaGid: platform === "huya" ? selected?.gid ?? null : null,
      douyinPartition: platform === "douyin" && parts.length >= 1 ? parts[parts.length - 1] : null,
      douyinType: platform === "douyin" && parts.length >= 2 ? parts[parts.length - 2] : null,
      biliArea: platform === "bilibili" ? selected?.gid ?? null : null,
      biliParent: platform === "bilibili" ? selected?.parentId ?? null : null,
      douyuType: platform === "douyu" && href ? (cate3 ? ("cate3" as const) : ("cate2" as const)) : null,
      douyuId: platform === "douyu" ? cate3?.id ?? href : null
    };
  }, [cate3, platform, selected]);

  // All hooks run (rules of hooks); non-current platforms get null params and stay idle.
  const huya = useHuyaLiveRooms(params.huyaGid, { defaultPageSize: 120 });
  const douyin = useDouyinLiveRooms(params.douyinPartition, params.douyinType);
  const bili = useBilibiliLiveRooms(params.biliArea, params.biliParent);
  const douyu = useDouyuLiveRooms(params.douyuType, params.douyuId);
  const list = platform === "huya" ? huya : platform === "douyin" ? douyin : platform === "bilibili" ? bili : douyu;
  const error: string | null = (list as { error?: string | null }).error ?? null;

  const rooms = useMemo(() => {
    const seen = new Set<string>();
    return list.rooms.filter((r) => {
      const id = String(r.room_id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [list.rooms]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = scroller.current;
    const el = sentinel.current;
    if (!root || !el || !list.hasMore) return;
    const io = new IntersectionObserver(
      ([entry]) => entry?.isIntersecting && !list.isLoading && !list.isLoadingMore && void list.loadMoreRooms(),
      { root, rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [list, rooms.length]);

  return (
    <div ref={scroller} className="h-full overflow-y-auto" onScroll={(e) => onScroll(e.currentTarget.scrollTop)}>
      <div className="mx-auto max-w-[1600px] px-10 pt-28 pb-16">
        <header className="mb-7">
          <div className="mb-5 flex items-center gap-2.5 text-[13px] font-semibold text-fg-3">
            <PlatformMark platform={platform} />
            {PLATFORM_META[platform].name}
            {selected?.cate1Title ? <span>· {selected.cate1Title}</span> : null}
          </div>
          <div className="flex items-end justify-between gap-6">
            <div className="flex items-center gap-4">
              <h1 className="text-[56px] leading-none font-black tracking-[-0.03em] text-fg">{cate3?.name ?? selected?.title ?? "选择分类"}</h1>
              {selected ? (
                <button
                  type="button"
                  aria-label={fav ? "取消收藏" : "收藏分类"}
                  onClick={() => categories.toggleFavorite(platform, selected)}
                  className={`grid size-9 place-items-center rounded-full transition-colors ${fav ? "bg-accent-soft text-accent" : "bg-chip text-fg-3 hover:text-accent"}`}
                >
                  <Star size={16} fill={fav ? "currentColor" : "none"} />
                </button>
              ) : null}
            </div>
            {rooms.length > 0 ? <span className="text-[13px] font-semibold text-fg-3">{rooms.length}+ 个直播间</span> : null}
          </div>
          {platform === "douyu" && categories.douyuCate3List.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {[{ id: "", name: "全部" }, ...categories.douyuCate3List].map((c) => {
                const on = (cate3?.id ?? "") === c.id;
                return (
                  <button
                    key={c.id || "all"}
                    type="button"
                    onClick={() => categories.selectDouyuCate3(c.id ? c : null)}
                    className={`rounded-full px-3.5 py-[7px] text-[13px] transition-colors ${
                      on ? "bg-fg font-bold text-surface" : "bg-chip font-semibold text-fg-2 hover:text-fg"
                    }`}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          ) : null}
        </header>

        {error && rooms.length === 0 ? (
          <StateCard icon={<RotateCw size={22} />} title="加载失败" sub={`${PLATFORM_META[platform].name}：${error}`} action="重试" onAction={() => void list.loadInitialRooms()} tone="error" />
        ) : !list.isLoading && rooms.length === 0 && selected ? (
          <StateCard
            icon={<Tv size={22} />}
            title="这个分类暂时没人直播"
            sub="换个分类，或收藏后有人开播时提醒你"
            action={fav ? "已收藏" : "收藏分类"}
            onAction={() => !fav && categories.toggleFavorite(platform, selected)}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-5 gap-y-7">
            {rooms.map((r) => (
              <RoomCard key={r.room_id} room={r} platform={platform} />
            ))}
            {list.isLoading || list.isLoadingMore ? Array.from({ length: rooms.length ? 4 : 12 }, (_, i) => <RoomCardSkeleton key={`sk${i}`} />) : null}
          </div>
        )}
        <div ref={sentinel} className="h-10" />
        {!list.hasMore && rooms.length > 0 ? <p className="text-center text-xs text-fg-3">已经到底啦</p> : null}
      </div>
    </div>
  );
}

function RoomCard({ room, platform }: { room: CommonStreamer; platform: UiPlatform }) {
  const openRoom = useOpenRoom();
  const [coverFailed, setCoverFailed] = useState(false);
  const id = String(room.room_id);
  return (
    <button
      type="button"
      onClick={() => openRoom({ platform, roomId: id, title: room.title, anchorName: room.nickname, avatar: room.avatar, isLive: true })}
      className="group text-left"
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-raised ring-accent transition-[transform,box-shadow] duration-150 group-hover:-translate-y-1 group-hover:shadow-pop group-hover:ring-2">
        {room.room_cover && !coverFailed ? (
          <img src={room.room_cover} alt="" loading="lazy" draggable={false} onError={() => setCoverFailed(true)} className="size-full object-cover" />
        ) : null}
        <div className="absolute inset-x-2.5 top-2.5 flex items-center justify-between">
          <LiveBadge />
          {room.viewer_count_str ? (
            <span className="flex items-center gap-1 rounded-full bg-[#0d0d1099] px-2 py-[3px] text-[11px] font-semibold text-white backdrop-blur">
              <Users size={11} className="opacity-80" />
              {room.viewer_count_str}
            </span>
          ) : null}
        </div>
        <div className="absolute inset-0 grid place-items-center bg-black/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <span className="grid size-12 place-items-center rounded-full bg-accent text-on-accent">
            <Play size={20} fill="currentColor" />
          </span>
        </div>
      </div>
      <div className="mt-2.5 flex gap-2.5">
        <Avatar src={room.avatar} name={room.nickname} platform={platform} size={36} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg group-hover:text-accent" title={room.title}>
            {room.title || "未命名直播间"}
          </p>
          <p className="truncate text-xs font-medium text-fg-3">{room.nickname}</p>
        </div>
      </div>
    </button>
  );
}

function RoomCardSkeleton() {
  return (
    <div>
      <div className="ld-skeleton aspect-video rounded-xl" />
      <div className="mt-2.5 flex gap-2.5">
        <div className="ld-skeleton size-9 rounded-full" />
        <div className="flex-1 space-y-1.5 pt-0.5">
          <div className="ld-skeleton h-3 w-4/5 rounded" />
          <div className="ld-skeleton h-2.5 w-2/5 rounded" />
        </div>
      </div>
    </div>
  );
}

function StateCard({
  icon,
  title,
  sub,
  action,
  onAction,
  tone
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  action: string;
  onAction: () => void;
  tone?: "error";
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5 rounded-2xl border border-line bg-raised px-6 py-10 text-center">
      <span className={`grid size-12 place-items-center rounded-full ${tone === "error" ? "bg-live/15 text-live" : "bg-chip text-fg-3"}`}>{icon}</span>
      <p className="text-sm font-bold text-fg">{title}</p>
      <p className="text-xs font-medium text-fg-3">{sub}</p>
      <button type="button" onClick={onAction} className="mt-1 flex items-center gap-1.5 rounded-full bg-chip px-4 py-2 text-[13px] font-bold text-fg-2 hover:text-fg">
        {tone === "error" ? <RotateCw size={14} /> : <Star size={14} />}
        {action}
      </button>
    </div>
  );
}
