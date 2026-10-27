// Queue of island notifications (state F: "went live"). Each shows for 5s.
// Also the player's seat in the island: the island renders a slot element and the
// open player portals its bar (close, streamer, follow, split) into it.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { UiPlatform } from "@/state/category/CategoryProvider";

export interface IslandNotification {
  id: string;
  platform: UiPlatform;
  roomId: string;
  anchorName: string;
  avatar: string;
  title: string;
}

type IslandContextValue = {
  notifications: IslandNotification[];
  notify: (n: Omit<IslandNotification, "id">) => void;
  dismiss: (id: string) => void;
  /** Element the player portals its bar into; null while the island isn't mounted. */
  playerSlot: HTMLElement | null;
  setPlayerSlot: (el: HTMLElement | null) => void;
  /** Player bar wants to be shown (true) or tucked to the rest line (false); null = no player bar. */
  playerChrome: boolean | null;
  setPlayerChrome: (visible: boolean | null) => void;
};

const IslandContext = createContext<IslandContextValue | null>(null);
const SHOW_MS = 5000;

export function IslandProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<IslandNotification[]>([]);
  const [playerSlot, setPlayerSlot] = useState<HTMLElement | null>(null);
  const [playerChrome, setPlayerChrome] = useState<boolean | null>(null);

  const dismiss = useCallback((id: string) => setNotifications((prev) => prev.filter((n) => n.id !== id)), []);
  const notify = useCallback<IslandContextValue["notify"]>((n) => {
    setNotifications((prev) => [...prev, { ...n, id: `${n.platform}:${n.roomId}:${Date.now()}` }]);
  }, []);

  const head = notifications[0]?.id;
  useEffect(() => {
    if (!head) return;
    const timer = window.setTimeout(() => dismiss(head), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [dismiss, head]);

  const value = useMemo(
    () => ({ notifications, notify, dismiss, playerSlot, setPlayerSlot, playerChrome, setPlayerChrome }),
    [dismiss, notifications, notify, playerChrome, playerSlot]
  );
  return <IslandContext.Provider value={value}>{children}</IslandContext.Provider>;
}

export function useIsland() {
  const ctx = useContext(IslandContext);
  if (!ctx) throw new Error("useIsland must be used within IslandProvider");
  return ctx;
}
