import { getProxyBase } from "./api";

/**
 * Routes a remote image through the local proxy, which adds the Referer that
 * Huya/Bilibili/Douyin CDNs require. Douyu images load fine directly.
 */
export async function proxify(url: string): Promise<string> {
  if (!url) return "";
  const base = await getProxyBase();
  return `${base}/image?url=${encodeURIComponent(url)}`;
}

const NEEDS_PROXY = /hdslb\.com|bilibili\.com|huya\.com|huyaimg\.com|douyinpic\.com|douyin/;

/** Synchronous variant for URLs stored before the proxy base was known. */
export function proxifyWith(base: string | undefined, url: string | null | undefined): string {
  if (!url) return "";
  if (!base || !NEEDS_PROXY.test(url)) return url;
  return `${base}/image?url=${encodeURIComponent(url)}`;
}
