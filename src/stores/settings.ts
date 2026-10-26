import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "system" | "light" | "dark";

interface SettingsState {
  theme: Theme;
  sidebarCollapsed: boolean;
  danmakuEnabled: boolean;
  danmakuPanelOpen: boolean;
  danmakuOpacity: number;
  volume: number;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  toggleDanmaku: () => void;
  toggleDanmakuPanel: () => void;
  setDanmakuOpacity: (v: number) => void;
  setVolume: (v: number) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      sidebarCollapsed: false,
      danmakuEnabled: true,
      danmakuPanelOpen: true,
      danmakuOpacity: 0.9,
      volume: 0.6,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleDanmaku: () => set((s) => ({ danmakuEnabled: !s.danmakuEnabled })),
      toggleDanmakuPanel: () => set((s) => ({ danmakuPanelOpen: !s.danmakuPanelOpen })),
      setDanmakuOpacity: (danmakuOpacity) => set({ danmakuOpacity }),
      setVolume: (volume) => set({ volume }),
    }),
    { name: "livedeck-settings" },
  ),
);
