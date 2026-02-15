import type { IssueEntry, IssueMapData, DocEntry } from './types.js';

/** Resolves issue numbers to implementation context */
export class IssueResolver {
  constructor(
    private issues: Map<number, IssueEntry>,
    private issueMapRaw: IssueMapData | null,
    private roadmapContent: string,
    private docs: Map<string, DocEntry>,
  ) {}

  /** Get full implementation context for an issue */
  getIssueContext(issueNumber: number): string | null {
    const issue = this.issues.get(issueNumber);
    if (!issue) return null;

    const parts: string[] = [];

    // Header
    parts.push(`# Issue #${issueNumber}: ${issue.title}`);
    parts.push('');
    parts.push(`**Phase:** ${issue.phase} | **Section:** ${issue.section} | **Priority:** ${issue.priority} | **Scope:** ${issue.estimatedScope}`);
    parts.push('');

    // Roadmap section
    const roadmapSection = this.extractRoadmapSection(issue.roadmapLineStart, issue.roadmapLineEnd);
    if (roadmapSection) {
      parts.push('## Roadmap Description');
      parts.push('');
      parts.push(roadmapSection);
      parts.push('');
    }

    // Files
    if (issue.filesToCreate.length > 0) {
      parts.push('## Files to Create');
      for (const f of issue.filesToCreate) {
        parts.push(`- \`${f}\``);
      }
      parts.push('');
    }

    if (issue.filesToModify.length > 0) {
      parts.push('## Files to Modify');
      for (const f of issue.filesToModify) {
        parts.push(`- \`${f}\``);
      }
      parts.push('');
    }

    // Dependencies
    if (issue.dependsOnIssues.length > 0) {
      parts.push('## Depends On');
      for (const dep of issue.dependsOnIssues) {
        const depIssue = this.issues.get(dep);
        parts.push(`- #${dep}: ${depIssue?.title ?? 'Unknown'}`);
      }
      parts.push('');
    }

    if (issue.dependedByIssues.length > 0) {
      parts.push('## Depended By');
      for (const dep of issue.dependedByIssues) {
        const depIssue = this.issues.get(dep);
        parts.push(`- #${dep}: ${depIssue?.title ?? 'Unknown'}`);
      }
      parts.push('');
    }

    // Patterns
    if (issue.existingPatterns.length > 0) {
      parts.push('## Existing Patterns to Follow');
      for (const p of issue.existingPatterns) {
        parts.push(`- \`${p}\``);
      }
      parts.push('');
    }

    // Key interfaces
    if (issue.keyInterfaces.length > 0) {
      parts.push('## Key Interfaces');
      parts.push(issue.keyInterfaces.map((i) => `\`${i}\``).join(', '));
      parts.push('');
    }

    // Phase doc link
    parts.push('## Phase Documentation');
    parts.push(`See: \`${issue.phaseDoc}\``);
    const phaseDocKey = issue.phaseDoc.replace('docs/', '');
    const phaseDoc = this.docs.get(phaseDocKey);
    if (phaseDoc) {
      // Extract the relevant section from the phase doc
      const sectionContent = this.extractPhaseSection(phaseDoc.content, issue.section, issueNumber);
      if (sectionContent) {
        parts.push('');
        parts.push(sectionContent);
      }
    }

    return parts.join('\n');
  }

  /** Get dependency chain for an issue (transitive) */
  getDependencyChain(issueNumber: number): number[] {
    const visited = new Set<number>();
    const chain: number[] = [];

    const visit = (num: number) => {
      if (visited.has(num)) return;
      visited.add(num);
      const issue = this.issues.get(num);
      if (!issue) return;
      for (const dep of issue.dependsOnIssues) {
        visit(dep);
      }
      chain.push(num);
    };

    visit(issueNumber);
    return chain;
  }

  /** Get all issues for a phase */
  getPhaseIssues(phase: number): IssueEntry[] {
    const result: IssueEntry[] = [];
    for (const issue of this.issues.values()) {
      if (issue.phase === phase) {
        result.push(issue);
      }
    }
    return result.sort((a, b) => {
      const aNum = parseFloat(a.section);
      const bNum = parseFloat(b.section);
      return aNum - bNum;
    });
  }

