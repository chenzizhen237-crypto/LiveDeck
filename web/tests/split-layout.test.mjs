// Split-view grid logic. Runs on Node 24 with no test deps: `node --test tests/`
// (Node strips the TypeScript types from layout.ts itself).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESETS,
  applySlots,
  dragMove,
  freeCells,
  gridFor,
  moveTile,
  overlaps,
  rectFromHandle,
  resizeGrid,
  resizeTile,
  swapTiles
} from "../src/state/split/layout.ts";

const t = (id, col, row, colSpan = 1, rowSpan = 1) => ({ id, rect: { col, row, colSpan, rowSpan } });
const rectOf = (tiles, id) => tiles.find((x) => x.id === id).rect;

test("every preset tiles its grid exactly once", () => {
  for (const p of PRESETS) {
    const covered = new Array(p.cols * p.rows).fill(0);
    for (const s of p.slots) {
      for (let r = s.row; r < s.row + s.rowSpan; r++) for (let c = s.col; c < s.col + s.colSpan; c++) covered[r * p.cols + c]++;
    }
    assert.ok(covered.every((n) => n === 1), `${p.name} leaves a gap or overlaps`);
  }
});

test("applySlots fills slots in order and refuses too many tiles", () => {
  const stage = PRESETS.find((p) => p.name === "Stage");
  const placed = applySlots([t("a", 0, 0), t("b", 0, 0)], stage.slots);
  assert.deepEqual(rectOf(placed, "a"), { col: 0, row: 0, colSpan: 3, rowSpan: 3 });
  assert.deepEqual(rectOf(placed, "b"), { col: 3, row: 0, colSpan: 1, rowSpan: 1 });
  assert.equal(applySlots([t("a", 0, 0), t("b", 0, 0), t("c", 0, 0)], PRESETS[1].slots), null);
});

