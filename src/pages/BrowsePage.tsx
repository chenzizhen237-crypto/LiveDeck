import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useParams } from "react-router";
import clsx from "clsx";
import { isPlatform, platformInfo, staticCategoryGroups, type CategoryGroup } from "../lib/platforms";
import type { Platform } from "../lib/api";
import { useDouyuCategories, useRooms } from "../hooks/useRooms";
import { RoomCard } from "../components/RoomCard";

export function BrowsePage() {
  const { platform } = useParams();
  if (!isPlatform(platform)) return <Navigate to="/browse/douyu" replace />;
  // Remount per platform so selection state resets cleanly.
  return <Browse key={platform} platform={platform} />;
}

const lastCategory = (p: Platform) => localStorage.getItem(`livedeck-cat-${p}`);

function Browse({ platform }: { platform: Platform }) {
  const douyu = useDouyuCategories();
  const groups: CategoryGroup[] = useMemo(
    () => (platform === "douyu" ? (douyu.data ?? []) : staticCategoryGroups(platform)),
    [platform, douyu.data],
  );
  const [groupIndex, setGroupIndex] = useState(0);
  const [categoryKey, setCategoryKey] = useState<string | null>(lastCategory(platform));

  // Default to the first category once the tree is known.
  useEffect(() => {
    if (!groups.length) return;
    const all = groups.flatMap((g) => g.items);
    const current = all.find((c) => c.key === categoryKey);
    if (!current) setCategoryKey(groups[0].items[0]?.key ?? null);
    else setGroupIndex(Math.max(0, groups.findIndex((g) => g.items.includes(current))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  const select = (key: string) => {
    setCategoryKey(key);
    localStorage.setItem(`livedeck-cat-${platform}`, key);
  };

  const info = platformInfo(platform);
  const group = groups[groupIndex];

  return (
    <div className="px-6 pb-10">
      <h1 className="mb-4 flex items-center gap-3 text-3xl font-bold tracking-tight">
        <img src={info.icon} alt="" className="size-9 rounded-lg" />
        {info.name}
      </h1>

      {/* Two-level category picker: groups as tabs, categories as chips. */}
      <div className="sticky top-0 z-10 -mx-6 bg-panel/95 px-6 pt-1 pb-3 backdrop-blur">
        <div className="mb-2 flex gap-4 overflow-x-auto border-b border-line">
          {groups.map((g, i) => (
            <button
              key={g.name}
              onClick={() => setGroupIndex(i)}
              className={clsx(
                "-mb-px shrink-0 border-b-2 pb-2 text-sm font-bold",
                i === groupIndex ? "border-accent text-text" : "border-transparent text-text-3 hover:text-text-2",
              )}
            >
              {g.name}
            </button>
          ))}
        </div>
        <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
          {group?.items.map((c) => (
            <button
              key={c.key}
              onClick={() => select(c.key)}
              className={clsx(
                "rounded-full px-3 py-1 text-xs font-bold transition-colors",
                c.key === categoryKey ? "bg-accent text-accent-ink" : "bg-panel-2 text-text-2 hover:bg-panel-3 hover:text-text",
              )}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {platform === "douyu" && douyu.isError && <ErrorNote message="斗鱼分类加载失败" />}
      <RoomGrid platform={platform} categoryKey={categoryKey} />
    </div>
  );
}

function RoomGrid({ platform, categoryKey }: { platform: Platform; categoryKey: string | null }) {
  const query = useRooms(platform, categoryKey);
  const sentinel = useRef<HTMLDivElement>(null);
  const rooms = useMemo(() => {
    // Platforms page by offset and can repeat rooms between pages.
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flatMap((p) => p.rooms).filter((r) => {
      if (!r.roomId || seen.has(r.roomId)) return false;
      seen.add(r.roomId);
      return true;
    });
  }, [query.data]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [query]);

  if (query.isError) return <ErrorNote message={String(query.error)} onRetry={() => void query.refetch()} />;

  return (
    <>
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-6">
        {query.isPending && categoryKey
          ? Array.from({ length: 12 }, (_, i) => <RoomCard.Skeleton key={i} />)
          : rooms.map((r) => <RoomCard key={r.roomId} room={r} />)}
      </div>
      {!query.isPending && rooms.length === 0 && categoryKey && (
        <p className="py-16 text-center text-sm text-text-3">这个分类下暂时没有直播</p>
      )}
      <div ref={sentinel} className="h-10" />
      {query.isFetchingNextPage && <p className="text-center text-xs text-text-3">加载中…</p>}
    </>
  );
}

function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mt-6 rounded-lg bg-panel-2 p-4 text-sm text-text-2">
      {message}
      {onRetry && (
        <button onClick={onRetry} className="ml-3 font-bold text-accent">
          重试
        </button>
      )}
    </div>
  );
}
