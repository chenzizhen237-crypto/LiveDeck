// Saved split-view setups: named snapshots of rooms, grid, spans and viewing
// preferences. Pure helpers; SplitProvider owns the state and persistence.

import type { RoomRef } from "@/hooks/useOpenRoom";
import type { Rect } from "./layout";

export interface SavedSetup {
  id: string;
  name: string;
  /** Layout only: rectangles without rooms, applied to whatever rooms are open. */
  layoutOnly: boolean;
  cols: number;
  rows: number;
  layoutName: string;
  /** Reading order; `room` is absent for layout-only setups. */
  tiles: { room?: RoomRef; rect: Rect }[];
  /** Index into `tiles` of the room with audio. */
  focusIndex: number | null;
  danmakuAll: boolean;
  audioFollowsClick: boolean;
  updatedAt: number;
}

export interface SplitSnapshot {
  cols: number;
  rows: number;
  layoutName: string;
  tiles: { id: string; room: RoomRef; rect: Rect }[];
  focusId: string | null;
  danmakuAll: boolean;
  audioFollowsClick: boolean;
}

const byReading = (a: { rect: Rect }, b: { rect: Rect }) => a.rect.row - b.rect.row || a.rect.col - b.rect.col;
const roomKey = (r?: RoomRef) => (r ? `${r.platform}:${r.roomId}` : "");

export function captureSetup(s: SplitSnapshot, id: string, name: string, layoutOnly: boolean): SavedSetup {
  const tiles = [...s.tiles].sort(byReading);
  const focusIndex = tiles.findIndex((t) => t.id === s.focusId);
  return {
    id,
    name,
    layoutOnly,
    cols: s.cols,
    rows: s.rows,
    layoutName: s.layoutName,
    tiles: tiles.map((t) => (layoutOnly ? { rect: { ...t.rect } } : { room: { ...t.room }, rect: { ...t.rect } })),
    focusIndex: layoutOnly || focusIndex < 0 ? null : focusIndex,
    danmakuAll: s.danmakuAll,
    audioFollowsClick: s.audioFollowsClick,
    updatedAt: Date.now()
  };
}

/** What a setup compares on, so "unsaved changes" ignores tile ids and order. */
export function signature(setup: Pick<SavedSetup, "layoutOnly" | "cols" | "rows" | "tiles" | "focusIndex" | "danmakuAll">) {
  const tiles = [...setup.tiles].sort(byReading).map((t) => `${setup.layoutOnly ? "" : roomKey(t.room)}@${t.rect.col},${t.rect.row},${t.rect.colSpan},${t.rect.rowSpan}`);
  return JSON.stringify([setup.cols, setup.rows, tiles, setup.layoutOnly ? null : setup.focusIndex, setup.layoutOnly ? null : setup.danmakuAll]);
}

export function isDirty(s: SplitSnapshot, setup: SavedSetup) {
  return signature(captureSetup(s, setup.id, setup.name, setup.layoutOnly)) !== signature(setup);
}

export function summary(setup: SavedSetup) {
  const n = setup.tiles.length;
  return setup.layoutOnly ? `仅布局 · ${n} 格 · ${setup.layoutName}` : `${n} 个直播间 · ${setup.layoutName}`;
}
