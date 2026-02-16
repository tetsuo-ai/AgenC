#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");

// src/server.ts
var import_mcp = require("@modelcontextprotocol/sdk/server/mcp.js");

// src/loader.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
function findRepoRoot() {
  const envRoot = process.env.DOCS_ROOT;
  if (envRoot) {
    return envRoot;
  }
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "Anchor.toml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..");
}
function extractTitle(content, filePath) {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return path.basename(filePath, ".md");
}
function categorize(relPath) {
  if (relPath.includes("flows/")) return "flow";
  if (relPath.includes("phases/")) return "phase";
  if (relPath.includes("guides/")) return "guide";
  if (relPath.includes("architecture/")) return "architecture";
  return "other";
}
function loadMarkdownFiles(dirPath, basePath) {
  const entries = [];
  if (!fs.existsSync(dirPath)) return entries;
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      entries.push(...loadMarkdownFiles(fullPath, basePath));
    } else if (item.name.endsWith(".md")) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const relPath = path.relative(basePath, fullPath);
      entries.push({
        path: relPath,
        title: extractTitle(content, fullPath),
        content,
        category: categorize(relPath)
      });
    }
  }
  return entries;
}
function loadDocs() {
  const repoRoot = findRepoRoot();
  const docsDir = path.join(repoRoot, "docs");
  const archDir = path.join(docsDir, "architecture");
  const docEntries = loadMarkdownFiles(archDir, docsDir);
  const docs = /* @__PURE__ */ new Map();
  for (const entry of docEntries) {
    docs.set(entry.path, entry);
  }
  let roadmapContent = "";
  const roadmapPath = path.join(docsDir, "ROADMAP.md");
  if (fs.existsSync(roadmapPath)) {
    roadmapContent = fs.readFileSync(roadmapPath, "utf-8");
    docs.set("ROADMAP.md", {
      path: "ROADMAP.md",
      title: "AgenC Roadmap: Personal AI Agent Platform",
      content: roadmapContent,
      category: "other"
    });
  }
  const issues = /* @__PURE__ */ new Map();
  let issueMapRaw = null;
  const issueMapPath = path.join(archDir, "issue-map.json");
  if (fs.existsSync(issueMapPath)) {
    const raw = JSON.parse(fs.readFileSync(issueMapPath, "utf-8"));
    issueMapRaw = raw;
    for (const [numStr, entry] of Object.entries(raw.issues)) {
      const issueNumber = parseInt(numStr, 10);
      issues.set(issueNumber, { ...entry, issueNumber });
    }
  }
  return { docs, issues, issueMapRaw, roadmapContent, repoRoot };
}

