/**
 * The screen itself. It holds no state of its own: the server streams the current state and this
 * file draws it, so a change in the control panel shows up on every screen straight away.
 */
import type { Card, PublicConfig, Role, Scene, ServerMessage, State } from "../shared/types.ts";
import { $, $$, connect } from "./live.ts";

const stage = $("#stage");

/** Where stickers may sit on the idle screen: around the edges, clear of the clock in the middle. */
const STICKER_SLOTS = [
  { x: 4, y: 15, w: 13 },
  { x: 9, y: 42, w: 12 },
  { x: 3, y: 70, w: 13 },
  { x: 22, y: 19, w: 9 },
  { x: 85, y: 15, w: 13 },
  { x: 80, y: 42, w: 12 },
  { x: 86, y: 70, w: 13 },
  { x: 70, y: 20, w: 9 },
];

let state: State | null = null;
let config: PublicConfig | null = null;
/** Screens' own clocks are often wrong, so everything is timed against the server's. */
let clockOffset = 0;
let build: string | null = null;

const now = () => Date.now() + clockOffset;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

/* ---------- time ---------- */

let timeFormat: Intl.DateTimeFormat;
let dateFormat: Intl.DateTimeFormat;

function setTimeZone(timeZone: string) {
  timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long" });
}
setTimeZone("UTC");

const clockText = (ms: number) => timeFormat.format(ms);

function minutesOfDay(ms: number): number {
  const [h = 0, m = 0] = clockText(ms).split(":").map(Number);
  return h * 60 + m;
}

function parseTime(text: string): number {
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

/** Draws "12:34" as fixed-width cells, and only touches the page when the text changes. */
function drawDigits(el: HTMLElement, text: string, blink = false) {
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.replaceChildren(
    ...[...text].map((ch) => {
      const span = document.createElement("span");
      span.className = ch === ":" ? (blink ? "c blink" : "c") : "d";
      span.textContent = ch;
      return span;
    }),
  );
}

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

/* ---------- scenes ---------- */

function currentScene(s: State): Scene {
  if (s.scene !== "rotate") return s.scene;
  const { scenes, seconds } = s.rotate;
  // Derived from the shared clock rather than a local timer, so every screen flips together.
  return scenes[Math.floor(now() / (seconds * 1000)) % scenes.length] ?? "idle";
}

function showScene(name: Scene) {
  if (stage.dataset.scene === name && document.querySelector(".scene.active")) return;
  stage.dataset.scene = name;
  for (const el of $$(".scene")) el.classList.toggle("active", el.dataset.scene === name);
}

function fillCard(card: HTMLElement, { kicker, title, body, tone }: Card) {
  card.className = `card tone-${tone}`;
  setText($(".card-kicker", card), kicker);
  const titleEl = $(".card-title", card);
  setText(titleEl, title);
  titleEl.classList.toggle("medium", title.length > 18 && title.length <= 45);
  titleEl.classList.toggle("small", title.length > 45);
  const bodyEl = $(".card-body", card);
  setText(bodyEl, body);
  bodyEl.classList.toggle("small", body.length > 220);
}

let scheduleMinute = -1;

function renderSchedule(s: State) {
  const { items, title, platform } = s.schedule;
  setText($("#boardTitle"), title);
  setText($("#boardPlatform"), platform);

  const rows = $("#rows");
  rows.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = item.time;
      const dest = document.createElement("span");
      dest.className = "dest";
      dest.textContent = item.title;
      if (item.detail) {
        const small = document.createElement("small");
        small.textContent = item.detail;
        dest.append(small);
      }
      const status = document.createElement("span");
      status.className = "status";
      li.append(time, dest, status);
      return li;
    }),
  );
  // Shrink the type as rows are added so the whole day always fits on one screen.
  const size = Math.min(2.9, Math.max(1.1, 36 / (1.85 * Math.max(items.length, 1))));
  $(".board").style.setProperty("--fs", `${size}rem`);
  scheduleMinute = -1;
}

function updateScheduleMarkers(s: State) {
  const minute = minutesOfDay(now());
  if (minute === scheduleMinute) return;
  scheduleMinute = minute;

  const items = s.schedule.items;
  const times = items.map((i) => parseTime(i.time));
  let current = -1;
  times.forEach((t, i) => {
    if (t <= minute) current = i;
  });
  const next = times.findIndex((t) => t > minute);

  const labels = { now: "Now", past: "Departed", next: "Next", "": "On time" } as const;
  $$("#rows li").forEach((li, i) => {
    const kind = i === current ? "now" : i < current ? "past" : i === next ? "next" : "";
    li.className = kind;
    $(".status", li).textContent = labels[kind];
  });

  const nowItem = items[current];
  const nextItem = items[next];
  if (nowItem) {
    setText($("#nowLabel"), "Now");
    setText($("#nowTitle"), nowItem.title);
    setText($("#nowNext"), nextItem ? `Next at ${nextItem.time}: ${nextItem.title}` : "");
  } else if (nextItem) {
    setText($("#nowLabel"), `First up at ${nextItem.time}`);
    setText($("#nowTitle"), nextItem.title);
    setText($("#nowNext"), nextItem.detail);
  }
  $("#nowCard").hidden = !nowItem && !nextItem;

  $("#idleNext").hidden = !(s.idle.showNext && nextItem);
  if (nextItem) {
    setText($("#idleNextTime"), nextItem.time);
    setText($("#idleNextTitle"), nextItem.title);
  }
}

