import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PluginManifest } from './manifest.js';

export type PluginPrecedence = 'workspace' | 'user' | 'builtin';

export type PluginSlot = 'memory' | 'llm' | 'proof' | 'telemetry' | 'custom';

export interface CatalogEntry {
  manifest: PluginManifest;
  precedence: PluginPrecedence;
  enabled: boolean;
  slot?: PluginSlot;
  sourcePath?: string;
  installedAtMs: number;
  lastModifiedMs: number;
}

export interface CatalogState {
  schemaVersion: number;
  entries: Record<string, CatalogEntry>;
  slotAssignments: Record<string, string>;
  lastModifiedMs: number;
}

export interface CatalogOperationResult {
  success: boolean;
  pluginId: string;
  operation: 'install' | 'enable' | 'disable' | 'reload' | 'uninstall';
  message: string;
  previousState?: Partial<CatalogEntry>;
  newState?: Partial<CatalogEntry>;
}

export interface SlotCollision {
  slot: PluginSlot;
  incumbent: string;
  challenger: string;
  incumbentPrecedence: PluginPrecedence;
  challengerPrecedence: PluginPrecedence;
}

export class PluginCatalogError extends Error {
  public readonly pluginId?: string;

  constructor(message: string, pluginId?: string) {
    super(message);
    this.name = 'PluginCatalogError';
    this.pluginId = pluginId;
  }
}

const DEFAULT_CATALOG_PATH = '.agenc/plugins.json';
const DEFAULT_SCHEMA_VERSION = 1;
const PRECEDENCE_ORDER: Record<PluginPrecedence, number> = {
  workspace: 0,
  user: 1,
  builtin: 2,
};

function toDateNow(): number {
  return Date.now();
}

function normalizePluginPrecedence(precedence: PluginPrecedence): PluginPrecedence {
  return precedence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneEntry(entry: CatalogEntry): CatalogEntry {
  return {
    manifest: { ...entry.manifest },
    precedence: entry.precedence,
    enabled: entry.enabled,
    slot: entry.slot,
    sourcePath: entry.sourcePath,
    installedAtMs: entry.installedAtMs,
    lastModifiedMs: entry.lastModifiedMs,
  };
}

function emptyState(): CatalogState {
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    entries: {},
    slotAssignments: {},
    lastModifiedMs: 0,
  };
}

export class PluginCatalog {
  private state: CatalogState;
  private readonly statePath: string;

  constructor(statePath = DEFAULT_CATALOG_PATH) {
    this.statePath = statePath;
    this.state = this.loadState();
  }

  list(): CatalogEntry[] {
    return Object.values(this.state.entries)
      .map(cloneEntry)
      .sort((left, right) => {
        const precedenceDelta = PRECEDENCE_ORDER[left.precedence] - PRECEDENCE_ORDER[right.precedence];
        if (precedenceDelta !== 0) {
          return precedenceDelta;
        }
        return left.manifest.id.localeCompare(right.manifest.id);
      });
  }

  install(
    manifest: PluginManifest,
    precedence: PluginPrecedence,
    options?: { slot?: PluginSlot; sourcePath?: string },
  ): CatalogOperationResult {
    const id = manifest.id;

    if (this.state.entries[id]) {
      return {
        success: false,
        pluginId: id,
        operation: 'install',
        message: `Plugin "${id}" is already installed`,
      };
    }

    const slot = options?.slot;
    if (slot) {
      const collision = this.checkSlotCollision(id, slot, precedence);
      if (collision) {
        return {
          success: false,
          pluginId: id,
          operation: 'install',
          message: `Slot "${collision.slot}" is occupied by "${collision.incumbent}"`,
        };
      }
    }

    const normalizedPrecedence = normalizePluginPrecedence(precedence);
    const now = toDateNow();
    const entry: CatalogEntry = {
      manifest,
      precedence: normalizedPrecedence,
      enabled: true,
      slot,
      sourcePath: options?.sourcePath,
      installedAtMs: now,
      lastModifiedMs: now,
    };

    this.state.entries[id] = cloneEntry(entry);
    if (slot) {
      this.claimSlot(id, slot, now);
    }
    this.state.lastModifiedMs = now;
    this.saveState();

    return {
      success: true,
      pluginId: id,
      operation: 'install',
      message: `Plugin "${id}" installed`,
      newState: {
        enabled: true,
        precedence: normalizedPrecedence,
        slot,
      },
    };
  }

  disable(pluginId: string): CatalogOperationResult {
    const entry = this.state.entries[pluginId];
    if (!entry) {
      return {
        success: false,
        pluginId,
        operation: 'disable',
        message: `Plugin "${pluginId}" not found`,
      };
    }

    if (!entry.enabled) {
      return {
        success: true,
        pluginId,
        operation: 'disable',
        message: `Plugin "${pluginId}" is already disabled`,
      };
    }

    const previous = {
      enabled: entry.enabled,
      lastModifiedMs: entry.lastModifiedMs,
    };
    entry.enabled = false;
    entry.lastModifiedMs = toDateNow();
    this.releaseSlot(pluginId);
    this.state.lastModifiedMs = entry.lastModifiedMs;
    this.saveState();

    return {
      success: true,
      pluginId,
      operation: 'disable',
      message: `Plugin "${pluginId}" disabled`,
      previousState: previous,
      newState: {
        enabled: false,
        lastModifiedMs: entry.lastModifiedMs,
      },
    };
  }

