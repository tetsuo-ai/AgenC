/**
 * Personality configuration file loader and validator.
 *
 * Reads a JSON personality file (default `~/.agenc/personality.json`),
 * validates its structure, and returns a typed `PersonalityConfig`.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { GatewayValidationError } from '../errors.js';
import type { PersonalityConfig, CommunicationStyle, Tone, ResponsePreferences, Trait } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const VALID_STYLES: readonly CommunicationStyle[] = ['formal', 'casual', 'technical', 'creative'];
const VALID_TONES: readonly Tone[] = ['friendly', 'professional', 'playful', 'empathetic', 'direct'];
const VALID_LENGTHS: readonly string[] = ['concise', 'balanced', 'detailed'];
const VALID_STRUCTURES: readonly string[] = ['bulleted', 'narrative', 'step-by-step'];

// ============================================================================
// Default path
// ============================================================================

/** Return the default personality file path: `~/.agenc/personality.json`. */
export function getDefaultPersonalityPath(): string {
  return join(homedir(), '.agenc', 'personality.json');
}

// ============================================================================
// Validation
// ============================================================================

function requireString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayValidationError(field, 'must be a non-empty string');
  }
  return value;
}

function validateTrait(raw: unknown, index: number): Trait {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GatewayValidationError(`traits[${index}]`, 'must be an object');
  }

  const obj = raw as Record<string, unknown>;
  const name = requireString(obj, 'name');
  const description = requireString(obj, 'description');

  if (typeof obj.intensity !== 'number' || obj.intensity < 0 || obj.intensity > 1) {
    throw new GatewayValidationError(`traits[${index}].intensity`, 'must be a number between 0.0 and 1.0');
  }

  return { name, description, intensity: obj.intensity };
}

function validatePreferences(raw: unknown): ResponsePreferences {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GatewayValidationError('preferences', 'must be an object');
  }

  const obj = raw as Record<string, unknown>;

  if (!VALID_LENGTHS.includes(obj.length as string)) {
    throw new GatewayValidationError('preferences.length', `must be one of: ${VALID_LENGTHS.join(', ')}`);
  }
  if (!VALID_STRUCTURES.includes(obj.structure as string)) {
    throw new GatewayValidationError('preferences.structure', `must be one of: ${VALID_STRUCTURES.join(', ')}`);
  }
  if (typeof obj.examples !== 'boolean') {
    throw new GatewayValidationError('preferences.examples', 'must be a boolean');
  }
  if (typeof obj.codeBlocks !== 'boolean') {
    throw new GatewayValidationError('preferences.codeBlocks', 'must be a boolean');
  }

  return {
    length: obj.length as ResponsePreferences['length'],
    structure: obj.structure as ResponsePreferences['structure'],
    examples: obj.examples,
    codeBlocks: obj.codeBlocks,
  };
}

/** Validate raw parsed JSON and return a typed `PersonalityConfig`. */
export function validatePersonalityConfig(raw: unknown): PersonalityConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GatewayValidationError('personality', 'must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  const name = requireString(obj, 'name');
  const description = requireString(obj, 'description');

  if (!VALID_STYLES.includes(obj.style as CommunicationStyle)) {
    throw new GatewayValidationError('style', `must be one of: ${VALID_STYLES.join(', ')}`);
  }

  if (!Array.isArray(obj.tone) || obj.tone.length === 0) {
    throw new GatewayValidationError('tone', 'must be a non-empty array');
  }
  for (const t of obj.tone) {
    if (!VALID_TONES.includes(t as Tone)) {
      throw new GatewayValidationError('tone', `invalid value "${t}" — must be one of: ${VALID_TONES.join(', ')}`);
    }
  }

  if (!Array.isArray(obj.traits)) {
    throw new GatewayValidationError('traits', 'must be an array');
  }
  const traits = obj.traits.map((t: unknown, i: number) => validateTrait(t, i));

  const preferences = validatePreferences(obj.preferences);

  return {
    name,
    description,
    style: obj.style as CommunicationStyle,
    tone: obj.tone as Tone[],
    traits,
    preferences,
  };
}

// ============================================================================
// PersonalityLoader
// ============================================================================

/** Loads and validates a personality configuration file. */
export class PersonalityLoader {
  readonly path: string;

  constructor(filePath?: string) {
    this.path = filePath ?? getDefaultPersonalityPath();
  }

  /**
   * Load the personality file.
   *
   * Returns `undefined` when the file does not exist (ENOENT).
   * Throws `GatewayValidationError` for malformed JSON or invalid schema.
   */
  async load(): Promise<PersonalityConfig | undefined> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf-8');
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new GatewayValidationError('personality', 'file contains invalid JSON');
    }

    return validatePersonalityConfig(parsed);
  }
}
