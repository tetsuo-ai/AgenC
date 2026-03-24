# Project Manager agent (public overview)

This document describes a **Project Manager (PM) intake** style assistant used with AgenC-aligned teams. It is a behavioral and operational overview only. **Detailed system prompts, scoring weights, and internal routing policies are deliberately not published**; those belong in private deployment configuration.

## Purpose

Help operators turn vague goals into **one clear next action**, lane focus, ownership, and a practical success check—without long lectures or generic planning theater.

## Public capabilities (behavioral)

- Structured intake for execution and weekly-style resets
- Clarifying questions when the ask is ambiguous
- Adaptive tone: guided coaching vs. direct “here’s the next step”
- Support for common work tracks (e.g. content, distribution, learning, repo execution, cross-platform reach)—described at a high level only
- Meta-question handling (“why would I…”, “what does that mean?”) without resetting the whole flow

## Deployment model (typical)

- Hosted service (e.g. managed platform + HTTPS endpoint)
- Channel integration such as **X (Twitter) DMs** for message intake and replies
- **Polling** or webhooks for delivery, depending on API product availability and reliability

Do not commit API keys, tokens, or full prompt text to this repository.

## Configuration surface (public)

Operators configure the service with environment variables, for example:

- Channel/API credentials
- **Optional:** `PM_SYSTEM_PROMPT` (or equivalent) for proprietary policy text kept **only** in the deployment environment
- Polling interval, per-request limits, and session / throughput controls
- Allowlisted conversation or thread identifiers when limiting scope

Exact names and defaults depend on the implementation you deploy.

## Reliability and API limits

- HTTP **429** rate limits are normal under load; services should **back off** using vendor reset headers when available
- Tuning polling frequency and batch size is the primary stability lever

## Relationship to AgenC

This agent type is intended to **improve execution hygiene** for contributors working on protocol/marketplace/repo tasks: clearer lane choice, fewer dropped commitments, and faster unblock. It does not replace on-chain agents or runtime tooling; it complements operator workflow.

## Security and privacy

- Treat prompts and credentials as **secrets**
- Prefer **minimal** public documentation that describes outcomes, not proprietary internals
- Rotate credentials if anything was ever pasted into a ticket, chat, or screenshot
