import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import clsx from "clsx";
import { PanelLeftClose, PanelLeftOpen, RefreshCw, Heart } from "lucide-react";
import { PLATFORMS } from "../../lib/platforms";
import { followKey, useFollows, type FollowedStreamer } from "../../stores/follows";
import { useSettings } from "../../stores/settings";
import { Avatar } from "../ui/Avatar";

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const toggle = useSettings((s) => s.toggleSidebar);

  return (
    <aside
      className={clsx(
        "flex shrink-0 flex-col gap-2 transition-[width] duration-200",
        collapsed ? "w-[68px]" : "w-64",
      )}
    >
      {/* Top block: leaves room for the macOS traffic lights and doubles as a drag area. */}
      <nav className="rounded-xl bg-panel px-2 pb-2 pt-11" data-tauri-drag-region>
        <div className={clsx("mb-2 flex items-center px-2", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && <span className="text-lg font-bold tracking-tight">LiveDeck</span>}
          <button
            onClick={toggle}
            className="rounded-md p-1.5 text-text-3 hover:bg-panel-2 hover:text-text"
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        {PLATFORMS.map((p) => (
          <NavLink
            key={p.id}
            to={`/browse/${p.id}`}
            title={p.name}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-bold transition-colors",
                collapsed && "justify-center",
                isActive ? "bg-panel-3 text-text" : "text-text-2 hover:text-text",
              )
            }
          >
            <img src={p.icon} alt="" className="size-6 rounded-md" />
            {!collapsed && p.name}
          </NavLink>
        ))}
      </nav>

      <FollowList collapsed={collapsed} />
    </aside>
  );
}

function FollowList({ collapsed }: { collapsed: boolean }) {
  const { order, byKey, refreshing, refresh, reorder } = useFollows();
  const navigate = useNavigate();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const liveCount = order.filter((k) => byKey[k]?.status === "live").length;

  // Refresh once on launch, after the first screen has had a moment to load.
  useEffect(() => {
    const t = setTimeout(() => void useFollows.getState().refresh(), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl bg-panel">
      <header className={clsx("flex items-center px-4 py-3", collapsed ? "justify-center px-2" : "justify-between")}>
        {!collapsed && (
          <h2 className="flex items-center gap-2 text-sm font-bold text-text-2">
            <Heart size={16} /> 关注
            {liveCount > 0 && <span className="text-xs font-normal text-live">{liveCount} 直播中</span>}
          </h2>
        )}
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="rounded-md p-1.5 text-text-3 hover:bg-panel-2 hover:text-text disabled:opacity-60"
          aria-label="刷新关注状态"
        >
          <RefreshCw size={16} className={clsx(refreshing && "animate-spin")} />
        </button>
      </header>

      {order.length === 0 ? (
        !collapsed && (
          <p className="px-4 text-sm leading-relaxed text-text-3">在直播间点击「关注」，主播会出现在这里。</p>
        )
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {order.map((key, index) => {
            const s = byKey[key];
            if (!s) return null;
            return (
              <li
                key={key}
                draggable
                onDragStart={() => setDragFrom(index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragFrom !== null && dragFrom !== index) reorder(dragFrom, index);
                  setDragFrom(null);
                }}
              >
                <FollowRow streamer={s} collapsed={collapsed} onOpen={() => navigate(`/room/${s.platform}/${s.roomId}`)} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FollowRow({ streamer: s, collapsed, onOpen }: { streamer: FollowedStreamer; collapsed: boolean; onOpen: () => void }) {
  const live = s.status === "live";
  return (
    <button
      onClick={onOpen}
      title={`${s.name} · ${s.title}`}
      className={clsx(
        "flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-panel-2",
        collapsed && "justify-center",
        !live && "opacity-55",
      )}
      data-key={followKey(s.platform, s.roomId)}
    >
      <span className="relative shrink-0">
        <Avatar src={s.avatar} name={s.name} size={36} />
        {live && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-panel bg-live" />}
      </span>
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold">{s.name}</span>
          <span className="block truncate text-xs text-text-3">{live ? s.title || "直播中" : "未开播"}</span>
        </span>
      )}
    </button>
  );
}
