/** A loaded documentation entry */
export interface DocEntry {
  /** Relative path from docs root (e.g. "architecture/overview.md") */
  path: string;
  /** Document title (first # heading or filename) */
  title: string;
  /** Raw markdown content */
  content: string;
  /** Document category */
  category: 'architecture' | 'flow' | 'phase' | 'guide' | 'other';
}

/** A roadmap issue entry from issue-map.json */
export interface IssueEntry {
  issueNumber: number;
  title: string;
  phase: number;
  section: string;
  priority: string;
  roadmapLineStart: number;
  roadmapLineEnd: number;
  filesToCreate: string[];
  filesToModify: string[];
  dependsOnIssues: number[];
  dependedByIssues: number[];
  existingPatterns: string[];
  keyInterfaces: string[];
  phaseDoc: string;
  estimatedScope: string;
}

/** A search result with relevance score */
export interface SearchResult {
  /** Document path */
  path: string;
  /** Document title */
  title: string;
  /** Relevance score (0-1) */
  score: number;
  /** Context snippet around the match */
  snippet: string;
}

/** Phase tracking issue */
export interface TrackingIssue {
  issue: number;
  title: string;
  priority: string;
}

/** Raw issue-map.json structure */
export interface IssueMapData {
  meta: {
    description: string;
    sourceDocument: string;
    masterEpic: string;
    totalIssues: number;
    generatedFrom: string;
  };
  trackingIssues: Record<string, TrackingIssue>;
  issues: Record<string, Omit<IssueEntry, 'issueNumber'>>;
}
