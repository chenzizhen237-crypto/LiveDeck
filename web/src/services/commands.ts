// Command registry for the palette (⌘⇧P). Each part of the app registers the
// actions it owns while it's mounted (useRegisterCommands); the palette only
// lists and runs them, so no action logic moves out of its component.

import type React from "react";
import { useEffect, useSyncExternalStore } from "react";

import type { KeyBinding } from "./commandMatch";

export type { KeyBinding } from "./commandMatch";

export type CommandGroup = "room" | "split" | "app";

export interface SubmenuItem {
  id: string;
  title: string;
  hint?: string;
  current?: boolean;
  run: () => void;
}

export interface Command {
  id: string;
  group: CommandGroup;
  /** heading for the group in the palette, e.g. "当前直播间 · 张大仙" (first command's wins) */
  groupLabel?: string;
  title: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  /** shortcut shown on the row */
  keys?: string[];
  /** shortcut the palette host binds globally (outside text fields). Omit when another listener already owns it. */
  bind?: KeyBinding;
  keywords?: string[];
  /** position within its group (lower first); registration order breaks ties */
  order?: number;
  run?: () => void;
  /** a second level (quality, line…): the palette opens it instead of running */
  submenu?: () => SubmenuItem[];
}

const sources = new Map<string, Command[]>();
const listeners = new Set<() => void>();
let snapshot: Command[] = [];
const ORDER: Record<CommandGroup, number> = { room: 0, split: 1, app: 2 };

function publish() {
  snapshot = [...sources.values()].flat().sort((a, b) => ORDER[a.group] - ORDER[b.group] || (a.order ?? 50) - (b.order ?? 50));
  listeners.forEach((l) => l());
}

export function setCommands(source: string, commands: Command[] | null) {
  if (commands && commands.length) sources.set(source, commands);
  else sources.delete(source);
  publish();
}

/** Registers `commands` under `source` while the caller is mounted. Pass a memoized array. */
export function useRegisterCommands(source: string, commands: Command[]) {
  useEffect(() => {
    setCommands(source, commands);
    return () => setCommands(source, null);
  }, [source, commands]);
}

export function getCommands(): Command[] {
  return snapshot;
}

export function useCommands(): Command[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot,
    () => snapshot
  );
}

export { filterCommands, matchesBinding } from "./commandMatch";
