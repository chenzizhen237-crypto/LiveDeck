import { useEffect, useRef, useState } from "react";
import { startDanmaku, type DanmakuMessage, type Platform } from "../lib/api";

const KEEP = 200;

export interface ChatLine extends DanmakuMessage {
  id: number;
}

/**
 * Subscribes to a room's danmaku while `enabled`. `onMessage` fires for every
 * message (for the overlay); `lines` holds the most recent ones (for the list).
 */
export function useDanmaku(
  platform: Platform,
  roomId: string,
  enabled: boolean,
  onMessage: (msg: DanmakuMessage) => void,
) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    let id = 0;
    // Batch list updates to one render per frame; busy rooms send dozens per second.
    let pending: ChatLine[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setLines((prev) => [...prev, ...batch].slice(-KEEP));
    };

    setLines([]);
    startDanmaku(platform, roomId, (msg) => {
      onMessageRef.current(msg);
      pending.push({ ...msg, id: id++ });
      frame ||= requestAnimationFrame(flush);
    })
      .then((s) => (cancelled ? s() : (stop = s)))
      .catch((e) => console.warn("[danmaku] failed to start", e));

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [platform, roomId, enabled]);

  return lines;
}
