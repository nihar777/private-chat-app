import { io } from "socket.io-client";

// Prod build is served from the SAME origin as the Socket.IO server,
// so connect to window.location.origin. In dev, hit the local server.
// An explicit VITE_SERVER_URL always wins (e.g. split deploy).
const URL =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.DEV ? "http://localhost:4000" : window.location.origin);

// One shared socket for the app. autoConnect so it's ready on load.
export const socket = io(URL, { autoConnect: true });
