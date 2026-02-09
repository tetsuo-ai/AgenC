/**
 * Core tool system types for @agenc/runtime
 *
 * Defines the MCP-compatible Tool interface and supporting types
 * that bridge Skills and LLM adapters.
 *
 * @module
 */

import type { Connection } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../types/agenc_coordination.js';
import type { Logger } from '../utils/logger.js';

/**
 * JSON Schema type alias.
 * Matches LLMTool.function.parameters exactly — zero additional deps.
 */
export type JSONSchema = Record<string, unknown>;

/**
 * Result returned by a tool execution.
 *
 * `content` is a string because both `ToolHandler` (LLM system) and
 * MCP specify text content for tool results.
 */
export interface ToolResult {
  /** Result content — JSON string for structured data, plain text otherwise */
  content: string;
  /** True if execution failed (error message in content) */
  isError?: boolean;
  /** Optional metadata for logging — not sent to LLMs */
  metadata?: Record<string, unknown>;
}

/**
 * MCP-compatible tool interface.
 *
 * Tools are the atomic unit of functionality exposed to LLM agents.
 * They can be converted to `LLMTool[]` for provider configs and
 * dispatched via `ToolHandler` for the executor.
 */
export interface Tool {
  /** Namespaced tool name (e.g. "jupiter.getQuote", "agenc.listTasks") */
  readonly name: string;
  /** Human-readable description for LLM consumption */
  readonly description: string;
  /** JSON Schema describing the input parameters */
  readonly inputSchema: JSONSchema;
  /** Execute the tool with the given arguments */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Context provided to built-in tool factories.
 *
 * Omits `wallet` because built-in tools are read-only queries.
 */
export interface ToolContext {
  /** Solana RPC connection */
  readonly connection: Connection;
  /** Optional Anchor program instance (tools can create read-only if absent) */
  readonly program?: Program<AgencCoordination>;
  /** Logger instance */
  readonly logger: Logger;
}

/**
 * Configuration for ToolRegistry.
 */
export interface ToolRegistryConfig {
  /** Logger for registry operations */
  logger?: Logger;
}

/**
 * Bigint-safe JSON replacer.
 *
 * Use with `JSON.stringify` for any data that may contain bigint values
 * (e.g. lamport amounts, capability masks). Without this, `JSON.stringify`
 * throws `TypeError: Do not know how to serialize a BigInt`.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Bigint-safe `JSON.stringify` wrapper.
 *
 * Equivalent to `JSON.stringify(value, bigintReplacer)`.
 */
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}
