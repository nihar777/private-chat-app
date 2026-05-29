import { useEffect, useRef, useState } from "react";
import { socket } from "./socket";

// Screens: "lobby" -> "chat"
export default function App() {
  const [screen, setScreen] = useState("lobby");
  const [roomId, setRoomId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [members, setMembers] = useState(1);
  const [peerLeft, setPeerLeft] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);

  // messages live ONLY in component state. Refresh/close => gone.
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");

  const bottomRef = useRef(null);
  const typingTimeout = useRef(null);
  const fileRef = useRef(null);

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB raw file cap
  const [preview, setPreview] = useState(null); // {dataUrl, name} viewer

  // ---- socket listeners ----
  useEffect(() => {
      const onMessage = (m) => add({ ...m, mine: false });
    const onPeerJoined = ({ members }) => {
      setMembers(members);
      setPeerLeft(false);
      add({ system: true, text: "Stranger joined the room." });
    };
    const onPeerLeft = () => {
      setMembers(1);
      setPeerLeft(true);
      setPeerTyping(false);
      add({ system: true, text: "Stranger left. Room will vanish when you leave." });
    };
    const onRoomStatus = ({ members }) => setMembers(members);
    const onPeerTyping = (t) => setPeerTyping(t);

    socket.on("message", onMessage);
    socket.on("peer-joined", onPeerJoined);
    socket.on("peer-left", onPeerLeft);
    socket.on("room-status", onRoomStatus);
    socket.on("peer-typing", onPeerTyping);

    return () => {
      socket.off("message", onMessage);
      socket.off("peer-joined", onPeerJoined);
      socket.off("peer-left", onPeerLeft);
      socket.off("room-status", onRoomStatus);
      socket.off("peer-typing", onPeerTyping);
    };
  }, []);

  // leave room when tab closes
  useEffect(() => {
    const bye = () => socket.emit("leave-room");
    window.addEventListener("beforeunload", bye);
    return () => window.removeEventListener("beforeunload", bye);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, peerTyping]);

  const add = (m) => setMessages((prev) => [...prev, { id: cryptoId(), ...m }]);

  // ---- actions ----
  function createRoom() {
    setError("");
    socket.emit("create-room", (res) => {
      if (!res?.ok) return setError(res?.error || "Failed to create room.");
      socket.emit("join-room", { roomId: res.roomId }, (j) => {
        if (!j?.ok) return setError(j?.error || "Failed to join room.");
        setRoomId(res.roomId);
        setMembers(j.members);
        setMessages([]);
        setScreen("chat");
      });
    });
  }

  function joinRoom(e) {
    e?.preventDefault();
    setError("");
    const code = joinCode.trim().toUpperCase();
    if (!code) return setError("Enter a room code.");
    socket.emit("join-room", { roomId: code }, (res) => {
      if (!res?.ok) return setError(res?.error || "Failed to join.");
      setRoomId(code);
      setMembers(res.members);
      setMessages([]);
      setPeerLeft(false);
      setScreen("chat");
    });
  }

  function sendMessage(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    socket.emit("send-message", { text });
    add({ text, ts: Date.now(), mine: true });
    setDraft("");
    socket.emit("typing", false);
  }

  function pickImage(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking same file
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/")) return setError("Only image files allowed.");
    if (file.size > MAX_IMAGE_BYTES) return setError("Image too large (max 5MB).");

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      socket.emit("send-image", { dataUrl, name: file.name });
      add({ type: "image", dataUrl, name: file.name, ts: Date.now(), mine: true });
    };
    reader.onerror = () => setError("Failed to read image.");
    reader.readAsDataURL(file);
  }

  function onDraftChange(v) {
    setDraft(v);
    socket.emit("typing", true);
    clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => socket.emit("typing", false), 1200);
  }

  function leaveRoom() {
    socket.emit("leave-room");
    setScreen("lobby");
    setRoomId("");
    setJoinCode("");
    setMessages([]);
    setPeerLeft(false);
    setMembers(1);
  }

  // ---- render ----
  if (screen === "lobby") {
    return (
      <div className="wrap">
        <div className="card">
          <h1>🔒 Private Chat</h1>
          <p className="sub">
            Ephemeral 1-to-1 rooms. No history, no database. When both leave,
            the chat is gone forever.
          </p>

          <button className="primary" onClick={createRoom}>
            Create a room
          </button>

          <div className="divider"><span>or</span></div>

          <form onSubmit={joinRoom} className="joinRow">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ENTER ROOM CODE"
              maxLength={6}
            />
            <button type="submit">Join</button>
          </form>

          {error && <p className="error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="chat">
        <header className="chatHead">
          <div>
            <span className="dot" data-on={members >= 2} />
            Room <code>{roomId}</code>
            <span className="who">
              {members >= 2 ? "Stranger connected" : "Waiting for stranger…"}
            </span>
          </div>
          <button className="ghost" onClick={leaveRoom}>
            Leave
          </button>
        </header>

        <div className="messages">
          {members < 2 && !peerLeft && (
            <div className="hint">
              Share the code <b>{roomId}</b> with one person so they can join.
            </div>
          )}
          {messages.map((m) =>
            m.system ? (
              <div key={m.id} className="sys">{m.text}</div>
            ) : m.type === "image" ? (
              <div key={m.id} className={`bubble img ${m.mine ? "me" : "them"}`}>
                <img
                  src={m.dataUrl}
                  alt={m.name || "image"}
                  onClick={() => setPreview({ dataUrl: m.dataUrl, name: m.name })}
                />
              </div>
            ) : (
              <div key={m.id} className={`bubble ${m.mine ? "me" : "them"}`}>
                {m.text}
              </div>
            )
          )}
          {peerTyping && <div className="bubble them typing">typing…</div>}
          <div ref={bottomRef} />
        </div>

        {error && <div className="chatError">{error}</div>}

        <form className="composer" onSubmit={sendMessage}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={pickImage}
          />
          <button
            type="button"
            className="attach"
            title="Attach image"
            disabled={members < 2}
            onClick={() => fileRef.current?.click()}
          >
            📎
          </button>
          <input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={members >= 2 ? "Type a message…" : "Waiting for someone to join…"}
            disabled={members < 2}
          />
          <button type="submit" disabled={members < 2 || !draft.trim()}>
            Send
          </button>
        </form>
      </div>

      {preview && (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <img src={preview.dataUrl} alt={preview.name || "image"} />
        </div>
      )}
    </div>
  );
}

// small unique id for react keys (not the socket crypto)
function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
