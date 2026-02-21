/**
 * Skill-to-Tool adapter.
 *
 * Converts Skill actions into Tool instances, bridging the skill system
 * to the MCP-compatible tool registry.
 *
 * @module
 */

import type { Skill, SkillAction } from "../skills/types.js";
import { SkillState } from "../skills/types.js";
import type { Tool, JSONSchema, ToolResult } from "./types.js";
import { safeStringify } from "./types.js";
import { ToolExecutionError } from "./errors.js";

/**
 * Map of action names to their JSON Schema definitions.
 * Only actions with a schema entry are exposed as tools.
 */
export type ActionSchemaMap = Record<string, JSONSchema>;

/**
 * Options for converting a skill to tools.
 */
export interface SkillToToolsOptions {
  /** JSON Schema for each action to expose */
  schemas: ActionSchemaMap;
  /** Namespace prefix (defaults to skill.metadata.name) */
  namespace?: string;
}

/**
 * Convert a Skill's actions into Tool instances.
 *
 * Each SkillAction becomes a Tool with:
 * - name: `${namespace}.${action.name}`
 * - inputSchema: from the schema map
 * - execute: wraps action.execute, serializes result with safeStringify
 *
 * Actions without a schema entry are skipped.
 *
 * @param skill - The skill to convert (must be in Ready state)
 * @param options - Schema map and optional namespace override
 * @returns Array of Tool instances
 * @throws ToolExecutionError if skill is not in Ready state
 */
export function skillToTools(
  skill: Skill,
  options: SkillToToolsOptions,
): Tool[] {
  if (skill.state !== SkillState.Ready) {
    throw new ToolExecutionError(
      skill.metadata.name,
      `Skill must be in Ready state (current: ${SkillState[skill.state]})`,
    );
  }

  const namespace = options.namespace ?? skill.metadata.name;
  const actions = skill.getActions();
  const tools: Tool[] = [];

  for (const action of actions) {
    const schema = options.schemas[action.name];
    if (!schema) {
      continue;
    }

    tools.push(createToolFromAction(namespace, action, schema));
  }

  return tools;
}

/**
 * Create a single Tool from a SkillAction.
 */
function createToolFromAction(
  namespace: string,
  action: SkillAction,
  schema: JSONSchema,
): Tool {
  return {
    name: `${namespace}.${action.name}`,
    description: action.description,
    inputSchema: schema,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await action.execute(args);
        return { content: safeStringify(result) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: safeStringify({ error: message }),
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// Pre-built Schema Maps
// ============================================================================

/**
 * JSON Schema definitions for all 7 Jupiter skill actions.
 *
 * Bigint fields use `type: 'string'` since JSON cannot represent bigint.
 * The LLM sends numeric strings which the action casts internally.
 */
export const JUPITER_ACTION_SCHEMAS: ActionSchemaMap = {
  getQuote: {
    type: "object",
    properties: {
      inputMint: {
        type: "string",
        description: "Input token mint address (base58)",
      },
      outputMint: {
        type: "string",
        description: "Output token mint address (base58)",
      },
      amount: {
        type: "string",
        description: "Amount in smallest unit (e.g. lamports)",
      },
      slippageBps: {
        type: "number",
        description: "Slippage tolerance in basis points",
      },
      onlyDirectRoutes: {
        type: "boolean",
        description: "Restrict to direct routes only",
      },
    },
    required: ["inputMint", "outputMint", "amount"],
  },
  executeSwap: {
    type: "object",
    properties: {
      inputMint: {
        type: "string",
        description: "Input token mint address (base58)",
      },
      outputMint: {
        type: "string",
        description: "Output token mint address (base58)",
      },
      amount: {
        type: "string",
        description: "Amount in smallest unit (e.g. lamports)",
      },
      slippageBps: {
        type: "number",
        description: "Slippage tolerance in basis points",
      },
      onlyDirectRoutes: {
        type: "boolean",
        description: "Restrict to direct routes only",
      },
    },
    required: ["inputMint", "outputMint", "amount"],
  },
  getSolBalance: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "Wallet address (base58). Omit for own wallet.",
      },
    },
  },
  getTokenBalance: {
    type: "object",
    properties: {
      mint: { type: "string", description: "Token mint address (base58)" },
      owner: {
        type: "string",
        description: "Owner wallet address (base58). Omit for own wallet.",
      },
    },
    required: ["mint"],
  },
  transferSol: {
    type: "object",
    properties: {
      recipient: {
        type: "string",
        description: "Recipient wallet address (base58)",
      },
      lamports: { type: "string", description: "Amount in lamports" },
    },
    required: ["recipient", "lamports"],
  },
  transferToken: {
    type: "object",
    properties: {
      recipient: {
        type: "string",
        description: "Recipient wallet address (base58)",
      },
      mint: { type: "string", description: "Token mint address (base58)" },
      amount: { type: "string", description: "Amount in smallest unit" },
    },
    required: ["recipient", "mint", "amount"],
  },
  getTokenPrice: {
    type: "object",
    properties: {
      mints: {
        type: "array",
        items: { type: "string" },
        description: "Token mint addresses to look up",
      },
    },
    required: ["mints"],
  },
};
