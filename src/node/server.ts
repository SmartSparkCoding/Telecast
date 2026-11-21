/**
 * The Node host, used by the Docker image: serves the built pages, keeps state in a JSON file and
 * pushes changes to browsers over WebSockets.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Telecast, type Host, type Saved } from "../core/telecast.ts";
import type { Role } from "../shared/types.ts";

/** Set by the build; screens reload when it changes, so a redeploy reaches them without touching a TV. */
declare const __BUILD_ID__: string;

const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PORT = Number(process.env.PORT) || 8080;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};


let saving: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;

const host: Host = {
  async read() {
    try {
      return JSON.parse(await readFile(STATE_FILE, "utf8")) as Saved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Could not read saved state, starting from defaults:", (err as Error).message);
      }
      return undefined;
    }
  },

  write(saved) {
    const data = JSON.stringify(saved, null, 2);
    // Write-then-rename, queued, so a crash or two quick edits can't leave a half-written file.
    saving = saving
      .then(async () => {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(`${STATE_FILE}.tmp`, data, { mode: 0o600 });
        await rename(`${STATE_FILE}.tmp`, STATE_FILE);
      })
      .catch((err: Error) => console.error("Could not save state:", err.message));
    return saving;
  },

  send(message, to) {
    for (const [socket, page] of sockets) {
      if ((to === "all" || to === page.role) && socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  },

  displays: () => [...sockets.values()].filter((page) => page.role === "display").length,

  screens: () => [
    ...new Set(
      [...sockets.values()]
        .filter((page) => page.role === "display" && page.name)
        .map((page) => page.name),
    ),
  ],

  wake(at) {
    clearTimeout(timer);
    if (at === null) return;
    // setTimeout can't wait longer than about 24 days; alarm() re-arms itself if it fires early.
    timer = setTimeout(() => void telecast.alarm(), Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
  },
};

const sockets = new Map<WebSocket, { role: Role; name: string }>();

const telecast = new Telecast(host, process.env, __BUILD_ID__);

/** The address the browser used, which a reverse proxy passes along in forwarding headers. */
function requestUrl(req: http.IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
  const hostname = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0]!.trim();
  return `${proto}://${hostname}${req.url ?? "/"}`;
}

async function toRequest(req: http.IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 200_000) break;
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(requestUrl(req), { method: req.method, headers, body });
}

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/control" || rel === "/control/") rel = "/control.html";
  const file = path.join(PUBLIC, rel);
  try {
    if (!file.startsWith(PUBLIC + path.sep)) throw new Error("outside public");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": info.size,
      // Pages and scripts always revalidate so a deploy shows up at once; artwork can be cached.
      "Cache-Control": /\.(webp|png|jpg|svg|ico|woff2)$/.test(file) ? "public, max-age=86400" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "frame-ancestors 'self'",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
      return await sendResponse(res, await telecast.fetch(await toRequest(req)));
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return void res.writeHead(405, { "Content-Type": "text/plain" }).end("Method not allowed");
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") return void socket.destroy();
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const role: Role = url.searchParams.get("role") === "control" ? "control" : "display";
    ws.on("message", (data) => {
      const text = data.toString();
      if (text === "ping") return void ws.send("pong");
      if (text.startsWith("{")) {
        // A display introduces itself once it knows its name, so the panel can list the screens.
        try {
          const hello = JSON.parse(text) as { type?: string; name?: unknown };
          if (hello.type === "hello" && typeof hello.name === "string") {
            const page = sockets.get(ws);
            if (page) {
              page.name = hello.name.trim().slice(0, 40) || page.name;
              telecast.connectionsChanged();
            }
          }
        } catch {
          /* not for us */
        }
      }
    });
    ws.on("close", () => {
      sockets.delete(ws);
      telecast.connectionsChanged();
    });
    ws.on("error", () => ws.terminate());
    ws.send(await telecast.greeting());
    sockets.set(ws, { role, name: "" });
    telecast.connectionsChanged();
  });
});

async function main() {
  await telecast.ready();
  if (!process.env.TELECAST_PIN?.trim()) {
    console.warn(
      "TELECAST_PIN isn't set, so the control panel opens with the default PIN 000000. " +
        "Set TELECAST_PIN before the doors open.",
    );
  }
  server.listen(PORT, () => console.log(`Telecast: screens on http://localhost:${PORT}, control panel on /control`));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void saving.finally(() => process.exit(0)));
}

void main();
