// Command palette matching. Runs on Node 24 with no test deps: `node --test tests/`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { filterCommands, matchesBinding } from "../src/services/commandMatch.ts";

const items = [
  { title: "打开播放监控", hint: "播放是否流畅", keywords: ["monitor", "metrics"] },
  { title: "画质…", hint: "当前：原画", keywords: ["quality"] },
  { title: "分屏画质策略", hint: "3 路以上自动用高清" },
  { title: "Search rooms", keywords: ["find"] },
];

test("empty query keeps registration order", () => {
  assert.deepEqual(filterCommands(items, "  "), items);
});

test("prefix matches rank before substring and keyword matches", () => {
  const r = filterCommands(items, "画质").map((c) => c.title);
  assert.deepEqual(r, ["画质…", "分屏画质策略"]);
});

test("keywords and case-insensitive English work", () => {
  assert.deepEqual(filterCommands(items, "MONITOR").map((c) => c.title), ["打开播放监控"]);
  assert.deepEqual(filterCommands(items, "search").map((c) => c.title), ["Search rooms"]);
  assert.equal(filterCommands(items, "zzz").length, 0);
});

test("bindings need exact modifiers; Ctrl counts as ⌘", () => {
  const ev = (code, m = {}) => ({ code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
  assert.ok(matchesBinding(ev("KeyD"), { code: "KeyD" }));
  assert.ok(!matchesBinding(ev("KeyD", { metaKey: true }), { code: "KeyD" }), "⌘D must not trigger plain D");
  assert.ok(matchesBinding(ev("KeyP", { metaKey: true, altKey: true }), { code: "KeyP", meta: true, alt: true }));
  assert.ok(matchesBinding(ev("Digit1", { ctrlKey: true }), { code: "Digit1", meta: true }));
  assert.ok(!matchesBinding(ev("KeyP", { metaKey: true, shiftKey: true }), { code: "KeyP", meta: true, alt: true }));
});
