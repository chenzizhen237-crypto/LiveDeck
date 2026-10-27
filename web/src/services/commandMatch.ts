// Pure helpers for the command palette (no React), so Node tests can import them.

export interface KeyBinding {
  /** KeyboardEvent.code, e.g. "KeyD", "Digit1", "Backslash" */
  code: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Case-insensitive match on title, hint and keywords; prefix matches first. */
export function filterCommands<T extends { title: string; hint?: string; keywords?: string[] }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const title = item.title.toLowerCase();
    const hay = [item.hint ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
    const score = title.startsWith(q) ? 0 : title.includes(q) ? 1 : hay.includes(q) ? 2 : -1;
    if (score >= 0) scored.push({ item, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.item);
}

/** True when a key event matches a binding (exact modifiers; ⌘ or Ctrl count as "meta"). */
export function matchesBinding(e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, b: KeyBinding): boolean {
  return e.code === b.code && (e.metaKey || e.ctrlKey) === !!b.meta && e.shiftKey === !!b.shift && e.altKey === !!b.alt;
}
