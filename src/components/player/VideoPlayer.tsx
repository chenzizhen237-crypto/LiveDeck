import { useEffect, useRef } from "react";
import Player from "xgplayer";
import FlvPlugin from "xgplayer-flv";
import HlsPlugin from "xgplayer-hls";
import "xgplayer/dist/index.min.css";
import type { StreamType } from "../../lib/api";
import { useSettings } from "../../stores/settings";

interface Props {
  url: string;
  streamType: StreamType;
  onError?: (message: string) => void;
  children?: React.ReactNode; // overlays (danmaku) rendered above the video
}

export function VideoPlayer({ url, streamType, onError, children }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!host.current) return;
    const isHls = streamType === "hls" || url.includes(".m3u8");
    const player = new Player({
      el: host.current,
      url,
      isLive: true,
      autoplay: true,
      width: "100%",
      height: "100%",
      volume: useSettings.getState().volume,
      plugins: [isHls ? HlsPlugin : FlvPlugin],
      // Live streams can't seek; keep the control bar minimal.
      ignores: ["progress", "time", "playbackrate", "download"],
      flv: { retryCount: 3, retryDelay: 1000, loadTimeout: 15000 },
      hls: { retryCount: 3, retryDelay: 1000 },
    });
    player.on("volumechange", () => useSettings.getState().setVolume(player.volume));
    player.on("error", (err: { message?: string }) => onErrorRef.current?.(err?.message ?? "播放失败"));
    return () => player.destroy();
  }, [url, streamType]);

  return (
    <div className="relative size-full overflow-hidden bg-black">
      <div ref={host} className="absolute inset-0" />
      {/* Overlays sit above the video but below xgplayer's controls (z-index 10+). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bottom-12 z-[5]">{children}</div>
    </div>
  );
}
