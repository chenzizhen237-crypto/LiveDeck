// Typed wrappers around the Tauri commands registered in src-tauri/src/main.rs.
// Nothing outside this file should call `invoke` directly.
import { Channel, invoke } from "@tauri-apps/api/core";

export type Platform = "douyu" | "douyin" | "huya" | "bilibili";

// ---- Playback -------------------------------------------------------------

export type LiveStatus = "live" | "offline" | "error";
export type StreamType = "flv" | "hls" | "unknown";

export interface RoomMeta {
  platform: Platform;
  room_id: string;
  normalized_room_id: string | null;
  web_rid: string | null;
  title: string | null;
  anchor_name: string | null;
  avatar: string | null;
}

export interface LiveStreamResponse {
  status: LiveStatus;
  room: RoomMeta;
  playback: { url: string; stream_type: StreamType } | null;
  error: string | null;
}

export interface LiveStreamRequest {
  platform: Platform;
  room_id: string;
  quality?: string;
  line?: string;
  cookie?: string;
  /** "meta" skips stream resolution and only returns status + room info. */
  mode?: "playback" | "meta";
}

export const getLiveStream = (request: LiveStreamRequest) =>
  invoke<LiveStreamResponse>("get_live_stream_v2", {
    request: { debug: false, ...request },
  });

let proxyBase: Promise<string> | null = null;
export const getProxyBase = () => (proxyBase ??= invoke<string>("get_proxy_base"));

// ---- Danmaku --------------------------------------------------------------

export interface DanmakuMessage {
  room_id: string;
  user: string;
  content: string;
  user_level: number;
  fans_club_level: number;
  color: string | null;
}

export async function startDanmaku(
  platform: Platform,
  roomId: string,
  onMessage: (msg: DanmakuMessage) => void,
  cookie?: string,
): Promise<() => void> {
  const channel = new Channel<DanmakuMessage>();
  channel.onmessage = onMessage;
  await invoke("start_danmaku", { platform, roomId, cookie, onMessage: channel });
  return () => {
    channel.onmessage = () => {};
    void invoke("stop_danmaku", { platform, roomId });
  };
}

// ---- Browse ---------------------------------------------------------------

export interface DouyuCategories {
  cate1List: {
    id: string;
    name: string;
    cate2List: { id: string; name: string; short_name: string; icon: string }[];
  }[];
}

export const fetchDouyuCategories = () => invoke<DouyuCategories>("fetch_categories");

export interface DouyuLiveList {
  error: number;
  msg: string | null;
  data: {
    list: { rid: string; roomName: string; nickname: string; roomSrc: string; avatar: string; hn: string }[];
    total?: number;
    page_count?: number;
  } | null;
}

export const fetchDouyuLiveList = (cate2: string, offset: number, limit: number) =>
  invoke<DouyuLiveList>("fetch_live_list", { cate2, offset, limit });

export interface HuyaLiveList {
  error: number;
  msg: string | null;
  data: {
    room_id?: string | number;
    title?: string;
    nickname?: string;
    avatar?: string;
    room_cover?: string;
    viewer_count_str?: string;
  }[] | null;
}

export const fetchHuyaLiveList = (iGid: string, iPageNo: number, iPageSize: number) =>
  invoke<HuyaLiveList>("fetch_huya_live_list", { iGid, iPageNo, iPageSize });

export interface DouyinLiveList {
  rooms: {
    web_rid?: string;
    title?: string;
    owner_nickname?: string;
    avatar_url?: string;
    cover_url?: string;
    user_count_str?: string;
  }[];
  has_more: boolean;
  next_offset: number;
}

export const generateDouyinMsToken = () => invoke<string>("generate_douyin_ms_token");

export const fetchDouyinRooms = (
  partition: string,
  partitionType: string,
  offset: number,
  msToken: string,
) =>
  invoke<DouyinLiveList>("fetch_douyin_partition_rooms", {
    partition,
    partitionType,
    offset,
    msToken,
  });

/** Returns the raw JSON text of Bilibili's area room list. */
export const fetchBilibiliLiveList = (areaId: string, parentAreaId: string, page: number) =>
  invoke<string>("fetch_bilibili_live_list", { areaId, parentAreaId, page });

// ---- Search ---------------------------------------------------------------

export const searchDouyu = (keyword: string) => invoke<string>("search_anchor", { keyword });

export const searchHuya = (keyword: string, page = 1) =>
  invoke<{ room_id: string; avatar: string; user_name: string; live_status: boolean; title: string }[]>(
    "search_huya_anchors",
    { keyword, page },
  );

export const searchBilibili = (keyword: string, page = 1) =>
  invoke<{ room_id: string; title: string; cover: string; anchor: string; avatar: string; watching: string; is_live: boolean }[]>(
    "search_bilibili_rooms",
    { keyword, page },
  );
