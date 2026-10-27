// One split-view tile's playback: resolve the room, mount a bare xgplayer (no
// controls), hold the room's proxy entry, and run danmaku only while shown.
// Everything goes through services/roomSession, so tiles and the single
// player never stop each other's rooms.

import { useEffect, useId, useRef, useState } from "react";

import { DEFAULT_DANMU_FONT_FAMILY, loadDanmuPreferences, loadStoredVolume, type DanmuUserSettings } from "@/components/player/constants";
import type { DanmuOverlayInstance } from "@/components/player/types";
import { danmakuColor, holdRoomDanmaku, holdRoomProxy, resolveRoomStream, subscribeDanmaku } from "@/services/roomSession";
import type { RoomRef } from "@/hooks/useOpenRoom";
import { setTileStatus, trackTilePlayer, untrackTile } from "@/services/playbackMetrics/monitor";

export type TileStatus = "connecting" | "playing" | "offline" | "error";

export interface TileMeta {
  title: string | null;
  anchorName: string | null;
  avatar: string | null;
}

const OFFLINE_RETRY_MS = 60_000;

const DEFAULT_SETTINGS: DanmuUserSettings = {
  color: "#ffffff",
  strokeColor: "#444444",
  fontSize: "20px",
  duration: 10000,
  area: 0.5,
  mode: "scroll",
  opacity: 1
};

function isOfflineError(msg: string) {
  return /未开播|不在线|房间不存在|offline/i.test(msg);
}

/** Smaller tiles get smaller danmaku so a 4×4 wall stays readable. */
function settingsFor(height: number): DanmuUserSettings {
  const base = loadDanmuPreferences()?.settings ?? DEFAULT_SETTINGS;
  const px = height < 260 ? 13 : height < 420 ? 16 : parseInt(base.fontSize, 10) || 20;
  return { ...base, fontSize: `${px}px` };
}

