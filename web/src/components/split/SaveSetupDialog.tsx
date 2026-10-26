import React, { useEffect, useRef, useState } from "react";
import { m } from "framer-motion";
import { Check } from "lucide-react";

import { PlatformMark } from "@/components/livedeck/primitives";
import { useSplit } from "@/state/split/SplitProvider";

/** Save current setup (Nib: Desktop 20). `initialName` prefills "Save as new". */
export function SaveSetupDialog({ initialName, onClose, onSaved }: { initialName: string; onClose: () => void; onSaved: (name: string) => void }) {
  const split = useSplit();
  const [name, setName] = useState(initialName);
  const [layoutOnly, setLayoutOnly] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const focused = split.tiles.find((t) => t.id === split.focusId);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const save = () => {
    const setup = split.saveSetup(name, layoutOnly);
    onSaved(setup.name);
    onClose();
  };

  const row = (k: string, v: React.ReactNode) => (
    <div className="flex items-center text-[11px]">
      <span className="font-medium text-fg-3">{k}</span>
      <span className="flex-1" />
      <span className="flex items-center gap-1 font-semibold text-fg-2">{v}</span>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[700] grid place-items-center bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault(); // unhandled Esc exits macOS full screen
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <m.form
        initial={{ opacity: 0, scale: 0.97, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex w-[380px] flex-col gap-3.5 rounded-[18px] border border-line-strong bg-elevated p-5 text-fg shadow-pop"
      >
        <h2 className="text-[15px] font-bold">保存当前方案</h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-fg-3">名称</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-[10px] bg-chip px-3 py-2 text-[13px] font-semibold text-fg outline-none ring-1 ring-line-strong focus:ring-focus"
            placeholder="例如：晚间直播"
          />
        </label>

        <div className="flex flex-col gap-1 rounded-xl bg-white/[0.04] p-3">
          {row("直播间", layoutOnly ? "不保存" : `${split.tiles.length} 个`)}
          {row("网格", `${split.rows} × ${split.cols} · ${split.layoutName}`)}
          {!layoutOnly && focused
            ? row(
                "声音",
                <>
                  <PlatformMark platform={focused.room.platform} size={12} />
                  {focused.room.anchorName || focused.room.roomId}
                </>
              )
            : null}
          {row("弹幕", split.danmakuAll ? "所有画面" : "有声画面")}
        </div>

        <button type="button" onClick={() => setLayoutOnly((v) => !v)} className="flex items-start gap-2.5 text-left">
          <span
            className={`mt-px grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] ${layoutOnly ? "border-accent bg-accent text-on-accent" : "border-line-strong"}`}
          >
            {layoutOnly ? <Check size={11} strokeWidth={3} /> : null}
          </span>
          <span>
            <span className="block text-xs font-semibold">仅保存布局</span>
            <span className="block text-[11px] text-fg-3">不含直播间，可套用到其他房间</span>
          </span>
        </button>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-[10px] bg-chip px-3.5 py-[7px] text-xs font-bold hover:bg-hover">
            取消
          </button>
          <button type="submit" className="rounded-[10px] bg-accent px-3.5 py-[7px] text-xs font-bold text-on-accent">
            保存
          </button>
        </div>
      </m.form>
    </div>
  );
}
