"use client";

// Queue of island notifications (state F: "went live"). Each shows for 5s.

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
};

const IslandContext = createContext<IslandContextValue | null>(null);
const SHOW_MS = 5000;

export function IslandProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<IslandNotification[]>([]);

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

  const value = useMemo(() => ({ notifications, notify, dismiss }), [dismiss, notifications, notify]);
  return <IslandContext.Provider value={value}>{children}</IslandContext.Provider>;
}

export function useIsland() {
  const ctx = useContext(IslandContext);
  if (!ctx) throw new Error("useIsland must be used within IslandProvider");
  return ctx;
}
