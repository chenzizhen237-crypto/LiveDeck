// Port of the Vue `categoryStore`: one place that knows each platform's category
// tree, the selected category per platform, and Douyu's third-level categories.
// The island's category picker and the channel page both read from here.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { huyaCategoriesData } from "@/platforms/huya/huyaCategoriesData";
import { douyinCategoriesData } from "@/platforms/douyin/douyinCategoriesData";
import { biliCategoriesData } from "@/platforms/bilibili/biliCategoriesData";
import type { CommonPlatformCategory } from "@/platforms/common/types";
import { useCustomCategories } from "@/state/customCategories/CustomCategoriesProvider";

export type UiPlatform = "douyu" | "douyin" | "huya" | "bilibili";

/** `id` is what the platform's list API needs: Douyu short name, otherwise the category href. */
export interface CategoryItem {
  id: string;
  title: string;
  cate1Title: string;
  cate1Id: string;
  /** Platform list-API ids: Huya gid, Bilibili area + parent area. */
  gid?: string;
  parentId?: string;
}

export interface CategoryGroup {
  id: string;
  title: string;
  items: CategoryItem[];
}

export interface Cate3Item {
  id: string;
  name: string;
}

type DouyuCategoriesResponse = {
  cate1List: { id: string; name: string; cate2List: { id: string; name: string; short_name: string }[] }[];
};

type CategoryContextValue = {
  groups: (platform: UiPlatform) => CategoryGroup[];
  isLoading: (platform: UiPlatform) => boolean;
  selected: (platform: UiPlatform) => CategoryItem | null;
  select: (platform: UiPlatform, item: CategoryItem) => void;
  /** Douyu only: third-level categories of the selected cate2. */
  douyuCate3List: Cate3Item[];
  douyuCate3: Cate3Item | null;
  selectDouyuCate3: (item: Cate3Item | null) => void;
  isFavorite: (platform: UiPlatform, id: string) => boolean;
  toggleFavorite: (platform: UiPlatform, item: CategoryItem) => void;
  favorites: (platform: UiPlatform) => CategoryItem[];
};

const SELECTION_KEY = "livedeck_selected_category_v1";

const CategoryContext = createContext<CategoryContextValue | null>(null);

function staticGroups(platform: Exclude<UiPlatform, "douyu">): CategoryGroup[] {
  const source = (platform === "huya" ? huyaCategoriesData : platform === "douyin" ? douyinCategoriesData : biliCategoriesData) as {
    title: string;
    href: string;
    id?: string | number;
    subcategories: { title: string; href: string; id?: string | number; gid?: string | number; parent_id?: string | number }[];
  }[];
  return source.map((c1) => ({
    id: c1.href,
    title: c1.title,
    items: (c1.subcategories ?? []).map((c2) => ({
      id: c2.href,
      title: c2.title,
      cate1Title: c1.title,
      cate1Id: c1.href,
      gid: c2.id != null || c2.gid != null ? String(c2.id ?? c2.gid) : undefined,
      parentId: c2.parent_id != null || c1.id != null ? String(c2.parent_id ?? c1.id) : undefined
    }))
  }));
}

function loadSelections(): Partial<Record<UiPlatform, CategoryItem>> {
  try {
    return JSON.parse(window.localStorage.getItem(SELECTION_KEY) || "{}");
  } catch {
    return {};
  }
}

