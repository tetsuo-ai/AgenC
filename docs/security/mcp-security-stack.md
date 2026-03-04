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
- `GITGUARDIAN_API_KEY` (avoids interactive OAuth prompt)
- `ANCHOR_PROVIDER_URL` and `ANCHOR_WALLET` (for Solana Fender environment)

## Healthcheck

Use the bundled checker to validate server connectivity:

```bash
node scripts/check-security-mcp-stack.mjs --config mcp/security-stack.mcp.json --verbose --allow-fail
```

Use strict mode (non-zero exit on any failure):

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

## Trivy Image Scan (Closes "No image scan" gap)

`trivy fs` scans the repository filesystem and lockfiles.  
It does **not** scan built container images/layers.

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
/home/tetsuo/.local/bin/trivy image --scanners vuln,misconfig,secret --format json --quiet --output .tmp/trivy-image.json agenc/desktop:latest
```

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
