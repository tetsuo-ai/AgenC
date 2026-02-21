import { describe, it, expect } from "vitest";
import {
  validationResult,
  requireNonEmptyString,
  requireFiniteNumber,
  requireOneOf,
  requireIntRange,
} from "./validation.js";

describe("validationResult", () => {
  it("returns valid when no errors", () => {
    const result = validationResult([]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns invalid when errors present", () => {
    const result = validationResult(["bad field"]);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["bad field"]);
  });
});

describe("requireNonEmptyString", () => {
  it("accepts a non-empty string", () => {
    const errors: string[] = [];
    requireNonEmptyString("hello", "name", errors);
    expect(errors).toHaveLength(0);
  });

  it("rejects empty string", () => {
    const errors: string[] = [];
    requireNonEmptyString("", "name", errors);
    expect(errors).toContain("name must be a non-empty string");
  });

  it("rejects non-string", () => {
    const errors: string[] = [];
    requireNonEmptyString(42, "name", errors);
    expect(errors).toContain("name must be a non-empty string");
  });

  it("rejects undefined", () => {
    const errors: string[] = [];
    requireNonEmptyString(undefined, "name", errors);
    expect(errors).toContain("name must be a non-empty string");
  });
});

describe("requireFiniteNumber", () => {
  it("accepts a finite number", () => {
    const errors: string[] = [];
    requireFiniteNumber(42, "age", errors);
    expect(errors).toHaveLength(0);
  });

  it("rejects NaN", () => {
    const errors: string[] = [];
    requireFiniteNumber(NaN, "age", errors);
    expect(errors).toContain("age must be a finite number");
  });

  it("rejects Infinity", () => {
    const errors: string[] = [];
    requireFiniteNumber(Infinity, "age", errors);
    expect(errors).toContain("age must be a finite number");
  });

  it("rejects non-number", () => {
    const errors: string[] = [];
    requireFiniteNumber("42", "age", errors);
    expect(errors).toContain("age must be a finite number");
  });
});

describe("requireOneOf", () => {
  const allowed = new Set(["a", "b", "c"]);

  it("accepts allowed value", () => {
    const errors: string[] = [];
    requireOneOf("b", "field", allowed, errors);
    expect(errors).toHaveLength(0);
  });

  it("rejects disallowed value", () => {
    const errors: string[] = [];
    requireOneOf("x", "field", allowed, errors);
    expect(errors[0]).toContain("field must be one of");
  });

  it("rejects non-string", () => {
    const errors: string[] = [];
    requireOneOf(1, "field", allowed, errors);
    expect(errors).toHaveLength(1);
  });
});

describe("requireIntRange", () => {
  it("accepts integer in range", () => {
    const errors: string[] = [];
    requireIntRange(8080, "port", 1, 65535, errors);
    expect(errors).toHaveLength(0);
  });

  it("rejects below min", () => {
    const errors: string[] = [];
    requireIntRange(0, "port", 1, 65535, errors);
    expect(errors[0]).toContain("port must be an integer between 1 and 65535");
  });

  it("rejects above max", () => {
    const errors: string[] = [];
    requireIntRange(70000, "port", 1, 65535, errors);
    expect(errors).toHaveLength(1);
  });

  it("rejects float", () => {
    const errors: string[] = [];
    requireIntRange(3.14, "port", 1, 65535, errors);
    expect(errors).toHaveLength(1);
  });

  it("rejects non-number", () => {
    const errors: string[] = [];
    requireIntRange("8080", "port", 1, 65535, errors);
    expect(errors).toHaveLength(1);
  });
});