function updateCountdown(s: State) {
  const { target, doneText } = s.countdown;
  const left = Math.ceil((target - now()) / 1000);
  const digits = $("#countdownDigits");
  const done = $("#countdownDone");
  const finished = left <= 0;

  digits.hidden = finished;
  $("#countdownLabel").hidden = finished && Boolean(doneText);
  done.hidden = !finished;
  $("#countdownUntil").hidden = finished;
  if (finished) return setText(done, doneText || "00:00");

  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const sec = left % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  drawDigits(digits, h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`);
  digits.classList.toggle("long", h > 0 && h < 100);
  digits.classList.toggle("xlong", h >= 100);
  digits.classList.toggle("final", left <= 60);
  setText($("#countdownUntil"), `until ${clockText(target)}`);
}

function updateAlert(s: State) {
  const alert = s.alert;
  const el = $("#alert");
  // Hide on our own clock too, so an announcement still ends on time if the connection drops.
  if (!alert || (alert.expiresAt && alert.expiresAt <= now())) {
    el.hidden = true;
    el.dataset.id = "";
    return;
  }
  if (el.dataset.id !== alert.id) {
    el.dataset.id = alert.id;
    fillCard($("#alertCard"), alert);
    el.hidden = true;
    void el.offsetWidth; // restart the entrance animation for a new announcement
    el.hidden = false;
  }
  const bar = $("#alertProgress");
  bar.hidden = !alert.expiresAt;
  if (alert.expiresAt) {
    const fraction = (alert.expiresAt - now()) / (alert.expiresAt - alert.startedAt);
    $("i", bar).style.transform = `scaleX(${Math.min(1, Math.max(0, fraction))})`;
  }
}

/* ---------- ticker ---------- */

let tickerAnimation: Animation | null = null;

function renderTicker(s: State) {
  const { enabled, text } = s.ticker;
  const on = enabled && text.trim() !== "";
  const el = $("#ticker");
  const span = $("#tickerText");
  const changed = span.textContent !== text || el.hidden === on;
  el.hidden = !on;
  stage.classList.toggle("has-ticker", on);
  if (!changed && tickerAnimation) return;
  tickerAnimation?.cancel();
  tickerAnimation = null;
  if (!on) return;
  span.textContent = text;
  const from = el.clientWidth;
  const to = -span.offsetWidth;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  tickerAnimation = span.animate(
    [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
    { duration: ((from - to) / (11 * rem)) * 1000, iterations: Infinity },
  );
}

/* ---------- render ---------- */

function render(s: State) {
  setText($("#idleMessage"), s.idle.message);
  $("#stickers").classList.toggle("off", !s.idle.stickers);
  $("#mascot").hidden = !(s.idle.stickers && config?.mascot);

  fillCard($("#messageCard"), s.message);
  setText($("#countdownLabel"), s.countdown.label);
  renderSchedule(s);
  renderTicker(s);

  // Only keep a website loaded while it can actually appear, so it isn't running behind other scenes.
  const reachable = s.scene === "embed" || (s.scene === "rotate" && s.rotate.scenes.includes("embed"));
  const frame = $<HTMLIFrameElement>("#embedFrame");
  const url = reachable ? s.embed.url : "";
  if (frame.dataset.url !== url) {
    frame.dataset.url = url;
    if (url) frame.src = url;
    else frame.removeAttribute("src");
  }
  frame.hidden = !url;
  $("#embedEmpty").hidden = Boolean(url);
  stage.classList.toggle("embed-clock", s.embed.showClock);

  tick();
}

function tick() {
  $("#offline").hidden = live.silence() < 40_000;
  if (!state) return;
  const t = now();
  const time = clockText(t);
  for (const el of $$("[data-clock]")) drawDigits(el, time, el.classList.contains("idle-clock"));
  for (const el of $$("[data-date]")) setText(el, dateFormat.format(t));
  showScene(currentScene(state));
  updateScheduleMarkers(state);
  updateCountdown(state);
  updateAlert(state);
}

/* ---------- decoration ---------- */

function plantLeaves() {
  const colours = ["#fff8ec", "#e8f4fd", "#cfe3f2", "#fffdf6"];
  const layer = $("#leaves");
  for (let i = 0; i < 26; i++) {
    const leaf = document.createElement("i");
    leaf.className = "leaf";
    leaf.style.cssText = `
      --x: ${rand(0, 100)}%;
      --size: ${rand(0.45, 1.3)}rem;
      --colour: var(${pick(colours)});
      --dur: ${rand(11, 22)}s;
      --delay: ${-rand(0, 22)}s;
      --sway: ${rand(1, 4)}rem;
      --spin: ${rand(-180, 180)}deg;`;
    layer.append(leaf);
  }
}

let stickersPlaced = false;

function placeStickers(stickers: string[]) {
  if (stickersPlaced || !stickers.length) return;
  stickersPlaced = true;
  const layer = $("#stickers");
  const deck = [...stickers].sort(() => Math.random() - 0.5);
  const slots = STICKER_SLOTS.slice(0, stickers.length).map((slot) => {
    const el = document.createElement("div");
    el.className = "sticker";
    el.style.cssText = `
      --x: ${slot.x}%; --y: ${slot.y}%; --w: ${slot.w}rem;
      --tilt: ${rand(-14, 14)}deg; --dur: ${rand(5, 9)}s; --delay: ${-rand(0, 9)}s;`;
    const img = document.createElement("img");
    img.alt = "";
    img.src = deck.pop()!;
    el.append(img);
    layer.append(el);
    return { el, img };
  });

  // Every so often one sticker pops away and a different one takes its place.
  setInterval(() => {
    if (stage.dataset.scene !== "idle") return;
    const showing = new Set(slots.map((s) => new URL(s.img.src).pathname));
    const fresh = stickers.filter((src) => !showing.has(new URL(src, location.href).pathname));
    if (!fresh.length) return;
    const { el, img } = pick(slots);
    el.classList.add("out");
    setTimeout(() => {
      img.src = pick(fresh);
      el.style.setProperty("--tilt", `${rand(-14, 14)}deg`);
      img
        .decode()
        .catch(() => {})
        .finally(() => el.classList.remove("out"));
    }, 350);
  }, 7000);
}

// The mascot pops up somewhere new each time.
const mascot = $("#mascot");
mascot.addEventListener("animationiteration", () => {
  mascot.style.left = `${pick([rand(18, 30), rand(58, 68)])}%`;
});

/* ---------- connection ---------- */

let seenState = false;
/** The revision already on screen, so the poll below doesn't redraw what the socket just sent. */
let lastRev = -1;

function onMessage(message: ServerMessage) {
  if (message.type === "reload") return location.reload();
  if (message.type !== "state") return;
  // A new build means new display code, so pick it up.
  if (build && message.build !== build) return location.reload();
  clockOffset = message.now - Date.now();
  // The socket and the poll both arrive here; only a new revision means the screen is out of date.
  if (seenState && message.state.rev === lastRev) return;
  seenState = true;
  lastRev = message.state.rev;
  build = message.build;
  if (!config || config.timeZone !== message.config.timeZone) setTimeZone(message.config.timeZone);
  config = message.config;
  document.title = config.eventName;
  for (const logo of $$<HTMLImageElement>("[data-logo]")) logo.alt = config.eventName;
  placeStickers(config.stickers);
  state = message.state;
  render(state);
}

/**
 * The same state over plain HTTP. Some venue networks block WebSockets (a school proxy, a locked
 * down browser), and then the socket's first message never arrives, which used to leave the screen
 * showing nothing but the backdrop. Fetching it means a screen draws either way.
 */
async function prime(): Promise<void> {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (res.ok) onMessage((await res.json()) as ServerMessage);
  } catch {
    // Offline, or the server restarted. The loop below tries again.
  }
}

// The control panel's preview is this same page; it shouldn't be counted as a venue screen.
/**
 * Every screen says who it is, so the panel can list what's connected and where. The name lives in
 * this browser's storage; a screen that has never been named asks for one.
 */
const NAME_KEY = "telecast.screenName";

function screenName(): string {
  const saved = localStorage.getItem(NAME_KEY)?.trim();
  if (saved) return saved;
  const answer = (prompt("What's this screen called?", "Screen") ?? "").trim().slice(0, 40);
  const name = answer || "Unnamed screen";
  localStorage.setItem(NAME_KEY, name);
  return name;
}

const role: Role = new URLSearchParams(location.search).has("preview") ? "control" : "display";
const live = connect(role, onMessage, undefined, role === "display" ? () => ({ type: "hello", name: screenName() }) : undefined);

// Draw straight away, then keep asking over plain HTTP.
//
// A venue proxy can leave the socket looking healthy (pings answer) while the state the panel sends
// never gets through, and the old check only fell back once the socket went quiet, so the screen sat
// on an old scene until somebody reloaded the tab. Asking every few seconds costs one small request
// and means the screens follow the panel whatever the network is doing to WebSockets.
void prime();
setInterval(() => void prime(), 3000);

// A page kept in the browser's back/forward cache shouldn't go on counting as a connected screen.
addEventListener("pagehide", () => live.close());
addEventListener("pageshow", (event) => event.persisted && live.reopen());

plantLeaves();
setInterval(tick, 200);
addEventListener("resize", () => {
  tickerAnimation?.cancel();
  tickerAnimation = null;
  if (state) renderTicker(state);
});

// One click on the screen (or pressing F) goes full screen and keeps the panel awake.
async function goFullScreen() {
  if (!document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {});
  await navigator.wakeLock?.request("screen").catch(() => {});
}
addEventListener("click", goFullScreen);
addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "f") void goFullScreen();
});
