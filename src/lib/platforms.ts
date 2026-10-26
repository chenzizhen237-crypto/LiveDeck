import type { Platform } from "./api";
import douyuIcon from "../assets/platforms/douyu.webp";
import douyinIcon from "../assets/platforms/douyin.webp";
import huyaIcon from "../assets/platforms/huya.webp";
import bilibiliIcon from "../assets/platforms/bilibili.webp";
import huyaCategories from "../data/categories/huya.json";
import bilibiliCategories from "../data/categories/bilibili.json";
import douyinCategories from "../data/categories/douyin.json";

export interface PlatformInfo {
  id: Platform;
  name: string;
  icon: string;
  /** Brand colour, used for accents only. */
  color: string;
}

export const PLATFORMS: PlatformInfo[] = [
  { id: "douyu", name: "斗鱼", icon: douyuIcon, color: "#ff7a1a" },
  { id: "huya", name: "虎牙", icon: huyaIcon, color: "#ffa200" },
  { id: "douyin", name: "抖音", icon: douyinIcon, color: "#fe2c55" },
  { id: "bilibili", name: "哔哩哔哩", icon: bilibiliIcon, color: "#fb7299" },
];

export const platformInfo = (id: Platform) => PLATFORMS.find((p) => p.id === id)!;

export const isPlatform = (value: string | undefined): value is Platform =>
  PLATFORMS.some((p) => p.id === value);

/**
 * A category as the UI sees it. `key` is whatever the platform's list API needs;
 * see `useRooms` for how each platform decodes it.
 */
export interface Category {
  key: string;
  name: string;
}

export interface CategoryGroup {
  name: string;
  items: Category[];
}

interface StaticGroup {
  title: string;
  id?: string | number;
  subcategories: { title: string; href: string; id?: string; parent_id?: string }[];
}

/** Static category trees (Douyu's comes from its API, see `useDouyuCategories`). */
export function staticCategoryGroups(platform: Exclude<Platform, "douyu">): CategoryGroup[] {
  switch (platform) {
    case "huya":
      return (huyaCategories as StaticGroup[]).map((g) => ({
        name: g.title,
        items: g.subcategories.map((c) => ({ key: c.id ?? "", name: c.title })),
      }));
    case "bilibili":
      return (bilibiliCategories as StaticGroup[])
        .filter((g) => !g.title.includes("帮我玩"))
        .map((g) => ({
          name: g.title,
          items: g.subcategories.map((c) => ({
            // area id + parent area id
            key: `${c.id}:${c.parent_id ?? g.id}`,
            name: c.title,
          })),
        }));
    case "douyin":
      return (douyinCategories as StaticGroup[]).map((g) => ({
        name: g.title,
        // href is /category/<...>_<partitionType>_<partition>
        items: g.subcategories.map((c) => ({ key: c.href, name: c.title })),
      }));
  }
}
