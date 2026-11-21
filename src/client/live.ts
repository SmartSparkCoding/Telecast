/** The live connection both pages use: a WebSocket that reconnects by itself and notices when it has gone quiet. */
import type { Role, ServerMessage } from "../shared/types.ts";

/** Typed lookup that fails loudly if the markup and the script drift apart. */
export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] => [
  ...root.querySelectorAll<T>(selector),
];

const PING_EVERY = 15_000;
const QUIET_FOR = 40_000;

export interface Live {
  /** Milliseconds since anything was last heard from the server. */
  silence(): number;
  close(): void;
  reopen(): void;
}

export function connect(
  role: Role,
  onMessage: (message: ServerMessage) => void,
  onStatus: (online: boolean) => void = () => {},
  hello?: () => unknown,
): Live {
  let socket: WebSocket | undefined;
  let lastHeard = Date.now();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function open() {
    clearTimeout(retry);
    closed = false;
    const url = new URL(`/ws?role=${role}`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener("open", () => {
      lastHeard = Date.now();
      onStatus(true);
      if (hello) ws.send(JSON.stringify(hello()));
    });
    ws.addEventListener("message", (event) => {
      lastHeard = Date.now();
      if (event.data === "pong") return;
      onMessage(JSON.parse(String(event.data)) as ServerMessage);
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      onStatus(false);
      if (!closed) retry = setTimeout(open, 1500);
    });
  }

  setInterval(() => {
    if (closed) return;
    if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    // A connection can die without closing (Wi-Fi drop, sleeping TV); if so, start a new one.
    if (Date.now() - lastHeard > QUIET_FOR) {
      lastHeard = Date.now() - QUIET_FOR / 2;
      socket?.close();
      open();
    }
  }, PING_EVERY);

  open();

  return {
    silence: () => Date.now() - lastHeard,
    close() {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    },
    reopen: open,
  };
}
