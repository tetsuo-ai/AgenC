import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

export class ObservabilityStoreError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.MEMORY_BACKEND_ERROR);
    this.name = "ObservabilityStoreError";
  }
}
