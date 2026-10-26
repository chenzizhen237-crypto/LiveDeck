import React, { useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, Moon, MoveDiagonal2, RefreshCw, Repeat2, Volume2, VolumeX, X } from "lucide-react";

import { LiveBadge, PlatformMark } from "@/components/livedeck/primitives";
import type { SplitTile as Tile } from "@/state/split/SplitProvider";
import { useTilePlayer } from "./useTilePlayer";

const btn =
  "grid size-[26px] place-items-center rounded-lg border border-white/15 bg-[#0B0F1A]/80 text-white backdrop-blur hover:bg-[#0B0F1A] transition-colors";

export function SplitTile({
  tile,
  quality,
  focused,
  danmakuOn,
  zoomed,
  editing,
  dimmed,
  onFocus,
  clickFocuses,
  onToggleZoom,
  onReplace,
  onClose,
  onGripPointerDown,
  onHeaderPointerDown,
  style
}: {
  tile: Tile;
  quality: string;
  focused: boolean;
  danmakuOn: boolean;
  zoomed: boolean;
  editing: boolean;
  dimmed: boolean;
  onFocus: () => void;
  /** Clicking the video moves audio here (the "audio follows click" setting). */
  clickFocuses: boolean;
  onToggleZoom: () => void;
  onReplace: () => void;
  onClose: () => void;
  onGripPointerDown: (e: React.PointerEvent) => void;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  style: React.CSSProperties;
}) {
  const videoRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const { status, error, meta, reload } = useTilePlayer(videoRef, tile.room, { quality, muted: !focused, danmakuOn });
  const name = meta.anchorName || tile.room.anchorName || tile.room.roomId;
  const showChrome = hover || editing || status !== "playing";

  return (
    <div
      className={`group relative min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-black transition-[opacity,box-shadow] ${
        focused ? "ring-2 ring-accent" : "ring-1 ring-white/10"
      } ${dimmed ? "opacity-55" : ""}`}
      style={style}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={clickFocuses ? onFocus : undefined}
    >
      <div ref={videoRef} className="ld-split-video absolute inset-0" />

      {/* scrims keep the chrome readable over bright video */}
      <div
        className={`pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,.6)_0%,transparent_30%,transparent_65%,rgba(0,0,0,.65)_100%)] transition-opacity ${
          showChrome ? "opacity-100" : "opacity-60"
        }`}
      />

      {/* states sit under the chrome so name and actions stay usable */}
      {status === "connecting" ? (
        <div className="absolute inset-0 grid place-items-center bg-black/70">
          <div className="flex flex-col items-center gap-2.5 text-xs font-semibold text-white/80">
            <Loader2 size={26} className="animate-spin text-accent" />
            连接中…
          </div>
        </div>
      ) : status === "offline" ? (
        <div className="absolute inset-0 grid place-items-center bg-[#0A0D16]/90">
          <div className="flex flex-col items-center gap-1.5 text-center text-xs font-semibold text-white/60">
            <Moon size={20} className="text-white/50" />
            未开播 · 开播后自动加入
          </div>
        </div>
      ) : status === "error" ? (
        <div className="absolute inset-0 grid place-items-center bg-[#0A0D16]/90 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex max-w-[90%] flex-col items-center gap-2 text-center">
            <p className="line-clamp-2 text-xs font-semibold text-white/70">{error || "加载失败"}</p>
            <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/25" onClick={reload}>
              <RefreshCw size={13} /> 重试
            </button>
          </div>
        </div>
      ) : null}

      {/* header: drag handle in edit mode */}
      <div
        className={`absolute inset-x-0 top-0 flex items-center gap-1.5 p-2.5 ${editing ? "cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={editing ? onHeaderPointerDown : undefined}
      >
        <PlatformMark platform={tile.room.platform} size={16} />
        <span className="truncate text-xs font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,.6)]">{name}</span>
        {status === "playing" ? <LiveBadge /> : null}
        <span className="flex-1" />
        {hover && !editing ? (
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            <button type="button" className={btn} title={focused ? "已有声音" : "切换声音到此画面"} onClick={onFocus}>
              {focused ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
            <button type="button" className={btn} title="替换直播间" onClick={onReplace}>
              <Repeat2 size={14} />
            </button>
            <button type="button" className={btn} title={zoomed ? "还原" : "放大"} onClick={onToggleZoom}>
              {zoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button type="button" className={btn} title="关闭" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        ) : focused ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-[3px] text-[9px] font-extrabold tracking-wide text-on-accent">
            <Volume2 size={11} /> AUDIO
          </span>
        ) : (
          <VolumeX size={15} className="text-white/70" />
        )}
      </div>

      {/* footer */}
      {meta.title ? (
        <div className={`pointer-events-none absolute inset-x-0 bottom-0 p-2.5 transition-opacity ${showChrome ? "opacity-100" : "opacity-0"}`}>
          <p className="truncate pr-8 text-[11px] font-medium text-white/80">{meta.title}</p>
        </div>
      ) : null}

      {/* span grip (edit mode, or hover) */}
      {(editing || hover) && !zoomed ? (
        <button
          type="button"
          title="拖动以跨越多个格子"
          className={`${btn} absolute right-2 bottom-2 cursor-nwse-resize`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onGripPointerDown(e);
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MoveDiagonal2 size={12} />
        </button>
      ) : null}
    </div>
  );
}
