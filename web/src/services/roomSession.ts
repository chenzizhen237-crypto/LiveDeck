// Per-room playback plumbing shared by the single player and split-view tiles.
//
// The backend keys proxy streams and danmaku listeners by room, so several
// rooms can run at once. What's left for the frontend is reference counting:
// the same room may be open in the player and in a split tile, and closing one
// must not stop the other's stream or danmaku.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { getDouyuStreamConfig, stopDouyuProxy } from "@/platforms/douyu/playerHelper";
import { getHuyaStreamConfig, stopHuyaProxy } from "@/platforms/huya/playerHelper";
import { fetchAndPrepareDouyinStreamConfig } from "@/platforms/douyin/playerHelper";
import { getBilibiliStreamConfig } from "@/platforms/bilibili/playerHelper";
import type { UiPlatform } from "@/state/category/CategoryProvider";

export type DanmakuPayload = {
  room_id?: string;
  user: string;
  content: string;
  user_level: number;
  fans_club_level: number;
  color?: string | null;
};

export interface ResolvedStream {
  streamUrl: string;
  streamType: string | undefined;
  isHls: boolean;
  title: string | null;
  anchorName: string | null;
  avatar: string | null;
  /** Room id the danmaku backend is started with (Douyin needs the web_rid). */
  danmakuRoomId: string;
  /** Room id danmaku payloads carry (Douyin reports the numeric room id). */
  danmakuFilterRoomId: string;
}

const bilibiliCookie = () => {
  try {
    return window.localStorage.getItem("bilibili_cookie") || null;
  } catch {
    return null;
  }
};

/** Resolves a playable URL for a room. Douyu, Huya and Bilibili FLV register a keyed proxy entry. */
export async function resolveRoomStream(platform: UiPlatform, roomId: string, quality: string): Promise<ResolvedStream> {
  let streamUrl: string | null = null;
  let streamType: string | undefined;
  let title: string | null = null;
  let anchorName: string | null = null;
  let avatar: string | null = null;
  let danmakuRoomId = roomId;
  let danmakuFilterRoomId = roomId;

  if (platform === "douyu") {
    try {
      const info = await invoke<any>("fetch_douyu_room_info", { roomId });
      title = info?.room_name ?? null;
      anchorName = info?.nickname ?? null;
      avatar = info?.avatar_url ?? null;
    } catch {
      // metadata is optional
    }
    ({ streamUrl, streamType } = await getDouyuStreamConfig(roomId, quality));
  } else if (platform === "huya") {
    const r = await getHuyaStreamConfig(roomId, quality);
    ({ streamUrl, streamType } = r);
    title = r.title ?? null;
    anchorName = r.anchorName ?? null;
    avatar = r.avatar ?? null;
  } else if (platform === "douyin") {
    const r = await fetchAndPrepareDouyinStreamConfig(roomId, quality);
    if (!r.streamUrl) throw new Error(r.initialError || "主播未开播或无法获取直播流");
    ({ streamUrl, streamType } = r);
    title = r.title ?? null;
    anchorName = r.anchorName ?? null;
    avatar = r.avatar ?? null;
    danmakuRoomId = r.webRid || roomId;
    danmakuFilterRoomId = r.normalizedRoomId || roomId;
  } else {
    const cookie = bilibiliCookie();
    try {
      const info = await invoke<any>("fetch_bilibili_streamer_info", {
        payload: { platform: "BILIBILI", args: { room_id_str: roomId } },
        cookie
      });
      title = info?.title ?? null;
      anchorName = info?.anchor_name ?? null;
      avatar = info?.avatar ?? null;
    } catch {
      // metadata is optional
    }
    ({ streamUrl, streamType } = await getBilibiliStreamConfig(roomId, quality, cookie || undefined));
  }

  if (!streamUrl) throw new Error("主播未开播或无法获取直播流");
  const isHls = (streamType || "").toLowerCase() === "hls" || streamUrl.toLowerCase().includes(".m3u8");
  return { streamUrl, streamType, isHls, title, anchorName, avatar, danmakuRoomId, danmakuFilterRoomId };
}

// ---------------------------------------------------------------------------
// Proxy entries: keep each room's entry while anything still plays it.

const proxyHolds = new Map<string, number>();

async function stopRoomProxy(platform: UiPlatform, roomId: string) {
  if (platform === "douyu") await stopDouyuProxy(roomId);
  else if (platform === "huya") await stopHuyaProxy(roomId);
  else if (platform === "bilibili") await invoke("stop_proxy", { key: `bilibili-${roomId}` }).catch(() => {});
  // Douyin plays direct; nothing registered.
}

