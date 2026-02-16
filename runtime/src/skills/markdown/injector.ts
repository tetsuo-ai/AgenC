/**
 * Skill injection engine — context-aware prompt assembly.
 *
 * Selects relevant skills based on keyword matching, capability filtering,
 * and explicit requests, then formats them as `<skill>` blocks for the
 * system prompt. Implements the SkillInjector interface from ChatExecutor.
 *
 * @module
 */

import type { Logger } from '../../utils/logger.js';
import { silentLogger } from '../../utils/logger.js';
import type { SkillInjector } from '../../llm/chat-executor.js';
import type { MarkdownSkill } from './types.js';
import type { DiscoveredSkill } from './discovery.js';
import { SkillDiscovery } from './discovery.js';

// ============================================================================
// Types
// ============================================================================

export interface SkillInjectorConfig {
  readonly discovery: SkillDiscovery;
  /** Agent capability bitmask. Skills requiring capabilities the agent lacks are excluded. */
  readonly agentCapabilities?: bigint;
  /** Max estimated token budget for all injected skills (default: 4000). */
  readonly maxTokenBudget?: number;
  /** Cache TTL per session in ms (default: 60_000). */
  readonly sessionCacheTtlMs?: number;
  /** Minimum relevance score to consider a skill (default: 0.1). */
  readonly minRelevanceScore?: number;
  readonly logger?: Logger;
}

export interface InjectionResult {
  readonly content: string | undefined;
  readonly injectedSkills: readonly string[];
  readonly excludedSkills: readonly string[];
  readonly estimatedTokens: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MIN_SCORE = 0.1;
const CHARS_PER_TOKEN = 4;

const SKILL_COMMAND_REGEX = /\/skill\s+(\S+)/gi;

/** Common English stopwords filtered from keyword matching. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about',
  'up', 'down', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
  'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'let', 'get', 'got', 'make', 'go', 'going', 'want',
]);

// ============================================================================
// Helpers
// ============================================================================

/** Estimate token count from text (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokenize text into lowercase keywords, filtering stopwords. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Score relevance of a skill to a message (0-1).
 *
 * Compares message keywords against skill name, description, and tags.
 * Returns 1.0 for explicit `/skill <name>` requests.
 */
export function scoreRelevance(message: string, skill: MarkdownSkill): number {
  // Check for explicit /skill command
  const commandMatches = [...message.matchAll(SKILL_COMMAND_REGEX)];
  for (const match of commandMatches) {
    if (match[1].toLowerCase() === skill.name.toLowerCase()) {
      return 1.0;
    }
  }

  const messageKeywords = tokenize(message);
  if (messageKeywords.length === 0) return 0;

  // Build skill keyword set from name, description, and tags
  const skillKeywords = new Set<string>();
  for (const word of tokenize(skill.name)) skillKeywords.add(word);
  for (const word of tokenize(skill.description)) skillKeywords.add(word);
  for (const tag of skill.metadata.tags) {
    for (const word of tokenize(tag)) skillKeywords.add(word);
  }

  if (skillKeywords.size === 0) return 0;

  let matches = 0;
  for (const keyword of messageKeywords) {
    if (skillKeywords.has(keyword)) matches++;
  }

  return matches / messageKeywords.length;
}

/** Format a skill as an XML-like block for LLM prompt injection. */
function formatSkillBlock(skill: MarkdownSkill): string {
  return `<skill name="${skill.name}">\n${skill.body.trim()}\n</skill>`;
}

/** Check if a skill's required capabilities are ALL met by the agent. */
function meetsCapabilities(skill: MarkdownSkill, agentCaps: bigint): boolean {
  const required = skill.metadata.requiredCapabilities;
  if (!required) return true;

  try {
    const requiredBigint = BigInt(required);
    if (requiredBigint === 0n) return true;
    return (agentCaps & requiredBigint) === requiredBigint;
  } catch {
    // Invalid bigint string — skip the skill
    return false;
  }
}

// ============================================================================
// Session cache entry
// ============================================================================

interface CacheEntry {
  readonly skills: DiscoveredSkill[];
  readonly ts: number;
}

// ============================================================================
// MarkdownSkillInjector
// ============================================================================

export class MarkdownSkillInjector implements SkillInjector {
  private readonly discovery: SkillDiscovery;
  private readonly agentCaps: bigint;
  private readonly maxTokenBudget: number;
  private readonly cacheTtlMs: number;
  private readonly minScore: number;
  private readonly logger: Logger;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: SkillInjectorConfig) {
    this.discovery = config.discovery;
    this.agentCaps = config.agentCapabilities ?? 0n;
    this.maxTokenBudget = config.maxTokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.cacheTtlMs = config.sessionCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.minScore = config.minRelevanceScore ?? DEFAULT_MIN_SCORE;
    this.logger = config.logger ?? silentLogger;
  }

  // --------------------------------------------------------------------------
  // SkillInjector interface
  // --------------------------------------------------------------------------

  async inject(message: string, sessionId: string): Promise<string | undefined> {
    const result = await this.injectDetailed(message, sessionId);
    return result.content;
  }

  // --------------------------------------------------------------------------
  // Detailed injection
  // --------------------------------------------------------------------------

  async injectDetailed(message: string, sessionId: string): Promise<InjectionResult> {
    const available = await this.getAvailableSkills(sessionId);

    // Filter by capabilities
    const capable = available.filter((ds) => meetsCapabilities(ds.skill, this.agentCaps));

    // Score and sort
    const scored = capable
      .map((ds) => ({ ds, score: scoreRelevance(message, ds.skill) }))
      .filter((entry) => entry.score >= this.minScore)
      .sort((a, b) => b.score - a.score);

    // Pack into token budget
    const injected: string[] = [];
    const excluded: string[] = [];
    const blocks: string[] = [];
    let totalTokens = 0;

    for (const { ds } of scored) {
      const block = formatSkillBlock(ds.skill);
      const blockTokens = estimateTokens(block);

      if (totalTokens + blockTokens <= this.maxTokenBudget) {
        blocks.push(block);
        injected.push(ds.skill.name);
        totalTokens += blockTokens;
      } else {
        excluded.push(ds.skill.name);
      }
    }

    if (blocks.length === 0) {
      return { content: undefined, injectedSkills: [], excludedSkills: [], estimatedTokens: 0 };
    }

    const content = blocks.join('\n\n');

    this.logger.debug(
      `Injected ${injected.length} skills (${totalTokens} est. tokens): ${injected.join(', ')}`,
    );

    return {
      content,
      injectedSkills: injected,
      excludedSkills: excluded,
      estimatedTokens: totalTokens,
    };
  }

  // --------------------------------------------------------------------------
  // Cache
  // --------------------------------------------------------------------------

  clearCache(sessionId?: string): void {
    if (sessionId) {
      this.cache.delete(sessionId);
    } else {
      this.cache.clear();
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async getAvailableSkills(sessionId: string): Promise<DiscoveredSkill[]> {
    const cached = this.cache.get(sessionId);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.skills;
    }

    const skills = await this.discovery.getAvailable();
    this.cache.set(sessionId, { skills, ts: Date.now() });
    return skills;
  }
}
