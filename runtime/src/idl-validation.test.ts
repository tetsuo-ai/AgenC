/**
 * Tests for validateIdl error paths.
 *
 * These tests validate the IDL validation logic by passing malformed
 * IDL objects directly to validateIdl(), avoiding the need for module mocking.
 */

import { describe, it, expect } from "vitest";
import { Idl } from "@coral-xyz/anchor";
import { PROGRAM_ID } from "@agenc/sdk";
import { validateIdl, IDL } from "./idl";

const VALID_PROGRAM_ADDRESS = PROGRAM_ID.toBase58();

describe("validateIdl", () => {
  describe("valid IDL", () => {
    it("does not throw for the actual IDL", () => {
      expect(() => validateIdl()).not.toThrow();
      expect(() => validateIdl(IDL)).not.toThrow();
    });

    it("does not throw for a minimal valid IDL", () => {
      const validIdl = {
        address: VALID_PROGRAM_ADDRESS,
        metadata: { name: "test", version: "0.1.0", spec: "0.1.0" },
        instructions: [
          {
            name: "test_instruction",
            discriminator: [],
            accounts: [],
            args: [],
          },
        ],
        accounts: [],
        types: [],
        events: [],
        errors: [],
      } as unknown as Idl;

      expect(() => validateIdl(validIdl)).not.toThrow();
    });
  });

  describe("missing address field", () => {
    it("throws error when IDL is missing address field", () => {
      const idlMissingAddress = {
        metadata: { name: "test" },
        instructions: [{ name: "test_instruction" }],
        // address is missing
      } as unknown as Idl;

      expect(() => validateIdl(idlMissingAddress)).toThrow(
        'IDL is missing program address. The IDL file may be corrupted or from an older Anchor version. Run "anchor build" to regenerate the IDL.',
      );
    });

    it("throws error when address is empty string", () => {
      const idlEmptyAddress = {
        address: "",
        metadata: { name: "test" },
        instructions: [{ name: "test_instruction" }],
      } as unknown as Idl;

      expect(() => validateIdl(idlEmptyAddress)).toThrow(
        "IDL is missing program address",
      );
    });

    it("throws error when address is null", () => {
      const idlNullAddress = {
        address: null,
        metadata: { name: "test" },
        instructions: [{ name: "test_instruction" }],
      } as unknown as Idl;

      expect(() => validateIdl(idlNullAddress)).toThrow(
        "IDL is missing program address",
      );
    });

    it("throws error when address is undefined", () => {
      const idlUndefinedAddress = {
        address: undefined,
        metadata: { name: "test" },
        instructions: [{ name: "test_instruction" }],
      } as unknown as Idl;

      expect(() => validateIdl(idlUndefinedAddress)).toThrow(
        "IDL is missing program address",
      );
    });
  });

  describe("missing or empty instructions", () => {
    it("throws error when IDL has empty instructions array", () => {
      const idlEmptyInstructions = {
        address: VALID_PROGRAM_ADDRESS,
        metadata: { name: "test" },
        instructions: [],
      } as unknown as Idl;

      expect(() => validateIdl(idlEmptyInstructions)).toThrow(
        'IDL has no instructions. The IDL file may be corrupted. Run "anchor build" to regenerate the IDL.',
      );
    });

    it("throws error when IDL has null instructions", () => {
      const idlNullInstructions = {
        address: VALID_PROGRAM_ADDRESS,
        metadata: { name: "test" },
        instructions: null,
      } as unknown as Idl;

      expect(() => validateIdl(idlNullInstructions)).toThrow(
        "IDL has no instructions",
      );
    });

    it("throws error when IDL has undefined instructions", () => {
      const idlUndefinedInstructions = {
        address: VALID_PROGRAM_ADDRESS,
        metadata: { name: "test" },
        instructions: undefined,
      } as unknown as Idl;

      expect(() => validateIdl(idlUndefinedInstructions)).toThrow(
        "IDL has no instructions",
      );
    });

    it("throws error when instructions field is missing entirely", () => {
      const idlMissingInstructions = {
        address: VALID_PROGRAM_ADDRESS,
        metadata: { name: "test" },
        // instructions is missing
      } as unknown as Idl;

      expect(() => validateIdl(idlMissingInstructions)).toThrow(
        "IDL has no instructions",
      );
    });
  });

  describe("error message content", () => {
    it("address error suggests running anchor build", () => {
      const idlMissingAddress = {
        metadata: { name: "test" },
        instructions: [{ name: "test" }],
      } as unknown as Idl;

      try {
        validateIdl(idlMissingAddress);
        expect.fail("Should have thrown");
      } catch (e) {
        expect((e as Error).message).toContain("anchor build");
        expect((e as Error).message).toContain("older Anchor version");
      }
    });

    it("instructions error suggests running anchor build", () => {
      const idlEmptyInstructions = {
        address: "test",
        metadata: { name: "test" },
        instructions: [],
      } as unknown as Idl;

      try {
        validateIdl(idlEmptyInstructions);
        expect.fail("Should have thrown");
      } catch (e) {
        expect((e as Error).message).toContain("anchor build");
        expect((e as Error).message).toContain("corrupted");
      }
    });
  });

  describe("validation order", () => {
    it("checks address before instructions", () => {
      // Both address and instructions are invalid
      const idlBothInvalid = {
        metadata: { name: "test" },
        // no address, no instructions
      } as unknown as Idl;

      // Should throw about address first
      expect(() => validateIdl(idlBothInvalid)).toThrow(
        "IDL is missing program address",
      );
    });
  });
});

describe("validateIdl integration with factory functions", () => {
  it("createProgram and createReadOnlyProgram implicitly validate on each call", () => {
    // These tests are in idl.test.ts, but we verify the exported function works
    // The factory functions call validateIdl() internally
    expect(() => validateIdl()).not.toThrow();
  });
});
