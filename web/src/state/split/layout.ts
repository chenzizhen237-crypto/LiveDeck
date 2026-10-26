// Pure grid geometry for split view: presets, placement, spans and swaps.
// Kept free of React so it can be unit-tested.

export const MAX_DIM = 4;

/** Zero-based cell rectangle on the split grid. */
export interface Rect {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface Placed {
  id: string;
  rect: Rect;
}

export interface Preset {
  name: string;
  cols: number;
  rows: number;
  /** Slots in fill order; rooms take them one by one. */
  slots: Rect[];
}

const cell = (col: number, row: number, colSpan = 1, rowSpan = 1): Rect => ({ col, row, colSpan, rowSpan });

export function uniformSlots(cols: number, rows: number): Rect[] {
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(cell(c, r));
  return out;
}

const grid = (name: string, cols: number, rows: number): Preset => ({ name, cols, rows, slots: uniformSlots(cols, rows) });

export const PRESETS: Preset[] = [
  grid("1 × 1", 1, 1),
  grid("1 × 2", 2, 1),
  grid("2 × 1", 1, 2),
  grid("2 × 2", 2, 2),
  { name: "1 + 2", cols: 2, rows: 2, slots: [cell(0, 0, 1, 2), cell(1, 0), cell(1, 1)] },
  { name: "1 + 3", cols: 3, rows: 3, slots: [cell(0, 0, 2, 3), cell(2, 0), cell(2, 1), cell(2, 2)] },
  grid("3 × 3", 3, 3),
  grid("3 × 4", 4, 3),
  {
    name: "Stage",
    cols: 4,
    rows: 4,
    slots: [cell(0, 0, 3, 3), cell(3, 0), cell(3, 1), cell(3, 2), cell(0, 3), cell(1, 3), cell(2, 3), cell(3, 3)]
  },
  grid("4 × 4", 4, 4),
  { name: "Sidebar", cols: 4, rows: 3, slots: [cell(0, 0, 3, 3), cell(3, 0), cell(3, 1), cell(3, 2)] },
  { name: "2 + 4", cols: 4, rows: 2, slots: [cell(0, 0, 2, 2), cell(2, 0, 2, 1), cell(2, 1), cell(3, 1)] }
];

export const clampDim = (n: number) => Math.max(1, Math.min(MAX_DIM, Math.round(n)));

export function overlaps(a: Rect, b: Rect) {
  return a.col < b.col + b.colSpan && b.col < a.col + a.colSpan && a.row < b.row + b.rowSpan && b.row < a.row + a.rowSpan;
}

export function inBounds(r: Rect, cols: number, rows: number) {
  return r.col >= 0 && r.row >= 0 && r.colSpan >= 1 && r.rowSpan >= 1 && r.col + r.colSpan <= cols && r.row + r.rowSpan <= rows;
}

/** Cells no tile covers, in reading order. */
export function freeCells(tiles: Placed[], cols: number, rows: number): Rect[] {
  return uniformSlots(cols, rows).filter((c) => !tiles.some((t) => overlaps(t.rect, c)));
}

/** Gives tiles the preset's slots in order; returns null when there are more tiles than slots. */
export function applySlots<T extends Placed>(tiles: T[], slots: Rect[]): T[] | null {
  if (tiles.length > slots.length) return null;
  return tiles.map((t, i) => ({ ...t, rect: { ...slots[i] } }));
}

/**
 * Resizes one tile to `next` (anchored wherever `next` says). Tiles it now
 * covers move to free single cells in reading order. Returns null when the
 * new rectangle is out of bounds or the displaced tiles don't fit.
 */
export function resizeTile<T extends Placed>(tiles: T[], id: string, next: Rect, cols: number, rows: number): T[] | null {
  if (!inBounds(next, cols, rows)) return null;
  const target = tiles.find((t) => t.id === id);
  if (!target) return null;
  const displaced = tiles.filter((t) => t.id !== id && overlaps(t.rect, next));
  const staying = tiles.filter((t) => t.id !== id && !overlaps(t.rect, next));
  const free = freeCells([...staying, { id, rect: next }], cols, rows);
  if (free.length < displaced.length) return null;
  const moved = new Map(displaced.map((t, i) => [t.id, free[i]]));
  return tiles.map((t) => (t.id === id ? { ...t, rect: { ...next } } : moved.has(t.id) ? { ...t, rect: { ...moved.get(t.id)! } } : t));
}

/** Swaps two tiles' rectangles. */
export function swapTiles<T extends Placed>(tiles: T[], a: string, b: string): T[] {
  const ra = tiles.find((t) => t.id === a)?.rect;
  const rb = tiles.find((t) => t.id === b)?.rect;
  if (!ra || !rb) return tiles;
  return tiles.map((t) => (t.id === a ? { ...t, rect: { ...rb } } : t.id === b ? { ...t, rect: { ...ra } } : t));
}

/** Moves a tile to an empty cell, keeping its span when that fits there, else as a single cell. */
export function moveTile<T extends Placed>(tiles: T[], id: string, to: { col: number; row: number }, cols: number, rows: number): T[] | null {
  const t = tiles.find((x) => x.id === id);
  if (!t) return null;
  const others = tiles.filter((x) => x.id !== id);
  const spanned: Rect = { col: to.col, row: to.row, colSpan: t.rect.colSpan, rowSpan: t.rect.rowSpan };
  const single: Rect = { col: to.col, row: to.row, colSpan: 1, rowSpan: 1 };
  for (const r of [spanned, single]) {
    if (inBounds(r, cols, rows) && !others.some((o) => overlaps(o.rect, r))) {
      return tiles.map((x) => (x.id === id ? { ...x, rect: r } : x));
    }
  }
  return null;
}

/**
 * Drag-move: keep the tile's span with its top-left at `topLeft` (where the
 * grab offset puts it) if that fits, else drop it as one cell under the pointer.
 * Swapping with another tile is handled separately.
 */
export function dragMove<T extends Placed>(
  tiles: T[],
  id: string,
  topLeft: { col: number; row: number },
  pointer: { col: number; row: number },
  cols: number,
  rows: number
): T[] | null {
  const t = tiles.find((x) => x.id === id);
  if (!t) return null;
  const others = tiles.filter((x) => x.id !== id);
  const clamp = (v: number, span: number, max: number) => Math.max(0, Math.min(max - span, v));
  const spanned: Rect = {
    col: clamp(topLeft.col, t.rect.colSpan, cols),
    row: clamp(topLeft.row, t.rect.rowSpan, rows),
    colSpan: t.rect.colSpan,
    rowSpan: t.rect.rowSpan
  };
  const single: Rect = { col: pointer.col, row: pointer.row, colSpan: 1, rowSpan: 1 };
  for (const r of [spanned, single]) {
    if (inBounds(r, cols, rows) && !others.some((o) => overlaps(o.rect, r))) {
      return tiles.map((x) => (x.id === id ? { ...x, rect: r } : x));
    }
  }
  return null;
}

/**
 * Resize from any edge or corner: `handle` names the moving sides (n, s, e, w
 * or a corner like "nw"); the opposite sides stay put. Returns the new rect.
 */
export function rectFromHandle(rect: Rect, handle: string, pointer: { col: number; row: number }): Rect {
  let { col, row, colSpan, rowSpan } = rect;
  const right = rect.col + rect.colSpan - 1;
  const bottom = rect.row + rect.rowSpan - 1;
  if (handle.includes("e")) {
    col = Math.min(rect.col, pointer.col);
    colSpan = Math.abs(pointer.col - rect.col) + 1;
  } else if (handle.includes("w")) {
    col = Math.min(right, pointer.col);
    colSpan = Math.abs(right - pointer.col) + 1;
  }
  if (handle.includes("s")) {
    row = Math.min(rect.row, pointer.row);
    rowSpan = Math.abs(pointer.row - rect.row) + 1;
  } else if (handle.includes("n")) {
    row = Math.min(bottom, pointer.row);
    rowSpan = Math.abs(bottom - pointer.row) + 1;
  }
  return { col, row, colSpan, rowSpan };
}

/**
 * Changes the grid size. Tiles keep their place when they still fit; the rest
 * (clipped or pushed out) are re-placed as single cells. Null if they can't all fit.
 */
export function resizeGrid<T extends Placed>(tiles: T[], cols: number, rows: number): T[] | null {
  if (tiles.length > cols * rows) return null;
  const keep: T[] = [];
  const replace: T[] = [];
  for (const t of tiles) (inBounds(t.rect, cols, rows) && !keep.some((k) => overlaps(k.rect, t.rect)) ? keep : replace).push(t);
  const free = freeCells(keep, cols, rows);
  if (free.length < replace.length) return null;
  const moved = new Map(replace.map((t, i) => [t.id, free[i]]));
  return tiles.map((t) => (moved.has(t.id) ? { ...t, rect: { ...moved.get(t.id)! } } : t));
}

/** Picks a grid that fits `n` tiles, growing columns first (1×2, 2×2, 2×3, …, 4×4). */
export function gridFor(n: number): { cols: number; rows: number } {
  const steps = [
    [1, 1],
    [2, 1],
    [2, 2],
    [3, 2],
    [3, 3],
    [4, 3],
    [4, 4]
  ];
  for (const [cols, rows] of steps) if (cols * rows >= n) return { cols, rows };
  return { cols: MAX_DIM, rows: MAX_DIM };
}
