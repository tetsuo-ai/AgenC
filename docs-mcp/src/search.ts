import type { DocEntry, SearchResult } from './types.js';

/** Simple in-memory inverted index for full-text search */
export class SearchIndex {
  private index = new Map<string, Set<string>>();
  private docs = new Map<string, DocEntry>();

  /** Build index from loaded docs */
  build(docs: Map<string, DocEntry>): void {
    this.docs = docs;
    this.index.clear();

    for (const [docPath, entry] of docs) {
      const tokens = this.tokenize(entry.title + ' ' + entry.content);
      for (const token of tokens) {
        let set = this.index.get(token);
        if (!set) {
          set = new Set();
          this.index.set(token, set);
        }
        set.add(docPath);
      }
    }
  }

  /** Search for documents matching query */
  search(query: string, limit = 10): SearchResult[] {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    // Score each doc by number of matching tokens
    const scores = new Map<string, number>();
    for (const token of queryTokens) {
      const matches = this.index.get(token);
      if (!matches) continue;
      for (const docPath of matches) {
        scores.set(docPath, (scores.get(docPath) ?? 0) + 1);
      }
    }

    // Normalize scores and build results
    const results: SearchResult[] = [];
    for (const [docPath, matchCount] of scores) {
      const doc = this.docs.get(docPath);
      if (!doc) continue;

      const score = matchCount / queryTokens.length;
      const snippet = this.extractSnippet(doc.content, queryTokens);

      results.push({
        path: docPath,
        title: doc.title,
        score,
        snippet,
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_\-./# ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }

  private extractSnippet(content: string, queryTokens: string[]): string {
    const lines = content.split('\n');
    const lowerTokens = new Set(queryTokens);

    // Find the line with the most token matches
    let bestLine = 0;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineTokens = this.tokenize(lines[i]);
      let lineScore = 0;
      for (const t of lineTokens) {
        if (lowerTokens.has(t)) lineScore++;
      }
      if (lineScore > bestScore) {
        bestScore = lineScore;
        bestLine = i;
      }
    }

    // Extract 3 lines around the best match
    const start = Math.max(0, bestLine - 1);
    const end = Math.min(lines.length, bestLine + 2);
    const snippet = lines.slice(start, end).join('\n').trim();

    // Truncate long snippets
    if (snippet.length > 300) {
      return snippet.slice(0, 297) + '...';
    }
    return snippet;
  }
}
