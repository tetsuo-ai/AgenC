import { vi } from "vitest";
import type { CliOutputFormat, CliRuntimeContext } from "./types.js";

export function createContextCapture(outputFormat: CliOutputFormat = "json"): {
  context: CliRuntimeContext;
  outputs: unknown[];
  errors: unknown[];
} {
  const outputs: unknown[] = [];
  const errors: unknown[] = [];
  return {
    context: {
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      },
      outputFormat,
      output: (value) => outputs.push(value),
      error: (value) => errors.push(value),
    },
    outputs,
    errors,
  };
}
