import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'implement-issue',
    'Guided 10-step implementation workflow for a specific roadmap issue. Provides structured steps from context gathering through testing.',
    { issue_number: z.string().describe('GitHub issue number to implement (e.g. "1053")') },
    ({ issue_number }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
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

Start with Step 1 now.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'explore-phase',
    'Phase exploration workflow — understand the scope, dependencies, and implementation order before starting work on any issue.',
    { phase: z.string().describe('Phase number to explore (e.g. "1")') },
    ({ phase }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
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

Start with Step 1 now.`,
          },
        },
      ],
    }),
  );
}
