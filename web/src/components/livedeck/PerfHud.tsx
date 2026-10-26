"use client";

// Performance HUD (⌘⇧P). Measures frame pacing inside the real WebView so
// danmaku/player changes can be judged in a live room, not just in a harness.
// Also switches the danmaku engine for A/B (takes effect when a room reopens).

import React, { useEffect, useRef, useState } from "react";

type Stats = { fps: number; p95: number; jank30s: number; worst30s: number; bullets: number };

const ENGINE_KEY = "ld_danmu_engine";

export function PerfHud() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [engine, setEngine] = useState<"new" | "legacy">("new");
  const frames = useRef<{ t: number; dt: number }[]>([]);

  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem("ld_perf_hud") === "1");
      setEngine(window.localStorage.getItem(ENGINE_KEY) === "legacy" ? "legacy" : "new");
    } catch {
      // ignore
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setOpen((v) => {
          const next = !v;
          try {
            window.localStorage.setItem("ld_perf_hud", next ? "1" : "0");
          } catch {
            // ignore
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (last) frames.current.push({ t, dt: t - last });
      last = t;
      // keep 30s of history
      while (frames.current.length && t - frames.current[0].t > 30_000) frames.current.shift();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const timer = window.setInterval(() => {
      const now = performance.now();
      const all = frames.current;
      const last1 = all.filter((f) => now - f.t <= 1000);
      const last5 = all.filter((f) => now - f.t <= 5000).map((f) => f.dt).sort((a, b) => a - b);
      setStats({
        fps: last1.length,
        p95: last5.length ? Math.round(last5[Math.floor(last5.length * 0.95)] * 10) / 10 : 0,
        jank30s: all.filter((f) => f.dt > 33.4).length,
        worst30s: Math.round(Math.max(0, ...all.map((f) => f.dt))),
        bullets: document.querySelectorAll(".ld-danmu, .player-danmu-overlay .danmu > div").length
      });
    }, 1000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      frames.current = [];
    };
  }, [open]);

  if (!open) return null;

  const toggleEngine = () => {
    const next = engine === "new" ? "legacy" : "new";
    try {
      window.localStorage.setItem(ENGINE_KEY, next);
    } catch {
      // ignore
    }
    setEngine(next);
  };

  return (
    <div className="pointer-events-auto fixed bottom-3 left-3 z-[900] w-[220px] rounded-xl border border-white/15 bg-black/75 p-3 font-mono text-[11px] leading-5 text-white backdrop-blur">
      <div className="mb-1 flex items-center justify-between font-sans text-xs font-bold">
        <span>Perf</span>
        <span className="text-white/50">⌘⇧P</span>
      </div>
      {stats ? (
        <>
          <Row label="fps (1s)" value={stats.fps} bad={stats.fps < 50} />
          <Row label="p95 frame (5s)" value={`${stats.p95} ms`} bad={stats.p95 > 25} />
          <Row label="janks >33ms (30s)" value={stats.jank30s} bad={stats.jank30s > 5} />
          <Row label="worst frame (30s)" value={`${stats.worst30s} ms`} bad={stats.worst30s > 100} />
          <Row label="danmaku on screen" value={stats.bullets} />
        </>
      ) : (
        <p>measuring…</p>
      )}
      <button
        type="button"
        onClick={toggleEngine}
        className="mt-2 w-full rounded-md bg-white/15 px-2 py-1 font-sans text-[11px] font-semibold hover:bg-white/25"
      >
        Danmaku engine: {engine === "new" ? "new" : "danmu.js (legacy)"} — switch
      </button>
      <p className="mt-1 font-sans text-[10px] text-white/50">Reopen the room after switching.</p>
    </div>
  );
}

function Row({ label, value, bad }: { label: string; value: React.ReactNode; bad?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-white/60">{label}</span>
      <span className={bad ? "text-[#ff5c72]" : "text-[#4ade80]"}>{value}</span>
    </div>
  );
}
