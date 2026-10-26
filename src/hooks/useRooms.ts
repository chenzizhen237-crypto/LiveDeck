import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchBilibiliLiveList,
  fetchDouyinRooms,
  fetchDouyuCategories,
  fetchDouyuLiveList,
  fetchHuyaLiveList,
  generateDouyinMsToken,
  type Platform,
} from "../lib/api";
import type { CategoryGroup } from "../lib/platforms";
import { proxify } from "../lib/images";

/** A live room card, normalized across platforms. */
export interface Room {
  platform: Platform;
  roomId: string;
  title: string;
  anchor: string;
  avatar: string;
  cover: string;
  viewers: string;
}

interface Page {
  rooms: Room[];
  next: number | null;
}

const DOUYU_PAGE = 20;
const HUYA_PAGE = 120;
const HUYA_COVER_PARAMS =
  "x-oss-process=image/resize,limit_0,m_fill,w_338,h_190/sharpen,80/format,jpg/interlace,1/quality,q_90";

async function fetchPage(platform: Platform, key: string, cursor: number, msToken?: string): Promise<Page> {
  switch (platform) {
    case "douyu": {
      const resp = await fetchDouyuLiveList(key, cursor * DOUYU_PAGE, DOUYU_PAGE);
      if (resp.error !== 0 || !resp.data) throw new Error(resp.msg ?? "斗鱼接口返回错误");
      const rooms = resp.data.list.map((r) => ({
        platform,
        roomId: String(r.rid),
        title: r.roomName,
        anchor: r.nickname,
        avatar: r.avatar,
        cover: r.roomSrc,
        viewers: r.hn,
      }));
      const fetched = (cursor + 1) * DOUYU_PAGE;
      const more = resp.data.total != null ? resp.data.total > fetched : rooms.length === DOUYU_PAGE;
      return { rooms, next: more && rooms.length > 0 ? cursor + 1 : null };
    }
    case "huya": {
      const page = cursor + 1;
      const resp = await fetchHuyaLiveList(key, page, HUYA_PAGE);
      if (resp.error !== 0 || !resp.data) throw new Error(resp.msg ?? "虎牙接口返回错误");
      const rooms = await Promise.all(
        resp.data.map(async (r) => {
          const cover = r.room_cover ?? "";
          const sized = !cover || cover.includes("x-oss-process=")
            ? cover
            : `${cover}${cover.includes("?") ? "&" : "?"}${HUYA_COVER_PARAMS}`;
          return {
            platform,
            roomId: String(r.room_id ?? ""),
            title: r.title ?? "",
            anchor: r.nickname ?? "",
            avatar: await proxify(r.avatar ?? ""),
            cover: await proxify(sized),
            viewers: r.viewer_count_str ?? "",
          };
        }),
      );
      return { rooms, next: rooms.length === HUYA_PAGE ? cursor + 1 : null };
    }
    case "bilibili": {
      const [areaId, parentId] = key.split(":");
      const text = await fetchBilibiliLiveList(areaId, parentId, cursor + 1);
      const list: { roomid: number; title: string; uname: string; face: string; cover: string; watched_show?: { num: number } }[] =
        JSON.parse(text)?.data?.list ?? [];
      const rooms = await Promise.all(
        list.map(async (r) => ({
          platform,
          roomId: String(r.roomid),
          title: r.title,
          anchor: r.uname,
          avatar: await proxify(r.face),
          cover: await proxify(r.cover),
          viewers: r.watched_show?.num != null ? String(r.watched_show.num) : "",
        })),
      );
      return { rooms, next: rooms.length > 0 ? cursor + 1 : null };
    }
    case "douyin": {
      const parts = key.split("_");
      const partition = parts[parts.length - 1];
      const partitionType = parts[parts.length - 2];
      const resp = await fetchDouyinRooms(partition, partitionType, cursor, msToken ?? "");
      const rooms = resp.rooms.map((r) => ({
        platform,
        roomId: r.web_rid ?? "",
        title: r.title ?? "",
        anchor: r.owner_nickname ?? "",
        avatar: r.avatar_url ?? "",
        cover: r.cover_url ?? "",
        viewers: r.user_count_str ?? "",
      }));
      return { rooms, next: resp.has_more ? resp.next_offset : null };
    }
  }
}

export function useRooms(platform: Platform, categoryKey: string | null) {
  // Douyin list requests need a session msToken; generate one per category view.
  const msToken = useQuery({
    queryKey: ["douyin-ms-token"],
    queryFn: generateDouyinMsToken,
    enabled: platform === "douyin",
    staleTime: 10 * 60_000,
  });

  return useInfiniteQuery({
    queryKey: ["rooms", platform, categoryKey],
    queryFn: ({ pageParam }) => fetchPage(platform, categoryKey!, pageParam, msToken.data),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next,
    enabled: !!categoryKey && (platform !== "douyin" || !!msToken.data),
    staleTime: 60_000,
  });
}

export function useDouyuCategories() {
  return useQuery({
    queryKey: ["douyu-categories"],
    queryFn: async (): Promise<CategoryGroup[]> => {
      const resp = await fetchDouyuCategories();
      return resp.cate1List.map((c1) => ({
        name: c1.name,
        // The mobile list API takes the cate2 short name, not its numeric id.
        items: c1.cate2List.map((c2) => ({ key: c2.short_name, name: c2.name })),
      }));
    },
    staleTime: Infinity,
  });
}
