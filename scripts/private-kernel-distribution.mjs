#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = process.cwd();
const defaultConfigPath = path.join(repoRoot, 'config', 'private-kernel-distribution.json');
const defaultExampleConfigPath = path.join(repoRoot, 'config', 'private-kernel-distribution.example.json');
const defaultLocalConfigPath = path.join(repoRoot, 'config', 'private-kernel-distribution.local.json');
const defaultStageRoot = path.join(repoRoot, '.tmp', 'private-kernel-distribution', 'stage');
const lockfileNames = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
const dependencyObjectFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const recursiveDependencyFields = ['overrides', 'resolutions'];
const bundleDependencyFields = ['bundleDependencies', 'bundledDependencies'];

function parseArgs(argv) {
  const options = {
    mode: null,
    configPath: defaultConfigPath,
    stageRoot: defaultStageRoot,
    keepFailedStage: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--check':
      case '--stage':
      case '--dry-run':
        if (options.mode !== null) {
          throw new Error(`multiple modes provided: ${options.mode} and ${argument}`);
        }
        options.mode = argument.slice(2);
        break;
      case '--config':
        index += 1;
        if (index >= argv.length) {
          throw new Error('--config requires a path');
        }
        options.configPath = path.resolve(repoRoot, argv[index]);
        break;
      case '--stage-root':
        index += 1;
        if (index >= argv.length) {
          throw new Error('--stage-root requires a path');
        }
        options.stageRoot = path.resolve(repoRoot, argv[index]);
        break;
      case '--keep-failed-stage':
        options.keepFailedStage = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.mode === null) {
    throw new Error('one mode is required: --check, --stage, or --dry-run');
  }

  return options;
}

function log(message) {
  process.stdout.write(`[private-kernel-distribution] ${message}\n`);
}

function stableOrder(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableOrder(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, stableOrder(value[key])]),
    );
  }

  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableOrder(value), null, 2)}\n`;
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(filePath) {
  return sha256Buffer(await readFile(filePath));
}

async function waitForFile(filePath, { timeoutMs = 4000, pollMs = 50 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, pollMs);
      });
    }
  }
  throw new Error(`timed out waiting for file ${filePath}`);
}

function packFilename(packageName, version) {
  return `${packageName.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
}

async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function capturePackTarball(sourcePath, destinationPath, { timeoutMs = 4000, pollMs = 50 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const firstStat = await stat(sourcePath);
      await new Promise((resolve) => {
        setTimeout(resolve, pollMs);
      });
      const secondStat = await stat(sourcePath);
      if (firstStat.size <= 0 || firstStat.size !== secondStat.size) {
        continue;
      }
      await removeIfExists(destinationPath);
      await copyFile(sourcePath, destinationPath);
      await removeIfExists(sourcePath);
      return;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        await new Promise((resolve) => {
          setTimeout(resolve, pollMs);
        });
        continue;
      }
      throw error;
    }
  }
  throw new Error(`timed out capturing packed tarball ${sourcePath}`);
}

