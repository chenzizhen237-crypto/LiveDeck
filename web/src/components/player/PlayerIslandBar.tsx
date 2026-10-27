import React from "react";
import { Columns2, Heart, X } from "lucide-react";

import { Avatar } from "@/components/livedeck/primitives";
import type { UiPlatform } from "@/state/category/CategoryProvider";

/** The open room's controls, rendered inside the island (or a stand-in island in player fullscreen). */
export function PlayerIslandBar({
  platform,
  roomId,
  anchorName,
  title,
  avatar,
  status,
  followed,
  onClose,
  onToggleFollow,
  onSplit
}: {
  platform: UiPlatform;
  roomId: string;
  anchorName: string | null;
  title: string | null;
  avatar: string | null;
  status: "loading" | "live" | "offline";
  followed: boolean;
  onClose: () => void;
  onToggleFollow: () => void;
  onSplit: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onClose}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-hover text-fg-2 transition-colors hover:bg-chip hover:text-fg"
        title="关闭"
        aria-label="关闭"
      >
        <X size={17} strokeWidth={2.4} />
      </button>

      <div className="flex min-w-0 items-center gap-2.5 pr-1 pl-1.5" title={title || roomId}>
        <span className="relative shrink-0">
          <Avatar src={avatar} name={anchorName || roomId} platform={platform} size={30} />
          {status === "live" ? <span className="absolute -right-0.5 -bottom-0.5 size-[9px] rounded-full bg-live ring-2 ring-[var(--ld-bg-surface)]" /> : null}
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="max-w-[min(32vw,300px)] truncate text-[13px] font-bold">{title || roomId}</span>
          <span className="max-w-[min(32vw,300px)] truncate text-[11px] font-medium text-fg-3">
            {anchorName || "未知主播"} · ID:{roomId}
          </span>
        </span>
        <span
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-extrabold tracking-[0.12em] ${
            status === "live" ? "text-fg" : "text-fg-3"
          }`}
        >
          {status === "live" ? <span className="size-1.5 animate-pulse rounded-full bg-live" /> : null}
          {status === "loading" ? "加载中" : status === "offline" ? "未开播" : "LIVE"}
        </span>
      </div>

      <span className="mx-1 h-5 w-px shrink-0 bg-line-strong" />

      <button
        type="button"
        onClick={onToggleFollow}
        className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold transition-colors ${
          followed ? "bg-selected text-accent hover:bg-hover" : "bg-accent text-on-accent"
        }`}
        title={followed ? "取消关注" : "关注"}
      >
        <Heart size={14} fill={followed ? "currentColor" : "none"} />
        {followed ? "已关注" : "关注"}
      </button>
      <button
        type="button"
        onClick={onSplit}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold text-fg-2 transition-colors hover:bg-hover hover:text-fg"
        title="分屏：和其他直播间一起看"
      >
        <Columns2 size={15} />
        分屏
      </button>
    </>
  );
}
