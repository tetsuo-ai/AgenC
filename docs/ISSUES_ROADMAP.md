# Roadmap Issues

Master epic: [#1121](https://github.com/tetsuo-ai/AgenC/issues/1121)

Source document: `docs/ROADMAP.md`

## Tracking Issues

| Phase | Issue | Priority | Title |
|-------|-------|----------|-------|
| 1 | [#1111](https://github.com/tetsuo-ai/AgenC/issues/1111) | P0 | Gateway & Channel Foundation |
| 2 | [#1112](https://github.com/tetsuo-ai/AgenC/issues/1112) | P1 | Heartbeat & Autonomous Daemon |
| 3 | [#1113](https://github.com/tetsuo-ai/AgenC/issues/1113) | P0 | Documentation-Centric Skills (SKILL.md) |
| 4 | [#1114](https://github.com/tetsuo-ai/AgenC/issues/1114) | P0 | System Tools |
| 5 | [#1115](https://github.com/tetsuo-ai/AgenC/issues/1115) | P1 | Semantic Memory & Agent Personality |
| 6 | [#1116](https://github.com/tetsuo-ai/AgenC/issues/1116) | P2 | Remote Skill Registry |
| 7 | [#1117](https://github.com/tetsuo-ai/AgenC/issues/1117) | P2 | Multi-Agent Routing & Sub-Agents |
| 8 | [#1118](https://github.com/tetsuo-ai/AgenC/issues/1118) | P2 | Agent Social Layer |
| 9 | [#1119](https://github.com/tetsuo-ai/AgenC/issues/1119) | P2 | Advanced Channels & UI |
| 10 | [#1120](https://github.com/tetsuo-ai/AgenC/issues/1120) | P3 | Ecosystem & Marketplace |

## Implementation Issues

| Section | Issue | Title |
|---------|-------|-------|
| 1.1 | [#1053](https://github.com/tetsuo-ai/AgenC/issues/1053) | Gateway core process and WebSocket control plane |
| 1.2 | [#1051](https://github.com/tetsuo-ai/AgenC/issues/1051) | Unified message format (GatewayMessage / OutboundMessage) |
| 1.3 | [#1054](https://github.com/tetsuo-ai/AgenC/issues/1054) | Channel plugin interface and ChannelContext |
| 1.4 | [#1060](https://github.com/tetsuo-ai/AgenC/issues/1060) | Telegram channel plugin |
| 1.5 | [#1061](https://github.com/tetsuo-ai/AgenC/issues/1061) | Discord channel plugin |
| 1.6 | [#1055](https://github.com/tetsuo-ai/AgenC/issues/1055) | Session management (scoping, reset, compaction) |
| 1.7 | [#1056](https://github.com/tetsuo-ai/AgenC/issues/1056) | Lifecycle hook system (HookDispatcher) |
| 1.8 | [#1052](https://github.com/tetsuo-ai/AgenC/issues/1052) | Slash commands handler |
| 1.9 | [#1057](https://github.com/tetsuo-ai/AgenC/issues/1057) | Cross-channel identity linking |
| 1.10 | [#1058](https://github.com/tetsuo-ai/AgenC/issues/1058) | Gateway CLI commands and setup wizard |
| 1.11 | [#1063](https://github.com/tetsuo-ai/AgenC/issues/1063) | Agent loop integration (ChatExecutor + model fallback) |
| 1.12 | [#1059](https://github.com/tetsuo-ai/AgenC/issues/1059) | Media pipeline (voice transcription, image description) |
| 2.1 | [#1081](https://github.com/tetsuo-ai/AgenC/issues/1081) | Heartbeat scheduler |
| 2.2 | [#1084](https://github.com/tetsuo-ai/AgenC/issues/1084) | Built-in heartbeat actions (task scan, summary, portfolio) |
| 2.3 | [#1085](https://github.com/tetsuo-ai/AgenC/issues/1085) | Cron-like scheduling with per-action schedules |
| 2.4 | [#1078](https://github.com/tetsuo-ai/AgenC/issues/1078) | Daemon lifecycle (PID, signals, systemd, crash recovery) |
| 3.1 | [#1065](https://github.com/tetsuo-ai/AgenC/issues/1065) | SKILL.md parser (YAML frontmatter + markdown body) |
| 3.2 | [#1070](https://github.com/tetsuo-ai/AgenC/issues/1070) | Skill discovery and validation (3-tier, requirement checks) |
| 3.3 | [#1075](https://github.com/tetsuo-ai/AgenC/issues/1075) | Skill injection engine (context-aware prompt assembly) |
| 3.4 | [#1071](https://github.com/tetsuo-ai/AgenC/issues/1071) | Bundled skills (8 starter SKILL.md files) |
| 3.5 | [#1066](https://github.com/tetsuo-ai/AgenC/issues/1066) | Workspace files (AGENT.md, SOUL.md, USER.md, etc.) |
| 3.6 | [#1074](https://github.com/tetsuo-ai/AgenC/issues/1074) | Skill CLI commands (list, info, validate, create, install) |
| 4.1 | [#1067](https://github.com/tetsuo-ai/AgenC/issues/1067) | Bash tool (command execution with allow/deny lists) |
| 4.2 | [#1068](https://github.com/tetsuo-ai/AgenC/issues/1068) | Filesystem tool (read, write, list, stat, delete) |
| 4.3 | [#1069](https://github.com/tetsuo-ai/AgenC/issues/1069) | HTTP tool (GET, POST, fetch with domain control) |
| 4.4 | [#1072](https://github.com/tetsuo-ai/AgenC/issues/1072) | Browser tool (HTML extraction + optional Playwright) |
| 4.5 | [#1076](https://github.com/tetsuo-ai/AgenC/issues/1076) | Execution sandboxing via Docker |
| 4.6 | [#1073](https://github.com/tetsuo-ai/AgenC/issues/1073) | Approval policies (per-tool, per-amount rules) |
| 4.7 | [#1077](https://github.com/tetsuo-ai/AgenC/issues/1077) | Tool permission policy integration (extend PolicyEngine) |
| 5.1 | [#1079](https://github.com/tetsuo-ai/AgenC/issues/1079) | Embedding generation (multi-provider interface) |
| 5.2 | [#1082](https://github.com/tetsuo-ai/AgenC/issues/1082) | Vector memory store (cosine similarity + hybrid BM25) |
| 5.3 | [#1080](https://github.com/tetsuo-ai/AgenC/issues/1080) | Structured memory model (daily logs + curated facts + entities) |
| 5.4 | [#1086](https://github.com/tetsuo-ai/AgenC/issues/1086) | Automatic memory ingestion (per-turn + session-end) |
| 5.5 | [#1087](https://github.com/tetsuo-ai/AgenC/issues/1087) | Context-aware retrieval (semantic search in prompt assembly) |
| 5.6 | [#1083](https://github.com/tetsuo-ai/AgenC/issues/1083) | Agent personality file templates and loading |
| 6.1 | [#1089](https://github.com/tetsuo-ai/AgenC/issues/1089) | Registry API client (search, install, publish, rate) |
| 6.2 | [#1091](https://github.com/tetsuo-ai/AgenC/issues/1091) | On-chain skill registration instructions |
| 6.3 | [#1092](https://github.com/tetsuo-ai/AgenC/issues/1092) | Skill payment flow (escrow + protocol fee) |
| 6.4 | [#1088](https://github.com/tetsuo-ai/AgenC/issues/1088) | OpenClaw skill import bridge (namespace mapping) |
| 6.5 | [#1090](https://github.com/tetsuo-ai/AgenC/issues/1090) | Registry CLI integration (search, install, publish) |
| 7.1 | [#1093](https://github.com/tetsuo-ai/AgenC/issues/1093) | Agent workspace model (isolated config, memory, tools) |
| 7.2 | [#1094](https://github.com/tetsuo-ai/AgenC/issues/1094) | Routing rules (peer/guild/channel/content matching) |
| 7.3 | [#1095](https://github.com/tetsuo-ai/AgenC/issues/1095) | Session isolation (per-workspace memory, policy, auth) |
| 7.4 | [#1096](https://github.com/tetsuo-ai/AgenC/issues/1096) | Sub-agent spawning (parallel work, on-chain coordination) |
| 8.1 | [#1097](https://github.com/tetsuo-ai/AgenC/issues/1097) | Agent discovery (on-chain search by capability/reputation) |
| 8.2 | [#1101](https://github.com/tetsuo-ai/AgenC/issues/1101) | Agent-to-agent messaging (on-chain + off-chain) |
| 8.3 | [#1103](https://github.com/tetsuo-ai/AgenC/issues/1103) | Agent feed / forum (on-chain posts + IPFS content) |
| 8.4 | [#1104](https://github.com/tetsuo-ai/AgenC/issues/1104) | Reputation integration (social signals → reputation score) |
| 8.5 | [#1105](https://github.com/tetsuo-ai/AgenC/issues/1105) | Agent collaboration protocol (team formation via feed) |
| 9.1 | [#1098](https://github.com/tetsuo-ai/AgenC/issues/1098) | Additional channel plugins (Slack, WhatsApp, Signal, Matrix) |
| 9.2 | [#1099](https://github.com/tetsuo-ai/AgenC/issues/1099) | WebChat UI (React + WebSocket to Gateway) |
| 9.3 | [#1100](https://github.com/tetsuo-ai/AgenC/issues/1100) | Voice support (STT/TTS integration) |
| 9.4 | [#1102](https://github.com/tetsuo-ai/AgenC/issues/1102) | Mobile support (stretch — remote Gateway node) |
| 10.1 | [#1109](https://github.com/tetsuo-ai/AgenC/issues/1109) | Service marketplace (human-posted requests + agent bids) |
| 10.2 | [#1107](https://github.com/tetsuo-ai/AgenC/issues/1107) | Skill monetization (subscriptions, revenue sharing) |
| 10.3 | [#1110](https://github.com/tetsuo-ai/AgenC/issues/1110) | Agent reputation economy (staking, delegation, portability) |
| 10.4 | [#1108](https://github.com/tetsuo-ai/AgenC/issues/1108) | Cross-protocol bridges (OpenClaw, LangChain, Farcaster) |
| 10.5 | [#1106](https://github.com/tetsuo-ai/AgenC/issues/1106) | Governance (on-chain voting, treasury management) |
