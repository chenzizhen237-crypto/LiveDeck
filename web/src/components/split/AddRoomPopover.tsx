import React, { useMemo, useState } from "react";
import { m } from "framer-motion";
import { Compass, Hash } from "lucide-react";

import { Avatar, PLATFORM_META, PLATFORMS, PlatformMark } from "@/components/livedeck/primitives";
import { useActiveStreams } from "@/state/activeStreams/ActiveStreamsProvider";
import { useFollow } from "@/state/follow/FollowProvider";
import { useSplit, type PickTarget } from "@/state/split/SplitProvider";
import type { RoomRef } from "@/hooks/useOpenRoom";
import type { UiPlatform } from "@/state/category/CategoryProvider";

/** Rooms to add from: what's open in the island, live follows, a typed room ID, or browsing the channel pages. */
export function AddRoomPopover({ target, onClose, className = "" }: { target: PickTarget; onClose: () => void; className?: string }) {
  const split = useSplit();
  const active = useActiveStreams();
  const follow = useFollow();
  const [platform, setPlatform] = useState<UiPlatform>("douyu");
  const [roomId, setRoomId] = useState("");
  const [full, setFull] = useState(false);

  const inSplit = (p: string, id: string) => split.tiles.some((t) => t.room.platform === p && t.room.roomId === id);

  const candidates = useMemo(() => {
    const out: (RoomRef & { live: boolean })[] = [];
    const seen = new Set<string>();
    const push = (r: RoomRef & { live: boolean }) => {
      const k = `${r.platform}:${r.roomId}`;
      if (seen.has(k) || inSplit(r.platform, r.roomId)) return;
      seen.add(k);
      out.push(r);
    };
    for (const s of active.streamers) push({ ...s, live: s.isLive });
    for (const s of follow.followedStreamers) {
      if (s.liveStatus !== "LIVE") continue;
      push({ platform: s.platform.toLowerCase() as UiPlatform, roomId: s.id, anchorName: s.nickname, avatar: s.avatarUrl, title: s.roomTitle, live: true });
    }
    return out.slice(0, 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.streamers, follow.followedStreamers, split.tiles]);

  const add = (room: RoomRef) => {
    if (split.addRoom(room, target)) onClose();
    else setFull(true);
  };

  return (
    <>
      <button type="button" aria-label="关闭" className="fixed inset-0 z-0 cursor-default" onClick={onClose} />
      <m.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.16 }}
        className={`z-10 flex w-[320px] flex-col gap-3 rounded-2xl border border-line-strong bg-elevated p-3 shadow-pop backdrop-blur-2xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-1">
          <span className="text-sm font-bold text-fg">{target?.replaceTileId ? "替换直播间" : "添加直播间"}</span>
        </div>

        {candidates.length ? (
          <div className="flex max-h-[260px] flex-col overflow-y-auto">
            {candidates.map((r) => (
              <button
                key={`${r.platform}:${r.roomId}`}
                type="button"
                onClick={() => add(r)}
                className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-hover"
              >
                <Avatar src={r.avatar} name={r.anchorName || r.roomId} platform={r.platform} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-fg">{r.anchorName || r.roomId}</span>
                  <span className="block truncate text-[11px] text-fg-3">{r.title || `ID ${r.roomId}`}</span>
                </span>
                <PlatformMark platform={r.platform} size={16} />
              </button>
            ))}
          </div>
        ) : (
          <p className="px-1 text-xs text-fg-3">没有可添加的已打开或开播中的关注。</p>
        )}

        <form
          className="flex items-center gap-1.5 rounded-xl bg-chip p-1"
          onSubmit={(e) => {
            e.preventDefault();
            const id = roomId.trim();
            if (id) add({ platform, roomId: id, anchorName: id });
          }}
        >
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as UiPlatform)}
            className="rounded-lg bg-transparent px-1.5 py-1 text-xs font-semibold text-fg outline-none"
            aria-label="平台"
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_META[p].name}
              </option>
            ))}
          </select>
          <Hash size={13} className="text-fg-3" />
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="房间号"
            className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-fg outline-none placeholder:text-fg-3"
          />
          <button type="submit" className="rounded-lg bg-accent px-2.5 py-1 text-xs font-bold text-on-accent disabled:opacity-40" disabled={!roomId.trim()}>
            添加
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            split.beginPick(target);
            onClose();
          }}
          className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-xs font-semibold text-fg-2 hover:bg-hover"
        >
          <Compass size={14} /> 去频道里挑一个…
        </button>
        {full ? <p className="px-1 text-[11px] font-semibold text-live">网格已满（4 × 4）。先关掉一个画面。</p> : null}
      </m.div>
    </>
  );
}
