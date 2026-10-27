"use client";

// Command palette (Nib: Desktop 26–27). ⌘⇧P anywhere. Lists the commands the
// mounted parts of the app registered (services/commands), current room first.
// Typing filters; commands with a submenu open a second level; ⌫ on an empty
// query goes back; ⌘K hands over to search.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import { Activity, Check, ChevronRight, Circle, Languages, SquareTerminal } from "lucide-react";

import { getLocale, setLocale, useT } from "@/i18n";
import { filterCommands, getCommands, matchesBinding, useCommands, useRegisterCommands, type Command, type SubmenuItem } from "@/services/commands";
import { togglePlaybackMonitor } from "@/services/playbackMetrics/monitor";

type Row = { kind: "command"; command: Command } | { kind: "item"; item: SubmenuItem };

let paletteOpen = false;
const openListeners = new Set<(open: boolean, submenu?: string) => void>();

/** Opens the palette, optionally straight into a command's submenu. */
export function openCommandPalette(submenuOf?: string) {
  paletteOpen = true;
  openListeners.forEach((l) => l(true, submenuOf));
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** App-level home: ⌘⇧P, the commands' own shortcuts, and the app commands it owns. */
export function CommandPaletteHost() {
  const { t, locale } = useT();
  const [state, setState] = useState<{ open: boolean; submenu?: string }>({ open: false });

  useEffect(() => {
    const l = (open: boolean, submenu?: string) => setState({ open, submenu });
    openListeners.add(l);
    return () => {
      openListeners.delete(l);
    };
  }, []);

  const close = () => {
    paletteOpen = false;
    setState({ open: false });
  };

  // App commands owned here. Shortcuts that other listeners own are shown, not bound.
  const appCommands = useMemo<Command[]>(
    () => [
      { id: "app.monitor", group: "app", order: 0, title: t("cmd.monitor"), hint: t("cmd.monitor.hint"), icon: Activity, keys: ["⌘", "⇧", "M"], keywords: ["monitor", "metrics", "监控"], run: togglePlaybackMonitor },
      { id: "app.language", group: "app", order: 90, title: t("cmd.language"), hint: t("cmd.language.hint"), icon: Languages, keywords: ["language", "语言", "english", "中文"], run: () => setLocale(getLocale() === "en" ? "zh-CN" : "en") }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale]
  );
  useRegisterCommands("app", appCommands);

  // Capture phase so it runs before page-level handlers; text fields keep their keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyP") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (paletteOpen) {
          paletteOpen = false;
          setState({ open: false });
        } else openCommandPalette();
        return;
      }
      if (paletteOpen || isTyping(e.target)) return;
      const cmd = getCommands().find((c) => c.bind && matchesBinding(e, c.bind));
      if (!cmd) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (cmd.submenu) openCommandPalette(cmd.id);
      else cmd.run?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(<AnimatePresence>{state.open ? <Palette key="palette" initialSubmenu={state.submenu} onClose={close} /> : null}</AnimatePresence>, document.body);
}

