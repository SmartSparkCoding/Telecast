/** Types shared by the server, both hosts and the two browser pages. */

export const SCENES = ["idle", "schedule", "countdown", "message", "embed", "gallery", "rotate"] as const;
export type Scene = (typeof SCENES)[number];

export const TONES = ["orange", "green", "teal", "yellow", "red"] as const;
export type Tone = (typeof TONES)[number];

export interface ScheduleItem {
  /** 24-hour, like "9:00" or "13:30". */
  time: string;
  title: string;
  detail: string;
}

/** One picture in the image scroll. Uploaded files sit under /images/ on the Node host. */
export interface GalleryImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

/** How many pictures the scroll takes. Any more and the state file gets silly. */
export const MAX_IMAGES = 50;

/** A picture bigger than this is refused even after the browser has shrunk it. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface Card {
  kicker: string;
  title: string;
  body: string;
  tone: Tone;
}

/** A temporary full-screen announcement on top of whatever scene is showing. */
export interface Alert extends Card {
  id: string;
  startedAt: number;
  /** null means it stays until someone clears it. */
  expiresAt: number | null;
}

/** Everything an organiser can edit. */
export interface Content {
  scene: Scene;
  idle: { message: string; showNext: boolean; stickers: boolean };
  message: Card;
  countdown: { label: string; target: number; doneText: string };
  embed: { url: string; showClock: boolean };
  /** Pages of pictures that move on by themselves, laid out by how good each one is. */
  gallery: { title: string; seconds: number; images: GalleryImage[] };
  schedule: { title: string; platform: string; items: ScheduleItem[] };
  /** Cycles through these scenes; every screen switches at the same moment. */
  rotate: { seconds: number; scenes: Scene[] };
  /** A scrolling strip along the bottom, on top of whatever scene is showing. */
  ticker: { enabled: boolean; text: string };
}

export interface State extends Content {
  rev: number;
  alert: Alert | null;
}

/** The part of the event's config that the browser needs. */
export interface PublicConfig {
  eventName: string;
  /** Clocks and the schedule's "now" marker use this zone, whatever the screen's own clock says. */
  timeZone: string;
  /** Images that drift around the idle screen. */
  stickers: string[];
  /** Whether /theme/mascot.webp peeks over the bottom of the idle screen. */
  mascot: boolean;
}

export interface TelecastConfig extends PublicConfig {
  /** What the screens show before anyone has touched the control panel, and what "Reset" goes back to. */
  defaults: Content;
}

export type ServerMessage =
  | { type: "state"; state: State; config: PublicConfig; now: number; build: string }
  | { type: "stats"; displays: number; screens: string[] }
  | { type: "reload" };

export type Role = "display" | "control";

/**
 * What /api/me returns to a signed-in organiser. There's one role now: whoever knows the PIN.
 */
/** Everyone who can open the panel. Admins manage people; controllers only change the screens. */
export type PersonRole = "admin" | "controller";

export interface Person {
  id: string;
  name: string;
  /** Shown back to admins so a forgotten one can be read out, so it is stored as typed. */
  pin: string;
  role: PersonRole;
  /** The one that came from TELECAST_PIN. It can be renamed and re-pinned, but never removed. */
  owner?: boolean;
}

export interface Me {
  user: { id: string; name: string; role: PersonRole };
}
