# Telecast

Live screens for an event venue, with a control panel for the organisers. Built for
[Haven London](https://haven.london); this copy runs the
[Ashford School Christmas Fair](https://pfa.navaratne.uk/).

- `/` is the screen. Open it on each TV or projector and click once (or press F) to go full screen.
- `/control` is the organisers' panel. Type the PIN to get in; it works on a phone, and every change
  reaches every screen straight away.

One deployment runs one event.

## What it can show

| Scene | What it is |
| --- | --- |
| Clock | The default. The time, a welcome line, what's next, and stickers drifting about. |
| Schedule | A departure board of the day. Marks what's on now and next by itself. |
| Countdown | Counts down to a time, then shows a closing line. |
| Message | A full-screen card that stays up until the scene changes. |
| Website | Any web page, embedded full screen. |
| Rotation | Cycles through a chosen set of the scenes above. |

On top of any scene: a **flash announcement** (takes over for a set time, then goes away) and a
scrolling **ticker** along the bottom.

## Who can get in

`TELECAST_PIN` is the first admin's PIN, and `TELECAST_ADMIN_NAME` names them. Everyone else is
added from the **People** panel in `/control`: give them a name, a PIN of their own, and a role.

- **Admins** change what is on the screens, add people, change anyone's PIN, and read PINs back.
- **Controllers** change what is on the screens. They can't add people or see anyone else's PIN.

PINs are stored as typed in `state.json`, because an admin has to be able to read one out when
somebody forgets theirs. Keep that file to yourself. The first admin can be renamed and re-PINned
but never removed, so the panel can't lock itself out.

Each screen names itself the first time it is opened (a prompt, remembered in that browser's
storage), and the **Screens** panel lists every display that is connected right now.

## The PIN

No accounts, no Slack app. The control panel asks for one PIN, and everyone who knows it can change
what's on the screens.

| Variable | Purpose |
| --- | --- |
| `TELECAST_PIN` | The panel's PIN. If it isn't set it falls back to `000000`, and the server warns on boot. |
| `PUBLIC_URL` | Optional. The public address, if a proxy in front doesn't pass it along. |
| `PORT` | Optional. Defaults to `8080`; the deploy script uses `12345`. |
| `DATA_DIR` | Optional. Where the state and cookie key are kept. Defaults to `./data`. |

Eight wrong tries from one address locks that address out for ten minutes. The PIN is only a lock on
the control panel, so treat it like a door code: change it from the default before the doors open,
and don't put it on a poster.

## Hosting

### One command on a Linux server

```bash
curl -fsSL https://raw.githubusercontent.com/SmartSparkCoding/Telecast/main/deploy.sh | bash
```

It needs `git` and `curl` (or `wget`). If the machine has no Node 22 or newer, the script downloads one
into `~/.local/node` and uses it for that run, so a box still on Node 20 from the distro works as-is.
Override it with `NODE_DIR` if you'd rather keep it somewhere else.

Clones into `~/telecast`, installs, builds, writes `.env` with `PORT=12345` and `TELECAST_PIN=000000`,
then runs the server in the background and waits for it to answer. Override with env vars:

```bash
PORT=8080 TELECAST_PIN=4821 DIR=/opt/telecast bash deploy.sh
```

Screens end up on `http://<server>:12345`, the panel on `http://<server>:12345/control`. Logs go to
`~/telecast/telecast.log`.

That copy dies with the machine. If it should come back after a reboot or a crash, use the service
installer instead.

### One command, and systemd keeps it up

```bash
curl -fsSL https://raw.githubusercontent.com/SmartSparkCoding/Telecast/main/install-service.sh | sudo bash
```

Clones into `/opt/telecast`, installs and builds, writes `/etc/telecast.env`, then installs and starts
`telecast.service` with `Restart=always` and `WantedBy=multi-user.target`, so it starts again on boot.
It also fetches Node 22 into `/opt/node22` if the machine's own Node is too old, stops a copy
`deploy.sh` left running, and waits for `/api/health` before it says it worked. Run the same command
again to update: it pulls, rebuilds and restarts, and it keeps the PIN and port already in
`/etc/telecast.env`.

```bash
PORT=8080 TELECAST_PIN=4821 PUBLIC_URL=https://screens.example.com \
  curl -fsSL https://raw.githubusercontent.com/SmartSparkCoding/Telecast/main/install-service.sh | sudo -E bash
```

`PUBLIC_URL` matters when something sits in front of the server: the panel refuses writes whose
`Origin` doesn't match an address the server knows about, and the quietest way to satisfy that behind
a proxy is to tell it the address people actually type.

| Command | What it does |
| --- | --- |
| `journalctl -u telecast -f` | Follow the server's output. |
| `systemctl restart telecast` | Restart it. |
| `systemctl disable --now telecast` | Stop it and stop it coming back on boot. |

### Docker

```bash
docker build -t telecast .
```

```bash
docker run -p 8080:8080 --env-file .env -v telecast:/data telecast
```

The volume at `/data` keeps what's on screen and the cookie-signing key across redeploys. `PORT` and
`DATA_DIR` can be changed if needed. A proxy in front must allow WebSockets on `/ws` and pass
`X-Forwarded-Proto` and `X-Forwarded-Host` (or set `PUBLIC_URL`).

### Cloudflare Workers

Runs as a Worker with static assets and one Durable Object (works on the free plan).

```bash
pnpm exec wrangler secret put TELECAST_PIN
```

Then:

```bash
pnpm deploy:worker
```

Add your domain under the Worker's settings, or as a `routes` entry in `wrangler.jsonc`.

Either way, screens reconnect by themselves and reload by themselves after a redeploy. A screen also
pulls `/api/state` over plain HTTP on load and every few seconds, so it still shows something on a
network that blocks WebSockets.

## Making it yours

Everything specific to an event is in two places:

- **[`telecast.config.ts`](telecast.config.ts):** the event's name, time zone, sticker list and the
  content the screens start with (schedule, welcome line and so on).
- **[`public/theme/`](public/theme):** `theme.css` (fonts, colours, backdrop), `logo.webp`,
  `background.webp`, `mascot.webp` and `stickers/`. Replace the files and adjust the CSS variables.

The backdrop and the wordmark in this copy were drawn for the Ashford School Christmas Fair: a night
scene with string lights and a snowy "Ashford School Christmas Fair" logo. The snowman mascot and the
ten stickers (candy cane, bauble, gingerbread, holly, present, snowflake, bell, tree, wreath,
hot drink) come from [publicdomainvectors.org](https://publicdomainvectors.org), which
releases its clip art into the public domain: no attribution needed, no licence to track. See
[`public/theme/CREDITS.md`](public/theme/CREDITS.md).

## Developing

Needs Node 22.18 or newer.

```bash
npm install
```

```bash
npm run build && PORT=12345 TELECAST_PIN=000000 npm start
```

`npm run dev` builds and starts in one go, reading `.env` if there is one. `npm run dev:worker` runs
the Cloudflare version locally.

| Folder | What's in it |
| --- | --- |
| `src/core` | The state, API and PIN sign-in, written against web standards so both hosts share it. |
| `src/node` | The Docker host: HTTP, WebSockets, a JSON file for storage. |
| `src/worker` | The Cloudflare host: a Worker and a Durable Object. |
| `src/client` | The screen (`display.ts`) and control panel (`control.ts`). |
| `src/shared` | Types used on both sides. |
| `public` | Pages, styles and the theme. |

To add a scene: a `<section class="scene" data-scene="…">` in `public/index.html`, its type in
`src/shared/types.ts`, its clean-up rule in `src/core/state.ts`, and a form in `public/control.html`.

`npm run typecheck` checks all three targets.
