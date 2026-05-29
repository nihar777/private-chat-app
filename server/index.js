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

/**
 * Ephemeral, in-memory room store. Nothing touches disk.
 * rooms: Map<roomId, { members: Set<socketId>, createdAt: number }>
 * Messages are NEVER stored server-side — they are relayed only.
 * When a room's member count hits 0, the room is deleted and its
 * existence (and any chance of rejoining) disappears entirely.
 */
const rooms = new Map();
const MAX_MEMBERS = 2;

const genRoomId = () => crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars

io.on("connection", (socket) => {
  let joinedRoom = null;

  // ---- Create a room ----
  socket.on("create-room", (cb) => {
    let roomId = genRoomId();
    while (rooms.has(roomId)) roomId = genRoomId();
    rooms.set(roomId, { members: new Set(), createdAt: Date.now() });
    cb?.({ ok: true, roomId });
  });

  // ---- Join a room ----
  socket.on("join-room", ({ roomId } = {}, cb) => {
    roomId = (roomId || "").trim().toUpperCase();
    const room = rooms.get(roomId);

    if (!room) return cb?.({ ok: false, error: "Room not found or already closed." });
    if (room.members.size >= MAX_MEMBERS)
      return cb?.({ ok: false, error: "Room is full (2 users max)." });

    room.members.add(socket.id);
    socket.join(roomId);
    joinedRoom = roomId;

    cb?.({ ok: true, roomId, members: room.members.size });
    // Tell the other peer someone joined.
    socket.to(roomId).emit("peer-joined", { members: room.members.size });
    // Tell the joiner the current count.
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

  // ---- Explicit leave ----
  socket.on("leave-room", () => leave());

  // ---- Disconnect (tab close, network drop) ----
  socket.on("disconnect", () => leave());

  function leave() {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (room) {
      room.members.delete(socket.id);
      socket.to(joinedRoom).emit("peer-left");
      // Room empty -> destroy it. Chat disappears.
      if (room.members.size === 0) rooms.delete(joinedRoom);
    }
    socket.leave(joinedRoom);
    joinedRoom = null;
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