// src/search.ts
var SearchIndex = class {
  index = /* @__PURE__ */ new Map();
  docs = /* @__PURE__ */ new Map();
  /** Build index from loaded docs */
  build(docs) {
    this.docs = docs;
    this.index.clear();
    for (const [docPath, entry] of docs) {
      const tokens = this.tokenize(entry.title + " " + entry.content);
      for (const token of tokens) {
        let set = this.index.get(token);
        if (!set) {
          set = /* @__PURE__ */ new Set();
          this.index.set(token, set);
        }
        set.add(docPath);
      }
    }
  }
  /** Search for documents matching query */
  search(query, limit = 10) {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];
    const scores = /* @__PURE__ */ new Map();
    for (const token of queryTokens) {
      const matches = this.index.get(token);
      if (!matches) continue;
      for (const docPath of matches) {
        scores.set(docPath, (scores.get(docPath) ?? 0) + 1);
      }
    }
    const results = [];
    for (const [docPath, matchCount] of scores) {
      const doc = this.docs.get(docPath);
      if (!doc) continue;
      const score = matchCount / queryTokens.length;
      const snippet = this.extractSnippet(doc.content, queryTokens);
      results.push({
        path: docPath,
        title: doc.title,
        score,
        snippet
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
  tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9_\-./# ]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
  }
  extractSnippet(content, queryTokens) {
    const lines = content.split("\n");
    const lowerTokens = new Set(queryTokens);
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
    const start = Math.max(0, bestLine - 1);
    const end = Math.min(lines.length, bestLine + 2);
    const snippet = lines.slice(start, end).join("\n").trim();
    if (snippet.length > 300) {
      return snippet.slice(0, 297) + "...";
    }
    return snippet;
  }
};

// src/issue-resolver.ts
var IssueResolver = class {
  constructor(issues, issueMapRaw, roadmapContent, docs) {
    this.issues = issues;
    this.issueMapRaw = issueMapRaw;
    this.roadmapContent = roadmapContent;
    this.docs = docs;
  }
  /** Get full implementation context for an issue */
  getIssueContext(issueNumber) {
    const issue = this.issues.get(issueNumber);
    if (!issue) return null;
    const parts = [];
    parts.push(`# Issue #${issueNumber}: ${issue.title}`);
    parts.push("");
    parts.push(`**Phase:** ${issue.phase} | **Section:** ${issue.section} | **Priority:** ${issue.priority} | **Scope:** ${issue.estimatedScope}`);
    parts.push("");
    const roadmapSection = this.extractRoadmapSection(issue.roadmapLineStart, issue.roadmapLineEnd);
    if (roadmapSection) {
      parts.push("## Roadmap Description");
      parts.push("");
      parts.push(roadmapSection);
      parts.push("");
    }
    if (issue.filesToCreate.length > 0) {
      parts.push("## Files to Create");
      for (const f of issue.filesToCreate) {
        parts.push(`- \`${f}\``);
      }
      parts.push("");
    }
    if (issue.filesToModify.length > 0) {
      parts.push("## Files to Modify");
      for (const f of issue.filesToModify) {
        parts.push(`- \`${f}\``);
      }
      parts.push("");
    }
    if (issue.dependsOnIssues.length > 0) {
      parts.push("## Depends On");
      for (const dep of issue.dependsOnIssues) {
        const depIssue = this.issues.get(dep);
        parts.push(`- #${dep}: ${depIssue?.title ?? "Unknown"}`);
      }
      parts.push("");
    }
    if (issue.dependedByIssues.length > 0) {
      parts.push("## Depended By");
      for (const dep of issue.dependedByIssues) {
        const depIssue = this.issues.get(dep);
        parts.push(`- #${dep}: ${depIssue?.title ?? "Unknown"}`);
      }
      parts.push("");
    }
    if (issue.existingPatterns.length > 0) {
      parts.push("## Existing Patterns to Follow");
      for (const p of issue.existingPatterns) {
        parts.push(`- \`${p}\``);
      }
      parts.push("");
    }
    if (issue.keyInterfaces.length > 0) {
      parts.push("## Key Interfaces");
      parts.push(issue.keyInterfaces.map((i) => `\`${i}\``).join(", "));
      parts.push("");
    }
    parts.push("## Phase Documentation");
    parts.push(`See: \`${issue.phaseDoc}\``);
    const phaseDocKey = issue.phaseDoc.replace("docs/", "");
    const phaseDoc = this.docs.get(phaseDocKey);
    if (phaseDoc) {
      const sectionContent = this.extractPhaseSection(phaseDoc.content, issue.section, issueNumber);
      if (sectionContent) {
        parts.push("");
        parts.push(sectionContent);
      }
    }
    return parts.join("\n");
  }
  /** Get dependency chain for an issue (transitive) */
  getDependencyChain(issueNumber) {
    const visited = /* @__PURE__ */ new Set();
    const chain = [];
    const visit = (num) => {
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
  getPhaseIssues(phase) {
    const result = [];
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
  getPhaseDependencyGraph(phase) {
    const issues = this.getPhaseIssues(phase);
    if (issues.length === 0) return "No issues found for this phase.";
    const tracking = this.issueMapRaw?.trackingIssues[String(phase)];
    const lines = [];
    lines.push("```mermaid");
    lines.push("flowchart TD");
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
    lines.push("```");
    lines.push("");
    if (tracking) {
      lines.push(`**Tracking issue:** #${tracking.issue} \u2014 ${tracking.title} (${tracking.priority})`);
    }
    lines.push("");
    lines.push("## Implementation Order");
    lines.push("");
    const sorted = this.topSortPhase(issues);
    for (let i = 0; i < sorted.length; i++) {
      const issue = sorted[i];
      lines.push(`${i + 1}. **#${issue.issueNumber}** ${issue.title} (${issue.estimatedScope})`);
    }
    return lines.join("\n");
  }
  topSortPhase(issues) {
    const issueMap = new Map(issues.map((i) => [i.issueNumber, i]));
    const inDegree = /* @__PURE__ */ new Map();
    const adj = /* @__PURE__ */ new Map();
    for (const issue of issues) {
      inDegree.set(issue.issueNumber, 0);
      adj.set(issue.issueNumber, []);
    }
    for (const issue of issues) {
      for (const dep of issue.dependsOnIssues) {
        if (issueMap.has(dep)) {
          adj.get(dep).push(issue.issueNumber);
          inDegree.set(issue.issueNumber, (inDegree.get(issue.issueNumber) ?? 0) + 1);
        }
      }
    }
    const queue = [];
    for (const [num, deg] of inDegree) {
      if (deg === 0) queue.push(num);
    }
    queue.sort((a, b) => a - b);
    const result = [];
    while (queue.length > 0) {
      const num = queue.shift();
      result.push(issueMap.get(num));
      for (const next of adj.get(num) ?? []) {
        const newDeg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) {
          queue.push(next);
          queue.sort((a, b) => a - b);
        }
      }
    }
    for (const issue of issues) {
      if (!result.includes(issue)) {
        result.push(issue);
      }
    }
    return result;
  }
  extractRoadmapSection(startLine, endLine) {
    if (!this.roadmapContent) return null;
    const lines = this.roadmapContent.split("\n");
    const section = lines.slice(startLine - 1, endLine).join("\n");
    return section.trim() || null;
  }
  extractPhaseSection(phaseContent, section, issueNumber) {
    const patterns = [
      new RegExp(`^###\\s+${section.replace(".", "\\.")}[:\\s]`, "m"),
      new RegExp(`#${issueNumber}`, "m")
    ];
    for (const pattern of patterns) {
      const match = phaseContent.match(pattern);
      if (match && match.index !== void 0) {
        const start = match.index;
        const rest = phaseContent.slice(start);
        const nextSection = rest.indexOf("\n### ", 10);
        const extracted = nextSection > 0 ? rest.slice(0, nextSection) : rest.slice(0, 2e3);
        return extracted.trim();
      }
    }
    return null;
  }
};

// src/tools/search.ts
var import_zod = require("zod");
function registerSearchTools(server, searchIndex) {
  server.tool(
    "docs_search",
    "Full-text search across AgenC architecture documentation. Returns ranked results with context snippets.",
    { query: import_zod.z.string().describe('Search query (e.g. "gateway", "dispute resolution", "tool registry")') },
    async ({ query }) => {
      const results = searchIndex.search(query, 10);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}".` }]
        };
      }
      const lines = [];
      lines.push(`## Search Results for "${query}"`);
      lines.push("");
      for (const result of results) {
        lines.push(`### ${result.title} (${Math.round(result.score * 100)}% match)`);
        lines.push(`**Path:** \`docs/${result.path}\``);
        lines.push("");
        lines.push(result.snippet);
        lines.push("");
        lines.push("---");
        lines.push("");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    }
  );
}

// src/tools/issues.ts
var import_zod2 = require("zod");
function registerIssueTools(server, resolver) {
  server.tool(
    "docs_get_issue_context",
    "Get full implementation context for a specific roadmap issue. Returns roadmap description, files to create/modify, dependencies, existing patterns to follow, key interfaces, and phase documentation.",
    { issue_number: import_zod2.z.number().int().describe("GitHub issue number (e.g. 1053, 1092, 1109)") },
    async ({ issue_number }) => {
      const context = resolver.getIssueContext(issue_number);
      if (!context) {
        return {
          content: [{
            type: "text",
            text: `Issue #${issue_number} not found in the roadmap. Valid issues: 1051-1110.`
          }]
        };
      }
      return {
        content: [{ type: "text", text: context }]
      };
    }
  );
}

// src/tools/phases.ts
var import_zod3 = require("zod");
function registerPhaseTools(server, resolver) {
  server.tool(
    "docs_get_phase_graph",
    "Get the dependency graph and implementation order for a specific phase. Returns a Mermaid flowchart of issue dependencies and a recommended build sequence.",
    { phase: import_zod3.z.number().int().min(1).max(10).describe("Phase number (1-10)") },
    async ({ phase }) => {
      const graph = resolver.getPhaseDependencyGraph(phase);
      const issues = resolver.getPhaseIssues(phase);
      if (issues.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No issues found for phase ${phase}.`
          }]
        };
      }
      const lines = [];
      lines.push(`# Phase ${phase} Dependency Graph`);
      lines.push("");
      lines.push(graph);
      lines.push("");
      lines.push("## Issue Summary");
      lines.push("");
      lines.push("| # | Section | Title | Scope | Dependencies |");
      lines.push("|---|---------|-------|-------|-------------|");
      for (const issue of issues) {
        const deps = issue.dependsOnIssues.map((d) => `#${d}`).join(", ") || "none";
        lines.push(`| #${issue.issueNumber} | ${issue.section} | ${issue.title} | ${issue.estimatedScope} | ${deps} |`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    }
  );
}

// src/tools/modules.ts
var import_zod4 = require("zod");
var MODULE_TYPES = ["core", "task", "ai", "protocol", "infrastructure", "collaboration"];
var MODULE_TEMPLATE = `# {MODULE_NAME} Module

## Directory Structure

\`\`\`
runtime/src/{module_name}/
\u251C\u2500\u2500 types.ts              # Interfaces, config types, enums
\u251C\u2500\u2500 errors.ts             # Module-specific error classes
\u251C\u2500\u2500 {primary}.ts          # Primary class implementation
\u251C\u2500\u2500 {primary}.test.ts     # Unit tests (vitest)
\u2514\u2500\u2500 index.ts              # Barrel exports
\`\`\`

## types.ts

\`\`\`typescript
export interface {PrimaryClass}Config {
  /** Connection instance */
  connection: Connection;
  /** Logger instance */
  logger?: Logger;
}
\`\`\`

## errors.ts

\`\`\`typescript
import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

export class {PrimaryClass}Error extends RuntimeError {
  constructor(message: string) {
    super(RuntimeErrorCodes.{ERROR_CODE}, message);
  }
}
\`\`\`

## {primary}.ts

\`\`\`typescript
import type { {PrimaryClass}Config } from './types.js';
import type { Logger } from '../utils/logger.js';

export class {PrimaryClass} {
  private readonly logger: Logger;

  constructor(private readonly config: {PrimaryClass}Config) {
    this.logger = config.logger ?? console;
  }
}
\`\`\`

## index.ts

\`\`\`typescript
export * from './types.js';
export * from './errors.js';
export * from './{primary}.js';
\`\`\`

## Wiring

1. Add exports to \`runtime/src/index.ts\`
2. Add \`.with{PrimaryClass}()\` method to \`runtime/src/builder.ts\`
3. Register error codes in \`runtime/src/types/errors.ts\`
`;
var MODULE_INFO = {
  agent: { description: "Agent registration, capabilities, event subscriptions, PDA derivation", layer: 2, primaryClass: "AgentManager", errorRange: "1-5", testFile: "agent/manager.test.ts" },
  task: { description: "Task CRUD, discovery, speculative execution, proof pipeline, DLQ", layer: 3, primaryClass: "TaskOperations", errorRange: "6-12", testFile: "task/operations.test.ts" },
  autonomous: { description: "Autonomous agent loop, task scanner, verifier lanes, risk scoring", layer: 4, primaryClass: "AutonomousAgent", errorRange: "13-16", testFile: "autonomous/agent.test.ts" },
  llm: { description: "LLM provider adapters (Grok, Anthropic, Ollama), task executor", layer: 3, primaryClass: "LLMTaskExecutor", errorRange: "17-21", testFile: "llm/executor.test.ts" },
  memory: { description: "Memory backends (InMemory, SQLite, Redis), thread + KV operations", layer: 3, primaryClass: "MemoryBackend (interface)", errorRange: "22-24", testFile: "memory/in-memory/backend.test.ts" },
  proof: { description: "ZK proof generation, verification, caching (TTL + LRU)", layer: 2, primaryClass: "ProofEngine", errorRange: "25-27", testFile: "proof/engine.test.ts" },
  dispute: { description: "Dispute instructions, PDA derivation, memcmp queries", layer: 2, primaryClass: "DisputeOperations", errorRange: "28-31", testFile: "dispute/operations.test.ts" },
  workflow: { description: "DAG orchestration, goal compilation, optimization, canary rollout", layer: 5, primaryClass: "DAGOrchestrator", errorRange: "32-35", testFile: "workflow/orchestrator.test.ts" },
  connection: { description: "Resilient RPC with retry, failover, request coalescing", layer: 2, primaryClass: "ConnectionManager", errorRange: "36-37", testFile: "connection/manager.test.ts" },
  tools: { description: "MCP-compatible tool registry, built-in AgenC tools, skill adapter", layer: 3, primaryClass: "ToolRegistry", errorRange: "\u2014", testFile: "tools/registry.test.ts" },
  skills: { description: "Skill registry, Jupiter DEX integration", layer: 3, primaryClass: "SkillRegistry", errorRange: "\u2014", testFile: "skills/registry.test.ts" },
  events: { description: "Event subscription, parsing, IDL drift checks", layer: 2, primaryClass: "EventMonitor", errorRange: "\u2014", testFile: "events/monitor.test.ts" },
  policy: { description: "Budget enforcement, circuit breakers, access control", layer: 6, primaryClass: "PolicyEngine", errorRange: "\u2014", testFile: "policy/engine.test.ts" },
  team: { description: "Team contracts, payouts (Fixed/Weighted/Milestone), audit trail", layer: 6, primaryClass: "TeamContractEngine", errorRange: "\u2014", testFile: "team/engine.test.ts" },
  marketplace: { description: "Task bid marketplace, matching engine, bid strategies", layer: 6, primaryClass: "TaskBidMarketplace", errorRange: "\u2014", testFile: "marketplace/marketplace.test.ts" },
  eval: { description: "Benchmark runner, mutation testing, trajectory replay", layer: 6, primaryClass: "BenchmarkRunner", errorRange: "\u2014", testFile: "eval/benchmark.test.ts" },
  replay: { description: "Replay store, projector, incident reconstruction", layer: 6, primaryClass: "ReplayStore", errorRange: "\u2014", testFile: "replay/store.test.ts" },
  telemetry: { description: "Unified metrics collection, pluggable sinks", layer: 6, primaryClass: "UnifiedTelemetryCollector", errorRange: "\u2014", testFile: "telemetry/collector.test.ts" }
};
var CONVENTIONS = {
  types: `# Type Conventions

- **bigint**: All on-chain u64 values (capabilities, stake, amounts). Use literals: 1n, 0n
- **BN**: Only at Anchor instruction boundary. Convert: new BN(amount.toString())
- **number**: Small values only (status enums 0-5, counts, timestamps as seconds)
- **Uint8Array**: All binary data (agent IDs, task IDs, proofs, hashes)
- **PublicKey**: All Solana addresses. Never store as string except JSON serialization.
- **safeStringify()**: Always use for JSON with bigint values
- **Idl vs AgencCoordination**: Idl for raw JSON, AgencCoordination for Program<T>`,
  testing: `# Testing Conventions

- vitest with co-located .test.ts files
- Mock Program: \`{ methods: { name: vi.fn().mockReturnValue({ accountsPartial: vi.fn().mockReturnValue({ rpc: vi.fn() }) }) } }\`
- silentLogger: \`{ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }\`
- InMemoryBackend for memory tests (zero deps)
- NoopTelemetryCollector for telemetry in tests
- LiteSVM: advanceClock(svm, 61) before updateAgent, getClockTimestamp() not Date.now()`,
  errors: `# Error Handling Conventions

- RuntimeErrorCodes: 37 codes (core 1-16, LLM 17-21, memory 22-24, proof 25-27, dispute 28-31, workflow 32-35, connection 36-37)
- Extend RuntimeError with specific code and typed properties
- Anchor errors: 6000 + enum index. isAnchorError() to detect.
- Never throw raw strings. Always wrap in RuntimeError subclass.
- Use safeStringify() for error serialization (bigint-safe)`
};
function registerModuleTools(server, docs) {
  server.tool(
    "docs_get_module_template",
    "Get a boilerplate template for creating a new runtime module with standard file structure, error codes, and barrel exports.",
    {
      module_name: import_zod4.z.string().describe('Module name in lowercase (e.g. "gateway", "social")'),
      module_type: import_zod4.z.enum(MODULE_TYPES).describe("Module category for layer placement")
    },
    async ({ module_name, module_type }) => {
      const primaryClass = module_name.charAt(0).toUpperCase() + module_name.slice(1) + "Manager";
      const errorCode = module_name.toUpperCase() + "_ERROR";
      const template = MODULE_TEMPLATE.replace(/\{MODULE_NAME\}/g, module_name.charAt(0).toUpperCase() + module_name.slice(1)).replace(/\{module_name\}/g, module_name).replace(/\{PrimaryClass\}/g, primaryClass).replace(/\{primary\}/g, module_name).replace(/\{ERROR_CODE\}/g, errorCode);
      return {
        content: [{ type: "text", text: template }]
      };
    }
  );
  server.tool(
    "docs_get_module_info",
    "Get architecture details about an existing runtime module: description, layer, primary class, error codes, test file.",
    { module: import_zod4.z.string().describe('Module name (e.g. "agent", "task", "llm", "memory", "dispute")') },
    async ({ module: moduleName }) => {
      const info = MODULE_INFO[moduleName];
      if (!info) {
        const available = Object.keys(MODULE_INFO).join(", ");
        return {
          content: [{
            type: "text",
            text: `Module "${moduleName}" not found. Available modules: ${available}`
          }]
        };
      }
      const lines = [
        `# Module: ${moduleName}/`,
        "",
        `**Description:** ${info.description}`,
        `**Layer:** ${info.layer}`,
        `**Primary class:** \`${info.primaryClass}\``,
        `**Error code range:** ${info.errorRange}`,
        `**Test file:** \`runtime/src/${info.testFile}\``,
        `**Source:** \`runtime/src/${moduleName}/\``
      ];
      const relatedDoc = docs.get(`architecture/runtime-layers.md`);
      if (relatedDoc) {
        const moduleSection = relatedDoc.content.match(new RegExp(`\\|.*\`${moduleName}/\`.*\\|`, "g"));
        if (moduleSection) {
          lines.push("", "## From Architecture Docs", "");
          for (const line of moduleSection) {
            lines.push(line);
          }
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    }
  );
  server.tool(
    "docs_get_conventions",
    "Get type, testing, or error handling conventions for implementing AgenC code.",
    {
      topic: import_zod4.z.enum(["types", "testing", "errors"]).optional().describe("Specific topic. Omit to get all conventions.")
    },
    async ({ topic }) => {
      if (topic) {
        const content = CONVENTIONS[topic];
        return {
          content: [{ type: "text", text: content ?? `Unknown topic: ${topic}` }]
        };
      }
      const all = Object.values(CONVENTIONS).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: all }]
      };
    }
  );
}

// src/prompts/implementation.ts
var import_zod5 = require("zod");
function registerPrompts(server) {
  server.prompt(
    "implement-issue",
    "Guided 10-step implementation workflow for a specific roadmap issue. Provides structured steps from context gathering through testing.",
    { issue_number: import_zod5.z.string().describe('GitHub issue number to implement (e.g. "1053")') },
    ({ issue_number }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are implementing AgenC roadmap issue #${issue_number}. Follow these 10 steps:

## Step 1: Gather Context
Use \`docs_get_issue_context\` with issue_number=${issue_number} to get the full implementation context including roadmap description, files, dependencies, and patterns.

## Step 2: Check Dependencies
Review the "Depends On" section. For each dependency, verify the required code already exists. If a dependency is not yet implemented, note it as a blocker.

## Step 3: Read Existing Patterns
Read each file listed in "Existing Patterns to Follow". These show the coding conventions and architectural patterns to replicate.

## Step 4: Read Phase Documentation
Use \`docs_get_phase_graph\` with the issue's phase number to understand where this issue fits in the implementation sequence.

## Step 5: Check Conventions
Use \`docs_get_conventions\` to review type conventions (bigint vs BN), testing patterns, and error handling patterns.

## Step 6: Plan the Implementation
Based on the context gathered, create a detailed plan:
- List all files to create and modify
- Define the key interfaces and types
- Map out the integration points
- Identify error codes to register
- Plan the test strategy

## Step 7: Implement Types and Errors
Create \`types.ts\` and \`errors.ts\` first. Follow the patterns from existing modules.

## Step 8: Implement Primary Logic
Create the main implementation file(s). Follow the existing pattern from similar modules.

## Step 9: Write Tests
Create comprehensive tests using vitest. Mock Program/Connection as needed. Use silentLogger and InMemoryBackend for test isolation.

## Step 10: Wire Up Exports
- Add to module's \`index.ts\` barrel
- Add to \`runtime/src/index.ts\` barrel exports
- Add \`.with*()\` method to \`runtime/src/builder.ts\` if applicable
- Verify the build compiles: \`cd runtime && npm run typecheck\`

Start with Step 1 now.`
          }
        }
      ]
    })
  );
  server.prompt(
    "explore-phase",
    "Phase exploration workflow \u2014 understand the scope, dependencies, and implementation order before starting work on any issue.",
    { phase: import_zod5.z.string().describe('Phase number to explore (e.g. "1")') },
    ({ phase }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are exploring AgenC Phase ${phase} before implementation. Follow these steps:

## Step 1: Get Phase Overview
Use \`docs_get_phase_graph\` with phase=${phase} to see the dependency graph and implementation order.

## Step 2: Understand Each Issue
For each issue in the phase, use \`docs_get_issue_context\` to understand:
- What files are created/modified
- What the key interfaces are
- What patterns to follow

## Step 3: Map Dependencies
Draw the dependency graph:
- Which issues in this phase depend on each other?
- Which issues from OTHER phases are prerequisites?
- What is the critical path?

## Step 4: Identify Risk Areas
- Which issues are scope "L" (large)?
- Which issues require new Rust instructions?
- Which issues modify existing files that other issues also modify?
- Are there any circular or unclear dependencies?

## Step 5: Recommend Implementation Strategy
Based on your analysis:
- What is the optimal build order?
- Which issues can be parallelized?
- What are the testing milestones (first testable checkpoint)?
- What is the minimum viable subset for a first PR?

Start with Step 1 now.`
          }
        }
      ]
    })
  );
}

