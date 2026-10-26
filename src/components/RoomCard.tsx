import { useState } from "react";
import { Link } from "react-router";
import { Users } from "lucide-react";
import type { Room } from "../hooks/useRooms";
import { Avatar } from "./ui/Avatar";

export function RoomCard({ room }: { room: Room }) {
  const [coverFailed, setCoverFailed] = useState(false);
  return (
    <Link to={`/room/${room.platform}/${room.roomId}`} className="group block" draggable={false}>
      <div className="relative aspect-video overflow-hidden rounded-lg bg-panel-2">
        {room.cover && !coverFailed && (
          <img
            src={room.cover}
            alt=""
            loading="lazy"
            onError={() => setCoverFailed(true)}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            draggable={false}
          />
        )}
        {room.viewers && (
          <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-bold text-white">
            <Users size={11} /> {room.viewers}
          </span>
        )}
      </div>
      <div className="mt-2 flex gap-2.5">
        <Avatar src={room.avatar} name={room.anchor} size={32} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold group-hover:text-accent">{room.title || "未命名直播间"}</p>
          <p className="truncate text-xs text-text-3">{room.anchor}</p>
        </div>
      </div>
    </Link>
  );
}

RoomCard.Skeleton = function RoomCardSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="aspect-video rounded-lg bg-panel-2" />
      <div className="mt-2 flex gap-2.5">
        <div className="size-8 rounded-full bg-panel-2" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-4/5 rounded bg-panel-2" />
          <div className="h-3 w-2/5 rounded bg-panel-2" />
        </div>
      </div>
    </div>
  );
};
