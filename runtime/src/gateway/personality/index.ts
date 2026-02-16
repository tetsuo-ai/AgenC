export type {
  CommunicationStyle,
  Tone,
  Trait,
  ResponsePreferences,
  PersonalityConfig,
} from './types.js';

export { formatPersonality } from './formatter.js';

export {
  getDefaultPersonalityPath,
  validatePersonalityConfig,
  PersonalityLoader,
} from './loader.js';
