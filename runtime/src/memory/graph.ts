/**
 * Provenance-aware persistent memory graph built on top of MemoryBackend.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import type { MemoryBackend } from './types.js';

const NODE_PREFIX = 'graph:node:';
const EDGE_PREFIX = 'graph:edge:';
const SESSION_INDEX_PREFIX = 'graph:index:session:';

const DEFAULT_CONFIDENCE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type ProvenanceSourceType =
  | 'onchain_event'
  | 'tool_output'
  | 'tx_signature'
  | 'external_doc'
  | 'materialization'
  | 'manual';

export interface ProvenanceSource {
  type: ProvenanceSourceType;
  sourceId: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export type MemoryEdgeType =
  | 'derived_from'
  | 'supports'
  | 'contradicts'
  | 'supersedes';

export interface MemoryGraphNode {
  id: string;
  content: string;
  sessionId?: string;
  taskPda?: string;
  createdAt: number;
  updatedAt: number;
  baseConfidence: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  provenance: ProvenanceSource[];
}

export interface MemoryGraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: MemoryEdgeType;
  createdAt: number;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface UpsertMemoryNodeInput {
  id?: string;
  content: string;
  sessionId?: string;
  taskPda?: string;
  baseConfidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  provenance: ProvenanceSource[];
}

export interface AddMemoryEdgeInput {
  id?: string;
  fromId: string;
  toId: string;
  type: MemoryEdgeType;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryGraphQuery {
  sessionId?: string;
  taskPda?: string;
  textContains?: string;
  tagsAny?: string[];
  provenanceTypes?: ProvenanceSourceType[];
  requireProvenance?: boolean;
  minConfidence?: number;
  includeContradicted?: boolean;
  includeSuperseded?: boolean;
  limit?: number;
  nowMs?: number;
}

export interface MemoryGraphResult {
  node: MemoryGraphNode;
  effectiveConfidence: number;
  contradicted: boolean;
  superseded: boolean;
  sources: ProvenanceSource[];
}

export interface MemoryGraphConfig {
  confidenceHalfLifeMs?: number;
  now?: () => number;
}

export interface CompactOptions {
  retentionMs?: number;
  minBaseConfidence?: number;
}

export class MemoryGraph {
  private readonly backend: MemoryBackend;
  private readonly confidenceHalfLifeMs: number;
  private readonly now: () => number;

  constructor(backend: MemoryBackend, config: MemoryGraphConfig = {}) {
    this.backend = backend;
    this.confidenceHalfLifeMs = config.confidenceHalfLifeMs ?? DEFAULT_CONFIDENCE_HALF_LIFE_MS;
    this.now = config.now ?? Date.now;
  }

  async upsertNode(input: UpsertMemoryNodeInput): Promise<MemoryGraphNode> {
    this.assertProvenance(input.provenance);

    const timestamp = this.now();
    const existing = input.id ? await this.getNode(input.id) : null;
    const node: MemoryGraphNode = existing
      ? {
        ...existing,
        content: input.content,
        sessionId: input.sessionId ?? existing.sessionId,
        taskPda: input.taskPda ?? existing.taskPda,
        baseConfidence: this.normalizeConfidence(input.baseConfidence ?? existing.baseConfidence),
        tags: input.tags ?? existing.tags,
        metadata: input.metadata ?? existing.metadata,
        provenance: this.mergeProvenance(existing.provenance, input.provenance),
        updatedAt: timestamp,
      }
      : {
        id: input.id ?? randomUUID(),
        content: input.content,
        sessionId: input.sessionId,
        taskPda: input.taskPda,
        createdAt: timestamp,
        updatedAt: timestamp,
        baseConfidence: this.normalizeConfidence(input.baseConfidence ?? 0.75),
        tags: input.tags,
        metadata: input.metadata,
        provenance: [...input.provenance],
      };

    await this.backend.set(this.nodeKey(node.id), node);
    if (node.sessionId) {
      await this.addSessionIndex(node.sessionId, node.id);
    }
    return node;
  }

  async addEdge(input: AddMemoryEdgeInput): Promise<MemoryGraphEdge> {
    if (!(await this.getNode(input.fromId))) {
      throw new Error(`Source node not found: ${input.fromId}`);
    }
    if (!(await this.getNode(input.toId))) {
      throw new Error(`Target node not found: ${input.toId}`);
    }

    const edge: MemoryGraphEdge = {
      id: input.id ?? randomUUID(),
      fromId: input.fromId,
      toId: input.toId,
      type: input.type,
      createdAt: this.now(),
      weight: input.weight,
      metadata: input.metadata,
    };
    await this.backend.set(this.edgeKey(edge.id), edge);
    return edge;
  }

  async getNode(id: string): Promise<MemoryGraphNode | null> {
    const node = await this.backend.get<MemoryGraphNode>(this.nodeKey(id));
    return node ?? null;
  }

  async getEdge(id: string): Promise<MemoryGraphEdge | null> {
    const edge = await this.backend.get<MemoryGraphEdge>(this.edgeKey(id));
    return edge ?? null;
  }

  async listNodes(sessionId?: string): Promise<MemoryGraphNode[]> {
    if (sessionId) {
      const ids = await this.backend.get<string[]>(this.sessionIndexKey(sessionId));
      if (!ids || ids.length === 0) return [];
      const nodes = await Promise.all(ids.map((id) => this.getNode(id)));
      return nodes.filter((node): node is MemoryGraphNode => node !== null);
    }

    const keys = await this.backend.listKeys(NODE_PREFIX);
    const nodes = await Promise.all(
      keys.map((key) => this.backend.get<MemoryGraphNode>(key)),
    );
    return nodes.filter((node): node is MemoryGraphNode => node !== undefined);
  }

  async listEdges(): Promise<MemoryGraphEdge[]> {
    const keys = await this.backend.listKeys(EDGE_PREFIX);
    const edges = await Promise.all(
      keys.map((key) => this.backend.get<MemoryGraphEdge>(key)),
    );
    return edges.filter((edge): edge is MemoryGraphEdge => edge !== undefined);
  }

  async query(query: MemoryGraphQuery = {}): Promise<MemoryGraphResult[]> {
    const now = query.nowMs ?? this.now();
    const nodes = await this.listNodes(query.sessionId);
    const edges = await this.listEdges();

    const contradictedIds = new Set(
      edges.filter((edge) => edge.type === 'contradicts').map((edge) => edge.toId),
    );
    const supersededIds = new Set(
      edges.filter((edge) => edge.type === 'supersedes').map((edge) => edge.toId),
    );

    const results: MemoryGraphResult[] = [];
    for (const node of nodes) {
      if (query.taskPda && node.taskPda !== query.taskPda) continue;
      if (query.textContains && !node.content.toLowerCase().includes(query.textContains.toLowerCase())) continue;
      if (query.tagsAny && query.tagsAny.length > 0) {
        const tags = node.tags ?? [];
        if (!query.tagsAny.some((tag) => tags.includes(tag))) continue;
      }

      const sources = node.provenance ?? [];
      if (query.requireProvenance && sources.length === 0) continue;
      if (query.provenanceTypes && query.provenanceTypes.length > 0) {
        if (!sources.some((source) => query.provenanceTypes!.includes(source.type))) continue;
      }

      const contradicted = contradictedIds.has(node.id);
      const superseded = supersededIds.has(node.id);
      if (contradicted && query.includeContradicted === false) continue;
      if (superseded && query.includeSuperseded === false) continue;

      const effectiveConfidence = this.computeEffectiveConfidence(node, now);
      if (query.minConfidence !== undefined && effectiveConfidence < query.minConfidence) continue;

      results.push({
        node,
        effectiveConfidence,
        contradicted,
        superseded,
        sources,
      });
    }

    results.sort((a, b) => {
      if (b.effectiveConfidence !== a.effectiveConfidence) {
        return b.effectiveConfidence - a.effectiveConfidence;
      }
      return b.node.updatedAt - a.node.updatedAt;
    });

    if (query.limit !== undefined && query.limit > 0) {
      return results.slice(0, query.limit);
    }
    return results;
  }

  async materializeSessionSummary(sessionId: string, limit = 50): Promise<MemoryGraphNode> {
    const entries = await this.backend.getThread(sessionId, limit);
    const summaryLines = entries.slice(-5).map((entry) => `${entry.role}: ${entry.content}`);
    const summary = summaryLines.join('\n');

    return await this.upsertNode({
      content: summary.length > 0 ? summary : 'No session history available',
      sessionId,
      tags: ['summary', 'materialized'],
      baseConfidence: 0.65,
      provenance: [{
        type: 'materialization',
        sourceId: `session:${sessionId}`,
        description: `Materialized from ${entries.length} thread entries`,
      }],
    });
  }

  async ingestToolOutput(options: {
    sessionId: string;
    toolName: string;
    output: string;
    taskPda?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<MemoryGraphNode> {
    return await this.upsertNode({
      content: options.output,
      sessionId: options.sessionId,
      taskPda: options.taskPda,
      tags: ['tool-output', options.toolName],
      baseConfidence: options.confidence ?? 0.8,
      metadata: options.metadata,
      provenance: [{
        type: 'tool_output',
        sourceId: `${options.toolName}:${this.now()}`,
        description: `Tool output from ${options.toolName}`,
        metadata: options.metadata,
      }],
    });
  }

  async ingestOnChainEvent(options: {
    eventName: string;
    txSignature: string;
    payload: string;
    sessionId?: string;
    taskPda?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<MemoryGraphNode> {
    return await this.upsertNode({
      content: options.payload,
      sessionId: options.sessionId,
      taskPda: options.taskPda,
      tags: ['onchain-event', options.eventName],
      baseConfidence: options.confidence ?? 0.9,
      metadata: options.metadata,
      provenance: [{
        type: 'onchain_event',
        sourceId: options.txSignature,
        description: options.eventName,
        metadata: options.metadata,
      }],
    });
  }

  async compact(options: CompactOptions = {}): Promise<{ removedNodes: number; removedEdges: number }> {
    const now = this.now();
    const nodes = await this.listNodes();
    const retentionMs = options.retentionMs;
    const minBaseConfidence = options.minBaseConfidence;

    const toRemove = new Set<string>();
    for (const node of nodes) {
      const stale = retentionMs !== undefined && now - node.updatedAt > retentionMs;
      const weak = minBaseConfidence !== undefined && node.baseConfidence < minBaseConfidence;
      if (stale || weak) {
        toRemove.add(node.id);
      }
    }

    for (const nodeId of toRemove) {
      await this.backend.delete(this.nodeKey(nodeId));
    }

    const edges = await this.listEdges();
    let removedEdges = 0;
    for (const edge of edges) {
      if (toRemove.has(edge.fromId) || toRemove.has(edge.toId)) {
        await this.backend.delete(this.edgeKey(edge.id));
        removedEdges++;
      }
    }

    return { removedNodes: toRemove.size, removedEdges };
  }

  private computeEffectiveConfidence(node: MemoryGraphNode, nowMs: number): number {
    if (this.confidenceHalfLifeMs <= 0) {
      return node.baseConfidence;
    }
    const ageMs = Math.max(0, nowMs - node.updatedAt);
    const decay = Math.exp((-Math.log(2) * ageMs) / this.confidenceHalfLifeMs);
    return node.baseConfidence * decay;
  }

  private async addSessionIndex(sessionId: string, nodeId: string): Promise<void> {
    const key = this.sessionIndexKey(sessionId);
    const ids = (await this.backend.get<string[]>(key)) ?? [];
    if (!ids.includes(nodeId)) {
      ids.push(nodeId);
      await this.backend.set(key, ids);
    }
  }

  private mergeProvenance(
    existing: ProvenanceSource[],
    incoming: ProvenanceSource[],
  ): ProvenanceSource[] {
    const merged = [...existing];
    for (const source of incoming) {
      const exists = merged.some(
        (current) =>
          current.type === source.type
          && current.sourceId === source.sourceId,
      );
      if (!exists) {
        merged.push(source);
      }
    }
    return merged;
  }

  private assertProvenance(provenance: ProvenanceSource[]): void {
    if (!Array.isArray(provenance) || provenance.length === 0) {
      throw new Error('Memory graph writes require provenance metadata');
    }
    for (const source of provenance) {
      if (!source.type || !source.sourceId) {
        throw new Error('Invalid provenance entry: type and sourceId are required');
      }
    }
  }

  private normalizeConfidence(confidence: number): number {
    if (!Number.isFinite(confidence)) return 0;
    if (confidence < 0) return 0;
    if (confidence > 1) return 1;
    return confidence;
  }

  private nodeKey(id: string): string {
    return `${NODE_PREFIX}${id}`;
  }

  private edgeKey(id: string): string {
    return `${EDGE_PREFIX}${id}`;
  }

  private sessionIndexKey(sessionId: string): string {
    return `${SESSION_INDEX_PREFIX}${sessionId}`;
  }
}