  /** Get phase dependency graph as Mermaid */
  getPhaseDependencyGraph(phase: number): string {
    const issues = this.getPhaseIssues(phase);
    if (issues.length === 0) return 'No issues found for this phase.';

    const tracking = this.issueMapRaw?.trackingIssues[String(phase)];
    const lines: string[] = [];
    lines.push('```mermaid');
    lines.push('flowchart TD');

    for (const issue of issues) {
      const label = `${issue.section}: ${issue.title}`;
      lines.push(`    N${issue.issueNumber}["#${issue.issueNumber} ${label}"]`);
    }

    const phaseIssueNums = new Set(issues.map((i) => i.issueNumber));
    for (const issue of issues) {
      for (const dep of issue.dependsOnIssues) {
        if (phaseIssueNums.has(dep)) {
          lines.push(`    N${dep} --> N${issue.issueNumber}`);
        }
      }
    }

    lines.push('```');
    lines.push('');

    if (tracking) {
      lines.push(`**Tracking issue:** #${tracking.issue} — ${tracking.title} (${tracking.priority})`);
    }

    lines.push('');
    lines.push('## Implementation Order');
    lines.push('');
    // Topological sort within phase
    const sorted = this.topSortPhase(issues);
    for (let i = 0; i < sorted.length; i++) {
      const issue = sorted[i];
      lines.push(`${i + 1}. **#${issue.issueNumber}** ${issue.title} (${issue.estimatedScope})`);
    }

    return lines.join('\n');
  }

  private topSortPhase(issues: IssueEntry[]): IssueEntry[] {
    const issueMap = new Map(issues.map((i) => [i.issueNumber, i]));
    const inDegree = new Map<number, number>();
    const adj = new Map<number, number[]>();

    for (const issue of issues) {
      inDegree.set(issue.issueNumber, 0);
      adj.set(issue.issueNumber, []);
    }

    for (const issue of issues) {
      for (const dep of issue.dependsOnIssues) {
        if (issueMap.has(dep)) {
          adj.get(dep)!.push(issue.issueNumber);
          inDegree.set(issue.issueNumber, (inDegree.get(issue.issueNumber) ?? 0) + 1);
        }
      }
    }

    const queue: number[] = [];
    for (const [num, deg] of inDegree) {
      if (deg === 0) queue.push(num);
    }
    queue.sort((a, b) => a - b);

    const result: IssueEntry[] = [];
    while (queue.length > 0) {
      const num = queue.shift()!;
      result.push(issueMap.get(num)!);
      for (const next of adj.get(num) ?? []) {
        const newDeg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) {
          queue.push(next);
          queue.sort((a, b) => a - b);
        }
      }
    }

    // Add any remaining (shouldn't happen in acyclic graph)
    for (const issue of issues) {
      if (!result.includes(issue)) {
        result.push(issue);
      }
    }

    return result;
  }

  private extractRoadmapSection(startLine: number, endLine: number): string | null {
    if (!this.roadmapContent) return null;
    const lines = this.roadmapContent.split('\n');
    const section = lines.slice(startLine - 1, endLine).join('\n');
    return section.trim() || null;
  }

  private extractPhaseSection(phaseContent: string, section: string, issueNumber: number): string | null {
    // Try to find the section by issue number or section number
    const patterns = [
      new RegExp(`^###\\s+${section.replace('.', '\\.')}[:\\s]`, 'm'),
      new RegExp(`#${issueNumber}`, 'm'),
    ];

    for (const pattern of patterns) {
      const match = phaseContent.match(pattern);
      if (match && match.index !== undefined) {
        const start = match.index;
        // Find next ### or end
        const rest = phaseContent.slice(start);
        const nextSection = rest.indexOf('\n### ', 10);
        const extracted = nextSection > 0 ? rest.slice(0, nextSection) : rest.slice(0, 2000);
        return extracted.trim();
      }
    }

    return null;
  }
}