export function useTilePlayer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  room: RoomRef,
  opts: { quality: string; muted: boolean; danmakuOn: boolean }
) {
  const [status, setStatus] = useState<TileStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<TileMeta>({ title: room.title ?? null, anchorName: room.anchorName ?? null, avatar: room.avatar ?? null });
  const [reloadKey, setReloadKey] = useState(0);
  const [danmakuIds, setDanmakuIds] = useState<{ backend: string; filter: string } | null>(null);
  const playerRef = useRef<any>(null);
  const overlayRef = useRef<DanmuOverlayInstance | null>(null);
  const mutedRef = useRef(opts.muted);
  mutedRef.current = opts.muted;
  const autoReload = useRef({ since: 0, count: 0 });
  // Playback monitor: one id per tile; every player (re)creation starts a new counter epoch.
  const metricsId = useId();
  useEffect(() => () => untrackTile(metricsId), [metricsId]);

  // --- stream + player
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let releaseProxy: () => void = () => {};
    let untrack: () => void = () => {};
    let retryTimer = 0;
    setStatus("connecting");
    setError(null);
    setDanmakuIds(null);

    const reloadSoon = (delay: number) => {
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => !disposed && setReloadKey((k) => k + 1), delay);
    };

    (async () => {
      try {
        const s = await resolveRoomStream(room.platform, room.roomId, opts.quality);
        releaseProxy = holdRoomProxy(room.platform, room.roomId);
        if (disposed) return;
        setMeta((m) => ({ title: s.title ?? m.title, anchorName: s.anchorName ?? m.anchorName, avatar: s.avatar ?? m.avatar }));

        const [{ default: Player }, flvMod, hlsMod, overlayMod] = await Promise.all([
          import("xgplayer"),
          import("xgplayer-flv"),
          import("@/components/player/hlsPlugin"),
          import("@/components/player/danmuOverlay")
        ]);
        if (disposed) return;

        const options: Record<string, unknown> = {
          el,
          url: s.streamUrl,
          isLive: true,
          autoplay: true,
          autoplayMuted: true,
          muted: mutedRef.current,
          playsinline: true,
          width: "100%",
          height: "100%",
          videoFillMode: "contain",
          controls: false,
          keyShortcut: false,
          closeVideoClick: true,
          closeVideoDblclick: true,
          // The tile draws its own chrome and states.
          ignores: ["start", "enter", "loading", "error", "replay", "poster", "keyboard", "miniprogress", "pc", "mobile"]
        };
        if (s.isHls) {
          options.plugins = [(hlsMod as any).default ?? hlsMod];
          options.HlsJsPlugin = { hlsOpts: { enableWorker: true, lowLatencyMode: false, fragLoadingMaxRetry: 3 } };
        } else {
          options.plugins = [(flvMod as any).default ?? flvMod];
          options.flv = { isLive: true, retryCount: 3, retryDelay: 1000, loadTimeout: 10000, preloadTime: 5, bufferBehind: 10 };
        }

        const player = new (Player as any)(options);
        playerRef.current = player;
        untrack = trackTilePlayer(
          { id: metricsId, label: s.anchorName || room.anchorName || room.roomId, platform: room.platform, streamUrl: s.streamUrl, isHls: s.isHls },
          player
        );
        if (!mutedRef.current) {
          const v = loadStoredVolume();
          if (v !== null) player.volume = v;
        }
        player.on?.("playing", () => !disposed && setStatus("playing"));
        // Relay ends the stream on a codec change or a 15 s stall: reload, at most 3×/min.
        const onBroken = () => {
          if (disposed) return;
          const now = Date.now();
          const r = autoReload.current;
          if (now - r.since > 60_000) Object.assign(r, { since: now, count: 0 });
          if (r.count >= 3) {
            setTileStatus(metricsId, "error");
            setStatus("error");
            setError("直播流中断");
            return;
          }
          r.count += 1;
          reloadSoon(1000);
        };
        player.on?.("error", onBroken);
        player.on?.("ended", onBroken);

        el.style.setProperty("--danmu-font-family", DEFAULT_DANMU_FONT_FAMILY);
        overlayRef.current = overlayMod.createDanmuOverlay(player, settingsFor(el.clientHeight), true);
        setDanmakuIds({ backend: s.danmakuRoomId, filter: s.danmakuFilterRoomId });
      } catch (e: any) {
        if (disposed) return;
        const msg = e?.message ? String(e.message) : String(e);
        const offline = isOfflineError(msg);
        setStatus(offline ? "offline" : "error");
        setTileStatus(metricsId, offline ? "offline" : "error");
        setError(msg);
        // Offline rooms rejoin by themselves when they go live.
        if (offline) reloadSoon(OFFLINE_RETRY_MS);
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      try {
        overlayRef.current?.clear?.();
        (overlayRef.current as any)?.destroy?.();
      } catch {
        // ignore
      }
      overlayRef.current = null;
      untrack();
      try {
        playerRef.current?.destroy?.();
      } catch {
        // ignore
      }
      playerRef.current = null;
      releaseProxy();
    };
    // quality is fixed per mount on purpose: re-layouts shouldn't restart streams.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.platform, room.roomId, reloadKey]);

  // --- audio focus
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    p.muted = opts.muted;
    if (!opts.muted) {
      const v = loadStoredVolume();
      if (v !== null && v > 0) p.volume = v;
      void p.play?.()?.catch?.(() => {});
    }
  }, [opts.muted, status]);

  // --- danmaku, only while this tile shows it
  useEffect(() => {
    if (!opts.danmakuOn || !danmakuIds) return;
    const release = holdRoomDanmaku(room.platform, danmakuIds.backend);
    const unsubscribe = subscribeDanmaku(danmakuIds.filter, (p) => {
      overlayRef.current?.sendComment?.({
        txt: p.content || "",
        user: p.user || "",
        duration: 10000,
        mode: "scroll",
        style: { color: danmakuColor(p.color) || "#FFFFFF" }
      });
    });
    return () => {
      unsubscribe();
      release();
      overlayRef.current?.clear?.();
    };
  }, [danmakuIds, opts.danmakuOn, room.platform]);

  return { status, error, meta, reload: () => setReloadKey((k) => k + 1) };
}
