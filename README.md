# NOROSA · نورسا

**A cryptographic meeting room where the server sees nothing.**

NOROSA is a browser-based, end‑to‑end‑encrypted meeting and streaming suite. Two peers exchange Olm‑grade identity keys through a **blind relay**, negotiate a double ratchet, and broadcast screen, system audio, and microphone — all blended and encrypted on the device. The relay stores only public keys, room codes, and a member count.

---

## Feature highlights

- **End‑to‑end encryption** — session + group (Megolm) keys live only in the device vault; plaintext never leaves the browser.
- **Passphrase vault** — identity, ratchet, and group state are pickled into IndexedDB and re‑locked with a passphrase every session (`PBKDF2‑SHA256 · 600k`), so a copied store is useless without it.
- **Blind relay** — a stateless WebSocket gate (`norosa-relay`) that routes ciphertext and autoreserves *one* one‑time pre‑key per peer pair, so a pre‑key can never be drained by a third party.
- **Auto‑reconnecting peers** — transport + encryption layers re‑arm on network drops; stale aliases are re‑minted on every reconnect.
- **Streaming Room dashboard** (`src/streaming/StreamingRoom.tsx`) — screen + system audio + mic capture blended into a **single output track**, downstream‑only viewer mode (no echo / feedback), volume + quick‑mute, fullscreen stage, self‑healing permission handling.
- **Luxury dark brand** — `#0B0F19` ground, indigo primary, glassmorphic panels, neon‑emerald live indicators.

## Threat model at a glance

| What | Where it lives |
|---|---|
| Identity account, private keys, ratchet state | IndexedDB on the device, wrapped by a passphrase KEK |
| Curves + ciphertext | In transit, end‑to‑end |
| Identity key, room code, member count | Relay database (public by design) |
| Anything else | Nowhere on the server (see `server/src/db.ts`) |

## Repository layout

```
├── src/                     # Web client (React 19 · Vite · Tailwind v4)
│   ├── e2ee/                # Olm double ratchet / Megolm, relay link, vault, IDB
│   ├── context/             # E2E provider wiring
│   └── streaming/           # StreamingRoom dashboard + Web Audio mixer
├── server/                  # Node blind relay (ws · better-sqlite3)
│   └── src/                 #   db.ts, index.ts, wire protocol
├── public/                  # Olm WASM
├── guidelines/              # Visual brand guidelines (dark immersive)
└── index.html · vite.config.ts
```

## Getting started

### 1. Relay server

```bash
cd server
npm install
npm run build
npm start            # ws://0.0.0.0:8081 (DB_PATH and PORT env vars optional)
```

### 2. Web client

```bash
npm install
npm run dev          # Vite dev server; set VITE_RELAY_URL to your relay
```

The client connects to `VITE_RELAY_URL` (defaults to `ws://localhost:8081`), mints/joins a room by code, and begins an encrypted session with the first peer it finds.

### Production build

```bash
npm run build        # emits to dist/
```

## StreamingRoom integration

Drop the dashboard anywhere with three wiring hooks — the component owns all media:

```tsx
import { StreamingRoom } from './streaming/StreamingRoom'

<StreamingRoom
  audience={42}
  onStartBroadcast={(output) => mySignaling.send(output)}
  onViewStart={async () => mySignaling.requestHostStream()}
/>
```

- `onStartBroadcast(output)` — called when the host reaches **live**; `output` is the single blended track (screen + system audio + mic).
- `onViewStart` / `onViewEnd` — viewer‑side downstream‑only hooks. When omitted, a local test tone lets you verify audio without a peer.
- Media is 100% local: delivery is intentionally your responsibility (no signaling is bundled).

## Scripts

| Project | Command | Purpose |
|---|---|---|
| client | `npm run dev` | Vite dev server |
| client | `npm run build` | Production build |
| client | `npm run format` | oxfmt formatting |
| server | `npm run dev` | tsx watch |
| server | `npm run build` | tsc → `dist/` |
| server | `npm run typecheck` | typecheck only |

## License

MIT — see [LICENSE](LICENSE).