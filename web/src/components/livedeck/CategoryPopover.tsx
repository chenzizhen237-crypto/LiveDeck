// "浏览分类" picker (Desktop 03): platform tabs, category groups, favourites on top.

import React, { useEffect, useState } from "react";
import { m } from "framer-motion";
import { Star, X } from "lucide-react";

import { IconButton, PLATFORM_META, PLATFORMS, PlatformMark } from "./primitives";
import { useCategories, type CategoryItem, type UiPlatform } from "@/state/category/CategoryProvider";
import { LoadingDots } from "@/components/common/LoadingDots";

export function CategoryPopover({
  platform,
  onClose,
  onPick
}: {
  platform: UiPlatform;
  onClose: () => void;
  /** Called with the platform the category belongs to (tabs can browse other platforms). */
  onPick: (platform: UiPlatform, item: CategoryItem) => void;
}) {
  const categories = useCategories();
  const [tab, setTab] = useState<UiPlatform>(platform);
  const groups = categories.groups(tab);
  const selected = categories.selected(tab);
  const [groupId, setGroupId] = useState<string | null>(null);

  useEffect(() => {
    // Open on the group containing the current selection.
    const owning = groups.find((g) => g.items.some((c) => c.id === selected?.id));
    setGroupId(owning?.id ?? groups[0]?.id ?? null);
  }, [groups, selected?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const favorites = categories.favorites(tab);
  const loading = categories.isLoading(tab);

  const tile = (c: CategoryItem) => {
    const isSel = c.id === selected?.id;
    const fav = categories.isFavorite(tab, c.id);
    return (
      <div
        key={c.id}
        role="button"
        tabIndex={0}
        onClick={() => onPick(tab, c)}
        onKeyDown={(e) => e.key === "Enter" && onPick(tab, c)}
        className={`group flex h-14 cursor-pointer items-center gap-1.5 rounded-xl border px-3.5 transition-colors ${
          isSel ? "border-focus bg-selected" : "border-line bg-raised hover:border-line-strong hover:bg-hover"
        }`}
      >
        <span className={`flex-1 truncate text-[13px] ${isSel ? "font-bold text-accent" : "font-semibold text-fg"}`}>{c.title}</span>
        <button
          type="button"
          aria-label={fav ? "取消收藏" : "收藏"}
          onClick={(e) => {
            e.stopPropagation();
            categories.toggleFavorite(tab, c);
          }}
          className={`transition-opacity ${fav ? "text-accent" : "text-fg-3 opacity-0 group-hover:opacity-100 hover:text-accent"}`}
        >
          <Star size={14} fill={fav ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-start justify-center px-8 pt-24">
      <m.button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-scrim"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <m.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        className="relative flex max-h-[76vh] w-full max-w-[960px] flex-col overflow-hidden rounded-3xl border border-line-strong bg-elevated text-fg shadow-pop backdrop-blur-2xl"
      >
        <div className="flex items-center gap-3 px-6 py-5">
          <h2 className="text-[22px] font-extrabold">浏览分类</h2>
          <div className="flex gap-1.5 rounded-full bg-chip p-1">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setTab(p)}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold transition-colors ${
                  p === tab ? "bg-surface text-fg shadow-float" : "text-fg-3 hover:text-fg"
                }`}
              >
                <PlatformMark platform={p} size={16} />
                {PLATFORM_META[p].short}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="h-px bg-line" />
        {loading ? (
          <div className="grid h-80 place-items-center">
            <LoadingDots />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav className="w-[200px] shrink-0 overflow-y-auto p-3">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onMouseEnter={() => setGroupId(g.id)}
                  onClick={() => setGroupId(g.id)}
                  className={`mb-0.5 flex w-full items-center justify-between rounded-[10px] px-3 py-2.5 text-left text-[13px] transition-colors ${
                    g.id === group?.id ? "bg-selected font-bold text-accent" : "font-medium text-fg-2 hover:bg-hover"
                  }`}
                >
                  <span className="truncate">{g.title}</span>
                  <span className="text-[11px] font-semibold text-fg-3">{g.items.length}</span>
                </button>
              ))}
            </nav>
            <div className="w-px bg-line" />
            <div className="min-w-0 flex-1 overflow-y-auto p-6">
              {favorites.length > 0 ? (
                <>
                  <p className="mb-3 flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-fg-3">
                    <Star size={13} className="text-accent" fill="currentColor" /> 已收藏
                  </p>
                  <div className="mb-5 grid grid-cols-4 gap-2.5">{favorites.map(tile)}</div>
                  <div className="mb-5 h-px bg-line" />
                </>
              ) : null}
              <p className="mb-3 text-[11px] font-bold tracking-wider text-fg-3">
                {group?.title} · {group?.items.length ?? 0}
              </p>
              <div className="grid grid-cols-4 gap-2.5">{(group?.items ?? []).map(tile)}</div>
            </div>
          </div>
        )}
      </m.div>
    </div>
  );
}