function Palette({ initialSubmenu, onClose }: { initialSubmenu?: string; onClose: () => void }) {
  const { t } = useT();
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [submenuId, setSubmenuId] = useState<string | undefined>(initialSubmenu);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const parent = submenuId ? commands.find((c) => c.id === submenuId) : undefined;
  const rows: Row[] = useMemo(() => {
    if (parent?.submenu) return filterCommands(parent.submenu(), query).map((item) => ({ kind: "item" as const, item }));
    return filterCommands(commands, query).map((command) => ({ kind: "command" as const, command }));
  }, [commands, parent, query]);

  useEffect(() => setActive(0), [query, submenuId]);
  useEffect(() => inputRef.current?.focus(), [submenuId]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "item") {
      onClose();
      row.item.run();
      return;
    }
    if (row.command.submenu) {
      setSubmenuId(row.command.id);
      setQuery("");
      return;
    }
    onClose();
    row.command.run?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[active]);
    } else if (e.key === "Backspace" && !query && submenuId) {
      e.preventDefault();
      setSubmenuId(undefined);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      getCommands().find((c) => c.id === "app.search")?.run?.();
    }
  };

  // Esc: back out of a submenu, else close. Capture + stopImmediatePropagation keeps it from
  // reaching split view's Esc chain or macOS full-screen exit.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (submenuId && !initialSubmenu) setSubmenuId(undefined);
      else onClose();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [initialSubmenu, onClose, submenuId]);

  // Group headings in command mode.
  let lastGroup: string | null = null;
  const groupLabel = (c: Command) => commands.find((x) => x.group === c.group && x.groupLabel)?.groupLabel ?? t(`palette.group.${c.group}` as "palette.group.app");

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-[730] flex justify-center bg-scrim pt-[12vh] font-sans"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <m.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        role="dialog"
        aria-label={t("palette.placeholder")}
        className="flex h-fit max-h-[70vh] w-[720px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[20px] border border-line-strong bg-elevated text-fg shadow-pop backdrop-blur-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4">
          <SquareTerminal size={20} className="shrink-0 text-accent" />
          {parent ? (
            <button type="button" onClick={() => setSubmenuId(undefined)} className="flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2 py-[3px] text-xs font-semibold text-accent">
              {parent.title.replace(/…$/, "")}
              <ChevronRight size={12} />
            </button>
          ) : null}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={parent ? "" : t("palette.placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[17px] font-medium text-fg outline-none placeholder:text-fg-3"
            spellCheck={false}
            autoCorrect="off"
          />
          <Kbd>ESC</Kbd>
        </div>
        <div className="h-px bg-line" />
        <div ref={listRef} className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2">
          {rows.length === 0 ? <div className="px-3 py-6 text-center text-sm text-fg-3">{t("palette.empty")}</div> : null}
          {rows.map((row, i) => {
            const on = i === active;
            if (row.kind === "item") {
              return (
                <RowShell key={row.item.id} index={i} on={on} onHover={() => setActive(i)} onClick={() => run(row)}>
                  <IconBox on={on}>{row.item.current ? <Check size={15} /> : <Circle size={15} />}</IconBox>
                  <RowText title={row.item.title} hint={row.item.current ? t("palette.current") : row.item.hint} />
                </RowShell>
              );
            }
            const c = row.command;
            const heading = !query && c.group !== lastGroup ? groupLabel(c) : null;
            lastGroup = c.group;
            const Icon = c.icon;
            return (
              <React.Fragment key={c.id}>
                {heading ? <div className="px-2.5 pt-2.5 pb-1 text-[11px] font-bold tracking-[0.04em] text-fg-3">{heading}</div> : null}
                <RowShell index={i} on={on} onHover={() => setActive(i)} onClick={() => run(row)}>
                  <IconBox on={on}>
                    <Icon size={15} />
                  </IconBox>
                  <RowText title={c.title} hint={c.hint} />
                  {c.keys ? (
                    <span className="flex shrink-0 gap-1">
                      {c.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  ) : null}
                </RowShell>
              </React.Fragment>
            );
          })}
        </div>
        <div className="h-px bg-line" />
        <div className="flex items-center gap-4 px-5 py-2.5 text-[11px] font-medium text-fg-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd>
            {t("palette.key.select")}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            {parent ? t("palette.key.choose") : t("palette.key.run")}
          </span>
          {parent ? (
            <span className="flex items-center gap-1.5">
              <Kbd>⌫</Kbd>
              {t("palette.key.back")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Kbd>⌘K</Kbd>
              {t("palette.key.search")}
            </span>
          )}
        </div>
      </m.div>
    </m.div>
  );
}

function RowShell({ index, on, onHover, onClick, children }: { index: number; on: boolean; onHover: () => void; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-row={index}
      onMouseMove={onHover}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left ${on ? "bg-selected" : ""}`}
    >
      {children}
    </button>
  );
}

function IconBox({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <span className={`grid size-[30px] shrink-0 place-items-center rounded-lg ${on ? "bg-accent-soft text-accent" : "bg-chip text-fg-2"}`}>{children}</span>;
}

function RowText({ title, hint }: { title: string; hint?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[13px] font-semibold">{title}</span>
      {hint ? <span className="truncate text-[11px] text-fg-3">{hint}</span> : null}
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md border border-line-strong bg-chip px-1.5 py-px font-sans text-[10px] font-bold text-fg-3">{children}</span>;
}
