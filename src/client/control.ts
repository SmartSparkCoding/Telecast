/**
 * The organisers' control panel. Each form edits one section of the shared state and saves it with
 * a PATCH; the server then pushes the result to every screen (and back here) at once.
 */
// A panel that dies while booting looks exactly like a panel that is broken, with no clue why.
// Say what happened on the page instead of leaving an inert form.
function complain(what: string) {
  const box = document.getElementById("bootError");
  if (!box) return;
  box.hidden = false;
  box.textContent = `The panel hit an error: ${what}. Reload the page, and tell Jacob if it keeps happening.`;
}
addEventListener("error", (event) => complain((event as ErrorEvent).message || "unknown error"));
addEventListener("unhandledrejection", (event) => complain(String((event as PromiseRejectionEvent).reason ?? "unknown error")));

import type { Content, GalleryImage, Me, ScheduleItem, Scene, State } from "../shared/types.ts";
import { $, $$, connect } from "./live.ts";

type Section = Exclude<keyof Content, "scene">;
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

let state: State | null = null;
let me: Me | null = null;

/* ---------- talking to the server ---------- */

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  // Venue proxies sometimes drop PATCH and DELETE-less writes along with them, so state changes go
  // out as a POST, which the server accepts as the same thing.
  const verb = method === "PATCH" ? "POST" : method;
  const res = await fetch(path, {
    method: verb,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    showSignIn(data.error);
    throw new Error(data.error ?? "Sign in to make changes");
  }
  if (!res.ok) throw new Error(data.error ?? "That didn't save. Try again.");
  return data as T;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, bad = false) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 5000 : 1800);
}

/** Runs a change and reports how it went, so every button behaves the same way. */
async function run(action: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await action();
    if (done) toast(done);
    return true;
  } catch (err) {
    toast((err as Error).message, true);
    return false;
  }
}

/* ---------- signing in ---------- */

function showSignIn(reason?: string) {
  $("#loginReason").textContent = reason ?? "Type the PIN to change what's on the screens.";
  $("#login").hidden = false;
  $<HTMLInputElement>("#pin").focus();
}

async function loadMe() {
  const res = await fetch("/api/me", { cache: "no-store" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return showSignIn(res.status === 401 ? undefined : data.error);
  }
  me = (await res.json()) as Me;
  $("#login").hidden = true;
  $("#who").hidden = false;
  $("#whoName").textContent = me.user.name;
}

$("#pinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("#pin");
  const button = $<HTMLButtonElement>("#pinGo");
  button.disabled = true;
  void (async () => {
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: input.value }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That PIN isn't right");
      input.value = "";
      await loadMe();
      toast("Signed in");
    } catch (err) {
      $("#loginReason").textContent = (err as Error).message;
      input.select();
    } finally {
      button.disabled = false;
    }
  })();
});

$("#signOut").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.reload();
});

/* ---------- forms ---------- */

const sectionForms = $$<HTMLFormElement>("form[data-section]");
const sectionOf = (form: HTMLFormElement) => form.dataset.section as Section;
const formFor = (section: Section) => $<HTMLFormElement>(`form[data-section='${section}']`);

function collect(form: HTMLFormElement): Record<string, unknown> {
  const section = sectionOf(form);
  const data: Record<string, unknown> = {};
  for (const el of $$<Field>("[data-field]", form)) {
    const input = el as HTMLInputElement;
    if (input.type === "radio" && !input.checked) continue;
    data[el.dataset.field!] =
      input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : el.value;
  }
  if (section === "countdown") {
    const target = new Date($<HTMLInputElement>("#countdownTarget").value).getTime();
    if (Number.isFinite(target)) data.target = target;
  }
  if (section === "schedule") {
    data.items = $$("#items li").map(
      (li): ScheduleItem => ({
        time: $<HTMLInputElement>(".time", li).value,
        title: $<HTMLInputElement>(".title", li).value,
        detail: $<HTMLInputElement>(".detail", li).value,
      }),
    );
  }
  if (section === "gallery") data.images = state?.gallery.images ?? [];
  if (section === "rotate") {
    const scenes = $$<HTMLInputElement>("#rotateScenes input:checked").map((el) => el.value);
    if (!scenes.length) throw new Error("Pick at least one scene to rotate through");
    data.scenes = scenes;
  }
  return data;
}

