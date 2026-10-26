import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { searchBilibili, searchDouyu, searchHuya, type Platform } from "../lib/api";
import { PLATFORMS, platformInfo } from "../lib/platforms";
import { Avatar } from "../components/ui/Avatar";

interface Hit {
  platform: Platform;
  roomId: string;
  name: string;
  title: string;
  avatar: string;
  live: boolean;
}

async function douyuHits(q: string): Promise<Hit[]> {
  const data = JSON.parse(await searchDouyu(q));
  if (data.error !== 0) return [];
  return (data.data?.relateUser ?? [])
    .filter((u: { type: number }) => u.type === 1)
    .map(({ anchorInfo: a }: { anchorInfo: Record<string, any> }) => ({
      platform: "douyu" as const,
      roomId: String(a.rid ?? ""),
      name: a.nickName ?? "",
      title: a.roomName || a.description || "",
      avatar: a.avatar ?? "",
      live: a.isLive === 1 && a.videoLoop !== 1,
    }));
}

const huyaHits = async (q: string): Promise<Hit[]> =>
  (await searchHuya(q)).map((h) => ({
    platform: "huya",
    roomId: h.room_id,
    name: h.user_name,
    title: h.title,
    avatar: h.avatar,
    live: h.live_status,
  }));

const bilibiliHits = async (q: string): Promise<Hit[]> =>
  (await searchBilibili(q)).map((h) => ({
    platform: "bilibili",
    roomId: h.room_id,
    name: h.anchor,
    title: h.title,
    avatar: h.avatar,
    live: h.is_live,
  }));

const SEARCHERS: [Platform, (q: string) => Promise<Hit[]>][] = [
  ["douyu", douyuHits],
  ["huya", huyaHits],
  ["bilibili", bilibiliHits],
];

export function SearchPage() {
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const roomNumber = /^\d{3,}$/.test(q) ? q : null;

  return (
    <div className="px-6 pb-10">
      <h1 className="mb-6 text-2xl font-bold">“{q}” 的搜索结果</h1>

      {roomNumber && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold text-text-2">按房间号打开</h2>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => (
              <Link
                key={p.id}
                to={`/room/${p.id}/${roomNumber}`}
                className="flex items-center gap-2 rounded-full bg-panel-2 py-1.5 pr-4 pl-1.5 text-sm font-bold hover:bg-panel-3"
              >
                <img src={p.icon} alt="" className="size-6 rounded-full" />
                {p.name} {roomNumber}
              </Link>
            ))}
          </div>
        </section>
      )}

      {SEARCHERS.map(([platform, search]) => (
        <PlatformResults key={platform} platform={platform} q={q} search={search} />
      ))}
      <p className="text-xs text-text-3">抖音暂不支持关键词搜索，可直接输入房间号。</p>
    </div>
  );
}

function PlatformResults({ platform, q, search }: { platform: Platform; q: string; search: (q: string) => Promise<Hit[]> }) {
  const result = useQuery({ queryKey: ["search", platform, q], queryFn: () => search(q), enabled: !!q });
  const info = platformInfo(platform);
  const hits = [...(result.data ?? [])].sort((a, b) => Number(b.live) - Number(a.live)).slice(0, 12);

  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-text-2">
        <img src={info.icon} alt="" className="size-5 rounded" /> {info.name}
        {result.isFetching && <span className="font-normal text-text-3">搜索中…</span>}
      </h2>
      {result.isError ? (
        <p className="text-xs text-text-3">搜索失败：{String(result.error)}</p>
      ) : !result.isFetching && hits.length === 0 ? (
        <p className="text-xs text-text-3">没有结果</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
          {hits.map((h) => (
            <Link
              key={h.roomId}
              to={`/room/${h.platform}/${h.roomId}`}
              className="flex items-center gap-3 rounded-lg p-2 hover:bg-panel-2"
            >
              <span className="relative">
                <Avatar src={h.avatar} name={h.name} size={40} />
                {h.live && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-panel bg-live" />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">{h.name}</span>
                <span className="block truncate text-xs text-text-3">{h.title || `房间 ${h.roomId}`}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
