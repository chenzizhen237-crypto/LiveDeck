"use client";

// App-level home of the Playback monitor: ⌘⇧M toggles it from anywhere
// (single room or split), and Esc closes it without reaching anything below.

import React, { useEffect } from "react";
import { AnimatePresence } from "framer-motion";

import { closePlaybackMonitor, togglePlaybackMonitor, usePlaybackMonitorOpen } from "@/services/playbackMetrics/monitor";

import { PlaybackMonitor } from "./PlaybackMonitor";

export function PlaybackMonitorHost() {
  const open = usePlaybackMonitorOpen();
  const openRef = React.useRef(open);
  openRef.current = open;

  // Registered once at app start, in the capture phase, so it runs before the
  // split view's Esc chain; stopImmediatePropagation keeps that chain (and
  // macOS full-screen exit) from also handling an Esc that closed the monitor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePlaybackMonitor();
      } else if (e.key === "Escape" && openRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePlaybackMonitor();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return <AnimatePresence>{open ? <PlaybackMonitor key="playback-monitor" onClose={closePlaybackMonitor} /> : null}</AnimatePresence>;
}
