import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const PROD = process.env.NODE_ENV === "production";
// In prod the client is served from the SAME origin, so CORS is not needed.
// In dev the Vite server runs on a different port, so allow it.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

const app = express();
if (!PROD) app.use(cors({ origin: CLIENT_ORIGIN }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  // same-origin in prod -> no cors block; dev -> allow Vite origin
  cors: PROD ? undefined : { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
  // images sent as base64 data URLs -> raise default 1MB cap to 6MB
  maxHttpBufferSize: 6 * 1024 * 1024,
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // server-side guard
const GRACE_MS = 5 * 60 * 1000; // keep a room alive 5 min after a member drops

/**
 * Ephemeral, in-memory room store. Nothing touches disk.
 * rooms: Map<roomId, { members: Map<clientId, Member>, createdAt: number }>
 *   Member = { socketId, away: boolean, timer: Timeout|null }
 * Members are keyed by a stable browser clientId (NOT socketId) so a user
 * who drops (tab evicted, network blip) can reconnect into the SAME slot
 * within GRACE_MS. The room is only destroyed once a slot's grace expires
 * with nobody reclaiming it, or on an explicit Leave.
 * Messages are NEVER stored server-side — they are relayed only.
 */
const rooms = new Map();
const MAX_MEMBERS = 2;

const genRoomId = () => crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars

io.on("connection", (socket) => {
  let joinedRoom = null;
  let clientId = null;

  // ---- Create a room ----
  socket.on("create-room", (cb) => {
    let roomId = genRoomId();
    while (rooms.has(roomId)) roomId = genRoomId();
    rooms.set(roomId, { members: new Map(), createdAt: Date.now() });
    cb?.({ ok: true, roomId });
  });

  // ---- Join (or rejoin) a room ----
  socket.on("join-room", ({ roomId, clientId: cid } = {}, cb) => {
    roomId = (roomId || "").trim().toUpperCase();
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, error: "Room not found or already closed." });

    cid = (cid || socket.id).toString();
    const existing = room.members.get(cid);

    if (existing) {
      // Returning member -> reclaim the held slot, cancel its grace timer.
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = null;
      existing.socketId = socket.id;
      existing.away = false;
      socket.join(roomId);
      joinedRoom = roomId;
      clientId = cid;
      cb?.({ ok: true, roomId, members: room.members.size });
      socket.to(roomId).emit("peer-back");
      socket.emit("room-status", { members: room.members.size });
      return;
    }

    if (room.members.size >= MAX_MEMBERS)
      return cb?.({ ok: false, error: "Room is full (2 users max)." });

    room.members.set(cid, { socketId: socket.id, away: false, timer: null });
    socket.join(roomId);
    joinedRoom = roomId;
    clientId = cid;

    cb?.({ ok: true, roomId, members: room.members.size });
    socket.to(roomId).emit("peer-joined", { members: room.members.size });
    socket.emit("room-status", { members: room.members.size });
  });

  // ---- Relay a chat message (not stored) ----
  socket.on("send-message", ({ text } = {}) => {
    if (!joinedRoom || !rooms.has(joinedRoom)) return;
    if (typeof text !== "string" || !text.trim()) return;
    socket.to(joinedRoom).emit("message", {
      type: "text",
      text: text.slice(0, 2000),
      ts: Date.now(),
    });
  });

  // ---- Relay an image (base64 data URL, not stored) ----
  socket.on("send-image", ({ dataUrl, name } = {}) => {
    if (!joinedRoom || !rooms.has(joinedRoom)) return;
    if (typeof dataUrl !== "string") return;
    if (!dataUrl.startsWith("data:image/")) return;
    if (dataUrl.length > MAX_IMAGE_BYTES) return; // reject oversized
    socket.to(joinedRoom).emit("message", {
      type: "image",
      dataUrl,
      name: typeof name === "string" ? name.slice(0, 120) : "",
      ts: Date.now(),
    });
  });

  // ---- Typing indicator ----
  socket.on("typing", (isTyping) => {
    if (!joinedRoom) return;
    socket.to(joinedRoom).emit("peer-typing", !!isTyping);
  });

  // ---- Explicit Leave button -> destroy slot immediately, no grace. ----
  socket.on("leave-room", () => removeNow());

  // ---- Disconnect (tab close/evict, network drop) -> hold slot GRACE_MS. ----
  socket.on("disconnect", () => holdOrRemove());

  function removeNow() {
    const room = joinedRoom && rooms.get(joinedRoom);
    if (room && clientId) {
      const m = room.members.get(clientId);
      if (m?.timer) clearTimeout(m.timer);
      room.members.delete(clientId);
      socket.to(joinedRoom).emit("peer-left");
      if (room.members.size === 0) rooms.delete(joinedRoom);
    }
    if (joinedRoom) socket.leave(joinedRoom);
    joinedRoom = null;
  }

  function holdOrRemove() {
    const rid = joinedRoom;
    const room = rid && rooms.get(rid);
    if (!room || !clientId) return;
    const m = room.members.get(clientId);
    if (!m || m.socketId !== socket.id) return; // a newer socket already reclaimed it
    m.away = true;
    socket.to(rid).emit("peer-away");
    m.timer = setTimeout(() => {
      const r = rooms.get(rid);
      if (!r) return;
      const cur = r.members.get(clientId);
      if (!cur || !cur.away) return; // came back during grace
      r.members.delete(clientId);
      io.to(rid).emit("peer-left");
      if (r.members.size === 0) rooms.delete(rid);
    }, GRACE_MS);
  }
});

// ---- Serve the built React app in production (combined single service) ----
if (PROD) {
  const dist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(dist));
  // SPA fallback: any non-API route returns index.html
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

server.listen(PORT, () => {
  console.log(`Chat server on http://localhost:${PORT} (prod=${PROD})`);
});
