const umbrellaRequiredFiles = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/dependabot.yml',
  '.github/workflows/umbrella-validation.yml',
  'README.md',
  'docs/GETTING_STARTED.md',
  'docs/DEVELOPER_GUIDE.md',
  'docs/CODEBASE_MAP.md',
  'docs/COMMANDS_AND_VALIDATION.md',
  'docs/DOCS_INDEX.md',
  'docs/PLUGIN_KIT.md',
  'docs/REPOSITORY_TOPOLOGY.md',
  'docs/SDK.md',
  'docs/VERSION_DOCS_MAP.md',
  'examples/README.md',
  'examples/tsconfig.public-example.base.json',
  'scripts/bootstrap-agenc-repos.sh',
  'scripts/check-public-contract-boundary.mjs',
  'scripts/check-umbrella-boundary.mjs',
  'scripts/smoke-test-examples.sh',
  'scripts/umbrella-contract-manifest.mjs',
];

const umbrellaRequiredDirectories = [
  'examples/helius-webhook',
  'examples/risc0-proof-demo',
  'examples/simple-usage',
  'examples/tetsuo-integration',
];

export const umbrellaRequiredPaths = [
  ...umbrellaRequiredFiles,
  ...umbrellaRequiredDirectories,
];

const umbrellaContentScanExcludes = new Set([
  'scripts/check-umbrella-boundary.mjs',
  'scripts/umbrella-contract-manifest.mjs',
]);

export const umbrellaActiveContractFiles = umbrellaRequiredFiles.filter(
  (relPath) => !umbrellaContentScanExcludes.has(relPath),
);
