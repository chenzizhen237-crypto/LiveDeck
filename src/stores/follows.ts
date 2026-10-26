import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getLiveStream, type Platform } from "../lib/api";

export type FollowStatus = "live" | "offline" | "error" | "unknown";

export interface FollowedStreamer {
  platform: Platform;
  roomId: string;
  name: string;
  avatar: string;
  title: string;
  status: FollowStatus;
  followedAt: number;
}

export const followKey = (platform: Platform, roomId: string) => `${platform}:${roomId}`;

interface FollowsState {
  /** Manual order; refresh regroups as live -> other while keeping order within groups. */
  order: string[];
  byKey: Record<string, FollowedStreamer>;
  refreshing: boolean;
  isFollowed: (platform: Platform, roomId: string) => boolean;
  follow: (s: Omit<FollowedStreamer, "status" | "followedAt"> & { status?: FollowStatus }) => void;
  unfollow: (platform: Platform, roomId: string) => void;
  reorder: (from: number, to: number) => void;
  refresh: () => Promise<void>;
}

const REFRESH_CONCURRENCY = 3;

export const useFollows = create<FollowsState>()(
  persist(
    (set, get) => ({
      order: [],
      byKey: {},
      refreshing: false,

      isFollowed: (platform, roomId) => !!get().byKey[followKey(platform, roomId)],

      follow: (s) => {
        const key = followKey(s.platform, s.roomId);
        if (get().byKey[key]) return;
        set((state) => ({
          order: [key, ...state.order],
          byKey: { ...state.byKey, [key]: { status: "unknown", ...s, followedAt: Date.now() } },
        }));
      },

      unfollow: (platform, roomId) => {
        const key = followKey(platform, roomId);
        set((state) => {
          const { [key]: _, ...rest } = state.byKey;
          return { order: state.order.filter((k) => k !== key), byKey: rest };
        });
      },

      reorder: (from, to) =>
        set((state) => {
          const order = [...state.order];
          const [moved] = order.splice(from, 1);
          order.splice(to, 0, moved);
          return { order };
        }),

      refresh: async () => {
        if (get().refreshing) return;
        set({ refreshing: true });
        const keys = [...get().order];
        let cursor = 0;
        const worker = async () => {
          while (cursor < keys.length) {
            const key = keys[cursor++];
            const s = get().byKey[key];
            if (!s) continue;
            let patch: Partial<FollowedStreamer>;
            try {
              const resp = await getLiveStream({ platform: s.platform, room_id: s.roomId, mode: "meta" });
              patch = {
                status: resp.status,
                name: resp.room.anchor_name || s.name,
                title: resp.room.title || s.title,
                avatar: resp.room.avatar || s.avatar,
              };
            } catch {
              patch = { status: "error" };
            }
            set((state) =>
              state.byKey[key] ? { byKey: { ...state.byKey, [key]: { ...state.byKey[key], ...patch } } } : state,
            );
          }
        };
        try {
          await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, worker));
        } finally {
          // Stable regroup: live first, original order otherwise.
          set((state) => ({
            refreshing: false,
            order: [...state.order].sort(
              (a, b) => Number(state.byKey[b]?.status === "live") - Number(state.byKey[a]?.status === "live"),
            ),
          }));
        }
      },
    }),
    {
      name: "livedeck-follows",
      partialize: ({ order, byKey }) => ({ order, byKey }),
    },
  ),
);