test("spanning a tile pushes covered tiles into free cells", () => {
  // 2×2 grid: a b / c _ ; grow a to 2×1 → b must move to the free cell.
  const tiles = [t("a", 0, 0), t("b", 1, 0), t("c", 0, 1)];
  const next = resizeTile(tiles, "a", { col: 0, row: 0, colSpan: 2, rowSpan: 1 }, 2, 2);
  assert.deepEqual(rectOf(next, "a"), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
  assert.deepEqual(rectOf(next, "b"), { col: 1, row: 1, colSpan: 1, rowSpan: 1 });
  assert.deepEqual(rectOf(next, "c"), { col: 0, row: 1, colSpan: 1, rowSpan: 1 });
  assert.equal(freeCells(next, 2, 2).length, 0);
});

test("a span that leaves no room for the tiles it covers is refused", () => {
  const tiles = [t("a", 0, 0), t("b", 1, 0), t("c", 0, 1), t("d", 1, 1)];
  assert.equal(resizeTile(tiles, "a", { col: 0, row: 0, colSpan: 2, rowSpan: 1 }, 2, 2), null);
  assert.equal(resizeTile(tiles, "a", { col: 0, row: 0, colSpan: 3, rowSpan: 1 }, 2, 2), null, "out of bounds");
});

test("shrinking a span frees cells", () => {
  const tiles = [t("a", 0, 0, 2, 2)];
  const next = resizeTile(tiles, "a", { col: 0, row: 0, colSpan: 1, rowSpan: 1 }, 2, 2);
  assert.equal(freeCells(next, 2, 2).length, 3);
});

test("swap exchanges rectangles, spans included", () => {
  const next = swapTiles([t("a", 0, 0, 2, 2), t("b", 2, 0)], "a", "b");
  assert.deepEqual(rectOf(next, "a"), { col: 2, row: 0, colSpan: 1, rowSpan: 1 });
  assert.deepEqual(rectOf(next, "b"), { col: 0, row: 0, colSpan: 2, rowSpan: 2 });
});

test("move keeps the span when it fits, else drops to one cell", () => {
  const tiles = [t("a", 0, 0, 2, 1), t("b", 0, 1)];
  assert.deepEqual(rectOf(moveTile(tiles, "a", { col: 1, row: 2 }, 3, 3), "a"), { col: 1, row: 2, colSpan: 2, rowSpan: 1 });
  assert.deepEqual(rectOf(moveTile(tiles, "a", { col: 2, row: 1 }, 3, 3), "a"), { col: 2, row: 1, colSpan: 1, rowSpan: 1 });
  assert.equal(moveTile(tiles, "a", { col: 0, row: 1 }, 3, 3), null, "occupied");
});

test("shrinking the grid re-places tiles that no longer fit", () => {
  const tiles = [t("a", 0, 0), t("b", 3, 3), t("c", 2, 0, 2, 1)];
  const next = resizeGrid(tiles, 2, 2);
  assert.equal(next.length, 3);
  for (const x of next) assert.ok(x.rect.col + x.rect.colSpan <= 2 && x.rect.row + x.rect.rowSpan <= 2);
  for (let i = 0; i < next.length; i++) for (let j = i + 1; j < next.length; j++) assert.ok(!overlaps(next[i].rect, next[j].rect));
  assert.equal(resizeGrid([t("a", 0, 0), t("b", 1, 0)], 1, 1), null);
});

test("gridFor grows columns first and caps at 4×4", () => {
  assert.deepEqual(gridFor(1), { cols: 1, rows: 1 });
  assert.deepEqual(gridFor(2), { cols: 2, rows: 1 });
  assert.deepEqual(gridFor(5), { cols: 3, rows: 2 });
  assert.deepEqual(gridFor(12), { cols: 4, rows: 3 });
  assert.deepEqual(gridFor(40), { cols: 4, rows: 4 });
});

test("drag-move keeps the span at the grab offset, else lands as one cell", () => {
  const tiles = [t("a", 0, 0, 2, 2), t("b", 3, 3)];
  // 4×4: drop a 2×2 with its top-left at (2,0) → fits.
  assert.deepEqual(rectOf(dragMove(tiles, "a", { col: 2, row: 0 }, { col: 2, row: 0 }, 4, 4), "a"), { col: 2, row: 0, colSpan: 2, rowSpan: 2 });
  // Top-left past the edge is clamped back inside.
  assert.deepEqual(rectOf(dragMove(tiles, "a", { col: 3, row: 0 }, { col: 3, row: 0 }, 4, 4), "a"), { col: 2, row: 0, colSpan: 2, rowSpan: 2 });
  // 2×2 at (2,2) would cover b → falls back to one cell at the pointer.
  assert.deepEqual(rectOf(dragMove(tiles, "a", { col: 2, row: 2 }, { col: 2, row: 2 }, 4, 4), "a"), { col: 2, row: 2, colSpan: 1, rowSpan: 1 });
  assert.equal(dragMove(tiles, "a", { col: 3, row: 3 }, { col: 3, row: 3 }, 4, 4), null, "pointer on another tile");
});

test("resize handles move only their own sides", () => {
  const r = { col: 1, row: 1, colSpan: 1, rowSpan: 1 };
  assert.deepEqual(rectFromHandle(r, "se", { col: 2, row: 2 }), { col: 1, row: 1, colSpan: 2, rowSpan: 2 });
  assert.deepEqual(rectFromHandle(r, "nw", { col: 0, row: 0 }), { col: 0, row: 0, colSpan: 2, rowSpan: 2 });
  assert.deepEqual(rectFromHandle(r, "n", { col: 3, row: 0 }), { col: 1, row: 0, colSpan: 1, rowSpan: 2 }, "edge ignores the other axis");
  assert.deepEqual(rectFromHandle(r, "w", { col: 0, row: 3 }), { col: 0, row: 1, colSpan: 2, rowSpan: 1 });
  // Dragging the left edge past the right one flips instead of going negative.
  assert.deepEqual(rectFromHandle({ col: 1, row: 0, colSpan: 2, rowSpan: 1 }, "w", { col: 3, row: 0 }), { col: 2, row: 0, colSpan: 2, rowSpan: 1 });
});
