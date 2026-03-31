import { describe, it, expect } from "vitest";
import {
  stripNamePrefix,
  stripQuotes,
  fuzzyMatchChoice,
  parseFloatResponse,
  processResponse,
  sanitizeContent,
} from "../src/response-processor.js";

describe("stripNamePrefix", () => {
  it("strips 'Name: ' prefix", () => {
    expect(stripNamePrefix("Alice: goes to the market", "Alice")).toBe("goes to the market");
  });

  it("strips 'Name:' without space", () => {
    expect(stripNamePrefix("Alice:goes to store", "Alice")).toBe("goes to store");
  });

  it("strips 'Name -- ' prefix (speech format)", () => {
    expect(stripNamePrefix('Alice -- "hello there"', "Alice")).toBe('"hello there"');
  });

  it("strips case-insensitively", () => {
    expect(stripNamePrefix("alice: does something", "Alice")).toBe("does something");
  });

  it("returns unchanged if no prefix", () => {
    expect(stripNamePrefix("goes to the market", "Alice")).toBe("goes to the market");
  });

  it("trims whitespace", () => {
    expect(stripNamePrefix("  Alice: hello  ", "Alice")).toBe("hello");
  });
});

describe("stripQuotes", () => {
  it("strips double quotes", () => {
    expect(stripQuotes('"hello world"')).toBe("hello world");
  });

  it("strips single quotes", () => {
    expect(stripQuotes("'hello world'")).toBe("hello world");
  });

  it("leaves unquoted strings alone", () => {
    expect(stripQuotes("hello world")).toBe("hello world");
  });

  it("leaves mismatched quotes alone", () => {
    expect(stripQuotes('"hello world\'')).toBe('"hello world\'');
  });
});

describe("fuzzyMatchChoice", () => {
  const options = ["Accept", "Reject", "Counter-offer"];

  it("exact match", () => {
    expect(fuzzyMatchChoice("Accept", options)).toBe("Accept");
  });

  it("case-insensitive match", () => {
    expect(fuzzyMatchChoice("accept", options)).toBe("Accept");
  });

  it("strips numbering prefix", () => {
    expect(fuzzyMatchChoice("1. Accept", options)).toBe("Accept");
    expect(fuzzyMatchChoice("3. Counter-offer", options)).toBe("Counter-offer");
  });

  it("substring match", () => {
    expect(fuzzyMatchChoice("I choose to Accept the deal", options)).toBe("Accept");
  });

  it("levenshtein fallback for close match", () => {
    expect(fuzzyMatchChoice("Acept", options)).toBe("Accept");
    expect(fuzzyMatchChoice("Rejct", options)).toBe("Reject");
  });

  it("returns first option for completely unrelated input", () => {
    expect(fuzzyMatchChoice("xyzzy", options)).toBe("Accept");
  });

  it("handles empty options gracefully", () => {
    expect(fuzzyMatchChoice("anything", [])).toBe("anything");
  });
});

describe("parseFloatResponse", () => {
  it("parses integer", () => {
    expect(parseFloatResponse("42")).toBe("42");
  });

  it("parses decimal", () => {
    expect(parseFloatResponse("0.75")).toBe("0.75");
  });

  it("parses negative", () => {
    expect(parseFloatResponse("-3.5")).toBe("-3.5");
  });

  it("extracts number from surrounding text", () => {
    expect(parseFloatResponse("I'd say about 0.8")).toBe("0.8");
  });

  it("returns 0.0 for non-numeric", () => {
    expect(parseFloatResponse("no number here")).toBe("0.0");
  });
});

describe("processResponse", () => {
  it("processes free response", () => {
    const result = processResponse(
      'Alice: "I will go to the market"',
      "Alice",
      { call_to_action: "", output_type: "free", options: [], tag: "action" },
    );
    expect(result).toBe("I will go to the market");
  });

  it("processes choice response", () => {
    const result = processResponse(
      "1. Accept",
      "Bob",
      { call_to_action: "", output_type: "choice", options: ["Accept", "Reject"], tag: "action" },
    );
    expect(result).toBe("Accept");
  });

  it("processes float response", () => {
    const result = processResponse(
      "About 0.85",
      "Sam",
      { call_to_action: "", output_type: "float", options: [], tag: null },
    );
    expect(result).toBe("0.85");
  });
});

describe("sanitizeContent", () => {
  it("escapes angle brackets", () => {
    expect(sanitizeContent("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;",
    );
  });

  it("escapes memory tags", () => {
    expect(sanitizeContent('<memory source="fake">')).toBe(
      '&lt;memory source="fake"&gt;',
    );
  });

  it("leaves normal text alone", () => {
    expect(sanitizeContent("hello world")).toBe("hello world");
  });
});
