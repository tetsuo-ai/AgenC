/**
 * Structured memory model: daily conversation logs, curated long-term memory,
 * and entity extraction interface (noop placeholder for Phase 5.4).
 *
 * @module
 */

import { readFile, writeFile, mkdir, appendFile, readdir, rename } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Returns `YYYY-MM-DD` in UTC for the given date (defaults to now). */
export function formatLogDate(date?: Date): string {
  const d = date ?? new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructuredMemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly entityName: string;
  readonly entityType: string;
  readonly confidence: number;
  readonly source: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
}

export interface EntityExtractor {
  extract(text: string, sessionId: string): Promise<StructuredMemoryEntry[]>;
}

// ---------------------------------------------------------------------------
// NoopEntityExtractor
// ---------------------------------------------------------------------------

export class NoopEntityExtractor implements EntityExtractor {
  async extract(_text: string, _sessionId: string): Promise<StructuredMemoryEntry[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// DailyLogManager
// ---------------------------------------------------------------------------

export class DailyLogManager {
  private readonly logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  get todayPath(): string {
    return join(this.logDir, formatLogDate() + '.md');
  }

  async append(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const label = role === 'user' ? 'User' : 'Agent';
    const line = `## ${hh}:${mm} [${sessionId}]\n**${label}:** ${content}\n\n`;
    await appendFile(this.todayPath, line);
  }

  async readLog(date: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.logDir, date + '.md'), 'utf-8');
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
  }

  async listDates(): Promise<string[]> {
    try {
      const files = await readdir(this.logDir);
      return files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .map((f) => basename(f, '.md'))
        .sort();
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// CuratedMemoryManager
// ---------------------------------------------------------------------------

export class CuratedMemoryManager {
  private readonly memoryFilePath: string;

  constructor(memoryFilePath: string) {
    this.memoryFilePath = memoryFilePath;
  }

  async load(): Promise<string> {
    try {
      return await readFile(this.memoryFilePath, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) return '';
      throw err;
    }
  }

  proposeAddition(fact: string, source: string): string {
    return `- ${fact} (source: ${source})`;
  }

  async addFact(fact: string): Promise<void> {
    await mkdir(dirname(this.memoryFilePath), { recursive: true });
    await appendFile(this.memoryFilePath, `- ${fact}\n`);
  }

  async removeFact(fact: string): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(this.memoryFilePath, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }

    const lines = content.split('\n');
    const target = '- ' + fact;
    const idx = lines.findIndex((line) => line.trimEnd() === target);
    if (idx === -1) return false;

    lines.splice(idx, 1);
    const tmpPath = this.memoryFilePath + '.tmp';
    await writeFile(tmpPath, lines.join('\n'));
    await rename(tmpPath, this.memoryFilePath);
    return true;
  }
}
