import { invoke } from '@tauri-apps/api/core';

// Proxy keys this helper registered; the backend keeps one entry per room.
const douyuProxyKeys = new Set<string>();
const douyuKey = (roomId: string) => `douyu-${roomId}`;

export async function getDouyuStreamConfig(
  roomId: string,
  quality: string = '原画',
  line?: string | null,
): Promise<{ streamUrl: string, streamType: string | undefined }> {
  let finalStreamUrl: string | null = null;
  let streamType: string | undefined = undefined;
  const MAX_STREAM_FETCH_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_STREAM_FETCH_ATTEMPTS; attempt++) {
    try {
      const streamUrl = await invoke<string>('get_stream_url_with_quality_cmd', {
        roomId: roomId,
        quality: quality,
        line: line ?? null,
      });
      
      if (streamUrl) {
        finalStreamUrl = enforceHttps(streamUrl);
        streamType = 'flv';
        break;
      } else {
        throw new Error('斗鱼直播流地址获取为空。');
      }
    } catch (e: any) {
      console.error(`[DouyuPlayerHelper] 获取斗鱼直播流失败 (尝试 ${attempt}/${MAX_STREAM_FETCH_ATTEMPTS}):`, e.message);
      const offlineOrInvalidRoomMessages = [
        '主播未开播',
        '房间不存在',
        'error: 1',
        'error: 102',
        'error code 1',
        'error code 102',
      ];

      const errorMessageLowerCase = e.message?.toLowerCase() || '';
      const isDefinitivelyOffline = offlineOrInvalidRoomMessages.some(msg => errorMessageLowerCase.includes(msg.toLowerCase()));

      if (isDefinitivelyOffline) {
        console.warn(`[DouyuPlayerHelper] Streamer for room ${roomId} is definitively offline or room is invalid. Aborting retries.`);
        throw e;
      }

      if (attempt === MAX_STREAM_FETCH_ATTEMPTS) {
        throw new Error(`获取斗鱼直播流失败 (尝试 ${MAX_STREAM_FETCH_ATTEMPTS} 次后): ${e.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); 
    }
  }

  if (!finalStreamUrl) {
    throw new Error('未能获取有效的斗鱼直播流地址。');
  }

  try {
    const key = douyuKey(roomId);
    await invoke('set_stream_url_cmd', { url: finalStreamUrl, key });
    // 斗鱼直链 300 秒后会被 CDN 主动断开，登记房间信息让代理层在到期前自行续流，
    // 否则播放器每 5 分钟就会停在最后一帧并显示「重播」。
    await invoke('set_stream_renew_cmd', {
      roomId: roomId,
      quality: quality,
      line: line ?? null,
      key,
    });
    const proxyUrl = await invoke<string>('start_proxy', { key });
    douyuProxyKeys.add(key);
    return { streamUrl: proxyUrl, streamType };
  } catch (e: any) {
    throw new Error(`设置斗鱼代理失败: ${e.message}`);
  }
}

/** Unregisters one room's stream, or every Douyu stream this helper registered. */
export async function stopDouyuProxy(roomId?: string): Promise<void> {
  const keys = roomId ? [douyuKey(roomId)] : [...douyuProxyKeys];
  for (const key of keys) {
    douyuProxyKeys.delete(key);
    try {
      await invoke('stop_proxy', { key });
    } catch (e) {
      console.error('[DouyuPlayerHelper] Error stopping proxy stream:', e);
    }
  }
}

function enforceHttps(url: string): string {
  if (!url) return url;
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) {
    return `https://${url.slice('http://'.length)}`;
  }
  return url;
}
