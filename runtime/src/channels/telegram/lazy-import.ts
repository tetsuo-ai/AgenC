/**
 * Lazy-import helper for channel plugins.
 *
 * Thin wrapper around {@link ensureLazyModule} that throws
 * {@link ChannelConnectionError} on missing packages.
 *
 * @module
 */

import { ensureLazyModule } from "../../utils/lazy-import.js";
import { ChannelConnectionError } from "./errors.js";

/**
 * Dynamically import an optional channel SDK package.
 *
 * @param packageName - npm package to import (e.g. 'grammy')
 * @param channelName - Channel name for error messages (e.g. 'telegram')
 * @param configure - Extract and configure the client from the imported module
 * @returns The configured client instance
 */
export async function ensureLazyChannel<T>(
  packageName: string,
  channelName: string,
  configure: (mod: Record<string, unknown>) => T,
): Promise<T> {
  return ensureLazyModule(
    packageName,
    (msg) => new ChannelConnectionError(channelName, msg),
    configure,
  );
}
