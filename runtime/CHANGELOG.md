# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Added initial changelog + API baseline tooling. (#983)

### Deprecated
- `TaskFilter.acceptedMints` in `runtime/src/autonomous/types.ts` — use `TaskFilter.rewardMint` instead. Removal planned for v0.2.0. (#983)

## [0.1.0] - 2026-02-14

### Added
- Agent runtime primitives (`AgentRuntime`, `TaskExecutor`, `TaskDiscovery`, `TaskOperations`).
- Replay comparison + alerting utilities and deterministic CLI workflows.