  enable(pluginId: string): CatalogOperationResult {
    const entry = this.state.entries[pluginId];
    if (!entry) {
      return {
        success: false,
        pluginId,
        operation: 'enable',
        message: `Plugin "${pluginId}" not found`,
      };
    }

    if (entry.enabled) {
      return {
        success: true,
        pluginId,
        operation: 'enable',
        message: `Plugin "${pluginId}" is already enabled`,
        newState: {
          enabled: true,
        },
      };
    }

    const previous = {
      enabled: entry.enabled,
      lastModifiedMs: entry.lastModifiedMs,
    };

    if (entry.slot) {
      const currentOccupant = this.state.slotAssignments[entry.slot];
      if (currentOccupant && currentOccupant !== pluginId) {
        return {
          success: false,
          pluginId,
          operation: 'enable',
          message: `Slot "${entry.slot}" is occupied by "${currentOccupant}"`,
          previousState: previous,
        };
      }
    }

    entry.enabled = true;
    entry.lastModifiedMs = toDateNow();
    if (entry.slot) {
      this.claimSlot(pluginId, entry.slot, entry.lastModifiedMs);
    }
    this.state.lastModifiedMs = entry.lastModifiedMs;
    this.saveState();

    return {
      success: true,
      pluginId,
      operation: 'enable',
      message: `Plugin "${pluginId}" enabled`,
      previousState: previous,
      newState: {
        enabled: true,
        lastModifiedMs: entry.lastModifiedMs,
      },
    };
  }

  reload(pluginId: string, manifest?: PluginManifest): CatalogOperationResult {
    const entry = this.state.entries[pluginId];
    if (!entry) {
      return {
        success: false,
        pluginId,
        operation: 'reload',
        message: `Plugin "${pluginId}" not found`,
      };
    }

    const previous = {
      manifest: { ...entry.manifest },
      lastModifiedMs: entry.lastModifiedMs,
    };
    if (manifest) {
      entry.manifest = manifest;
    }
    entry.lastModifiedMs = toDateNow();
    this.state.lastModifiedMs = entry.lastModifiedMs;
    this.saveState();

    return {
      success: true,
      pluginId,
      operation: 'reload',
      message: `Plugin "${pluginId}" reloaded`,
      previousState: previous,
      newState: {
        manifest: { ...entry.manifest },
        lastModifiedMs: entry.lastModifiedMs,
      },
    };
  }

  private loadState(): CatalogState {
    if (!existsSync(this.statePath)) {
      return emptyState();
    }

    const raw = readFileSync(this.statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CatalogState>;
    const entries = isRecord(parsed.entries) ? parsed.entries : {};
    const slotAssignments = isRecord(parsed.slotAssignments)
      ? parsed.slotAssignments
      : {};
    const normalizedEntries = Object.entries(entries).reduce<Record<string, CatalogEntry>>(
      (accumulator, [id, candidate]) => {
        if (isRecord(candidate) && typeof candidate.manifest === 'object' && candidate.manifest !== null) {
          accumulator[id] = {
            ...(candidate as CatalogEntry),
            manifest: candidate.manifest as PluginManifest,
          };
        }
        return accumulator;
      },
      {},
    );

    return {
      schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : DEFAULT_SCHEMA_VERSION,
      entries: normalizedEntries,
      slotAssignments: Object.entries(slotAssignments).reduce<Record<string, string>>((accumulator, [slot, pluginId]) => {
        if (typeof pluginId === 'string') {
          accumulator[slot] = pluginId;
        }
        return accumulator;
      }, {}),
      lastModifiedMs: typeof parsed.lastModifiedMs === 'number' ? parsed.lastModifiedMs : toDateNow(),
    };
  }

  private saveState(): void {
    const directory = dirname(this.statePath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  private checkSlotCollision(
    pluginId: string,
    slot: PluginSlot,
    precedence: PluginPrecedence,
  ): SlotCollision | null {
    const incumbentId = this.state.slotAssignments[slot];
    if (!incumbentId || incumbentId === pluginId) {
      return null;
    }

    const incumbent = this.state.entries[incumbentId];
    if (!incumbent) {
      return null;
    }

    if (PRECEDENCE_ORDER[precedence] < PRECEDENCE_ORDER[incumbent.precedence]) {
      return null;
    }

    return {
      slot,
      incumbent: incumbentId,
      challenger: pluginId,
      incumbentPrecedence: incumbent.precedence,
      challengerPrecedence: precedence,
    };
  }

  private claimSlot(pluginId: string, slot: PluginSlot, nowMs: number): void {
    const incumbentId = this.state.slotAssignments[slot];
    if (incumbentId && incumbentId !== pluginId) {
      const incumbent = this.state.entries[incumbentId];
      if (incumbent && incumbent.enabled) {
        incumbent.enabled = false;
        incumbent.lastModifiedMs = nowMs;
      }
    }

    this.state.slotAssignments[slot] = pluginId;
  }

  private releaseSlot(pluginId: string): void {
    const plugin = this.state.entries[pluginId];
    if (!plugin?.slot) {
      return;
    }

    if (this.state.slotAssignments[plugin.slot] === pluginId) {
      delete this.state.slotAssignments[plugin.slot];
    }
  }
}
