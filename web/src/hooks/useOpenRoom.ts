"use client";

import { useCallback } from "react";

import { useActiveStreams } from "@/state/activeStreams/ActiveStreamsProvider";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import type { UiPlatform } from "@/state/category/CategoryProvider";

export interface RoomRef {
  platform: UiPlatform;
  roomId: string;
  title?: string;
  anchorName?: string;
  avatar?: string;
  isLive?: boolean;
}

/** Opens a room in the player and records it as an island capsule. */
export function useOpenRoom() {
  const active = useActiveStreams();
  const overlay = usePlayerOverlay();
  return useCallback(
    (room: RoomRef) => {
      if (!room.roomId) return;
      active.open({
        platform: room.platform,
        roomId: room.roomId,
        title: room.title ?? "",
        anchorName: room.anchorName ?? room.roomId,
        avatar: room.avatar ?? "",
        isLive: room.isLive ?? true
      });
      overlay.openPlayer({ platform: room.platform, roomId: room.roomId });
    },
    [active, overlay]
  );
}