/** A timestamp as the value a datetime-local input expects, in this device's own time zone. */
function toLocalInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function addItem(item: ScheduleItem = { time: "", title: "", detail: "" }): HTMLElement {
  const template = $<HTMLTemplateElement>("#itemTemplate");
  const li = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  $<HTMLInputElement>(".time", li).value = item.time;
  $<HTMLInputElement>(".title", li).value = item.title;
  $<HTMLInputElement>(".detail", li).value = item.detail;
  $("#items").append(li);
  return li;
}

function fill(form: HTMLFormElement, s: State) {
  const section = sectionOf(form);
  const data = s[section] as unknown as Record<string, unknown>;
  for (const el of $$<Field>("[data-field]", form)) {
    const value = data[el.dataset.field!];
    const input = el as HTMLInputElement;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (input.type === "radio") input.checked = input.value === value;
    else el.value = String(value ?? "");
  }
  if (section === "countdown") $<HTMLInputElement>("#countdownTarget").value = toLocalInput(s.countdown.target);
  if (section === "schedule") {
    $("#items").replaceChildren();
    s.schedule.items.forEach(addItem);
  }
  if (section === "gallery") renderThumbs(s.gallery.images);
  if (section === "rotate") {
    for (const el of $$<HTMLInputElement>("#rotateScenes input")) {
      el.checked = s.rotate.scenes.includes(el.value as Scene);
    }
  }
}

for (const form of sectionForms) {
  // Once someone starts typing, incoming updates leave this form alone until it's saved.
  form.addEventListener("input", () => (form.dataset.dirty = ""));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const show = (event.submitter as HTMLElement | null)?.dataset.show;
    void run(
      async () => {
        const patch: Record<string, unknown> = { [sectionOf(form)]: collect(form) };
        if (show) patch.scene = show;
        await api("PATCH", "/api/state", patch);
        delete form.dataset.dirty;
        if (state) fill(form, state);
      },
      show ? "Saved and on screen" : "Saved",
    );
  });
}

$("#addItem").addEventListener("click", () => {
  $(".time", addItem()).focus();
  formFor("schedule").dataset.dirty = "";
});

$("#items").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!target.matches(".remove")) return;
  target.closest("li")?.remove();
  formFor("schedule").dataset.dirty = "";
});

$("#quick").addEventListener("click", (event) => {
  const minutes = Number((event.target as HTMLElement).dataset.minutes);
  if (!minutes) return;
  const form = formFor("countdown");
  void run(async () => {
    const countdown = { ...collect(form), target: Date.now() + minutes * 60_000 };
    await api("PATCH", "/api/state", { countdown, scene: "countdown" });
    delete form.dataset.dirty;
  }, `Counting down ${minutes} minutes`);
});

/* ---------- scene switcher, flash announcement, housekeeping ---------- */

$("#scenes").addEventListener("click", (event) => {
  const scene = (event.target as HTMLElement).dataset.scene;
  if (scene) void run(() => api("PATCH", "/api/state", { scene }));
});

$<HTMLFormElement>("#alertForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form));
  void run(async () => {
    await api("POST", "/api/alert", { ...data, seconds: Number(data.seconds) });
    $<HTMLInputElement>("[name=title]", form).value = "";
    $<HTMLTextAreaElement>("[name=body]", form).value = "";
  }, "Announcement sent");
});

$("#clearAlert").addEventListener("click", () => void run(() => api("DELETE", "/api/alert"), "Announcement cleared"));
$("#reloadScreens").addEventListener("click", () => void run(() => api("POST", "/api/reload"), "Screens refreshed"));

$("#reset").addEventListener("click", () => {
  if (!confirm("Reset every scene to its starting content? This can't be undone.")) return;
  for (const form of sectionForms) delete form.dataset.dirty;
  void run(() => api("POST", "/api/reset"), "Everything reset");
});

/* ---------- pictures ---------- */

const MAX_PIXELS = 1920;