/** Call after resolveRoomStream succeeds; the returned function lets go of the room's proxy entry. */
export function holdRoomProxy(platform: UiPlatform, roomId: string): () => void {
  const key = `${platform}:${roomId}`;
  proxyHolds.set(key, (proxyHolds.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (proxyHolds.get(key) ?? 1) - 1;
    if (n > 0) {
      proxyHolds.set(key, n);
      return;
    }
    proxyHolds.delete(key);
    void stopRoomProxy(platform, roomId).catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Danmaku: one backend listener per room, one Tauri event subscription for all.

type DanmakuHandler = (p: DanmakuPayload) => void;
const subscribers = new Map<string, Set<DanmakuHandler>>();
let unlistenGlobal: Promise<UnlistenFn> | null = null;

function ensureGlobalListener() {
  if (unlistenGlobal) return;
  unlistenGlobal = listen<DanmakuPayload>("danmaku-message", (event) => {
    const p = event.payload;
    if (!p) return;
    if (p.room_id) {
      subscribers.get(p.room_id)?.forEach((h) => h(p));
    } else {
      // Older backends omit room_id; deliver to everyone rather than drop it.
      subscribers.forEach((set) => set.forEach((h) => h(p)));
    }
  });
}

/** Receives danmaku payloads for one room (matched on the payload's room_id). */
export function subscribeDanmaku(filterRoomId: string, handler: DanmakuHandler): () => void {
  ensureGlobalListener();
  let set = subscribers.get(filterRoomId);
  if (!set) subscribers.set(filterRoomId, (set = new Set()));
  set.add(handler);
  return () => {
    set!.delete(handler);
    if (set!.size === 0) subscribers.delete(filterRoomId);
  };
}

const danmakuHolds = new Map<string, number>();
// Backend commands run concurrently; chain each room's start/stop so a stop
// issued before a start (player → split hand-over) can't land after it.
const danmakuChains = new Map<string, Promise<unknown>>();
function chain(key: string, task: () => Promise<unknown>) {
  const next = (danmakuChains.get(key) ?? Promise.resolve()).then(task, task);
  danmakuChains.set(key, next.catch(() => {}));
  return next;
}

async function startBackend(platform: UiPlatform, roomId: string) {
  const payload = { args: { room_id_str: roomId } };
  if (platform === "douyu") await invoke("start_danmaku_listener", { roomId });
  else if (platform === "douyin") await invoke("start_douyin_danmu_listener", { payload: { ...payload, platform: "DOUYIN" } });
  else if (platform === "huya") await invoke("start_huya_danmaku_listener", { payload });
  else await invoke("start_bilibili_danmaku_listener", { payload, cookie: bilibiliCookie() });
}

async function stopBackend(platform: UiPlatform, roomId: string) {
  if (platform === "douyu") await invoke("stop_danmaku_listener", { roomId });
  else if (platform === "douyin") await invoke("stop_douyin_danmu_listener", { roomId });
  else if (platform === "huya") await invoke("stop_huya_danmaku_listener", { roomId });
  else await invoke("stop_bilibili_danmaku_listener", { roomId });
}

/** Starts the room's danmaku backend unless it is already running; returns its release. */
export function holdRoomDanmaku(platform: UiPlatform, roomId: string): () => void {
  const key = `${platform}:${roomId}`;
  const n = danmakuHolds.get(key) ?? 0;
  danmakuHolds.set(key, n + 1);
  if (n === 0) {
    void chain(key, () => startBackend(platform, roomId)).catch((e) => console.warn("[roomSession] start danmaku failed:", e));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (danmakuHolds.get(key) ?? 1) - 1;
    if (left > 0) {
      danmakuHolds.set(key, left);
      return;
    }
    danmakuHolds.delete(key);
    void chain(key, () => stopBackend(platform, roomId)).catch(() => {});
  };
}

// ---------------------------------------------------------------------------

// Danmaku colour codes (Douyu sends numbers); other platforms send none.
const DANMAKU_COLORS: Record<number, string> = {
  // 斗鱼官方计算色值。
  1: '#FFFFFF', // 蓝/白
  2: '#70C150', // 绿
  3: '#E04AC0', // 粉
  4: '#D4A113', // 黄
  5: '#8A5BE9', // 紫
  6: '#FF314E', // 红
  7: '#FF314E', // 渐变色在覆盖层中降级为红色
};

export function danmakuColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return DANMAKU_COLORS[parseInt(color, 10)];
}
