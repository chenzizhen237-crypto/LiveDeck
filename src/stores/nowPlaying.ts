import { create } from "zustand";
import type { Platform } from "../lib/api";

export interface NowPlaying {
  platform: Platform;
  roomId: string;
  name: string;
  title: string;
  avatar: string;
}

/** The room open in the player, shown in the top "island" while browsing. */
export const useNowPlaying = create<{
  current: NowPlaying | null;
  set: (np: NowPlaying | null) => void;
}>()((set) => ({
  current: null,
  set: (current) => set({ current }),
}));