function renderThumbs(images: GalleryImage[]) {
  const list = $("#galleryThumbs");
  list.replaceChildren(
    ...images.map((image) => {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = image.url;
      img.alt = "";
      img.loading = "lazy";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "thumb-remove";
      remove.textContent = "×";
      remove.title = "Remove this picture";
      remove.addEventListener("click", () => void run(() => api("DELETE", `/api/images/${image.id}`), "Removed"));
      li.append(img, remove);
      return li;
    }),
  );
  $("#galleryClear").hidden = !images.length;
  $("#galleryHint").textContent = images.length
    ? `${images.length} of 50 pictures. The biggest get a screen of their own.`
    : "Up to 50 pictures. They are shrunk here before they are sent, so phone photos are fine.";
}

/** Shrinks a picture in the browser, so a 12MP phone photo doesn't crawl through the venue wifi. */
async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number } | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, MAX_PIXELS / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  return blob ? { blob, width, height } : null;
}

$<HTMLInputElement>("#galleryFiles").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  void run(async () => {
    let added = 0;
    for (const file of files) {
      const shrunk = await shrink(file);
      if (!shrunk) {
        toast(`${file.name} isn't a picture I can read`, true);
        continue;
      }
      const res = await fetch(`/api/images?w=${shrunk.width}&h=${shrunk.height}`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: shrunk.blob,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; count?: number };
      if (res.status === 401) {
        showSignIn(data.error);
        throw new Error(data.error ?? "Sign in to add pictures");
      }
      if (!res.ok) throw new Error(data.error ?? "That picture didn't upload");
      added += 1;
    }
    formFor("gallery").dataset.dirty = "";
    if (state) renderThumbs(state.gallery.images);
    void prime();
    toast(`${added} ${added === 1 ? "picture" : "pictures"} added`);
  });
});

$("#galleryClear").addEventListener("click", () => {
  const images = state?.gallery.images ?? [];
  if (!images.length) return;
  if (!confirm(`Remove all ${images.length} pictures?`)) return;
  void run(async () => {
    for (const image of images) await api("DELETE", `/api/images/${image.id}`);
    delete formFor("gallery").dataset.dirty;
    if (state) renderThumbs(state.gallery.images);
    void prime();
  }, "Pictures removed");
});

/* ---------- live updates ---------- */

let displays = 0;
let online = false;

function renderStatus() {
  const el = $("#status");
  el.dataset.state = online ? "live" : "offline";
  el.textContent = online
    ? `Live · ${displays} ${displays === 1 ? "screen" : "screens"} connected`
    : "Reconnecting…";
}

function render(s: State) {
  for (const form of sectionForms) {
    if (!("dirty" in form.dataset)) fill(form, s);
    const scene = sectionOf(form) as Scene;
    form.classList.toggle("live", s.scene === scene || (s.scene === "rotate" && s.rotate.scenes.includes(scene)));
  }
  for (const button of $$("#scenes button")) {
    button.setAttribute("aria-pressed", String(button.dataset.scene === s.scene));
  }
  $("#clearAlert").hidden = !s.alert;
}

let lastRev = -1;

function applyState(next: State, config?: { eventName: string }) {
  if (next.rev === lastRev) return;
  lastRev = next.rev;
  state = next;
  if (config) {
    $("#eventName").textContent = config.eventName;
    document.title = `Telecast · ${config.eventName}`;
  }
  render(next);
}

/**
 * The socket is the fast path, but a venue proxy can hold it open while swallowing everything sent
 * down it, which used to leave the panel showing empty forms. So the panel also asks for the state
 * over plain HTTP every few seconds and takes whichever arrives first.
 */
