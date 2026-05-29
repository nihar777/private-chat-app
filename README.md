# 🔒 Private Chat — Ephemeral Two-User Socket Chat

A free, real-time, **1-to-1 chat** built with **React** (Vite) + **Socket.IO**.

- One user **creates a room** and gets a 6-character code.
- The other user **joins** with that code.
- Both chat in real time over a live WebSocket.
- When **both users leave or close the tab, the room and all messages vanish forever** — nothing is ever written to a database or disk.

---

## How "disappearing" works

There is **no persistence by design**:

| Layer | Where messages live | When they disappear |
|-------|--------------------|---------------------|
| **Server** | Messages are **never stored** — only relayed between the two sockets. The room is a `Map` entry in memory holding only its member set. | The room entry is deleted the instant its member count hits `0` (last person leaves/closes). |
| **Client** | Messages live only in React state (`useState`). | Refreshing, closing the tab, or leaving the room clears them. |

Because the room is removed when empty, the code can never be rejoined — the conversation is gone.

---

## Project structure

```
PrivateChatApp/
├── server/            # Express + Socket.IO relay (in-memory, ephemeral)
│   ├── index.js
│   └── package.json
├── client/            # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx     # lobby + chat UI
│   │   ├── socket.js   # shared socket.io-client
│   │   ├── main.jsx
│   │   └── styles.css
│   ├── index.html
│   └── package.json
└── README.md
```

---

## Run locally

Open **two terminals**.

### 1. Server

```bash
cd server
npm install
npm start          # http://localhost:4000
```

### 2. Client

```bash
cd client
npm install
npm run dev        # http://localhost:5173
```

### 3. Try it

1. Open **http://localhost:5173** → click **Create a room** → copy the code.
2. Open a **second browser tab/window** (or another device) → paste the code → **Join**.
3. Chat. Close one tab, then the other → the room is destroyed server-side.

---

## Deploy (free) — Render, combined single service

The server serves the built React app **and** Socket.IO from one origin, so you
deploy **one** service. No CORS, one URL.

### Local production check

```bash
npm run build      # installs server+client, builds React to client/dist
npm start          # NODE_ENV=production, serves everything on :4000
# open http://localhost:4000
```

### Deploy to Render (free tier)

1. Push this repo to GitHub.
2. Go to **render.com** → **New** → **Blueprint** → pick your repo.
   Render reads [`render.yaml`](render.yaml) and configures everything:
   - build: `npm run build`
   - start: `npm start`
   - health check: `/health`
   - `NODE_ENV=production` (PORT is injected by Render)
3. Click **Apply**. First build ~2–3 min. You get a URL like
   `https://private-chat.onrender.com`.
4. Share it. One person **Create room**, the other **Join** with the code.

**Free-tier note:** the instance sleeps after ~15 min idle; the next visit
cold-starts (~30 s). Fine for occasional 1-to-1 use. To kill sleep, upgrade to a
paid instance.

> No manual env vars needed. The client auto-detects: same-origin in prod,
> `localhost:4000` in dev. Override with `VITE_SERVER_URL` only for a split deploy.

### Other hosts

Any always-on Node host with WebSocket support works the same way
(`npm run build` then `npm start`): Railway, Fly.io, a VPS, etc. Avoid
serverless/Functions platforms — Socket.IO needs a long-lived process.

---

## Features

- ✅ Create / join rooms with a short code
- ✅ Real-time messaging over WebSocket
- ✅ Max **2 users** per room (extra joiners rejected)
- ✅ Typing indicator
- ✅ Presence: "Stranger joined" / "Stranger left"
- ✅ Auto-cleanup on disconnect, leave, or tab close
- ✅ Zero database, zero message history

---

## Socket events (API)

**Client → Server**

| Event | Payload | Notes |
|-------|---------|-------|
| `create-room` | `cb(res)` | returns `{ ok, roomId }` |
| `join-room` | `{ roomId }, cb(res)` | returns `{ ok, members }` or `{ ok:false, error }` |
| `send-message` | `{ text }` | relayed to peer, not stored |
| `typing` | `boolean` | typing indicator |
| `leave-room` | — | leave + maybe destroy room |

**Server → Client**

| Event | Payload | Notes |
|-------|---------|-------|
| `peer-joined` | `{ members }` | other user joined |
| `peer-left` | — | other user left |
| `room-status` | `{ members }` | current member count |
| `message` | `{ text, ts }` | incoming message |
| `peer-typing` | `boolean` | peer typing state |

---

## Config

| Var | Side | Default | Purpose |
|-----|------|---------|---------|
| `PORT` | server | `4000` | server port (host injects in prod) |
| `NODE_ENV` | server | — | set `production` to serve built client + disable CORS |
| `CLIENT_ORIGIN` | server | `http://localhost:5173` | CORS allow-origin (dev only) |
| `VITE_SERVER_URL` | client | auto | server URL; auto same-origin in prod, `localhost:4000` in dev. Set only for split deploy |

---

## Notes / limits

- In-memory store → restarting the server clears all rooms (intended).
- For production: serve over HTTPS/WSS, run a single server instance (or add a shared adapter like Redis if you scale out — though that reintroduces shared state).
- No auth: anyone with the code can join until 2 people are in.
