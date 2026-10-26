// Scrolling danmaku renderer.
//
// Replaces danmu.js, which called getBoundingClientRect on queued bullets for
// every new comment. With bullets mid-transition each call forces a style +
// layout pass, so busy rooms (30–40 msgs/s) stuttered. This engine never reads
// layout on the hot path:
//   • text width comes from canvas measureText (no DOM layout),
//   • lane and position are pure math: x(t) = W − speed·(t − start),
//   • motion is a Web Animations transform, run by the compositor,
//   • elements are pooled and reused.
// Hovering a bullet pauses only that bullet's animation and shows an action
// tooltip; its position comes from the animation clock, not from layout.

import type Player from 'xgplayer';

import { loadDanmuBlockKeywords, persistDanmuBlockKeywords, sanitizeDanmuArea, sanitizeDanmuOpacity } from './constants';
import type { DanmuOverlayInstance } from './types';
import type { DanmuUserSettings } from './constants';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const LANE_GAP_PX = 24; // min horizontal gap between bullets in a lane
const POOL_MAX = 160;
const HOVER_RESUME_DELAY_MS = 180;

const parseFontSizePx = (fontSize: string | number | undefined) => {
  const parsed = parseInt(String(fontSize ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 20;
};

interface Bullet {
  el: HTMLSpanElement;
  anim: Animation | null;
  text: string;
  user: string;
  lane: number;
  width: number;
  start: number; // performance.now() when it entered; shifted by pauses
  duration: number;
  speed: number; // px per ms
  pausedAt: number | null;
}

export const ensureDanmuOverlayHost = (player: Player): HTMLElement | null => {
  const root = player.root as HTMLElement | undefined;
  if (!root) return null;

  let host = root.querySelector('.player-danmu-overlay') as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.className = 'player-danmu-overlay';
  }
  const videoContainer = root.querySelector('xg-video-container');
  const parent = videoContainer ?? root;
  if (host.parentElement !== parent) parent.appendChild(host);
  return host;
};

export const applyDanmuOverlayPreferences = (
  overlay: DanmuOverlayInstance | null,
  danmuSettings: DanmuUserSettings,
  isDanmuEnabled: boolean,
) => {
  if (!overlay) return;
  overlay.setFontSize?.(parseInt(danmuSettings.fontSize, 10));
  overlay.setArea?.({ start: 0, end: sanitizeDanmuArea(danmuSettings.area) });
  overlay.setAllDuration?.('scroll', danmuSettings.duration);
  overlay.setOpacity?.(isDanmuEnabled ? sanitizeDanmuOpacity(danmuSettings.opacity) : 0);
  (overlay as EngineOverlay).setStrokeColor?.(danmuSettings.strokeColor);
};

export const syncDanmuEnabledState = (
  overlay: DanmuOverlayInstance | null,
  danmuSettings: DanmuUserSettings,
  isDanmuEnabled: boolean,
) => {
  if (!overlay) return;
  if (isDanmuEnabled) overlay.play?.();
  else overlay.pause?.();
  overlay.setOpacity?.(isDanmuEnabled ? sanitizeDanmuOpacity(danmuSettings.opacity) : 0);
};

type EngineOverlay = DanmuOverlayInstance & { setStrokeColor?: (color: string) => void; destroy?: () => void };

export const createDanmuOverlay = (
  player: Player | null,
  danmuSettings: DanmuUserSettings,
  isDanmuEnabled: boolean,
): DanmuOverlayInstance | null => {
  if (!player) return null;
  const host = ensureDanmuOverlayHost(player);
  if (!host) return null;
  return createEngine(host, danmuSettings, isDanmuEnabled);
};

/** Exported for the benchmark harness; the player goes through createDanmuOverlay. */
export function createEngine(host: HTMLElement, danmuSettings: DanmuUserSettings, isDanmuEnabled: boolean): EngineOverlay {
  host.innerHTML = '';
  host.classList.add('ld-danmu-host');

  const stage = document.createElement('div');
  stage.className = 'ld-danmu-stage';
  host.appendChild(stage);

  // ---- settings & geometry (read once / on resize, never per bullet) ----
  let enabled = isDanmuEnabled;
  let fontSize = parseFontSizePx(danmuSettings.fontSize);
  let area = sanitizeDanmuArea(danmuSettings.area);
  let duration = clamp(Number(danmuSettings.duration) || 12000, 5000, 60000);
  let width = host.clientWidth || 1280;
  let height = host.clientHeight || 720;
  let laneHeight = Math.round(fontSize * 1.45);
  let laneCount = 1;
  let lanes: (Bullet | null)[] = [];
  const fontFamily = getComputedStyle(host).fontFamily || 'sans-serif';

  const measureCtx = document.createElement('canvas').getContext('2d')!;
  const setMeasureFont = () => {
    measureCtx.font = `700 ${fontSize}px ${fontFamily}`;
  };
  setMeasureFont();

  const relayout = () => {
    laneHeight = Math.round(fontSize * 1.45);
    laneCount = clamp(Math.floor((height * area) / laneHeight), 1, 60);
    lanes = Array.from({ length: laneCount }, (_, i) => lanes[i] ?? null);
    stage.style.setProperty('--ld-danmu-size', `${fontSize}px`);
  };
  relayout();

  const ro = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect;
    if (!r) return;
    width = r.width;
    height = r.height;
    relayout();
  });
  ro.observe(host);

  // ---- bullets ----
  const live = new Set<Bullet>();
  const pool: HTMLSpanElement[] = [];
  const byEl = new WeakMap<Element, Bullet>();

  const acquire = () => {
    const el = pool.pop() ?? document.createElement('span');
    el.className = 'ld-danmu';
    return el;
  };

  const release = (b: Bullet) => {
    live.delete(b);
    if (lanes[b.lane] === b) lanes[b.lane] = null;
    b.anim?.cancel();
    b.anim = null;
    b.el.remove();
    b.el.classList.remove('is-hovered');
    if (pool.length < POOL_MAX) pool.push(b.el);
  };

  /** x of a bullet's left edge at time `now`, from math only. */
  const xAt = (b: Bullet, now: number) => width - b.speed * ((b.pausedAt ?? now) - b.start);

  /** A lane is free if its last bullet's tail has cleared the right edge and
   *  the new (possibly faster) bullet won't catch it before it exits. */
  const laneFree = (prev: Bullet | null, w: number, now: number) => {
    if (!prev) return true;
    if (prev.pausedAt !== null) return false;
    const tail = xAt(prev, now) + prev.width;
    if (tail > width - LANE_GAP_PX) return false;
    const speed = (width + w) / duration;
    if (speed <= prev.speed) return true;
    const prevExit = prev.start + (width + prev.width) / prev.speed;
    const headAtExit = width - speed * (prevExit - now);
    return headAtExit >= LANE_GAP_PX;
  };

  const send: NonNullable<DanmuOverlayInstance['sendComment']> = (comment) => {
    if (!enabled || !comment.txt) return;
    const text = String(comment.txt);
    const w = Math.ceil(measureCtx.measureText(text).width) + 8;
    const now = performance.now();

    let lane = -1;
    for (let i = 0; i < laneCount; i++) {
      if (laneFree(lanes[i], w, now)) {
        lane = i;
        break;
      }
    }
    if (lane < 0) return; // every lane busy: drop rather than overlap

    const el = acquire();
    el.textContent = text;
    el.style.color = comment.style?.color || '#ffffff';
    el.style.top = `${lane * laneHeight}px`;
    const b: Bullet = {
      el,
      anim: null,
      text,
      user: comment.user ?? '',
      lane,
      width: w,
      start: now,
      duration,
      speed: (width + w) / duration,
      pausedAt: null,
    };
    byEl.set(el, b);
    stage.appendChild(el);
    b.anim = el.animate(
      [{ transform: `translate3d(${width}px,0,0)` }, { transform: `translate3d(${-w}px,0,0)` }],
      { duration, easing: 'linear', fill: 'both' },
    );
    b.anim.onfinish = () => release(b);
    lanes[lane] = b;
    live.add(b);
  };

  // ---- hover: pause one bullet + action tooltip ----
  const tip = document.createElement('div');
  tip.className = 'ld-danmu-tip';
  tip.innerHTML =
    '<span class="ld-danmu-tip__user"></span>' +
    '<button type="button" data-act="copy">复制</button>' +
    '<button type="button" data-act="plus1">+1</button>' +
    '<button type="button" data-act="block">屏蔽此词</button>';
  host.appendChild(tip);
  const tipUser = tip.querySelector('.ld-danmu-tip__user') as HTMLSpanElement;

  let hovered: Bullet | null = null;
  let resumeTimer: number | null = null;

  const showTip = (b: Bullet) => {
    const x = clamp(xAt(b, performance.now()), 8, Math.max(8, width - 260));
    const above = b.lane > 0;
    tip.style.transform = `translate3d(${x}px, ${above ? b.lane * laneHeight - 40 : laneHeight + 4}px, 0)`;
    tipUser.textContent = b.user ? `${b.user}：` : '';
    tip.classList.add('is-open');
  };

  const pauseBullet = (b: Bullet) => {
    if (resumeTimer) window.clearTimeout(resumeTimer);
    if (hovered && hovered !== b) resumeBullet(hovered);
    hovered = b;
    if (b.pausedAt === null) {
      b.pausedAt = performance.now();
      b.anim?.pause();
    }
    b.el.classList.add('is-hovered');
    showTip(b);
  };

  const resumeBullet = (b: Bullet) => {
    if (b.pausedAt !== null) {
      b.start += performance.now() - b.pausedAt;
      b.pausedAt = null;
      if (enabled) b.anim?.play();
    }
    b.el.classList.remove('is-hovered');
    if (hovered === b) {
      hovered = null;
      tip.classList.remove('is-open');
    }
  };

  const scheduleResume = () => {
    if (resumeTimer) window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => hovered && resumeBullet(hovered), HOVER_RESUME_DELAY_MS);
  };

  const onOver = (e: PointerEvent) => {
    const b = byEl.get(e.target as Element);
    if (b) pauseBullet(b);
  };
  const onOut = (e: PointerEvent) => {
    if (byEl.get(e.target as Element) && !tip.contains(e.relatedTarget as Node)) scheduleResume();
  };
  stage.addEventListener('pointerover', onOver);
  stage.addEventListener('pointerout', onOut);
  tip.addEventListener('pointerenter', () => resumeTimer && window.clearTimeout(resumeTimer));
  tip.addEventListener('pointerleave', scheduleResume);
  tip.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    const b = hovered;
    if (!act || !b) return;
    e.stopPropagation();
    if (act === 'copy' || act === 'plus1') {
      try {
        await navigator.clipboard.writeText(b.text);
        flash(act === 'plus1' ? '已复制，粘贴到弹幕框发送' : '已复制');
      } catch {
        flash('复制失败');
      }
    } else if (act === 'block') {
      const kw = b.text.trim().slice(0, 30);
      persistDanmuBlockKeywords([...loadDanmuBlockKeywords(), kw]);
      // Drop on-screen copies right away.
      live.forEach((x) => x.text.includes(kw) && release(x));
      resumeBullet(b);
      flash(`已屏蔽「${kw}」`);
    }
  });

  const toast = document.createElement('div');
  toast.className = 'ld-danmu-toast';
  host.appendChild(toast);
  let toastTimer: number | null = null;
  const flash = (msg: string) => {
    toast.textContent = msg;
    toast.classList.add('is-open');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-open'), 1600);
  };

  // ---- public API ----
  const setOpacity = (opacity: number) => {
    host.style.setProperty('--danmu-opacity', String(clamp(opacity, 0, 1)));
  };

  const overlay: EngineOverlay = {
    sendComment: send,
    clear: () => [...live].forEach(release),
    play: () => {
      enabled = true;
      stage.hidden = false;
      live.forEach((b) => b.pausedAt === null && b.anim?.play());
    },
    pause: () => {
      enabled = false;
      live.forEach((b) => b.anim?.pause());
      stage.hidden = true;
      if (hovered) resumeBullet(hovered);
    },
    stop: () => [...live].forEach(release),
    start: () => {},
    hide: () => {
      stage.hidden = true;
    },
    show: () => {
      stage.hidden = false;
    },
    setOpacity,
    setFontSize: (size) => {
      const next = parseFontSizePx(size);
      if (next === fontSize) return;
      fontSize = next;
      setMeasureFont();
      relayout();
    },
    setAllDuration: (_mode, d) => {
      if (Number.isFinite(d) && d > 0) duration = clamp(d, 5000, 60000);
    },
    setArea: (a) => {
      area = sanitizeDanmuArea(a?.end ?? area);
      relayout();
    },
    setPlayRate: () => {},
    setStrokeColor: (color) => host.style.setProperty('--danmu-stroke-color', color),
    destroy: () => {
      ro.disconnect();
      [...live].forEach(release);
      host.innerHTML = '';
    },
  };

  applyDanmuOverlayPreferences(overlay, danmuSettings, isDanmuEnabled);
  syncDanmuEnabledState(overlay, danmuSettings, isDanmuEnabled);
  return overlay;
}
