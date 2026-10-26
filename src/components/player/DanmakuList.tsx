import { useEffect, useRef, useState } from "react";
import type { ChatLine } from "../../hooks/useDanmaku";

/** Chat column. Auto-scrolls unless the user has scrolled up to read. */
export function DanmakuList({ lines, active }: { lines: ChatLine[]; active: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [lines, pinned]);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg bg-panel-2">
      <h3 className="border-b border-line px-4 py-2.5 text-xs font-bold text-text-3">弹幕</h3>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 text-[13px] leading-relaxed select-text"
      >
        {lines.length === 0 && (
          <p className="pt-8 text-center text-xs text-text-3">{active ? "等待弹幕…" : "弹幕已关闭"}</p>
        )}
        {lines.map((l) => (
          <p key={l.id} className="break-words">
            {l.user_level > 0 && (
              <span className="mr-1 rounded bg-panel-3 px-1 text-[10px] font-bold text-text-3">{l.user_level}</span>
            )}
            <span className="font-bold text-text-3">{l.user}：</span>
            <span>{l.content}</span>
          </p>
        ))}
      </div>
      {!pinned && (
        <button
          onClick={() => setPinned(true)}
          className="border-t border-line py-1.5 text-xs font-bold text-accent"
        >
          回到最新
        </button>
      )}
    </aside>
  );
}
