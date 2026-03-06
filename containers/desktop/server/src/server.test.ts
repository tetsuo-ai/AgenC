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
    const body = await res.json() as { status: string };
    assert.equal(body.status, "ok");
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