export function CategoryProvider({ children }: { children: React.ReactNode }) {
  const custom = useCustomCategories();
  const [douyuGroups, setDouyuGroups] = useState<CategoryGroup[]>([]);
  const [douyuCate2Ids, setDouyuCate2Ids] = useState<Record<string, string>>({});
  const [douyuLoading, setDouyuLoading] = useState(true);
  const [selections, setSelections] = useState<Partial<Record<UiPlatform, CategoryItem>>>({});
  const [cate3Cache, setCate3Cache] = useState<Record<string, Cate3Item[]>>({});
  const [douyuCate3, setDouyuCate3] = useState<Cate3Item | null>(null);

  const staticTrees = useMemo(
    () => ({ huya: staticGroups("huya"), douyin: staticGroups("douyin"), bilibili: staticGroups("bilibili") }),
    []
  );

  useEffect(() => {
    setSelections(loadSelections());
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<DouyuCategoriesResponse>("fetch_categories")
      .then((resp) => {
        if (!alive) return;
        const ids: Record<string, string> = {};
        const groups = (resp?.cate1List ?? []).map((c1) => ({
          id: String(c1.id),
          title: c1.name,
          items: (c1.cate2List ?? [])
            .filter((c2) => !!c2.short_name)
            .map((c2) => {
              ids[c2.short_name] = c2.id;
              return { id: c2.short_name, title: c2.name, cate1Title: c1.name, cate1Id: String(c1.id) };
            })
        }));
        setDouyuGroups(groups);
        setDouyuCate2Ids(ids);
      })
      .catch((e) => console.error("[CategoryProvider] fetch_categories failed:", e))
      .finally(() => alive && setDouyuLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const groups = useCallback(
    (platform: UiPlatform) => (platform === "douyu" ? douyuGroups : staticTrees[platform]),
    [douyuGroups, staticTrees]
  );

  const selected = useCallback(
    (platform: UiPlatform) => {
      const tree = groups(platform);
      const saved = selections[platform];
      const all = tree.flatMap((g) => g.items);
      // Fall back to the first category so a fresh install lands on something.
      return (saved && all.find((c) => c.id === saved.id)) || all[0] || null;
    },
    [groups, selections]
  );

  const select = useCallback((platform: UiPlatform, item: CategoryItem) => {
    setSelections((prev) => {
      const next = { ...prev, [platform]: item };
      try {
        window.localStorage.setItem(SELECTION_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
    if (platform === "douyu") setDouyuCate3(null);
  }, []);

  // Douyu third-level categories for the selected cate2.
  const douyuSelected = selected("douyu");
  useEffect(() => {
    const shortName = douyuSelected?.id;
    if (!shortName || shortName in cate3Cache) return;
    const tagId = Number.parseInt(douyuCate2Ids[shortName] ?? "", 10);
    if (!Number.isFinite(tagId)) return;
    invoke<CommonPlatformCategory[]>("fetch_three_cate", { tagId })
      .then((list) =>
        setCate3Cache((prev) => ({
          ...prev,
          [shortName]: (list ?? []).map((x) => ({ id: String(x.id ?? ""), name: String(x.name ?? "") })).filter((x) => x.id && x.name)
        }))
      )
      .catch(() => setCate3Cache((prev) => ({ ...prev, [shortName]: [] })));
  }, [cate3Cache, douyuCate2Ids, douyuSelected?.id]);

  // Favorites reuse the existing "custom categories" store so saved entries carry over.
  const isFavorite = useCallback((platform: UiPlatform, id: string) => custom.isSubscribed(platform, id), [custom]);

  const toggleFavorite = useCallback(
    (platform: UiPlatform, item: CategoryItem) => {
      if (custom.isSubscribed(platform, item.id)) custom.removeByKey(`${platform}:${item.id}`);
      else if (platform === "douyu") custom.addDouyuCate2(item.id, item.title);
      else custom.addCommonCate2(platform, item.id, item.title, item.cate1Title, item.cate1Id);
    },
    [custom]
  );

  const favorites = useCallback(
    (platform: UiPlatform) => {
      const all = groups(platform).flatMap((g) => g.items);
      return all.filter((c) => custom.isSubscribed(platform, c.id));
    },
    [custom, groups]
  );

  const value = useMemo<CategoryContextValue>(
    () => ({
      groups,
      isLoading: (platform) => platform === "douyu" && douyuLoading,
      selected,
      select,
      douyuCate3List: douyuSelected ? cate3Cache[douyuSelected.id] ?? [] : [],
      douyuCate3,
      selectDouyuCate3: setDouyuCate3,
      isFavorite,
      toggleFavorite,
      favorites
    }),
    [cate3Cache, douyuCate3, douyuLoading, douyuSelected, favorites, groups, isFavorite, select, selected, toggleFavorite]
  );

  return <CategoryContext.Provider value={value}>{children}</CategoryContext.Provider>;
}

export function useCategories() {
  const ctx = useContext(CategoryContext);
  if (!ctx) throw new Error("useCategories must be used within CategoryProvider");
  return ctx;
}
