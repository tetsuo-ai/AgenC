export async function loadWebSocketConstructor() {
  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket;
  }

  try {
    return (await import("ws")).default;
  } catch {
    throw new Error(
      "Unable to resolve a WebSocket implementation. Install the root `ws` dependency or use a Node runtime with global WebSocket support.",
    );
  }
}