async function prime() {
  try {
    const res = await fetch(`/api/state?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { state?: State; config?: { eventName: string } };
    if (data.state) applyState(data.state, data.config);
  } catch {
    // A dropped poll is not worth a message; the next one is three seconds away.
  }
}

setInterval(() => {
  if (!document.hidden) void prime();
}, 3000);
void prime();

connect(
  "control",
  (message) => {
    if (message.type === "state") {
      applyState(message.state, message.config);
    } else if (message.type === "stats") {
      displays = message.displays;
      renderStatus();
    }
  },
  (isOnline) => {
    online = isOnline;
    renderStatus();
  },
);

/* ---------- preview ---------- */

// The preview is the real display page at 1920×1080, shrunk to fit, so it matches the venue screens exactly.
const preview = $("#preview");
new ResizeObserver(([entry]) => {
  if (entry) $("iframe", preview).style.transform = `scale(${entry.contentRect.width / 1920})`;
}).observe(preview);

void loadMe();

/* ---------- connected screens ---------- */

interface Person {
  id: string;
  name: string;
  pin: string;
  role: "admin" | "controller";
  owner?: boolean;
}

const screensList = document.getElementById("screensList");
const peoplePanel = document.getElementById("peoplePanel");
const peopleList = document.getElementById("peopleList");
const personForm = document.getElementById("personForm") as HTMLFormElement | null;

function say(message: string): void {
  toast(message);
}

async function refreshScreens(): Promise<void> {
  if (!screensList) return;
  try {
    const data = await api<{ screens: string[] }>("GET", "/api/screens");
    const names = data.screens.length ? data.screens : ["No screens are connected right now."];
    screensList.replaceChildren(
      ...names.map((name) => {
        const li = document.createElement("li");
        li.textContent = name;
        return li;
      }),
    );
  } catch {
    /* signed out: nothing to show yet */
  }
}

function personRow(person: Person): HTMLElement {
  const row = document.createElement("div");
  row.className = "person-row";

  const name = document.createElement("input");
  name.value = person.name;
  name.setAttribute("aria-label", "Name");
  name.maxLength = 40;

  const pin = document.createElement("input");
  pin.value = person.pin;
  pin.setAttribute("aria-label", "PIN");
  pin.maxLength = 40;

  const role = document.createElement("select");
  role.setAttribute("aria-label", "Role");
  for (const value of ["admin", "controller"] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "admin" ? "Admin" : "Controller";
    option.selected = person.role === value;
    role.append(option);
  }
  // The first admin comes from the environment, so it can be renamed and re-pinned but stays an admin.
  role.disabled = Boolean(person.owner);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "button";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    void (async () => {
      try {
        await api("PATCH", "/api/people", {
          id: person.id,
          name: name.value,
          pin: pin.value,
          role: role.value,
        });
        say(`Saved ${name.value}`);
        await refreshPeople();
        await loadMe();
      } catch (err) {
        say(err instanceof Error ? err.message : "Could not save that");
      }
    })();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button ghost";
  remove.textContent = "Remove";
  remove.disabled = Boolean(person.owner);
  remove.addEventListener("click", () => {
    void (async () => {
      try {
        await api("DELETE", "/api/people", { id: person.id });
        say(`${person.name} removed`);
        await refreshPeople();
      } catch (err) {
        say(err instanceof Error ? err.message : "Could not remove them");
      }
    })();
  });

  row.append(name, pin, role, save, remove);
  return row;
}

async function refreshPeople(): Promise<void> {
  if (!peoplePanel || !peopleList) return;
  try {
    const data = await api<{ people: Person[]; me: string }>("GET", "/api/people");
    peoplePanel.hidden = false;
    peopleList.replaceChildren(...data.people.map(personRow));
  } catch {
    // Controllers and signed-out visitors get 403/401 here; the panel stays hidden.
    peoplePanel.hidden = true;
  }
}

personForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("personName") as HTMLInputElement | null;
  const pin = document.getElementById("personPin") as HTMLInputElement | null;
  const role = document.getElementById("personRole") as HTMLSelectElement | null;
  if (!name || !pin || !role) return;
  void (async () => {
    try {
      await api("POST", "/api/people", { name: name.value, pin: pin.value, role: role.value });
      say(`${name.value.trim()} can now sign in`);
      name.value = "";
      pin.value = "";
      await refreshPeople();
    } catch (err) {
      say(err instanceof Error ? err.message : "Could not add them");
    }
  })();
});

function refreshPanel(): void {
  if (document.hidden) return;
  void refreshScreens();
  void refreshPeople();
}

refreshPanel();
setInterval(refreshPanel, 5000);
