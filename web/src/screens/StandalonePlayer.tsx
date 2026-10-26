import React from "react";

import { PlayerPage } from "@/screens/PlayerPage";
import { useSearchParams } from "@/router";

/** `#/player/?platform=huya&roomId=…`: a room without the channel page behind it. */
export function StandalonePlayer() {
  const searchParams = useSearchParams();
  const platform = (searchParams.get("platform") || "douyu").toLowerCase();
  const roomId = searchParams.get("roomId") || "";

  if (!roomId) {
    return (
      <div className="grid h-full place-items-center text-center font-bold text-fg-2">
        <div>
          <div className="mb-2 text-base">未指定房间 ID</div>
          <div className="text-xs opacity-70">请从主播列表进入直播间</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <PlayerPage platform={platform} roomId={roomId} />
    </div>
  );
}
