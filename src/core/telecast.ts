/**
 * Telecast itself: the state, the API and the PIN sign-in. It only uses web-standard Request and
 * Response, and reaches storage, sockets and timers through a small Host interface, so the same
 * code runs under Node (Docker) and in a Cloudflare Durable Object.
 */
import config from "../../telecast.config.ts";
import type { Me, PublicConfig, Role, ServerMessage, State } from "../shared/types.ts";
import { cookie, randomToken, readCookie, seal, unseal } from "./session.ts";
import { applyPatch, freshState, newAlert, restoreState } from "./state.ts";

export interface Env {
  /** The PIN the organisers type to open the control panel. Falls back to 000000, loudly. */
  TELECAST_PIN?: string;
  /** The address people use, e.g. https://fair.example.org. Needed when a proxy hides it. */
  PUBLIC_URL?: string;
}

/** What gets written to disk or Durable Object storage. */
export interface Saved {
  state: unknown;
  /** Signs session cookies. Made once on first run, so there's no secret to configure. */
  secret: string;
}

export interface Host {
  read(): Promise<Saved | undefined>;
  write(saved: Saved): Promise<void>;
  /** Sends a message to connected pages: every one, or only control panels. */
  send(message: string, to: "all" | Role): void;
  /** How many venue screens are connected. */
  displays(): number;
  /** Asks for `alarm()` to be called at this time; null cancels. */
  wake(at: number | null): void | Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_COOKIE = "telecast_session";
const SESSION_DAYS = 7;

/** Used when TELECAST_PIN isn't set, so a fresh clone still opens. The host warns about it at boot. */
const FALLBACK_PIN = "000000";

/** Wrong PINs allowed from one address inside TRY_WINDOW before it has to wait. */
const TRIES = 8;
const TRY_WINDOW = 10 * 60_000;

/** What's inside a signed-in session cookie. */
interface Session {
  name: string;
}

const publicConfig: PublicConfig = {
  eventName: config.eventName,
  timeZone: config.timeZone,
  stickers: config.stickers,
  mascot: config.mascot,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 100_000) throw new HttpError(413, "That's too much to save at once");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Compares two short strings without leaking where they first differ. */
function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export class Telecast {
  private state: State = freshState(config.defaults);
  private secret = "";
  private loading?: Promise<void>;
  /** Recent wrong PINs, by address. In memory: a restart is not a bypass worth worrying about. */
  private readonly tries = new Map<string, number[]>();

  constructor(
    private readonly host: Host,
    private readonly env: Env,
    /** Changes with each deploy; screens reload themselves when they see a new one. */
    private readonly build: string,
  ) {}

  /** Loads saved state once. Everything public awaits this first. */
  ready(): Promise<void> {
    return (this.loading ??= this.load());
  }

  private async load(): Promise<void> {
    const saved = await this.host.read();
    if (saved) {
      this.state = restoreState(config.defaults, saved.state);
      this.secret = saved.secret ?? "";
    }
    if (!this.secret) {
      this.secret = randomToken();
      await this.persist();
    }
    await this.armAlert();
  }

  private persist(): Promise<void> {
    return this.host.write({ state: this.state, secret: this.secret });
  }

  /* ---------- live connections ---------- */

  private stateMessage(): string {
    const message: ServerMessage = {
      type: "state",
      state: this.state,
      config: publicConfig,
      now: Date.now(),
      build: this.build,
    };
    return JSON.stringify(message);
  }

  /** The first thing a newly connected page is sent. */
  async greeting(): Promise<string> {
    await this.ready();
    return this.stateMessage();
  }

  /** Call when a page connects or disconnects, so control panels can show how many screens are live. */
  connectionsChanged(): void {
    const message: ServerMessage = { type: "stats", displays: this.host.displays() };
    this.host.send(JSON.stringify(message), "control");
  }

  private async commit(): Promise<void> {
    this.state.rev += 1;
    this.host.send(this.stateMessage(), "all");
    await this.persist();
  }

  /* ---------- flash announcements ---------- */

  private async armAlert(): Promise<void> {
    await this.host.wake(this.state.alert?.expiresAt ?? null);
  }

  /** Called by the host at the time last given to `wake`. */
  async alarm(): Promise<void> {
    await this.ready();
    const expiresAt = this.state.alert?.expiresAt;
    if (!expiresAt) return;
    if (expiresAt > Date.now()) return void (await this.armAlert());
    this.state.alert = null;
    await this.commit();
  }

  /* ---------- who is asking ---------- */

  private origin(request: Request): string {
    return (this.env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, "");
  }

  /** Every host this request could legitimately have come from. */
  private hosts(request: Request): Set<string> {
    const hosts = new Set<string>();
    const add = (value: string | null | undefined) => {
      if (!value) return;
      for (const part of value.split(",")) {
        const raw = part.trim();
        if (!raw) continue;
        try {
          hosts.add(new URL(raw.includes("://") ? raw : `http://${raw}`).host.toLowerCase());
        } catch {
          // not an address, skip it
        }
      }
    };
    add(request.url);
    add(request.headers.get("host"));
    add(request.headers.get("x-forwarded-host"));
    add(this.origin(request));
    return hosts;
  }

  /**
   * A write has to come from one of this site's own addresses. Hosts are compared rather than
   * whole origins, because behind a proxy the browser's https:// origin and the host header the
   * server sees often disagree about the scheme, which refused every login.
   */
  private sameSite(request: Request): boolean {
    const from = request.headers.get("Origin");
    if (!from) return true; // no Origin header: a command-line client; the session cookie still guards writes
    try {
      return this.hosts(request).has(new URL(from).host.toLowerCase());
    } catch {
      return false;
    }
  }

  /** True when the browser got here over https, even if a proxy talks plain http to us. */
  private isSecure(request: Request): boolean {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (proto === "https" || proto === "http") return proto === "https";
    const from = request.headers.get("Origin");
    if (from) return from.startsWith("https:");
    return new URL(request.url).protocol === "https:";
  }

  private pin(): string {
    return (this.env.TELECAST_PIN ?? "").trim() || FALLBACK_PIN;
  }

  private address(request: Request): string {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return request.headers.get("cf-connecting-ip") || forwarded || "local";
  }

  private throttled(address: string): boolean {
    const now = Date.now();
    const recent = (this.tries.get(address) ?? []).filter((at) => now - at < TRY_WINDOW);
    if (recent.length) this.tries.set(address, recent);
    else this.tries.delete(address);
    return recent.length >= TRIES;
  }

  private async user(request: Request): Promise<Session> {
    const session = await unseal<Session>(readCookie(request, SESSION_COOKIE), this.secret);
    if (!session) throw new HttpError(401, "Enter the PIN to make changes");
    return session;
  }

  /* ---------- http ---------- */

  /** Answers /api/* and /auth/*. The host serves static files and sockets itself. */
  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready();
      const url = new URL(request.url);

      // Session cookies are SameSite=Lax; this also refuses cross-site writes from older browsers.
      if (request.method !== "GET" && !this.sameSite(request)) {
        console.error(
          `Refused a ${request.method} from ${request.headers.get("Origin")}; this server answers as ${[...this.hosts(request)].join(", ")}. Set PUBLIC_URL if it is behind a proxy.`,
        );
        throw new HttpError(403, "Cross-site request refused");
      }

      if (url.pathname.startsWith("/auth/")) return await this.auth(request, url);
      return await this.api(request, url);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: "Something went wrong on the server" });
    }
  }

  private async auth(request: Request, url: URL): Promise<Response> {
    const route = `${request.method} ${url.pathname}`;
    const secure = this.isSecure(request);
    const maxAge = SESSION_DAYS * 86_400;

    if (route === "POST /auth/login") {
      const address = this.address(request);
      if (this.throttled(address)) {
        throw new HttpError(429, "Too many tries. Wait ten minutes and try again.");
      }
      const { pin } = (await readJson(request)) as { pin?: unknown };
      // Spaces and dashes are how people write 012 345 down, so they're ignored.
      const typed = typeof pin === "string" ? pin.replace(/[\s-]/g, "") : "";
      if (!typed) throw new HttpError(400, "Type the PIN");

      if (!sameSecret(typed, this.pin().replace(/[\s-]/g, ""))) {
        const recent = this.tries.get(address) ?? [];
        recent.push(Date.now());
        this.tries.set(address, recent);
        throw new HttpError(401, "That PIN isn't right");
      }

      this.tries.delete(address);
      const session = await seal({ name: "Organiser" } satisfies Session, Date.now() + maxAge * 1000, this.secret);
      return json(200, { ok: true }, { "Set-Cookie": cookie(SESSION_COOKIE, session, maxAge, secure) });
    }

    if (route === "POST /auth/logout") {
      return json(200, { ok: true }, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0, secure) });
    }

    throw new HttpError(404, "Not found");
  }

  private async api(request: Request, url: URL): Promise<Response> {
    const route = `${request.method} ${url.pathname}`;

    // What's on screen is public by nature, so reading it needs no sign-in.
    if (route === "GET /api/state") return new Response(this.stateMessage(), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (route === "GET /api/health") return json(200, { ok: true, displays: this.host.displays(), pin: Boolean((this.env.TELECAST_PIN ?? "").trim()) });

    if (route === "GET /api/me") {
      const session = await this.user(request);
      const me: Me = { user: { name: session.name } };
      return json(200, me);
    }

    await this.user(request);

    if (route === "PATCH /api/state") {
      applyPatch(this.state, await readJson(request));
      await this.commit();
      return json(200, { ok: true, rev: this.state.rev });
    }

    if (route === "POST /api/alert") {
      const alert = newAlert(await readJson(request), randomToken(6), Date.now());
      if (!alert) throw new HttpError(400, "An announcement needs a title or a message");
      this.state.alert = alert;
      await this.armAlert();
      await this.commit();
      return json(200, { ok: true });
    }

    if (route === "DELETE /api/alert") {
      this.state.alert = null;
      await this.armAlert();
      await this.commit();
      return json(200, { ok: true });
    }

    if (route === "POST /api/reset") {
      this.state = freshState(config.defaults, this.state.rev);
      await this.armAlert();
      await this.commit();
      return json(200, { ok: true });
    }

    if (route === "POST /api/reload") {
      const message: ServerMessage = { type: "reload" };
      this.host.send(JSON.stringify(message), "all");
      return json(200, { ok: true });
    }

    throw new HttpError(404, "Not found");
  }
}
