# MCP Security Stack

This repo now includes an optional security MCP profile at:

`mcp/security-stack.mcp.json`

It combines multiple scanners to cover different risk classes:

- `semgrep` (SAST/code patterns)
- `trivy` (dependency CVEs, config/misconfiguration, secret signals)
- `gitguardian` (hardcoded secret and token leak detection)
- `solana-fender` (Anchor/Solana-specific checks)

## Why Multiple MCP Servers

No single scanner catches everything. This stack intentionally overlaps:

- Language/framework logic issues
- Known vulnerable dependencies
- Exposed credentials/secrets
- Solana program-specific risks

## Prerequisites

1. `uvx` available (for Semgrep MCP and GitGuardian MCP):
   - `pipx install uv` or install from `https://docs.astral.sh/uv/`
2. `trivy` installed and MCP plugin enabled:
   - `trivy plugin install mcp`
3. `anchor-mcp` installed and on `PATH` (for Solana Fender checks).

Recommended environment variables:

- `SEMGREP_APP_TOKEN` (for Semgrep AppSec platform features/rules)
- `GITGUARDIAN_API_KEY` (optional for `ggshield`; MCP mode can use OAuth login instead)
- `ANCHOR_PROVIDER_URL` and `ANCHOR_WALLET` (for Solana Fender environment)

## Healthcheck

Use the bundled checker to validate server connectivity:

```bash
node scripts/check-security-mcp-stack.mjs --config mcp/security-stack.mcp.json --verbose
```

## Skill Workflow

Use the repo skill:

```text
/security-mcp-sweep
```

Optional arguments:

```text
/security-mcp-sweep scope=program strict=true
/security-mcp-sweep profile=mcp/security-stack.mcp.json
```

The skill writes a structured report to:

`.claude/notes/security-mcp-sweep-YYYY-MM-DD.md`

## GitGuardian MCP Scan (No `ggshield` dependency)

Use the direct MCP scanner wrapper (adaptive batch split + retry/backoff):

```bash
npm run -s security:gitguardian:mcp:scan -- --scope . --output .tmp/security-mcp-sweep/gitguardian-mcp.json
```

Notes:
- Uses MCP `scan_secrets` from the configured `gitguardian` server in `mcp/security-stack.mcp.json`
- Automatically splits oversized batches when the API returns `400 Bad Request`
- Retries transient and rate-limit failures with exponential backoff

## Trivy Image Scan (Closes "No image scan" gap)

`trivy fs` scans the repository filesystem and lockfiles.  
It does **not** scan built container images/layers.
If a sweep report says `Trivy Image: Skipped` or `No image tag provided`,
it means only filesystem/lockfile coverage ran.

To include container image coverage:

1. Build image(s), for example:

```bash
docker compose -f containers/docker-compose.yml build desktop
```

2. Scan the image:

```bash
npm run -s security:trivy:image -- agenc/desktop:latest
```

3. Optional JSON artifact for reports:

```bash
trivy image --scanners vuln,misconfig,secret --format json --quiet --output .tmp/trivy-image.json agenc/desktop:latest
```

## Desktop Hardening Regression Check

Run the Dockerfile hardening guard before rebuilding desktop images:

```bash
npm run -s security:desktop:hardening:check
```

After rebuilding `agenc/desktop:latest`, run the Doom MCP smoke check to verify the image still exports the expected launchers on the secure path and that the Doom MCP server actually starts:

```bash
npm run -s desktop:image:doom:smoke
```

This check enforces:
- `ubuntu:24.04` base image with `apt-get upgrade -y`
- no apt install reintroduction of `imagemagick`, `epiphany-browser`, or system `ffmpeg`
- Playwright ffmpeg symlink wiring
- manifest-based secure-path launcher exports instead of ad hoc `/usr/games` symlinks

## Optional Snyk MCP

If your installed Snyk binary supports MCP mode, add this server:

```json
{
  "mcpServers": {
    "snyk": {
      "command": "snyk",
      "args": ["mcp", "-t", "stdio"],
      "timeout": 30000
    }
  }
}
```

Not all Snyk distribution channels expose `snyk mcp`; verify locally with:

```bash
snyk mcp --help
```
