/**
 * AES-256-GCM encryption provider for memory backends.
 *
 * Uses only Node.js `crypto` — zero external dependencies.
 *
 * Ciphertext format: base64(iv ∥ authTag ∥ ciphertext)
 *   - iv: 12 bytes
 *   - authTag: 16 bytes
 *   - ciphertext: variable length
 *
 * @module
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MEMORY_OPERATIONAL_LIMITS } from './types.js';

const IV_BYTES = MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_IV_SIZE_BYTES;
const TAG_BYTES = MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_AUTH_TAG_SIZE_BYTES;
const KEY_BYTES = MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_KEY_SIZE_BYTES;
const ALGORITHM = 'aes-256-gcm';

/**
 * Configuration for enabling encryption on a memory backend.
 */
export interface EncryptionConfig {
  /** 32-byte key as a Buffer or hex-encoded string */
  key: Buffer | string;
}

/**
 * Provider interface for encrypting/decrypting field values.
 */
export interface EncryptionProvider {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * Create an AES-256-GCM encryption provider.
 *
 * @param config - Encryption configuration with a 32-byte key
 * @returns An EncryptionProvider that encrypts/decrypts strings
 * @throws Error if the key is not exactly 32 bytes
 */
export function createAES256GCMProvider(config: EncryptionConfig): EncryptionProvider {
  const keyBuf = typeof config.key === 'string'
    ? Buffer.from(config.key, 'hex')
    : config.key;

  if (keyBuf.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be exactly ${KEY_BYTES} bytes, got ${keyBuf.length}`,
    );
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      // iv ∥ authTag ∥ ciphertext
      const combined = Buffer.concat([iv, authTag, encrypted]);
      return combined.toString('base64');
    },

    decrypt(ciphertext: string): string {
      const combined = Buffer.from(ciphertext, 'base64');

      if (combined.length < IV_BYTES + TAG_BYTES) {
        throw new Error('Ciphertext too short');
      }

      const iv = combined.subarray(0, IV_BYTES);
      const authTag = combined.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const encrypted = combined.subarray(IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    },
  };
}
