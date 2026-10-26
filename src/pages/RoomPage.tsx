import { useEffect, useRef, useState } from "react";
import { Navigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Heart, MessageSquare, MessageSquareOff, PanelRightClose, PanelRightOpen, RotateCw } from "lucide-react";
import { getLiveStream, type Platform } from "../lib/api";
import { isPlatform, platformInfo } from "../lib/platforms";
import { useFollows } from "../stores/follows";
import { useNowPlaying } from "../stores/nowPlaying";
import { useSettings } from "../stores/settings";
import { useDanmaku } from "../hooks/useDanmaku";
import { VideoPlayer } from "../components/player/VideoPlayer";
import { DanmakuOverlay, type DanmakuOverlayHandle } from "../components/player/DanmakuOverlay";
import { DanmakuList } from "../components/player/DanmakuList";
import { Avatar } from "../components/ui/Avatar";

const QUALITIES = ["原画", "高清", "标清"] as const;

export function RoomPage() {
  const { platform, roomId } = useParams();
  if (!isPlatform(platform) || !roomId) return <Navigate to="/" replace />;
  return <Room key={`${platform}:${roomId}`} platform={platform} roomId={roomId} />;
}

function Room({ platform, roomId }: { platform: Platform; roomId: string }) {
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>("原画");
  const settings = useSettings();
  const overlay = useRef<DanmakuOverlayHandle>(null);

  const stream = useQuery({
    queryKey: ["stream", platform, roomId, quality],
    queryFn: () => getLiveStream({ platform, room_id: roomId, quality }),
    // Signed stream URLs expire; never reuse a cached one.
    gcTime: 0,
    staleTime: 0,
  });
  // Meta mode is cheap and fills in anchor info for platforms whose playback
  // response leaves it empty.
  const meta = useQuery({
    queryKey: ["stream-meta", platform, roomId],
    queryFn: () => getLiveStream({ platform, room_id: roomId, mode: "meta" }),
    staleTime: 60_000,
  });

  const room = { ...meta.data?.room, ...pickDefined(stream.data?.room) };
  const name = room.anchor_name ?? roomId;
  const title = room.title ?? "";
  const avatar = room.avatar ?? "";
  const live = stream.data?.status === "live" && !!stream.data.playback;

  const setNowPlaying = useNowPlaying((s) => s.set);
  useEffect(() => {
    setNowPlaying({ platform, roomId, name, title, avatar });
  }, [platform, roomId, name, title, avatar, setNowPlaying]);

  const lines = useDanmaku(platform, roomId, live && settings.danmakuEnabled, (msg) => {
    overlay.current?.push(msg.content, msg.color);
  });

  const follows = useFollows();
  const followed = follows.isFollowed(platform, roomId);
  const toggleFollow = () =>
    followed
      ? follows.unfollow(platform, roomId)
      : follows.follow({ platform, roomId, name, title, avatar, status: live ? "live" : "offline" });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 pb-3">
        <Avatar src={avatar} name={name} size={44} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-lg font-bold">
            {name}
            <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] font-bold text-text-3">
              {platformInfo(platform).name} · {roomId}
            </span>
          </p>
          <p className="truncate text-sm text-text-3">{title}</p>
        </div>

        <select
          value={quality}
          onChange={(e) => setQuality(e.target.value as typeof quality)}
          className="h-8 rounded-full bg-panel-2 px-3 text-xs font-bold outline-none"
          aria-label="画质"
        >
          {QUALITIES.map((q) => (
            <option key={q}>{q}</option>
          ))}
        </select>
        <ToolbarButton
          label={settings.danmakuEnabled ? "关闭弹幕" : "开启弹幕"}
          onClick={settings.toggleDanmaku}
        >
          {settings.danmakuEnabled ? <MessageSquare size={16} /> : <MessageSquareOff size={16} />}
        </ToolbarButton>
        <ToolbarButton label={settings.danmakuPanelOpen ? "收起弹幕列表" : "展开弹幕列表"} onClick={settings.toggleDanmakuPanel}>
          {settings.danmakuPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </ToolbarButton>
        <button
          onClick={toggleFollow}
          className={clsx(
            "flex h-8 items-center gap-1.5 rounded-full px-4 text-xs font-bold",
            followed ? "bg-panel-2 text-text-2" : "bg-accent text-accent-ink",
          )}
        >
          <Heart size={14} fill={followed ? "currentColor" : "none"} />
          {followed ? "已关注" : "关注"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg bg-black">
          {stream.isPending ? (
            <Centered>正在获取直播流…</Centered>
          ) : stream.isError || stream.data?.status === "error" ? (
            <Centered>
              <p>获取直播流失败</p>
              <p className="max-w-md text-xs text-white/50">{String(stream.error ?? stream.data?.error ?? "")}</p>
              <button onClick={() => void stream.refetch()} className="mt-2 flex items-center gap-1 font-bold text-accent">
                <RotateCw size={14} /> 重试
              </button>
            </Centered>
          ) : !live ? (
            <Centered>主播暂未开播</Centered>
          ) : (
            <VideoPlayer url={stream.data!.playback!.url} streamType={stream.data!.playback!.stream_type}>
              {settings.danmakuEnabled && <DanmakuOverlay ref={overlay} opacity={settings.danmakuOpacity} />}
            </VideoPlayer>
          )}
        </div>
        {settings.danmakuPanelOpen && <DanmakuList lines={lines} active={live && settings.danmakuEnabled} />}
      </div>
    </div>
  );
}

function pickDefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== "")) as Partial<T>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex size-full flex-col items-center justify-center gap-1 text-sm text-white/70">{children}</div>;
}

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-full bg-panel-2 text-text-2 hover:text-text"
    >
      {children}
    </button>
  );
}
