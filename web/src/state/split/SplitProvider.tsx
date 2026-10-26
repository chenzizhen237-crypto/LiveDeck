// Split view: several rooms on one grid (1×2 up to 4×4), tiles spanning any
// rectangle of cells. Geometry lives in ./layout; this holds the state, the
// actions and persistence. Each tile plays through services/roomSession, so
// rooms run side by side on the backend's per-room proxy and danmaku.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import type { RoomRef } from "@/hooks/useOpenRoom";
import {
  PRESETS,
  applySlots,
  clampDim,
  freeCells,
  gridFor,
  moveTile,
  resizeGrid,
  resizeTile,
  swapTiles,
  type Rect
} from "./layout";

export interface SplitTile {
  id: string;
  room: RoomRef;
  rect: Rect;
}

interface SplitState {
  open: boolean;
  cols: number;
  rows: number;
  tiles: SplitTile[];
  /** The tile whose audio plays (and whose danmaku shows unless danmakuAll). */
  focusId: string | null;
  /** Shown full-grid on its own ("maximize"); the others keep running underneath. */
  zoomId: string | null;
  layoutName: string;
  danmakuAll: boolean;
  audioFollowsClick: boolean;
}

/** Where "Add room" puts the next pick: a specific empty cell, or replacing a tile's room. */
export type PickTarget = { cell?: { col: number; row: number }; replaceTileId?: string } | null;

type SplitContextValue = SplitState & {
  picking: PickTarget;
  /** Opens split view with these rooms (keeps it open with its rooms if already open). */
  openWith: (rooms: RoomRef[]) => void;
  close: () => void;
  /** Adds a room to the next free cell (or `target`); returns false when the grid is full. */
  addRoom: (room: RoomRef, target?: PickTarget) => boolean;
  removeTile: (id: string) => void;
  focus: (id: string) => void;
  toggleZoom: (id: string) => void;
  applyPreset: (name: string) => boolean;
  setGrid: (cols: number, rows: number) => boolean;
  /** Returns false (and changes nothing) when the span can't fit. */
  spanTile: (id: string, rect: Rect) => boolean;
  previewSpan: (id: string, rect: Rect) => boolean;
  swap: (a: string, b: string) => void;
  move: (id: string, to: { col: number; row: number }) => boolean;
  setDanmakuAll: (v: boolean) => void;
  setAudioFollowsClick: (v: boolean) => void;
  beginPick: (target: PickTarget) => void;
  cancelPick: () => void;
  emptyCells: Rect[];
};

const STORAGE_KEY = "livedeck_split_v1";
const sameRoom = (a: RoomRef, b: RoomRef) => a.platform === b.platform && a.roomId === b.roomId;

const INITIAL: SplitState = {
  open: false,
  cols: 2,
  rows: 1,
  tiles: [],
  focusId: null,
  zoomId: null,
  layoutName: "1 × 2",
  danmakuAll: false,
  audioFollowsClick: true
};

function gridName(cols: number, rows: number) {
  return `${rows} × ${cols}`;
}

type Grid = { cols: number; rows: number; tiles: SplitTile[] };

/** Puts a room in `cell` if free, else the first free cell, growing the grid (up to 4×4) when full. */
function placeRoom(grid: Grid, room: RoomRef, cell?: { col: number; row: number }): (Grid & { tile: SplitTile }) | null {
  let { cols, rows, tiles } = grid;
  let free = freeCells(tiles, cols, rows);
  if (!free.length) {
    if (cols * rows >= 16) return null;
    const next = gridFor(cols * rows + 1);
    const grown = resizeGrid(tiles, next.cols, next.rows);
    if (!grown) return null;
    ({ cols, rows } = next);
    tiles = grown;
    free = freeCells(tiles, cols, rows);
  }
  const rect = (cell && free.find((c) => c.col === cell.col && c.row === cell.row)) || free[0];
  const tile: SplitTile = { id: uuidv4(), room, rect: { ...rect } };
  return { cols, rows, tiles: [...tiles, tile], tile };
}

const SplitContext = createContext<SplitContextValue | null>(null);

