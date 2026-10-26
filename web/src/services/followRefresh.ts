"use client";

// Follow-list status refresh, lifted out of the old FollowsList so the new
// follow popover can share it. Calls the per-platform commands upstream uses.

import { invoke } from "@tauri-apps/api/core";

import { Platform as PlatformEnum } from "@/platforms/common/types";
import type { FollowedStreamer } from "@/state/follow/FollowProvider";

function normalizeLiveStatus(isLive: boolean | null | undefined): FollowedStreamer["liveStatus"] {
  if (isLive === true) return "LIVE";
  if (isLive === false) return "OFFLINE";
  return "UNKNOWN";
}

export async function refreshOne(streamer: FollowedStreamer) {
  if (streamer.platform === "DOUYU") {
    const info = await invoke<any>("fetch_douyu_room_info", { roomId: streamer.id });
    const showStatus = typeof info?.show_status === "number" ? info.show_status : Number(info?.show_status ?? 0);
    const rawVideoLoop = info?.video_loop ?? info?.videoLoop ?? null;
    const videoLoop =
      typeof rawVideoLoop === "number" ? rawVideoLoop : rawVideoLoop === null || typeof rawVideoLoop === "undefined" ? null : Number(rawVideoLoop);

    // Douyu: show_status === 1 需要结合 video_loop 判断；未知值一律不展示“在线”以避免误判
    let liveStatus: FollowedStreamer["liveStatus"] = "OFFLINE";
    if (showStatus === 1) {
      if (videoLoop === 0) liveStatus = "LIVE";
      else if (videoLoop === 1) liveStatus = "OFFLINE";
      else liveStatus = "UNKNOWN";
    }
    return {
      nickname: info?.nickname ?? streamer.nickname,
      avatarUrl: info?.avatar_url ?? streamer.avatarUrl,
      roomTitle: info?.room_name ?? info?.roomName ?? streamer.roomTitle,
      liveStatus
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "HUYA") {
    try {
      const info = await invoke<any>("get_huya_unified_cmd", { roomId: streamer.id, quality: null, line: null });
      return {
        nickname: info?.nick ?? streamer.nickname,
        avatarUrl: info?.avatar ?? streamer.avatarUrl,
        roomTitle: info?.title ?? streamer.roomTitle,
        liveStatus: normalizeLiveStatus(!!info?.is_live)
      } satisfies Partial<FollowedStreamer>;
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "";
      if (msg.includes("主播未开播或获取虎牙房间详情失败")) {
        return { liveStatus: "OFFLINE" } satisfies Partial<FollowedStreamer>;
      }
      throw e;
    }
  }

  if (streamer.platform === "BILIBILI") {
    const payload = { platform: PlatformEnum.BILIBILI, args: { room_id_str: streamer.id } };
    const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") || null : null;
    const info = await invoke<any>("fetch_bilibili_streamer_info", { payload, cookie });
    const live = Number(info?.status ?? 0) === 1;
    return {
      nickname: info?.anchor_name ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus: normalizeLiveStatus(live)
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "DOUYIN") {
    const payload = { platform: PlatformEnum.DOUYIN, args: { room_id_str: streamer.id } };
    const info = await invoke<any>("fetch_douyin_streamer_info", { payload });
    const status = Number(info?.status ?? 0);
    // Douyin: status === 2 means live (align with player/follow helpers)
    const live = status === 2;
    return {
      nickname: info?.anchor_name ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus: normalizeLiveStatus(live)
    } satisfies Partial<FollowedStreamer>;
  }

  return {} satisfies Partial<FollowedStreamer>;
}

