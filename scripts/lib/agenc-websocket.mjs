export async function loadWebSocketConstructor() {
  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket;
  }

  for (const candidate of [
    "../../runtime/node_modules/ws/wrapper.mjs",
    "../../node_modules/ws/wrapper.mjs",
  ]) {
    try {
      return (await import(candidate)).default;
    } catch {}
  }

  throw new Error(
    "Unable to resolve a WebSocket implementation. Install `ws` or use a Node runtime with global WebSocket support.",
  );
}
