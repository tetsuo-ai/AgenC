/**
 * Skill registry for managing skill instances.
 *
 * @module
 */

import type { Skill, SkillContext, SkillRegistryConfig } from './types.js';
import { SkillState } from './types.js';
import {
  SkillNotFoundError,
  SkillAlreadyRegisteredError,
  SkillInitializationError,
} from './errors.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

/**
 * Registry for managing skill instances.
 *
 * Skills are registered by name and can be looked up by name, capability,
 * or tag. The registry handles batch lifecycle (initialize/shutdown) for
 * all registered skills.
 *
 * @example
 * ```typescript
 * const registry = new SkillRegistry({ logger });
 * registry.register(new JupiterSkill());
 *
 * await registry.initializeAll({ connection, wallet, logger });
 *
 * const jupiter = registry.getOrThrow('jupiter');
 * const quote = await jupiter.getAction('getQuote')?.execute(params);
 *
 * await registry.shutdownAll();
 * ```
 */
export class SkillRegistry {
  private readonly skills: Map<string, Skill> = new Map();
  private readonly logger: Logger;

  constructor(config?: SkillRegistryConfig) {
    this.logger = config?.logger ?? silentLogger;
  }

  /**
   * Register a skill. Throws if a skill with the same name is already registered.
   */
  register(skill: Skill): void {
    const name = skill.metadata.name;
    if (this.skills.has(name)) {
      throw new SkillAlreadyRegisteredError(name);
    }
    this.skills.set(name, skill);
    this.logger.info(`Skill registered: "${name}" v${skill.metadata.version}`);
  }

  /**
   * Unregister a skill by name.
   * @returns true if the skill was found and removed, false otherwise
   */
  unregister(name: string): boolean {
    const removed = this.skills.delete(name);
    if (removed) {
      this.logger.info(`Skill unregistered: "${name}"`);
    }
    return removed;
  }

  /**
   * Get a skill by name.
   * @returns The skill, or undefined if not found
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get a skill by name, throwing if not found.
   */
  getOrThrow(name: string): Skill {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new SkillNotFoundError(name);
    }
    return skill;
  }

  /**
   * Find all skills that satisfy the required capability bitmask.
   * A skill matches if its requiredCapabilities is a subset of (or equal to)
   * the given bitmask, meaning the skill can operate within those capabilities.
   */
  findByCapability(capabilities: bigint): Skill[] {
    const results: Skill[] = [];
    for (const skill of this.skills.values()) {
      const required = skill.metadata.requiredCapabilities;
      if ((capabilities & required) === required) {
        results.push(skill);
      }
    }
    return results;
  }

  /**
   * Find all skills matching a tag.
   */
  findByTag(tag: string): Skill[] {
    const results: Skill[] = [];
    for (const skill of this.skills.values()) {
      if (skill.metadata.tags?.includes(tag)) {
        results.push(skill);
      }
    }
    return results;
  }

  /**
   * List all registered skill names.
   */
  listNames(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * List all registered skills.
   */
  listAll(): ReadonlyArray<Skill> {
    return Array.from(this.skills.values());
  }

  /**
   * Number of registered skills.
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Initialize all registered skills with the given context.
   * Skills that fail to initialize are logged and set to Error state,
   * but other skills continue initializing.
   *
   * @throws SkillInitializationError if any skill fails to initialize
   */
  async initializeAll(context: SkillContext): Promise<void> {
    const failures: string[] = [];

    for (const [name, skill] of this.skills) {
      try {
        this.logger.info(`Initializing skill: "${name}"`);
        await skill.initialize(context);
        this.logger.info(`Skill initialized: "${name}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to initialize skill "${name}": ${message}`);
        failures.push(name);
      }
    }

    if (failures.length > 0) {
      throw new SkillInitializationError(
        failures.join(', '),
        `${failures.length} skill(s) failed to initialize`,
      );
    }
  }

  /**
   * Shutdown all registered skills. Errors during shutdown are logged
   * but do not prevent other skills from shutting down.
   */
  async shutdownAll(): Promise<void> {
    for (const [name, skill] of this.skills) {
      if (skill.state === SkillState.Ready || skill.state === SkillState.Error) {
        try {
          this.logger.info(`Shutting down skill: "${name}"`);
          await skill.shutdown();
          this.logger.info(`Skill shut down: "${name}"`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Error shutting down skill "${name}": ${message}`);
        }
      }
    }
  }

  /**
   * Check if all registered skills are in Ready state.
   */
  isReady(): boolean {
    if (this.skills.size === 0) {
      return false;
    }
    for (const skill of this.skills.values()) {
      if (skill.state !== SkillState.Ready) {
        return false;
      }
    }
    return true;
  }
}
