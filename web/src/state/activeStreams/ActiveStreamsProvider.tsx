// Port of the Vue `playerStore`: the rooms you've opened, shown as capsules in
// the dynamic island. The backend plays one stream at a time, so only the
// current room is playing; the others are shortcuts back to it.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { UiPlatform } from "@/state/category/CategoryProvider";

export interface ActiveStreamer {
  platform: UiPlatform;
  roomId: string;
  title: string;
  anchorName: string;
  avatar: string;
  isLive: boolean;
}

type ActiveStreamsContextValue = {
  streamers: ActiveStreamer[];
  current: ActiveStreamer | null;
  /** Adds the room (or refreshes its info) and makes it current. */
  open: (info: ActiveStreamer) => void;
  /** Updates info for a room without changing which one is current. */
  update: (info: Partial<ActiveStreamer> & Pick<ActiveStreamer, "platform" | "roomId">) => void;
  remove: (platform: UiPlatform, roomId: string) => void;
  clear: () => void;
};

const STORAGE_KEY = "livedeck_active_streamers_v1";
const keyOf = (platform: string, roomId: string) => `${platform.toLowerCase()}:${roomId}`;

const ActiveStreamsContext = createContext<ActiveStreamsContextValue | null>(null);

export function ActiveStreamsProvider({ children }: { children: React.ReactNode }) {
  const [streamers, setStreamers] = useState<ActiveStreamer[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (saved?.streamers) setStreamers(saved.streamers);
      if (saved?.currentKey) setCurrentKey(saved.currentKey);
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ streamers, currentKey }));
    } catch {
      // ignore
    }
  }, [currentKey, hydrated, streamers]);

  const open = useCallback((info: ActiveStreamer) => {
    const key = keyOf(info.platform, info.roomId);
    setStreamers((prev) => {
      const idx = prev.findIndex((s) => keyOf(s.platform, s.roomId) === key);
      if (idx === -1) return [...prev, info];
      const next = [...prev];
      next[idx] = { ...prev[idx], ...info };
      return next;
    });
    setCurrentKey(key);
  }, []);

  const update = useCallback<ActiveStreamsContextValue["update"]>((info) => {
    const key = keyOf(info.platform, info.roomId);
    setStreamers((prev) => prev.map((s) => (keyOf(s.platform, s.roomId) === key ? { ...s, ...info } : s)));
  }, []);

  const remove = useCallback((platform: UiPlatform, roomId: string) => {
    const key = keyOf(platform, roomId);
    setStreamers((prev) => {
      const next = prev.filter((s) => keyOf(s.platform, s.roomId) !== key);
      setCurrentKey((cur) => (cur === key ? (next.length ? keyOf(next[next.length - 1].platform, next[next.length - 1].roomId) : null) : cur));
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setStreamers([]);
    setCurrentKey(null);
  }, []);

  const value = useMemo<ActiveStreamsContextValue>(
    () => ({
      streamers,
      current: streamers.find((s) => keyOf(s.platform, s.roomId) === currentKey) ?? null,
      open,
      update,
      remove,
      clear
    }),
    [clear, currentKey, open, remove, streamers, update]
  );

  return <ActiveStreamsContext.Provider value={value}>{children}</ActiveStreamsContext.Provider>;
}

export function useActiveStreams() {
  const ctx = useContext(ActiveStreamsContext);
  if (!ctx) throw new Error("useActiveStreams must be used within ActiveStreamsProvider");
  return ctx;
}
