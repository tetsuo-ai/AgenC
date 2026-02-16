/**
 * Personality config to markdown formatter.
 *
 * Pure function — no I/O.
 *
 * @module
 */

import type { PersonalityConfig, Trait } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

function intensityLabel(value: number): string {
  if (value <= 0.33) return 'low';
  if (value <= 0.66) return 'medium';
  return 'high';
}

function formatTrait(trait: Trait): string {
  return `- **${trait.name}** (${intensityLabel(trait.intensity)}): ${trait.description}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Render a `PersonalityConfig` as a markdown system-prompt section.
 */
export function formatPersonality(config: PersonalityConfig): string {
  const sections: string[] = [];

  sections.push(`## Personality: ${config.name}`);
  sections.push(config.description);

  sections.push('### Communication Style');
  sections.push(`Use a **${config.style}** communication style.`);

  sections.push('### Tone');
  sections.push(`Maintain a **${config.tone.join('** and **')}** tone.`);

  if (config.traits.length > 0) {
    sections.push('### Traits');
    sections.push(config.traits.map(formatTrait).join('\n'));
  }

  sections.push('### Response Preferences');
  sections.push(
    [
      `- Length: ${config.preferences.length}`,
      `- Structure: ${config.preferences.structure}`,
      `- Examples: ${config.preferences.examples ? 'yes' : 'no'}`,
      `- Code blocks: ${config.preferences.codeBlocks ? 'yes' : 'no'}`,
    ].join('\n'),
  );

  return sections.join('\n\n');
}
