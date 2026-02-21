import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createToken, verifyToken } from "./jwt.js";

const SECRET = "a-very-secure-secret-key-at-least-32-chars!!";
const SUBJECT = "agent_001";

describe("JWT utility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("createToken returns a 3-part JWT string", () => {
    const token = createToken(SECRET, SUBJECT);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("verifyToken accepts a valid token", () => {
    const token = createToken(SECRET, SUBJECT, 3600);
    const payload = verifyToken(SECRET, token);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(SUBJECT);
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it("verifyToken returns null for wrong secret", () => {
    const token = createToken(SECRET, SUBJECT);
    const payload = verifyToken(
      "wrong-secret-that-is-at-least-32-chars",
      token,
    );

    expect(payload).toBeNull();
  });

  it("verifyToken returns null for expired token", () => {
    // Create a token that expired 10 seconds ago
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockReturnValue((now - 100) * 1000);
    const token = createToken(SECRET, SUBJECT, 10);
    vi.restoreAllMocks();

    // Now Date.now() is back to real time — token expired ~90s ago
    const payload = verifyToken(SECRET, token);
    expect(payload).toBeNull();
  });

  it("verifyToken returns null for malformed token (too few parts)", () => {
    expect(verifyToken(SECRET, "only.two")).toBeNull();
    expect(verifyToken(SECRET, "single")).toBeNull();
    expect(verifyToken(SECRET, "")).toBeNull();
  });

  it("verifyToken returns null for tampered payload", () => {
    const token = createToken(SECRET, SUBJECT);
    const parts = token.split(".");
    // Tamper with the payload
    parts[1] = parts[1] + "x";
    const tampered = parts.join(".");

    expect(verifyToken(SECRET, tampered)).toBeNull();
  });

  it("verifyToken returns null for tampered signature", () => {
    const token = createToken(SECRET, SUBJECT);
    const parts = token.split(".");
    parts[2] = "invalid_signature";
    const tampered = parts.join(".");

    expect(verifyToken(SECRET, tampered)).toBeNull();
  });

  it("verifyToken returns null for invalid JSON in payload", () => {
    const token = createToken(SECRET, SUBJECT);
    const parts = token.split(".");
    // Replace payload with invalid base64url-encoded JSON
    parts[1] = Buffer.from("not-json", "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // Re-sign won't match, so this also tests signature mismatch
    expect(verifyToken(SECRET, parts.join("."))).toBeNull();
  });

  it("creates tokens with custom expiry", () => {
    const token = createToken(SECRET, SUBJECT, 60);
    const payload = verifyToken(SECRET, token);

    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(60);
  });

  it("default expiry is 3600 seconds", () => {
    const token = createToken(SECRET, SUBJECT);
    const payload = verifyToken(SECRET, token);

    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(3600);
  });

  it("verifyToken preserves scope field when present", () => {
    // Build a token manually with scope
    const now = Math.floor(Date.now() / 1000);
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      "utf-8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payloadB64 = Buffer.from(
      JSON.stringify({
        sub: "scoped",
        iat: now,
        exp: now + 3600,
        scope: "admin",
      }),
      "utf-8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = createHmac("sha256", SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const token = `${headerB64}.${payloadB64}.${sig}`;
    const payload = verifyToken(SECRET, token);

    expect(payload).not.toBeNull();
    expect(payload!.scope).toBe("admin");
  });

  it("verifyToken returns undefined scope when not present", () => {
    const token = createToken(SECRET, SUBJECT);
    const payload = verifyToken(SECRET, token);

    expect(payload).not.toBeNull();
    expect(payload!.scope).toBeUndefined();
  });

  it("round-trip: multiple tokens with different subjects", () => {
    const subjects = ["agent_001", "agent_002", "cli_user"];
    for (const sub of subjects) {
      const token = createToken(SECRET, sub);
      const payload = verifyToken(SECRET, token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe(sub);
    }
  });

  it("createToken throws for secret shorter than 32 characters", () => {
    expect(() => createToken("short", SUBJECT)).toThrow(
      "at least 32 characters",
    );
  });

  it("verifyToken returns null for secret shorter than 32 characters", () => {
    const token = createToken(SECRET, SUBJECT);
    expect(verifyToken("short", token)).toBeNull();
  });

  it("verifyToken returns null for token with missing sub field", () => {
    const now = Math.floor(Date.now() / 1000);
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      "utf-8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // Payload without sub
    const payloadB64 = Buffer.from(
      JSON.stringify({ iat: now, exp: now + 3600 }),
      "utf-8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = createHmac("sha256", SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(verifyToken(SECRET, `${headerB64}.${payloadB64}.${sig}`)).toBeNull();
  });
});
