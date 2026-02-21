import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHttpTools, isDomainAllowed } from "./http.js";
import { silentLogger } from "../../utils/logger.js";

// ============================================================================
// Mock fetch
// ============================================================================

function makeMockResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const headerEntries = Object.entries({
    "content-type": "application/json",
    ...headers,
  });
  const headersObj = new Headers(headerEntries);

  // Create a ReadableStream from the body string for streaming tests
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return {
    status,
    statusText: status === 200 ? "OK" : `Status ${status}`,
    ok: status >= 200 && status < 300,
    headers: headersObj,
    url: "",
    text: vi.fn().mockResolvedValue(body),
    body: stream,
    redirected: false,
  } as unknown as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue(makeMockResponse('{"ok":true}'));
  vi.stubGlobal("fetch", mockFetch);
});

// ============================================================================
// isDomainAllowed
// ============================================================================

describe("isDomainAllowed", () => {
  it("accepts allowed domain", () => {
    const result = isDomainAllowed("https://api.example.com/v1", [
      "api.example.com",
    ]);
    expect(result.allowed).toBe(true);
  });

  it("rejects blocked domain", () => {
    const result = isDomainAllowed("https://evil.com/steal", undefined, [
      "evil.com",
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("supports wildcard patterns", () => {
    const allowed = ["*.github.com"];
    expect(
      isDomainAllowed("https://api.github.com/repos", allowed).allowed,
    ).toBe(true);
    // Wildcard does NOT match the bare domain
    expect(isDomainAllowed("https://github.com/repos", allowed).allowed).toBe(
      false,
    );
  });

  it("blocked takes precedence over allowed", () => {
    const result = isDomainAllowed(
      "https://api.example.com/v1",
      ["api.example.com"],
      ["api.example.com"],
    );
    expect(result.allowed).toBe(false);
  });

  it("rejects non-HTTP URLs", () => {
    const result = isDomainAllowed("ftp://files.example.com/data");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("HTTP(S)");
  });

  it("rejects invalid URLs", () => {
    const result = isDomainAllowed("not-a-url");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid URL");
  });

  it("allows public domains when no lists configured", () => {
    expect(isDomainAllowed("https://anything.com/path").allowed).toBe(true);
    expect(isDomainAllowed("https://api.example.com/data").allowed).toBe(true);
  });

  // --- SSRF protection -------------------------------------------------------

  describe("SSRF protection", () => {
    it("blocks localhost", () => {
      const result = isDomainAllowed("http://localhost:3000/api");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("blocks 127.0.0.1", () => {
      const result = isDomainAllowed("http://127.0.0.1:8899/health");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("blocks ::1 (IPv6 loopback)", () => {
      expect(isDomainAllowed("http://[::1]:8899").allowed).toBe(false);
    });

    it("blocks 10.0.0.0/8 (private class A)", () => {
      expect(isDomainAllowed("http://10.0.0.1/admin").allowed).toBe(false);
      expect(isDomainAllowed("http://10.255.255.255/admin").allowed).toBe(
        false,
      );
    });

    it("blocks 172.16.0.0/12 (private class B)", () => {
      expect(isDomainAllowed("http://172.16.0.1/admin").allowed).toBe(false);
      expect(isDomainAllowed("http://172.31.255.255/admin").allowed).toBe(
        false,
      );
      // 172.15 and 172.32 should be allowed
      expect(isDomainAllowed("http://172.15.0.1/admin").allowed).toBe(true);
      expect(isDomainAllowed("http://172.32.0.1/admin").allowed).toBe(true);
    });

    it("blocks 192.168.0.0/16 (private class C)", () => {
      expect(isDomainAllowed("http://192.168.1.1/router").allowed).toBe(false);
      expect(isDomainAllowed("http://192.168.0.1").allowed).toBe(false);
    });

    it("blocks 169.254.169.254 (AWS IMDS)", () => {
      const result = isDomainAllowed("http://169.254.169.254/latest/meta-data");
      expect(result.allowed).toBe(false);
    });

    it("blocks 169.254.0.0/16 (link-local)", () => {
      expect(isDomainAllowed("http://169.254.1.1/data").allowed).toBe(false);
    });

    it("blocks metadata.google.internal (GCP)", () => {
      const result = isDomainAllowed("http://metadata.google.internal/");
      expect(result.allowed).toBe(false);
    });

    it("blocks 0.0.0.0", () => {
      expect(isDomainAllowed("http://0.0.0.0:8080").allowed).toBe(false);
    });

    it("blocks *.localhost wildcard", () => {
      expect(isDomainAllowed("http://app.localhost:3000").allowed).toBe(false);
    });

    it("blocks *.internal wildcard", () => {
      expect(isDomainAllowed("http://service.internal:8080").allowed).toBe(
        false,
      );
    });

    it("blocks IPv4-mapped IPv6 private addresses", () => {
      expect(isDomainAllowed("http://[::ffff:127.0.0.1]:8080").allowed).toBe(
        false,
      );
      expect(isDomainAllowed("http://[::ffff:10.0.0.1]:8080").allowed).toBe(
        false,
      );
      expect(isDomainAllowed("http://[::ffff:192.168.1.1]:8080").allowed).toBe(
        false,
      );
    });
  });
});

// ============================================================================
// system.httpGet
// ============================================================================

describe("system.httpGet", () => {
  it("makes GET request and returns response", async () => {
    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({
      url: "https://api.example.com/data",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe('{"ok":true}');
    expect(parsed.truncated).toBe(false);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchUrl).toBe("https://api.example.com/data");
    expect(fetchInit.method).toBe("GET");
    expect(fetchInit.redirect).toBe("manual");
  });

  it("rejects empty URL", async () => {
    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({ url: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Missing or invalid url");
  });

  it("rejects missing URL", async () => {
    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({});
    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// system.httpPost
// ============================================================================

describe("system.httpPost", () => {
  it("sends POST with JSON body", async () => {
    const [, httpPost] = createHttpTools({}, silentLogger);
    const body = '{"key":"value"}';
    const result = await httpPost.execute({
      url: "https://api.example.com/submit",
      body,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe(200);

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.method).toBe("POST");
    expect(fetchInit.body).toBe(body);
    expect(fetchInit.headers["content-type"]).toBe("application/json");
  });

  it("supports custom content type", async () => {
    const [, httpPost] = createHttpTools({}, silentLogger);
    await httpPost.execute({
      url: "https://api.example.com/submit",
      body: "key=value",
      contentType: "application/x-www-form-urlencoded",
    });

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });
});

// ============================================================================
// system.httpFetch
// ============================================================================

describe("system.httpFetch", () => {
  it("supports DELETE method", async () => {
    const [, , httpFetch] = createHttpTools({}, silentLogger);
    await httpFetch.execute({
      url: "https://api.example.com/resource/123",
      method: "DELETE",
    });

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.method).toBe("DELETE");
  });

  it("defaults to GET when no method specified", async () => {
    const [, , httpFetch] = createHttpTools({}, silentLogger);
    await httpFetch.execute({ url: "https://api.example.com/resource" });

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.method).toBe("GET");
  });

  it("rejects disallowed methods", async () => {
    const [, , httpFetch] = createHttpTools({}, silentLogger);
    const result = await httpFetch.execute({
      url: "https://api.example.com/resource",
      method: "CONNECT",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("method not allowed");
    expect(parsed.error).toContain("CONNECT");
  });

  it("rejects TRACE method", async () => {
    const [, , httpFetch] = createHttpTools({}, silentLogger);
    const result = await httpFetch.execute({
      url: "https://api.example.com/resource",
      method: "TRACE",
    });

    expect(result.isError).toBe(true);
  });

  it("respects custom allowedMethods config", async () => {
    const [, , httpFetch] = createHttpTools(
      { allowedMethods: ["GET", "POST"] },
      silentLogger,
    );

    // PUT is not in custom allowedMethods
    const result = await httpFetch.execute({
      url: "https://api.example.com/resource",
      method: "PUT",
    });
    expect(result.isError).toBe(true);

    // GET is allowed
    const okResult = await httpFetch.execute({
      url: "https://api.example.com/resource",
    });
    expect(okResult.isError).toBeUndefined();
  });
});

// ============================================================================
// Response handling
// ============================================================================

describe("response handling", () => {
  it("truncates at maxResponseBytes via streaming", async () => {
    const longBody = "x".repeat(500);
    mockFetch.mockResolvedValueOnce(makeMockResponse(longBody));

    const [httpGet] = createHttpTools({ maxResponseBytes: 100 }, silentLogger);
    const result = await httpGet.execute({ url: "https://example.com" });

    const parsed = JSON.parse(result.content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.body.length).toBeLessThanOrEqual(100);
  });

  it("does not truncate small responses", async () => {
    const smallBody = "hello";
    mockFetch.mockResolvedValueOnce(makeMockResponse(smallBody));

    const [httpGet] = createHttpTools({ maxResponseBytes: 100 }, silentLogger);
    const result = await httpGet.execute({ url: "https://example.com" });

    const parsed = JSON.parse(result.content);
    expect(parsed.truncated).toBe(false);
    expect(parsed.body).toBe("hello");
  });
});

// ============================================================================
// Timeout
// ============================================================================

describe("timeout", () => {
  it("timeout enforcement returns error", async () => {
    const timeoutError = new Error("The operation was aborted");
    timeoutError.name = "TimeoutError";
    mockFetch.mockRejectedValueOnce(timeoutError);

    const [httpGet] = createHttpTools({ timeoutMs: 100 }, silentLogger);
    const result = await httpGet.execute({ url: "https://slow.example.com" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("timed out");
  });
});

// ============================================================================
// Redirects
// ============================================================================

describe("redirects", () => {
  it("redirect to blocked domain is stopped", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      statusText: "Found",
      headers: new Headers({ location: "https://evil.com/trap" }),
      url: "https://safe.com/start",
      text: vi.fn().mockResolvedValue(""),
      body: null,
    } as unknown as Response);

    const [httpGet] = createHttpTools(
      { blockedDomains: ["evil.com"] },
      silentLogger,
    );
    const result = await httpGet.execute({ url: "https://safe.com/start" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("blocked");
  });

  it("redirect to SSRF target is stopped", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      statusText: "Found",
      headers: new Headers({
        location: "http://169.254.169.254/latest/meta-data",
      }),
      url: "https://safe.com/start",
      text: vi.fn().mockResolvedValue(""),
      body: null,
    } as unknown as Response);

    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({ url: "https://safe.com/start" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("blocked");
  });

  it("302 redirect changes method to GET and drops body", async () => {
    // First call: 302 redirect
    mockFetch.mockResolvedValueOnce({
      status: 302,
      statusText: "Found",
      headers: new Headers({ location: "https://example.com/redirected" }),
      url: "https://example.com/start",
      text: vi.fn().mockResolvedValue(""),
      body: null,
    } as unknown as Response);
    // Second call: final response
    mockFetch.mockResolvedValueOnce(makeMockResponse('{"redirected":true}'));

    const [, httpPost] = createHttpTools({}, silentLogger);
    await httpPost.execute({
      url: "https://example.com/start",
      body: '{"secret":"data"}',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = mockFetch.mock.calls[1];
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
  });

  it("307 redirect preserves original method and body", async () => {
    // First call: 307 redirect
    mockFetch.mockResolvedValueOnce({
      status: 307,
      statusText: "Temporary Redirect",
      headers: new Headers({ location: "https://example.com/redirected" }),
      url: "https://example.com/start",
      text: vi.fn().mockResolvedValue(""),
      body: null,
    } as unknown as Response);
    // Second call: final response
    mockFetch.mockResolvedValueOnce(makeMockResponse('{"ok":true}'));

    const [, httpPost] = createHttpTools({}, silentLogger);
    await httpPost.execute({
      url: "https://example.com/start",
      body: '{"data":"keep"}',
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = mockFetch.mock.calls[1];
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe('{"data":"keep"}');
  });

  it("stops after maxRedirects", async () => {
    // Create a chain of 6 redirects (default max is 5)
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        statusText: "Found",
        headers: new Headers({
          location: `https://example.com/redirect-${i + 1}`,
        }),
        url: `https://example.com/redirect-${i}`,
        text: vi.fn().mockResolvedValue(""),
        body: null,
      } as unknown as Response);
    }

    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({
      url: "https://example.com/redirect-0",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("Too many redirects");
  });
});

// ============================================================================
// Auth headers
// ============================================================================

describe("auth headers", () => {
  it("injected for matching domains", async () => {
    const [httpGet] = createHttpTools(
      {
        authHeaders: {
          "*.github.com": { Authorization: "Bearer ghp_test123" },
        },
      },
      silentLogger,
    );
    await httpGet.execute({ url: "https://api.github.com/repos" });

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers.Authorization).toBe("Bearer ghp_test123");
  });

  it("auth headers cannot be overridden by caller", async () => {
    const [httpGet] = createHttpTools(
      {
        authHeaders: {
          "api.example.com": { Authorization: "Bearer correct-token" },
        },
      },
      silentLogger,
    );
    await httpGet.execute({
      url: "https://api.example.com/data",
      headers: { Authorization: "Bearer malicious-token" },
    });

    const [, fetchInit] = mockFetch.mock.calls[0];
    // Auth headers are applied last, so the correct token wins
    expect(fetchInit.headers.Authorization).toBe("Bearer correct-token");
  });
});

// ============================================================================
// Default headers
// ============================================================================

describe("default headers", () => {
  it("default headers are merged into every request", async () => {
    const [httpGet] = createHttpTools(
      { defaultHeaders: { "X-Custom": "value" } },
      silentLogger,
    );
    await httpGet.execute({ url: "https://api.example.com/data" });

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers["X-Custom"]).toBe("value");
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe("error handling", () => {
  it("connection error returns isError: true", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({ url: "https://down.example.com" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("Connection failed");
    expect(parsed.error).toContain("ECONNREFUSED");
  });

  it("SSRF blocked via tool execute returns isError: true", async () => {
    const [httpGet] = createHttpTools({}, silentLogger);
    const result = await httpGet.execute({
      url: "http://localhost:8899/health",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("blocked");
    // fetch should never be called for blocked domains
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
