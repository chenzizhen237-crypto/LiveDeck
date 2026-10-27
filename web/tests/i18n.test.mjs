// Dictionaries stay in step: same keys, same {placeholders}.
// Runs on Node 24 with no test deps: `node --test tests/`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { zhCN } from "../src/i18n/zh-CN.ts";
import { en } from "../src/i18n/en.ts";

const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("English has exactly the Chinese keys", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
});

test("every translation uses the same placeholders", () => {
  for (const k of Object.keys(zhCN)) {
    assert.deepEqual(vars(en[k]), vars(zhCN[k]), `placeholders differ for ${k}`);
  }
});

test("no empty strings", () => {
  for (const [k, v] of [...Object.entries(zhCN), ...Object.entries(en)]) assert.ok(v.trim().length > 0, k);
});
