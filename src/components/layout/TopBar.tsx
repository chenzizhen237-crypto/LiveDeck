import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Moon, Search, Sun, SunMoon } from "lucide-react";
import { useNowPlaying } from "../../stores/nowPlaying";
import { useSettings, type Theme } from "../../stores/settings";
import { platformInfo } from "../../lib/platforms";
import { Avatar } from "../ui/Avatar";

const NEXT_THEME: Record<Theme, Theme> = { system: "dark", dark: "light", light: "system" };

export function TopBar() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const { theme, setTheme } = useSettings();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-2 px-4" data-tauri-drag-region>
      <div className="flex gap-1">
        <IconButton label="后退" onClick={() => navigate(-1)}>
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton label="前进" onClick={() => navigate(1)}>
          <ChevronRight size={18} />
        </IconButton>
      </div>

      <form onSubmit={submit} className="relative w-72 max-w-[40%]">
        <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-3" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索主播、房间号"
          className="h-9 w-full rounded-full bg-panel-2 pr-3 pl-9 text-sm outline-none placeholder:text-text-3 focus:ring-2 focus:ring-accent/60"
        />
      </form>

      <NowPlayingIsland />

      <div className="ml-auto">
        <IconButton label={`主题：${theme}`} onClick={() => setTheme(NEXT_THEME[theme])}>
          <ThemeIcon size={18} />
        </IconButton>
      </div>
    </header>
  );
}

/** Compact capsule for the open room; hidden while you're on that room's page. */
function NowPlayingIsland() {
  const current = useNowPlaying((s) => s.current);
  const location = useLocation();
  const navigate = useNavigate();
  if (!current) return null;
  const path = `/room/${current.platform}/${current.roomId}`;
  const onRoomPage = location.pathname === path;

  return (
    <button
      onClick={() => navigate(path)}
      className={clsx(
        "absolute left-1/2 flex max-w-xs -translate-x-1/2 items-center gap-2 rounded-full bg-black/80 py-1 pr-4 pl-1 text-white shadow-lg transition-all duration-300",
        onRoomPage ? "pointer-events-none -translate-y-3 opacity-0" : "opacity-100",
      )}
      title="回到直播间"
    >
      <Avatar src={current.avatar} name={current.name} size={26} />
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-live" />
      <span className="truncate text-xs font-bold">{current.name}</span>
      <span className="shrink-0 text-xs text-white/60">{platformInfo(current.platform).name}</span>
    </button>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-full bg-panel-2 text-text-2 hover:text-text"
    >
      {children}
    </button>
  );
}