function readJsonAbsolute(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readJson(relPath) {
  return readJsonAbsolute(path.join(repoRoot, relPath));
}

function runCommand(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function assertCommand(command, args, options) {
  const result = runCommand(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}${detail ? `\n${detail}` : ''}`,
    );
  }
  return result.stdout;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensureConfigShape(config, configPath) {
  if (!Number.isInteger(config.version) || config.version < 1) {
    throw new Error(`${configPath} must declare a positive integer version`);
  }

  if (!isObject(config.backend)) {
    throw new Error(`${configPath} must declare backend configuration`);
  }

  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error(`${configPath} must declare at least one distribution target`);
  }

  if (!isObject(config.supportWindow)) {
    throw new Error(`${configPath} must declare supportWindow`);
  }
}

function compareExampleConfig(configPath, config) {
  if (configPath !== defaultConfigPath || !existsSync(defaultExampleConfigPath)) {
    return;
  }

  const exampleConfig = readJsonAbsolute(defaultExampleConfigPath);
  if (stableJson(config) !== stableJson(exampleConfig)) {
    throw new Error(
      `${path.relative(repoRoot, defaultExampleConfigPath)} must stay in sync with ${path.relative(repoRoot, configPath)}`,
    );
  }
}

function compareLocalConfig(configPath, config) {
  if (configPath !== defaultLocalConfigPath || !existsSync(defaultConfigPath)) {
    return;
  }

  const canonicalConfig = readJsonAbsolute(defaultConfigPath);
  const localProjection = {
    version: config.version,
    versionPolicy: config.versionPolicy,
    supportWindow: config.supportWindow,
    targets: config.targets,
    backend: {
      scope: config.backend?.scope,
      authTokenEnvVar: config.backend?.authTokenEnvVar,
      publishAccess: config.backend?.publishAccess ?? null,
      kind: config.backend?.kind,
    },
  };
  const canonicalProjection = {
    version: canonicalConfig.version,
    versionPolicy: canonicalConfig.versionPolicy,
    supportWindow: canonicalConfig.supportWindow,
    targets: canonicalConfig.targets,
    backend: {
      scope: canonicalConfig.backend?.scope,
      authTokenEnvVar: canonicalConfig.backend?.authTokenEnvVar,
      publishAccess: canonicalConfig.backend?.publishAccess ?? null,
      kind: canonicalConfig.backend?.kind,
    },
  };

  if (stableJson(localProjection) !== stableJson(canonicalProjection)) {
    throw new Error(
      `${path.relative(repoRoot, defaultLocalConfigPath)} must keep version, versionPolicy, supportWindow, targets, and backend identity fields in sync with ${path.relative(repoRoot, defaultConfigPath)}`,
    );
  }
}

function applyRuntimeConfigOverrides(config) {
  const registryUrlOverride = process.env.PRIVATE_KERNEL_REGISTRY_URL?.trim();
  if (!registryUrlOverride) {
    return config;
  }

  if (registryUrlOverride.length === 0) {
    throw new Error('PRIVATE_KERNEL_REGISTRY_URL must not be empty when set');
  }

  return {
    ...config,
    backend: {
      ...config.backend,
      registryUrl: registryUrlOverride,
    },
  };
}

function rewriteAliasSpec(specifier, renameMap) {
  for (const [sourceName, stagedName] of renameMap.entries()) {
    if (specifier === sourceName) {
      return stagedName;
    }
    const aliasPrefix = `npm:${sourceName}@`;
    if (specifier.startsWith(aliasPrefix)) {
      return `npm:${stagedName}@${specifier.slice(aliasPrefix.length)}`;
    }
  }
  return specifier;
}

function rewritePackageSelectorKey(key, renameMap) {
  for (const [sourceName, stagedName] of renameMap.entries()) {
    if (key === sourceName) {
      return stagedName;
    }
    const selectorPrefix = `${sourceName}@`;
    if (key.startsWith(selectorPrefix)) {
      return `${stagedName}${key.slice(sourceName.length)}`;
    }
  }
  return key;
}

function isForbiddenSpecifier(specifier) {
  return specifier.startsWith('workspace:') || specifier.startsWith('file:');
}

function isUnexpectedRegistrySpecifier(specifier) {
  return /^https?:\/\//u.test(specifier);
}

function validateDependencySpecifier(specifier, failures, context) {
  if (typeof specifier !== 'string') {
    return;
  }
  if (isForbiddenSpecifier(specifier)) {
    failures.push(`${context} uses forbidden dependency specifier ${specifier}`);
  }
  if (isUnexpectedRegistrySpecifier(specifier)) {
    failures.push(`${context} uses unexpected registry URL dependency specifier ${specifier}`);
  }
}

function validateDependencyObject(name, objectValue, failures, fieldName) {
  if (!isObject(objectValue)) {
    return;
  }
  for (const [dependencyName, dependencySpecifier] of Object.entries(objectValue)) {
    if (typeof dependencySpecifier === 'string') {
      validateDependencySpecifier(
        dependencySpecifier,
        failures,
        `${name}:${fieldName}:${dependencyName}`,
      );
      continue;
    }

    if (isObject(dependencySpecifier)) {
      validateRecursiveDependencyMap(
        dependencySpecifier,
        failures,
        `${name}:${fieldName}:${dependencyName}`,
      );
    }
  }
}

function validateRecursiveDependencyMap(value, failures, context) {
  if (typeof value === 'string') {
    validateDependencySpecifier(value, failures, context);
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      validateRecursiveDependencyMap(entry, failures, `${context}[${index}]`);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    validateRecursiveDependencyMap(entry, failures, `${context}.${key}`);
  }
}

function collectInternalEdges(packageManifest, sourceNameToTarget) {
  const edges = new Set();
  for (const fieldName of dependencyObjectFields) {
    const dependencies = packageManifest[fieldName];
    if (!isObject(dependencies)) {
      continue;
    }
    for (const dependencyName of Object.keys(dependencies)) {
      if (sourceNameToTarget.has(dependencyName)) {
        edges.add(dependencyName);
      }
    }
  }
  return edges;
}

function detectCycles(targets, graph) {
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(nodeName, trail) {
    if (visited.has(nodeName)) {
      return;
    }
    if (visiting.has(nodeName)) {
      const cycleStart = trail.indexOf(nodeName);
      const cycle = [...trail.slice(cycleStart), nodeName];
      throw new Error(`private package dependency cycle detected: ${cycle.join(' -> ')}`);
    }

    visiting.add(nodeName);
    for (const dependencyName of graph.get(nodeName) ?? []) {
      visit(dependencyName, [...trail, nodeName]);
    }
    visiting.delete(nodeName);
    visited.add(nodeName);
    ordered.push(nodeName);
  }

  for (const target of targets) {
    visit(target.sourceName, []);
  }

  return ordered;
}

function sanitizeWorkspacePath(workspacePath) {
  return workspacePath.replaceAll('/', '__');
}

function packageEntryPaths(packageManifest) {
  const paths = new Set();

  const maybeAdd = (value) => {
    if (typeof value !== 'string') {
      return;
    }
    if (value.startsWith('./')) {
      paths.add(value.slice(2));
      return;
    }
    if (!value.startsWith('/')) {
      paths.add(value);
    }
  };

  maybeAdd(packageManifest.main);
  maybeAdd(packageManifest.module);
  maybeAdd(packageManifest.types);

  if (isObject(packageManifest.bin)) {
    for (const binTarget of Object.values(packageManifest.bin)) {
      maybeAdd(binTarget);
    }
  } else {
    maybeAdd(packageManifest.bin);
  }

  const walkExports = (value) => {
    if (typeof value === 'string') {
      maybeAdd(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walkExports(entry);
      }
      return;
    }
    if (isObject(value)) {
      for (const entry of Object.values(value)) {
        walkExports(entry);
      }
    }
  };

  walkExports(packageManifest.exports);
  return [...paths];
}

async function assertPackageEntryPaths(packageDir, packageManifest, context) {
  for (const relPath of packageEntryPaths(packageManifest)) {
    if (relPath.startsWith('node:') || relPath.startsWith('#')) {
      continue;
    }
    const fullPath = path.join(packageDir, relPath);
    try {
      await access(fullPath);
    } catch {
      throw new Error(`${context} references missing packaged entry ${relPath}`);
    }
  }
}

function rewriteNamedDependencyMap(record, renameMap) {
  if (!isObject(record)) {
    return record;
  }

  const rewritten = {};
  for (const [dependencyName, specifier] of Object.entries(record)) {
    const rewrittenKey = renameMap.get(dependencyName) ?? dependencyName;
    if (rewrittenKey in rewritten) {
      throw new Error(`dependency key collision while rewriting ${dependencyName} -> ${rewrittenKey}`);
    }
    rewritten[rewrittenKey] =
      typeof specifier === 'string' ? rewriteAliasSpec(specifier, renameMap) : specifier;
  }
  return rewritten;
}

function rewriteRecursiveDependencyMap(value, renameMap) {
  if (typeof value === 'string') {
    return rewriteAliasSpec(value, renameMap);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteRecursiveDependencyMap(entry, renameMap));
  }
  if (!isObject(value)) {
    return value;
  }

  const rewritten = {};
  for (const [key, entry] of Object.entries(value)) {
    const rewrittenKey = rewritePackageSelectorKey(key, renameMap);
    if (rewrittenKey in rewritten) {
      throw new Error(`override/resolution key collision while rewriting ${key} -> ${rewrittenKey}`);
    }
    rewritten[rewrittenKey] = rewriteRecursiveDependencyMap(entry, renameMap);
  }
  return rewritten;
}

function rewriteBundleDependencyList(value, renameMap) {
  if (Array.isArray(value)) {
    return value.map((entry) => (renameMap.get(entry) ?? entry));
  }
  return value;
}

function rewritePeerDependenciesMeta(value, renameMap) {
  if (!isObject(value)) {
    return value;
  }
  const rewritten = {};
  for (const [key, entry] of Object.entries(value)) {
    const rewrittenKey = renameMap.get(key) ?? key;
    if (rewrittenKey in rewritten) {
      throw new Error(`peerDependenciesMeta key collision while rewriting ${key} -> ${rewrittenKey}`);
    }
    rewritten[rewrittenKey] = entry;
  }
  return rewritten;
}

function buildStagedPublishConfig(config) {
  const publishConfig = {
    registry: config.backend.registryUrl,
  };
  if (typeof config.backend.publishAccess === 'string' && config.backend.publishAccess.length > 0) {
    publishConfig.access = config.backend.publishAccess;
  }
  return publishConfig;
}

function validateTargetSet(config, rootPkg) {
  const failures = [];
  const workspaceSet = new Set(rootPkg.workspaces ?? []);
  const targetByWorkspace = new Map();
  const sourceNameToTarget = new Map();
  const stagedNameSet = new Set();

  if (config.backend.scope === '@tetsuo-ai') {
    failures.push('private distribution scope must be distinct from the public @tetsuo-ai scope');
  }
  if (!config.backend.scope.startsWith('@')) {
    failures.push(`private distribution scope must be scoped, received ${config.backend.scope}`);
  }

  for (const target of config.targets) {
    if (!workspaceSet.has(target.workspace)) {
      failures.push(`configured target workspace ${target.workspace} is not present in root workspaces`);
      continue;
    }

    if (targetByWorkspace.has(target.workspace)) {
      failures.push(`duplicate target workspace ${target.workspace} in distribution config`);
    }
    targetByWorkspace.set(target.workspace, target);

    if (!target.stagedName.startsWith(`${config.backend.scope}/`)) {
      failures.push(
        `staged package ${target.stagedName} must stay under configured internal scope ${config.backend.scope}`,
      );
    }

    if (target.stagedName === target.sourceName) {
      failures.push(`staged package ${target.stagedName} must differ from source package name`);
    }

    if (stagedNameSet.has(target.stagedName)) {
      failures.push(`duplicate staged package identity ${target.stagedName}`);
    }
    stagedNameSet.add(target.stagedName);

    if (sourceNameToTarget.has(target.sourceName)) {
      failures.push(`duplicate source package identity ${target.sourceName}`);
    }
    sourceNameToTarget.set(target.sourceName, target);
  }

  return { failures, sourceNameToTarget, stagedNameSet };
}

function validateSourceManifests(config, sourceNameToTarget) {
  const failures = [];
  const manifests = new Map();

  for (const target of config.targets) {
    const manifestPath = path.join(repoRoot, target.workspace, 'package.json');
    const manifest = readJsonAbsolute(manifestPath);
    manifests.set(target.workspace, manifest);

    if (manifest.name !== target.sourceName) {
      failures.push(
        `${target.workspace}/package.json declares ${manifest.name}; expected ${target.sourceName}`,
      );
    }
    if (manifest.private !== true) {
      failures.push(`${target.workspace}/package.json must stay private=true in source control`);
    }
    for (const fieldName of dependencyObjectFields) {
      validateDependencyObject(manifest.name, manifest[fieldName], failures, fieldName);
    }
    for (const fieldName of recursiveDependencyFields) {
      validateRecursiveDependencyMap(manifest[fieldName], failures, `${manifest.name}:${fieldName}`);
    }
  }

  const graph = new Map();
  for (const target of config.targets) {
    const manifest = manifests.get(target.workspace);
    graph.set(target.sourceName, collectInternalEdges(manifest, sourceNameToTarget));
  }

  let publishOrder;
  try {
    publishOrder = detectCycles(config.targets, graph);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return { failures, manifests, publishOrder: publishOrder ?? [] };
}

function loadValidatedConfig(configPath) {
  const rawConfig = readJsonAbsolute(configPath);
  ensureConfigShape(rawConfig, configPath);
  compareExampleConfig(configPath, rawConfig);
  compareLocalConfig(configPath, rawConfig);
  const config = applyRuntimeConfigOverrides(rawConfig);

  const rootPkg = readJson('package.json');
  const targetValidation = validateTargetSet(config, rootPkg);
  const manifestValidation = validateSourceManifests(config, targetValidation.sourceNameToTarget);
  const failures = [...targetValidation.failures, ...manifestValidation.failures];

  if (failures.length > 0) {
    throw new Error(`private-kernel distribution check failed:\n- ${failures.join('\n- ')}`);
  }

  return {
    config,
    rootPkg,
    sourceNameToTarget: targetValidation.sourceNameToTarget,
    manifests: manifestValidation.manifests,
    publishOrder: manifestValidation.publishOrder,
  };
}

async function stripLockfiles(stageDir) {
  const stripped = [];
  for (const lockfileName of lockfileNames) {
    const candidatePath = path.join(stageDir, lockfileName);
    try {
      await access(candidatePath);
      await rm(candidatePath, { force: true });
      stripped.push(lockfileName);
    } catch {
      // no-op
    }
  }
  return stripped;
}

async function stagePackages({ config, configPath, publishOrder }, stageRoot) {
  await rm(stageRoot, { force: true, recursive: true });
  await mkdir(path.join(stageRoot, 'packages'), { recursive: true });
  await mkdir(path.join(stageRoot, 'tarballs'), { recursive: true });
  await mkdir(path.join(stageRoot, 'source-tarballs'), { recursive: true });

  const renameMap = new Map(config.targets.map((target) => [target.sourceName, target.stagedName]));
  const targetBySourceName = new Map(config.targets.map((target) => [target.sourceName, target]));
  const stagedManifest = {
    version: config.version,
    createdAt: new Date().toISOString(),
    configPath: path.relative(repoRoot, configPath),
    stageRoot: path.relative(repoRoot, stageRoot),
    registryUrl: config.backend.registryUrl,
    scope: config.backend.scope,
    publishOrder,
    packages: [],
  };

  for (const sourceName of publishOrder) {
    const target = targetBySourceName.get(sourceName);
    if (!target) {
      throw new Error(`publish-order source ${sourceName} is not present in target config`);
    }

    const sourceDir = path.join(repoRoot, target.workspace);
    const sourceManifest = readJsonAbsolute(path.join(sourceDir, 'package.json'));
    const sourcePackFilename = packFilename(sourceManifest.name, sourceManifest.version);
    const sourceCwdTarballPath = path.join(sourceDir, sourcePackFilename);
    const sourceTarballPath = path.join(stageRoot, 'source-tarballs', sourcePackFilename);
    await removeIfExists(sourceCwdTarballPath);
    await removeIfExists(sourceTarballPath);

    log(`packing source workspace ${target.workspace}`);
    const packOutput = assertCommand('npm', ['pack', '--json'], { cwd: sourceDir });
    const [packRecord] = JSON.parse(packOutput);
    if (!packRecord?.filename) {
      throw new Error(`npm pack did not return a filename for ${target.workspace}`);
    }
    if (packRecord.filename !== sourcePackFilename) {
      throw new Error(
        `unexpected source tarball filename for ${target.workspace}: expected ${sourcePackFilename}, received ${packRecord.filename}`,
      );
    }
    await waitForFile(sourceCwdTarballPath);
    await capturePackTarball(sourceCwdTarballPath, sourceTarballPath);
    const sourceTarballSha256 = await sha256File(sourceTarballPath);
    const extractRoot = path.join(stageRoot, 'packages', `${sanitizeWorkspacePath(target.workspace)}__extract`);
    await mkdir(extractRoot, { recursive: true });
    assertCommand('tar', ['-xzf', sourceTarballPath, '-C', extractRoot], { cwd: repoRoot });

    const extractedPackageDir = path.join(extractRoot, 'package');
    const stagedDir = path.join(stageRoot, 'packages', sanitizeWorkspacePath(target.workspace));
    await rm(stagedDir, { force: true, recursive: true });
    await rename(extractedPackageDir, stagedDir);
    await rm(extractRoot, { force: true, recursive: true });

    const strippedLockfiles = await stripLockfiles(stagedDir);
    const stagedPackagePath = path.join(stagedDir, 'package.json');
    const stagedPackage = readJsonAbsolute(stagedPackagePath);

    if (stagedPackage.name !== target.sourceName) {
      throw new Error(
        `staged package ${target.workspace} resolved as ${stagedPackage.name}; expected ${target.sourceName}`,
      );
    }

    stagedPackage.name = target.stagedName;
    stagedPackage.private = false;
    stagedPackage.publishConfig = buildStagedPublishConfig(config);
    delete stagedPackage.scripts;

    for (const fieldName of dependencyObjectFields) {
      stagedPackage[fieldName] = rewriteNamedDependencyMap(stagedPackage[fieldName], renameMap);
    }
    for (const fieldName of recursiveDependencyFields) {
      stagedPackage[fieldName] = rewriteRecursiveDependencyMap(stagedPackage[fieldName], renameMap);
    }
    for (const fieldName of bundleDependencyFields) {
      stagedPackage[fieldName] = rewriteBundleDependencyList(stagedPackage[fieldName], renameMap);
    }
    stagedPackage.peerDependenciesMeta = rewritePeerDependenciesMeta(
      stagedPackage.peerDependenciesMeta,
      renameMap,
    );

    const stagedFailures = [];
    for (const fieldName of dependencyObjectFields) {
      validateDependencyObject(stagedPackage.name, stagedPackage[fieldName], stagedFailures, fieldName);
    }
    for (const fieldName of recursiveDependencyFields) {
      validateRecursiveDependencyMap(stagedPackage[fieldName], stagedFailures, `${stagedPackage.name}:${fieldName}`);
    }
    if (stagedFailures.length > 0) {
      throw new Error(`staged dependency validation failed for ${stagedPackage.name}:\n- ${stagedFailures.join('\n- ')}`);
    }

    const stagedManifestText = stableJson(stagedPackage);
    await writeFile(stagedPackagePath, stagedManifestText, 'utf8');
    await assertPackageEntryPaths(stagedDir, stagedPackage, stagedPackage.name);

    const stagedManifestSha256 = sha256Buffer(Buffer.from(stagedManifestText, 'utf8'));
    const stagedPackFilename = packFilename(stagedPackage.name, stagedPackage.version);
    const stagedCwdTarballPath = path.join(stagedDir, stagedPackFilename);
    const finalTarballPath = path.join(stageRoot, 'tarballs', stagedPackFilename);
    await removeIfExists(stagedCwdTarballPath);
    await removeIfExists(finalTarballPath);
    const stagedPackOutput = assertCommand('npm', ['pack', '--json'], { cwd: stagedDir });
    const [stagedPackRecord] = JSON.parse(stagedPackOutput);
    if (!stagedPackRecord?.filename) {
      throw new Error(`npm pack did not return a filename for staged package ${stagedPackage.name}`);
    }
    if (stagedPackRecord.filename !== stagedPackFilename) {
      throw new Error(
        `unexpected staged tarball filename for ${stagedPackage.name}: expected ${stagedPackFilename}, received ${stagedPackRecord.filename}`,
      );
    }
    await waitForFile(stagedCwdTarballPath);
    await capturePackTarball(stagedCwdTarballPath, finalTarballPath);
    const stagedTarballSha256 = await sha256File(finalTarballPath);

    stagedManifest.packages.push({
      workspace: target.workspace,
      sourceName: target.sourceName,
      stagedName: target.stagedName,
      sourceVersion: stagedPackage.version,
      sourceTarball: path.relative(repoRoot, sourceTarballPath),
      sourceTarballSha256,
      stagedDir: path.relative(repoRoot, stagedDir),
      stagedManifestSha256,
      stagedTarball: path.relative(repoRoot, finalTarballPath),
      stagedTarballSha256,
      strippedLockfiles,
      publishConfig: stagedPackage.publishConfig,
    });
  }

  const manifestPath = path.join(stageRoot, 'staging-manifest.json');
  await writeFile(manifestPath, stableJson(stagedManifest), 'utf8');
  return manifestPath;
}

function registryAuthLine(registryUrl, token) {
  const registry = new URL(registryUrl);
  const normalizedPath = registry.pathname.endsWith('/') ? registry.pathname : `${registry.pathname}/`;
  return `//${registry.host}${normalizedPath}:_authToken=${token}`;
}

function buildUserConfigContent(registryUrl, scope, token) {
  return `registry=${registryUrl}\n${scope}:registry=${registryUrl}\n${registryAuthLine(registryUrl, token)}\n`;
}

async function withTemporaryUserConfig({ registryUrl, scope, token }, callback) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agenc-private-kernel-userconfig-'));
  const userConfigPath = path.join(tempDir, '.npmrc');

  try {
    await writeFile(userConfigPath, buildUserConfigContent(registryUrl, scope, token), {
      encoding: 'utf8',
      mode: 0o600,
    });

    return await callback(userConfigPath);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function classifyRegistryFailure(result) {
  const text = `${result.stdout}\n${result.stderr}\n${result.error ? String(result.error) : ''}`.toLowerCase();
  if (
    text.includes('dry-run disabled')
    || text.includes('dry run disabled')
    || text.includes('dry-run not supported')
    || text.includes('dry run not supported')
  ) {
    return 'publish_dry_run_disabled';
  }
  if (
    text.includes('e403')
    || text.includes(' 403')
    || text.includes('forbidden')
    || text.includes('insufficient')
    || text.includes('scope')
  ) {
    return 'insufficient_scope';
  }
  if (
    text.includes('e401')
    || text.includes('eneedauth')
    || text.includes(' 401')
    || text.includes('unauthorized')
    || text.includes('authentication')
    || text.includes('not logged in')
  ) {
    return 'auth_rejected';
  }
  if (
    text.includes('enotfound')
    || text.includes('econnrefused')
    || text.includes('eai_again')
    || text.includes('fetch failed')
    || text.includes('timed out')
    || text.includes('network is unreachable')
    || text.includes('unable to connect')
  ) {
    return 'registry_unreachable';
  }
  return null;
}

function isUnsupportedRegistryProbe(result) {
  const text = `${result.stdout}\n${result.stderr}\n${result.error ? String(result.error) : ''}`.toLowerCase();
  return (
    text.includes('not supported')
    || text.includes('not implemented')
    || text.includes('method not allowed')
    || text.includes('405')
    || text.includes('e405')
    || text.includes('unknown command')
    || text.includes('e404')
    || text.includes(' 404')
  );
}

function emitDryRunSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function dryRunStagedPackages(config, stageRoot) {
  const stageManifestPath = path.join(stageRoot, 'staging-manifest.json');
  if (!existsSync(stageManifestPath)) {
    throw new Error(`staging manifest missing at ${stageManifestPath}; run --stage first`);
  }

  if (config.backend.publishDryRunEnabled !== true) {
    emitDryRunSummary({
      mode: 'dry-run',
      status: 'skipped',
      reasonCode: 'publish_dry_run_disabled',
      registryUrl: config.backend.registryUrl,
      stageRoot: path.relative(repoRoot, stageRoot),
    });
    return;
  }

  const token = process.env[config.backend.authTokenEnvVar];
  if (!token) {
    const summary = {
      mode: 'dry-run',
      status: 'skipped',
      reasonCode: 'missing_token',
      tokenEnvVar: config.backend.authTokenEnvVar,
      registryUrl: config.backend.registryUrl,
      stageRoot: path.relative(repoRoot, stageRoot),
    };

    if (config.backend.ciAuthMode === 'optional-skip') {
      emitDryRunSummary(summary);
      return;
    }
    throw new Error(JSON.stringify(summary, null, 2));
  }

  const stageManifest = readJsonAbsolute(stageManifestPath);

  await withTemporaryUserConfig(
    {
      registryUrl: config.backend.registryUrl,
      scope: config.backend.scope,
      token,
    },
    async (userConfigPath) => {
      const dryRunEnv = {
        ...process.env,
        NPM_CONFIG_USERCONFIG: userConfigPath,
      };
      const skippedProbes = [];

      const pingResult = runCommand('npm', ['ping', '--registry', config.backend.registryUrl], {
        cwd: repoRoot,
        env: dryRunEnv,
      });
      if (pingResult.status !== 0) {
        if (isUnsupportedRegistryProbe(pingResult)) {
          skippedProbes.push('ping');
        } else {
          const reasonCode = classifyRegistryFailure(pingResult) ?? 'registry_unreachable';
          const summary = {
            mode: 'dry-run',
            status: config.backend.ciAuthMode === 'optional-skip' ? 'skipped' : 'failed',
            reasonCode,
            probe: 'ping',
            registryUrl: config.backend.registryUrl,
            stageRoot: path.relative(repoRoot, stageRoot),
          };
          if (config.backend.ciAuthMode === 'optional-skip') {
            emitDryRunSummary(summary);
            return;
          }
          throw new Error(JSON.stringify(summary, null, 2));
        }
      }

      const whoamiResult = runCommand('npm', ['whoami', '--registry', config.backend.registryUrl], {
        cwd: repoRoot,
        env: dryRunEnv,
      });
      if (whoamiResult.status !== 0) {
        if (isUnsupportedRegistryProbe(whoamiResult)) {
          skippedProbes.push('whoami');
        } else {
          const reasonCode = classifyRegistryFailure(whoamiResult) ?? 'auth_rejected';
          const summary = {
            mode: 'dry-run',
            status: config.backend.ciAuthMode === 'optional-skip' ? 'skipped' : 'failed',
            reasonCode,
            probe: 'whoami',
            registryUrl: config.backend.registryUrl,
            stageRoot: path.relative(repoRoot, stageRoot),
          };
          if (config.backend.ciAuthMode === 'optional-skip') {
            emitDryRunSummary(summary);
            return;
          }
          throw new Error(JSON.stringify(summary, null, 2));
        }
      }

      const published = [];
      for (const pkg of stageManifest.packages) {
        const stagedDir = path.join(repoRoot, pkg.stagedDir);
        const publishResult = runCommand(
          'npm',
          ['publish', '--dry-run', '--json', '--registry', config.backend.registryUrl],
          { cwd: stagedDir, env: dryRunEnv },
        );

        if (publishResult.status !== 0) {
          const reasonCode = classifyRegistryFailure(publishResult) ?? 'publish_dry_run_failed';
          const summary = {
            mode: 'dry-run',
            status: config.backend.ciAuthMode === 'optional-skip' ? 'skipped' : 'failed',
            reasonCode,
            packageName: pkg.stagedName,
            registryUrl: config.backend.registryUrl,
            stageRoot: path.relative(repoRoot, stageRoot),
          };
          if (config.backend.ciAuthMode === 'optional-skip') {
            emitDryRunSummary(summary);
            return;
          }
          throw new Error(JSON.stringify(summary, null, 2));
        }

        published.push(pkg.stagedName);
      }

      emitDryRunSummary({
        mode: 'dry-run',
        status: 'passed',
        registryUrl: config.backend.registryUrl,
        stageRoot: path.relative(repoRoot, stageRoot),
        packages: published,
        skippedProbes,
      });
    },
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { config, publishOrder } = loadValidatedConfig(options.configPath);

  if (options.mode === 'check') {
    log('private-kernel distribution check passed.');
    return;
  }

  try {
    if (options.mode === 'stage') {
      const manifestPath = await stagePackages(
        {
          config,
          configPath: options.configPath,
          publishOrder,
        },
        options.stageRoot,
      );
      log(`staged private-kernel packages at ${path.relative(repoRoot, options.stageRoot)}`);
      log(`staging manifest written to ${path.relative(repoRoot, manifestPath)}`);
      return;
    }

    if (options.mode === 'dry-run') {
      await dryRunStagedPackages(config, options.stageRoot);
    }
  } catch (error) {
    if (!options.keepFailedStage && (options.mode === 'stage' || options.mode === 'dry-run')) {
      await rm(options.stageRoot, { force: true, recursive: true });
    }
    throw error;
  }
}

export {
  applyRuntimeConfigOverrides,
  buildUserConfigContent,
  compareLocalConfig,
  isUnsupportedRegistryProbe,
  loadValidatedConfig,
  parseArgs,
  registryAuthLine,
  withTemporaryUserConfig,
};

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
