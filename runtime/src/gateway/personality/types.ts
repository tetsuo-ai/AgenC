/**
 * Personality configuration type definitions.
 *
 * Structured JSON-based personality configuration for agent
 * communication style, tone, traits, and response preferences.
 *
 * @module
 */

// ============================================================================
// Enums
// ============================================================================

export type CommunicationStyle = 'formal' | 'casual' | 'technical' | 'creative';

export type Tone = 'friendly' | 'professional' | 'playful' | 'empathetic' | 'direct';

// ============================================================================
// Interfaces
// ============================================================================

export interface Trait {
  readonly name: string;
  readonly description: string;
  /** Intensity level between 0.0 and 1.0 (inclusive). */
  readonly intensity: number;
}

export interface ResponsePreferences {
  readonly length: 'concise' | 'balanced' | 'detailed';
  readonly structure: 'bulleted' | 'narrative' | 'step-by-step';
  readonly examples: boolean;
  readonly codeBlocks: boolean;
}

export interface PersonalityConfig {
  readonly name: string;
  readonly description: string;
  readonly style: CommunicationStyle;
  readonly tone: readonly Tone[];
  readonly traits: readonly Trait[];
  readonly preferences: ResponsePreferences;
}
