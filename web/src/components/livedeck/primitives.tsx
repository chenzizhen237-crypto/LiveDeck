// Small building blocks shared by the LiveDeck UI (see the Components page in LiveDeck UI.nib).

import React, { useState } from "react";

import { useImageProxy } from "@/hooks/useImageProxy";
import type { UiPlatform } from "@/state/category/CategoryProvider";

export const PLATFORM_META: Record<UiPlatform, { name: string; short: string; glyph: string; color: string }> = {
  douyu: { name: "斗鱼", short: "斗鱼", glyph: "鱼", color: "var(--color-douyu)" },
  huya: { name: "虎牙", short: "虎牙", glyph: "虎", color: "var(--color-huya)" },
  douyin: { name: "抖音", short: "抖音", glyph: "抖", color: "var(--color-douyin)" },
  bilibili: { name: "哔哩哔哩", short: "B站", glyph: "B", color: "var(--color-bilibili)" }
};

export const PLATFORMS: UiPlatform[] = ["douyu", "huya", "douyin", "bilibili"];

export function PlatformMark({ platform, size = 20 }: { platform: UiPlatform; size?: number }) {
  const meta = PLATFORM_META[platform];
  return (
    <span
      className="inline-grid shrink-0 place-items-center rounded-[6px] font-black text-white"
      style={{ width: size, height: size, background: meta.color, fontSize: size * 0.55 }}
      aria-hidden
    >
      {meta.glyph}
    </span>
  );
}

/** Avatar with the platform-aware image proxy and an initial-letter fallback. */
export function Avatar({
  src,
  name,
  platform,
  size = 32,
  className = ""
}: {
  src?: string | null;
  name: string;
  platform: UiPlatform;
  size?: number;
  className?: string;
}) {
  const { getAvatarSrc } = useImageProxy();
  const [failed, setFailed] = useState(false);
  const url = getAvatarSrc(platform, src);
  const style = { width: size, height: size };
  if (!url || failed) {
    return (
      <span
        className={`grid shrink-0 place-items-center rounded-full border border-line-strong bg-chip text-xs font-bold text-fg-2 ${className}`}
        style={style}
      >
        {name.slice(0, 1) || "?"}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full border border-line-strong bg-chip object-cover ${className}`}
      style={style}
    />
  );
}

export function LiveBadge({ replay = false }: { replay?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[10px] font-extrabold tracking-wide ${
        replay ? "bg-replay text-[#1a1300]" : "bg-live text-white"
      }`}
    >
      <span className={`size-[5px] rounded-full ${replay ? "bg-[#1a1300]" : "bg-white"}`} />
      {replay ? "回放" : "LIVE"}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-line-strong bg-chip px-1.5 py-0.5 font-sans text-[10px] font-bold text-fg-3">
      {children}
    </kbd>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  size = 36,
  className = ""
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid shrink-0 place-items-center rounded-full bg-chip text-fg-2 transition-colors hover:text-fg ${className}`}
      style={{ width: size, height: size }}
    >
      {children}
    </button>
  );
}

export function StatusDot({ status, ring = "var(--ld-bg-surface)" }: { status: "live" | "replay" | "offline"; ring?: string }) {
  const color = status === "live" ? "bg-online" : status === "replay" ? "bg-replay" : "bg-offline";
  return <span className={`block size-[10px] rounded-full ${color}`} style={{ boxShadow: `0 0 0 2px ${ring}` }} />;
}
