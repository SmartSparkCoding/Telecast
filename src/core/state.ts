/** Turns whatever a request sent into well-formed state. */
import { SCENES, TONES } from "../shared/types.ts";
import { MAX_IMAGES } from "../shared/types.ts";
import type { Alert, Card, Content, Scene, State, Tone } from "../shared/types.ts";

type Loose = Record<string, unknown>;

const obj = (v: unknown): Loose => (v && typeof v === "object" ? (v as Loose) : {});
const str = (v: unknown, max: number, fallback = ""): string =>
  typeof v === "string" ? v.slice(0, max) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const isScene = (v: unknown): v is Scene => SCENES.includes(v as Scene);
const tone = (v: unknown, fallback: Tone): Tone => (TONES.includes(v as Tone) ? (v as Tone) : fallback);

function httpUrl(v: string): string {
  const s = v.slice(0, 2000).trim();
  if (!s) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

const card = (v: Loose, cur: Card): Card => ({
  kicker: str(v.kicker, 60, cur.kicker),
  title: str(v.title, 200, cur.title),
  body: str(v.body, 600, cur.body),
  tone: tone(v.tone, cur.tone),
});

/** Each section is rebuilt field by field, so a bad request can never put unexpected data on a screen. */
const sanitise: { [K in keyof Content]: (value: unknown, current: Content[K]) => Content[K] } = {
  scene: (v, cur) => (isScene(v) ? v : cur),

  idle: (raw, cur) => {
    const v = obj(raw);
    return {
      message: str(v.message, 200, cur.message),
      showNext: bool(v.showNext, cur.showNext),
      stickers: bool(v.stickers, cur.stickers),
    };
  },

  message: (raw, cur) => card(obj(raw), cur),

  countdown: (raw, cur) => {
    const v = obj(raw);
    return {
      label: str(v.label, 120, cur.label),
      target: num(v.target, 0, 8.64e15, cur.target),
      doneText: str(v.doneText, 120, cur.doneText),
    };
  },

  embed: (raw, cur) => {
    const v = obj(raw);
    return {
      url: typeof v.url === "string" ? httpUrl(v.url) : cur.url,
      showClock: bool(v.showClock, cur.showClock),
    };
  },

  gallery: (raw, cur) => {
    const v = obj(raw);
    const clean = Array.isArray(v.images)
      ? v.images
          .slice(0, MAX_IMAGES)
          .map(obj)
          .map((i) => ({
            id: str(i.id, 40).trim(),
            url: /^(\/images\/|https?:\/\/)/i.test(str(i.url, 500)) ? str(i.url, 500) : "",
            width: Math.round(num(i.width, 1, 20_000, 1600)),
            height: Math.round(num(i.height, 1, 20_000, 900)),
          }))
          .filter((i) => i.id && i.url)
      : cur.images;
    return {
      title: str(v.title, 60, cur.title),
      seconds: Math.round(num(v.seconds, 3, 120, cur.seconds)),
      images: clean,
    };
  },

  schedule: (raw, cur) => {
    const v = obj(raw);
    return {
      title: str(v.title, 60, cur.title),
      platform: str(v.platform, 60, cur.platform),
      items: Array.isArray(v.items)
        ? v.items
            .slice(0, 40)
            .map(obj)
            .map((i) => ({
              time: str(i.time, 5).trim(),
              title: str(i.title, 120).trim(),
              detail: str(i.detail, 200).trim(),
            }))
            .filter((i) => i.title)
        : cur.items,
    };
  },

  rotate: (raw, cur) => {
    const v = obj(raw);
    const scenes = Array.isArray(v.scenes)
      ? v.scenes.filter((s): s is Scene => isScene(s) && s !== "rotate").slice(0, 10)
      : cur.scenes;
    return {
      seconds: num(v.seconds, 5, 3600, cur.seconds),
      scenes: scenes.length ? scenes : cur.scenes,
    };
  },

  ticker: (raw, cur) => {
    const v = obj(raw);
    return {
      enabled: bool(v.enabled, cur.enabled),
      text: str(v.text, 500, cur.text),
    };
  },
};

export function applyPatch(state: State, patch: unknown): void {
  const p = obj(patch);
  for (const key of Object.keys(sanitise) as (keyof Content)[]) {
    if (!(key in p)) continue;
    const clean = sanitise[key] as (value: unknown, current: unknown) => unknown;
    (state as unknown as Loose)[key] = clean(p[key], state[key]);
  }
}

export function freshState(defaults: Content, rev = 0): State {
  return { ...structuredClone(defaults), rev, alert: null };
}

/** Rebuilds state from a saved copy, so an old or hand-edited file can't break the screens. */
export function restoreState(defaults: Content, saved: unknown): State {
  const s = obj(saved);
  const state = freshState(defaults, num(s.rev, 0, Number.MAX_SAFE_INTEGER, 0));
  applyPatch(state, s);
  const a = obj(s.alert);
  if (typeof a.id === "string") {
    state.alert = {
      ...card(a, { kicker: "", title: "", body: "", tone: "orange" }),
      id: a.id.slice(0, 32),
      startedAt: num(a.startedAt, 0, 8.64e15, Date.now()),
      expiresAt: typeof a.expiresAt === "number" ? a.expiresAt : null,
    };
  }
  return state;
}

/** Returns null when the request has neither a title nor a message. */
export function newAlert(raw: unknown, id: string, now: number): Alert | null {
  const v = obj(raw);
  const title = str(v.title, 200).trim();
  const body = str(v.body, 600).trim();
  if (!title && !body) return null;
  const seconds = num(v.seconds, 0, 86_400, 30);
  return {
    id,
    kicker: str(v.kicker, 60, "Announcement"),
    title,
    body,
    tone: tone(v.tone, "orange"),
    startedAt: now,
    expiresAt: seconds ? now + seconds * 1000 : null,
  };
}
