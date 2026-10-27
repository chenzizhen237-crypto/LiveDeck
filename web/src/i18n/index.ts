// Minimal i18n: a locale store (system language by default, overridable and
// persisted), flat dictionaries with {var} interpolation, and Msg objects
// ({ key, vars }) so pure modules can describe text without knowing the locale.
// The English dictionary is typed against the Chinese one, so a missing key is
// a compile error.

import { useCallback, useSyncExternalStore } from "react";

import { en } from "./en";
import { zhCN, type Dict } from "./zh-CN";

export type Locale = "zh-CN" | "en";
export type MsgKey = keyof Dict;

export interface Msg {
  key: string;
  vars?: Record<string, string | number | Msg | Msg[]>;
}

const DICTS: Record<Locale, Dict> = { "zh-CN": zhCN, en };
const STORAGE_KEY = "ld_locale";
/** Joins Msg[] values: "缓冲 1.2 秒，卡顿 1.0 秒" / "buffer 1.2 s, stall 1.0 s" */
const LIST_SEP: Record<Locale, string> = { "zh-CN": "，", en: ", " };

function detect(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    // ignore
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "zh-CN";
  return /^zh/i.test(nav) ? "zh-CN" : "en";
}

let locale: Locale = typeof window !== "undefined" ? detect() : "zh-CN";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale) {
  locale = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach((l) => l());
}

export function translate(loc: Locale, key: string, vars?: Msg["vars"]): string {
  const dict = DICTS[loc] as Record<string, string>;
  const template = dict[key] ?? (DICTS["zh-CN"] as Record<string, string>)[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) return `{${name}}`;
    if (Array.isArray(v)) return v.map((m) => translate(loc, m.key, m.vars)).join(LIST_SEP[loc]);
    if (typeof v === "object") return translate(loc, v.key, v.vars);
    return String(v);
  });
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => locale,
    () => "zh-CN"
  );
}

/** `t("key", vars)` for UI strings, `tm(msg)` / `tm(msgs)` for model messages. */
export function useT() {
  const loc = useLocale();
  const t = useCallback((key: MsgKey, vars?: Msg["vars"]) => translate(loc, key, vars), [loc]);
  const tm = useCallback(
    (m: Msg | Msg[]) => (Array.isArray(m) ? m.map((x) => translate(loc, x.key, x.vars)).join(LIST_SEP[loc]) : translate(loc, m.key, m.vars)),
    [loc]
  );
  return { t, tm, locale: loc };
}
