import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createDesktopServer } from "./server.js";

const AUTH_TOKEN = "test-token";

async function withServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createDesktopServer({ authToken: AUTH_TOKEN });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("rejects unauthenticated health requests", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
  });
});

test("serves health only with the configured bearer token", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      status: string;
      workingDirectory: string;
      workspaceRoot: string | null;
      features: string[];
    };
    assert.equal(body.status, "ok");
    assert.equal(body.workingDirectory, process.cwd());
    assert.equal(body.workspaceRoot, null);
    assert.ok(body.features.includes("foreground_bash_cwd"));
  });
});

test("allows loopback CORS preflight requests", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/tools`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "http://localhost:3000",
    );
    assert.equal(
      res.headers.get("access-control-allow-headers"),
      "Authorization, Content-Type",
    );
  });
});

test("rejects non-loopback CORS preflight requests", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/tools`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(res.status, 403);
  });
});

test("streams managed process exit events over /events", async () => {
  await withServer(async (baseUrl) => {
    const eventsResponse = await fetch(`${baseUrl}/events`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(eventsResponse.status, 200);
    assert.equal(eventsResponse.headers.get("content-type"), "text/event-stream");
    assert.ok(eventsResponse.body, "expected event stream body");

    const reader = eventsResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const eventPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("event stream ended before managed process exit");
        }
        buffer += decoder.decode(value, { stream: true });
        const dataMatch = buffer.match(
          /event:\s+managed_process\.exited[\s\S]*?data:\s+(\{.*\})\n\n/,
        );
        if (dataMatch?.[1]) {
          return JSON.parse(dataMatch[1]) as {
            type: string;
            payload: { processId?: string; state?: string };
          };
        }
      }
    })();

    const startResponse = await fetch(`${baseUrl}/tools/process_start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "/bin/sleep",
        args: ["1"],
        label: "event-stream-test",
      }),
    });
    assert.equal(startResponse.status, 200);

    const event = await eventPromise;
    assert.equal(event.type, "managed_process.exited");
    assert.equal(event.payload.state, "exited");
    assert.match(String(event.payload.processId ?? ""), /^proc_/);

    await reader.cancel();
  });
});
