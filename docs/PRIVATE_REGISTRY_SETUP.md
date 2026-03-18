# Private Registry Setup

This document describes both:

- the permanent hosted private-kernel backend on Cloudsmith
- the repo-owned local/CI reference implementation on Verdaccio

## Permanent hosted backend

The permanent hosted registry backend is Cloudsmith:

- owner: `agenc`
- repository: `private-kernel`
- npm endpoint: `https://npm.cloudsmith.io/agenc/private-kernel/`

Hosted validation is performed through:

- [private-kernel-cloudsmith.yml](/home/tetsuo/git/AgenC/.github/workflows/private-kernel-cloudsmith.yml)

Hosted auth rules:

- the npm token env var is `PRIVATE_KERNEL_REGISTRY_TOKEN`
- the credential must belong to a service-scoped Cloudsmith account, not a
  personal user token
- GitHub Actions must source that secret from the protected
  `private-kernel-cloudsmith` environment
- the hosted workflow hard-fails if the secret is absent so canonical
  `optional-skip` behavior cannot mask a broken hosted setup

Hosted validation sequence:

1. `npm ci`
2. `npm run build:private-kernel`
3. `npm run check:private-kernel-distribution`
4. `npm run stage:private-kernel-distribution`
5. `npm run dry-run:private-kernel-distribution`
6. `node scripts/private-registry-rehearsal.mjs --fixture-only --registry-url https://npm.cloudsmith.io/agenc/private-kernel/`

The hosted rehearsal intentionally uses a disposable fixture package under the
private scope so the permanent registry can prove live publish/view/install
without polluting the real staged private-kernel package versions.

Cloudsmith hosted validation does not require the registry to reject public
`@tetsuo-ai/*` package names. That denial remains part of the Verdaccio
reference backend contract, where the registry is intentionally configured to
enforce the private scope boundary directly.

## Local/CI reference backend

The current reference backend is a local/CI Verdaccio 6 registry managed by:

- [private-registry-service.mjs](/home/tetsuo/git/AgenC/scripts/private-registry-service.mjs)
- [bootstrap-private-registry-user.mjs](/home/tetsuo/git/AgenC/scripts/bootstrap-private-registry-user.mjs)

The image is pinned by digest in the service script. Record the corresponding
human-readable Verdaccio version when intentionally upgrading that digest.

This remains the reference implementation for local development and untrusted CI
validation. It is no longer the chosen hosted backend.

The registry service is responsible for preparing writable storage/auth
volumes for the non-root Verdaccio container user before startup. Bootstrap
does not rely on npm prompt automation; it provisions the service account
through the registry user API and then verifies the issued token with
`npm whoami` after the registry is restarted in locked mode.

## Local runtime contract

Default local settings:

- registry URL: `http://127.0.0.1:4873`
- internal scope: `@tetsuo-ai-private/*`
- instance name: derived from the current worktree path hash
- host port: `4873` unless overridden

Supported environment overrides:

- `PRIVATE_REGISTRY_INSTANCE`
- `PRIVATE_REGISTRY_PORT`
- `PRIVATE_KERNEL_REGISTRY_URL`
- `PRIVATE_REGISTRY_IMAGE`
- `PRIVATE_REGISTRY_USERNAME`
- `PRIVATE_REGISTRY_PASSWORD`
- `PRIVATE_REGISTRY_EMAIL`
- `PRIVATE_REGISTRY_TOKEN_FILE`

The local full distribution config is:

- [private-kernel-distribution.local.json](/home/tetsuo/git/AgenC/config/private-kernel-distribution.local.json)

The canonical hosted policy config remains:

- [private-kernel-distribution.json](/home/tetsuo/git/AgenC/config/private-kernel-distribution.json)

## Commands

Start the locked registry:

```bash
npm run private-registry:up
```

Check health:

```bash
npm run private-registry:health
```

Bootstrap a service account:

```bash
PRIVATE_REGISTRY_USERNAME=agenc-ci \
PRIVATE_REGISTRY_PASSWORD=agenc-ci-local \
PRIVATE_REGISTRY_EMAIL=local@example.com \
PRIVATE_REGISTRY_TOKEN_FILE="$(mktemp)" \
npm run private-registry:bootstrap
```

Important:

- the bootstrap script never prints the raw token to stdout
- it writes the token only to the token file you provide
- temp userconfig/token scratch files are created with restrictive permissions
- if the registry user already exists, rerun with the existing token file or
  reset the namespaced registry instance first
- CI must mask the token before exporting it through `GITHUB_ENV` or
  `GITHUB_OUTPUT`

Stage and dry-run against the local registry:

```bash
npm run stage:private-kernel-distribution:local
PRIVATE_KERNEL_REGISTRY_TOKEN="$(cat "$PRIVATE_REGISTRY_TOKEN_FILE")" \
npm run dry-run:private-kernel-distribution:local
```

Run the live publish/install rehearsal:

```bash
PRIVATE_KERNEL_REGISTRY_TOKEN="$(cat "$PRIVATE_REGISTRY_TOKEN_FILE")" \
npm run private-registry:rehearse
```

Reset the namespaced registry instance:

```bash
npm run private-registry:reset
```

## CI contract

The live Verdaccio-backed registry validation is owned by:

- [private-kernel-registry.yml](/home/tetsuo/git/AgenC/.github/workflows/private-kernel-registry.yml)

That workflow:

- pins `npm` to `11.7.0`
- builds the private-kernel packages before staging
- runs the focused registry script tests
- boots Verdaccio in a namespaced instance
- bootstraps a service account without printing the token
- stages the private-kernel graph
- proves:
  - public-scope npmjs uplink resolution
  - denial of public `@tetsuo-ai/*` publish attempts
  - disposable private fixture publish/view/install
  - real staged private-graph publish/install
  - authenticated dry-run publication

The package smoke workflow remains separate and does not own live registry
validation anymore.
