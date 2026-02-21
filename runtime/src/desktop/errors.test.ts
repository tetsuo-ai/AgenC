import { describe, it, expect } from "vitest";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import {
  DesktopSandboxLifecycleError,
  DesktopSandboxHealthError,
  DesktopSandboxConnectionError,
  DesktopSandboxPoolExhaustedError,
} from "./errors.js";

describe("DesktopSandboxLifecycleError", () => {
  it("sets correct code and name", () => {
    const err = new DesktopSandboxLifecycleError("create failed");
    expect(err.code).toBe(RuntimeErrorCodes.DESKTOP_SANDBOX_LIFECYCLE_ERROR);
    expect(err.name).toBe("DesktopSandboxLifecycleError");
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(Error);
  });

  it("includes containerId in message when provided", () => {
    const err = new DesktopSandboxLifecycleError("timeout", "abc123");
    expect(err.containerId).toBe("abc123");
    expect(err.message).toContain("abc123");
    expect(err.message).toContain("timeout");
  });

  it("handles missing containerId", () => {
    const err = new DesktopSandboxLifecycleError("general failure");
    expect(err.containerId).toBeUndefined();
    expect(err.message).toContain("general failure");
  });
});

describe("DesktopSandboxHealthError", () => {
  it("sets correct code and name", () => {
    const err = new DesktopSandboxHealthError("abc123");
    expect(err.code).toBe(RuntimeErrorCodes.DESKTOP_SANDBOX_HEALTH_ERROR);
    expect(err.name).toBe("DesktopSandboxHealthError");
    expect(err.containerId).toBe("abc123");
  });

  it("includes custom message", () => {
    const err = new DesktopSandboxHealthError("abc123", "3 consecutive failures");
    expect(err.message).toContain("3 consecutive failures");
  });
});

describe("DesktopSandboxConnectionError", () => {
  it("sets correct code and name", () => {
    const err = new DesktopSandboxConnectionError("abc123");
    expect(err.code).toBe(RuntimeErrorCodes.DESKTOP_SANDBOX_CONNECTION_ERROR);
    expect(err.name).toBe("DesktopSandboxConnectionError");
    expect(err.containerId).toBe("abc123");
  });

  it("includes custom message", () => {
    const err = new DesktopSandboxConnectionError("abc123", "ECONNREFUSED");
    expect(err.message).toContain("ECONNREFUSED");
  });
});

describe("DesktopSandboxPoolExhaustedError", () => {
  it("sets correct code and name", () => {
    const err = new DesktopSandboxPoolExhaustedError(4);
    expect(err.code).toBe(RuntimeErrorCodes.DESKTOP_SANDBOX_POOL_EXHAUSTED);
    expect(err.name).toBe("DesktopSandboxPoolExhaustedError");
    expect(err.maxConcurrent).toBe(4);
  });

  it("includes maxConcurrent in message", () => {
    const err = new DesktopSandboxPoolExhaustedError(8);
    expect(err.message).toContain("8");
  });
});