// src/server.ts
function createServer() {
  const server = new import_mcp.McpServer({
    name: "AgenC Architecture Docs",
    version: "0.1.0"
  });
  const loaded = loadDocs();
  const searchIndex = new SearchIndex();
  searchIndex.build(loaded.docs);
  const resolver = new IssueResolver(
    loaded.issues,
    loaded.issueMapRaw,
    loaded.roadmapContent,
    loaded.docs
  );
  for (const [docPath, entry] of loaded.docs) {
    const uri = `agenc-docs://architecture/${docPath}`;
    const safeName = docPath.replace(/[^a-zA-Z0-9_-]/g, "_");
    server.resource(
      safeName,
      uri,
      { description: entry.title },
      async (resourceUri) => ({
        contents: [{
          uri: resourceUri.href,
          text: entry.content
        }]
      })
    );
  }
  if (loaded.issueMapRaw) {
    server.resource(
      "issue-map",
      "agenc-docs://issue-map",
      { description: "Full issue-map.json \u2014 machine-readable index of all 58 roadmap issues" },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: JSON.stringify(loaded.issueMapRaw, null, 2)
        }]
      })
    );
  }
  if (loaded.roadmapContent) {
    server.resource(
      "roadmap",
      "agenc-docs://roadmap",
      { description: "Full ROADMAP.md \u2014 source document for all phase guides" },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: loaded.roadmapContent
        }]
      })
    );
  }
  const guideEntries = [...loaded.docs.values()].filter((e) => e.category === "guide");
  if (guideEntries.length > 0) {
    const conventionsText = guideEntries.map((e) => `---

${e.content}`).join("\n\n");
    server.resource(
      "conventions",
      "agenc-docs://conventions",
      { description: "All implementation guides concatenated \u2014 type conventions, testing patterns, error handling" },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: conventionsText
        }]
      })
    );
  }
  registerSearchTools(server, searchIndex);
  registerIssueTools(server, resolver);
  registerPhaseTools(server, resolver);
  registerModuleTools(server, loaded.docs);
  registerPrompts(server);
  return server;
}

// src/index.ts
async function main() {
  const server = createServer();
  const transport = new import_stdio.StdioServerTransport();
  await server.connect(transport);
}
main();