export function SplitProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SplitState>(INITIAL);
  const [picking, setPicking] = useState<PickTarget>(null);
  const hydrated = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Restore the last layout and rooms, closed: reopening shouldn't start N streams at launch.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && Array.isArray(saved.tiles)) setState({ ...INITIAL, ...saved, open: false, zoomId: null });
    } catch {
      // ignore
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      const { open: _open, zoomId: _zoom, ...persist } = state;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
    } catch {
      // ignore
    }
  }, [state]);

  const openWith = useCallback((rooms: RoomRef[]) => {
    setState((s) => {
      let grid = { cols: s.cols, rows: s.rows, tiles: s.tiles };
      let focusId = s.focusId;
      for (const room of rooms) {
        const existing = grid.tiles.find((t) => sameRoom(t.room, room));
        if (existing) {
          focusId = existing.id;
          continue;
        }
        const placed = placeRoom(grid, room);
        if (!placed) break;
        grid = placed;
        focusId = placed.tile.id;
      }
      const resized = grid.cols !== s.cols || grid.rows !== s.rows;
      return { ...s, ...grid, open: true, focusId: focusId ?? grid.tiles[0]?.id ?? null, layoutName: resized ? gridName(grid.cols, grid.rows) : s.layoutName };
    });
  }, []);

  const close = useCallback(() => {
    setPicking(null);
    setState((s) => ({ ...s, open: false, zoomId: null }));
  }, []);

  const addRoom = useCallback((room: RoomRef, target?: PickTarget) => {
    const s = stateRef.current;
    const existing = s.tiles.find((t) => sameRoom(t.room, room));
    if (existing) {
      setState((cur) => ({ ...cur, focusId: existing.id }));
      return true;
    }
    if (target?.replaceTileId) {
      setState((cur) => ({ ...cur, tiles: cur.tiles.map((t) => (t.id === target.replaceTileId ? { ...t, room } : t)) }));
      return true;
    }
    const placed = placeRoom(s, room, target?.cell);
    if (!placed) return false;
    setState((cur) => ({
      ...cur,
      cols: placed.cols,
      rows: placed.rows,
      tiles: placed.tiles,
      layoutName: placed.cols === cur.cols && placed.rows === cur.rows ? cur.layoutName : gridName(placed.cols, placed.rows),
      focusId: cur.focusId ?? placed.tile.id
    }));
    return true;
  }, []);

  const removeTile = useCallback((id: string) => {
    setState((s) => {
      const tiles = s.tiles.filter((t) => t.id !== id);
      return {
        ...s,
        tiles,
        focusId: s.focusId === id ? tiles[0]?.id ?? null : s.focusId,
        zoomId: s.zoomId === id ? null : s.zoomId
      };
    });
  }, []);

  const focus = useCallback((id: string) => setState((s) => (s.focusId === id ? s : { ...s, focusId: id })), []);
  const toggleZoom = useCallback((id: string) => setState((s) => ({ ...s, zoomId: s.zoomId === id ? null : id, focusId: id })), []);

  const applyPreset = useCallback((name: string) => {
    const preset = PRESETS.find((p) => p.name === name);
    if (!preset) return false;
    const placed = applySlots(stateRef.current.tiles, preset.slots);
    if (!placed) return false;
    setState((s) => ({ ...s, cols: preset.cols, rows: preset.rows, tiles: placed, layoutName: preset.name, zoomId: null }));
    return true;
  }, []);

  const setGrid = useCallback((c: number, r: number) => {
    const cols = clampDim(c);
    const rows = clampDim(r);
    const placed = resizeGrid(stateRef.current.tiles, cols, rows);
    if (!placed) return false;
    setState((s) => ({ ...s, cols, rows, tiles: placed, layoutName: gridName(cols, rows), zoomId: null }));
    return true;
  }, []);

  const previewSpan = useCallback((id: string, rect: Rect) => {
    const s = stateRef.current;
    return !!resizeTile(s.tiles, id, rect, s.cols, s.rows);
  }, []);

  const spanTile = useCallback((id: string, rect: Rect) => {
    const s = stateRef.current;
    const next = resizeTile(s.tiles, id, rect, s.cols, s.rows);
    if (!next) return false;
    setState((cur) => ({ ...cur, tiles: next, layoutName: "Custom" }));
    return true;
  }, []);

  const swap = useCallback((a: string, b: string) => {
    setState((s) => ({ ...s, tiles: swapTiles(s.tiles, a, b), layoutName: "Custom" }));
  }, []);

  const move = useCallback((id: string, to: { col: number; row: number }) => {
    const s = stateRef.current;
    const next = moveTile(s.tiles, id, to, s.cols, s.rows);
    if (!next) return false;
    setState((cur) => ({ ...cur, tiles: next, layoutName: "Custom" }));
    return true;
  }, []);

  const setDanmakuAll = useCallback((v: boolean) => setState((s) => ({ ...s, danmakuAll: v })), []);
  const setAudioFollowsClick = useCallback((v: boolean) => setState((s) => ({ ...s, audioFollowsClick: v })), []);
  const beginPick = useCallback((target: PickTarget) => setPicking(target ?? {}), []);
  const cancelPick = useCallback(() => setPicking(null), []);

  const emptyCells = useMemo(() => freeCells(state.tiles, state.cols, state.rows), [state.cols, state.rows, state.tiles]);

  const value = useMemo<SplitContextValue>(
    () => ({
      ...state,
      picking,
      openWith,
      close,
      addRoom,
      removeTile,
      focus,
      toggleZoom,
      applyPreset,
      setGrid,
      spanTile,
      previewSpan,
      swap,
      move,
      setDanmakuAll,
      setAudioFollowsClick,
      beginPick,
      cancelPick,
      emptyCells
    }),
    [state, picking, openWith, close, addRoom, removeTile, focus, toggleZoom, applyPreset, setGrid, spanTile, previewSpan, swap, move, setDanmakuAll, setAudioFollowsClick, beginPick, cancelPick, emptyCells]
  );

  return <SplitContext.Provider value={value}>{children}</SplitContext.Provider>;
}

export function useSplit() {
  const ctx = useContext(SplitContext);
  if (!ctx) throw new Error("useSplit must be used within SplitProvider");
  return ctx;
}
