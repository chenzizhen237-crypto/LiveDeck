import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";

export interface DanmakuOverlayHandle {
  push: (text: string, color?: string | null) => void;
}

interface Bullet {
  id: number;
  text: string;
  color: string;
  lane: number;
  duration: number;
}

const LANE_HEIGHT = 30;
const MAX_ON_SCREEN = 80;

/** Converts Douyu's decimal `col` codes / hex strings into a CSS colour. */
function toColor(color: string | null | undefined): string {
  if (!color) return "#fff";
  if (color.startsWith("#")) return color;
  const n = Number(color);
  // Douyu sends small palette indices (1-6); treat those as white for readability.
  if (!Number.isFinite(n) || n < 16) return "#fff";
  return `#${n.toString(16).padStart(6, "0")}`;
}

/**
 * Scrolling danmaku. Each bullet takes the lane that has been free longest,
 * so lines rarely overlap; anything beyond MAX_ON_SCREEN is dropped.
 */
export const DanmakuOverlay = forwardRef<DanmakuOverlayHandle, { opacity: number }>(function DanmakuOverlay(
  { opacity },
  ref,
) {
  const stage = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [bullets, setBullets] = useState<Bullet[]>([]);
  const laneFreeAt = useRef<number[]>([]);
  const nextId = useRef(0);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    push(text, color) {
      const el = stage.current;
      if (!el || !text) return;
      // Use the upper ~3/4 of the video so subtitles stay readable.
      const lanes = Math.max(1, Math.floor((el.clientHeight * 0.75) / LANE_HEIGHT));
      const now = performance.now();
      let lane = 0;
      for (let i = 0; i < lanes; i++) {
        if ((laneFreeAt.current[i] ?? 0) < (laneFreeAt.current[lane] ?? 0)) lane = i;
      }
      // Longer messages move a bit faster so they don't linger.
      const duration = 9000 - Math.min(text.length, 30) * 50;
      laneFreeAt.current[lane] = now + duration * 0.35;
      setBullets((prev) => {
        if (prev.length >= MAX_ON_SCREEN) return prev;
        return [...prev, { id: nextId.current++, text, color: toColor(color), lane, duration }];
      });
    },
  }));

  return (
    <div
      ref={stage}
      className="absolute inset-0 overflow-hidden"
      style={{ opacity, "--stage-width": `${width}px` } as React.CSSProperties}
    >
      {bullets.map((b) => (
        <span
          key={b.id}
          className="absolute left-full whitespace-nowrap text-xl font-bold will-change-transform"
          style={{
            top: b.lane * LANE_HEIGHT + 6,
            color: b.color,
            textShadow: "0 0 2px #000, 0 1px 3px #000",
            animation: `danmaku-fly ${b.duration}ms linear forwards`,
          }}
          onAnimationEnd={() => setBullets((prev) => prev.filter((x) => x.id !== b.id))}
        >
          {b.text}
        </span>
      ))}
    </div>
  );
});
