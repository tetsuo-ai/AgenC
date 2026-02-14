import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

type ExportKind = 'function' | 'class' | 'type' | 'interface' | 'const' | 'enum';

interface ExportEntry {
  name: string;
  kind: ExportKind;
  signature?: string;
}

interface ApiBaseline {
  package: string;
  version: string;
  generatedAt: string;
  entryPoint: string;
  exports: ExportEntry[];
}

interface BreakingChange {
  type: 'removed' | 'signature_changed' | 'type_changed';
  symbol: string;
  package: string;
  baseline: ExportEntry | null;
  current: ExportEntry | null;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function requireTypescript(root: string): typeof import('typescript') {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(root, 'node_modules', 'typescript'),
    path.join(root, 'runtime', 'node_modules', 'typescript'),
    path.join(root, 'sdk', 'node_modules', 'typescript'),
    path.join(root, 'mcp', 'node_modules', 'typescript'),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate) as typeof import('typescript');
    } catch {
      // keep searching
    }
  }
  throw new Error('typescript module not found. Install dependencies for at least one package.');
}

function parseArgs(argv: string[]): { mode: 'generate' | 'check'; target: 'sdk' | 'runtime' | 'mcp' } {
  const modeFlag = argv.find((arg) => arg === '--generate' || arg === '--check');
  if (!modeFlag) {
    throw new Error('Usage: npx tsx scripts/check-breaking-changes.ts --generate|--check <sdk|runtime|mcp>');
  }

  const mode = modeFlag === '--generate' ? 'generate' : 'check';
  const idx = argv.indexOf(modeFlag);
  const target = argv[idx + 1] as 'sdk' | 'runtime' | 'mcp' | undefined;
  if (target !== 'sdk' && target !== 'runtime' && target !== 'mcp') {
    throw new Error('Expected target to be one of: sdk, runtime, mcp');
  }

  return { mode, target };
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function readPackageJson(root: string, target: string): { name: string; version: string } {
  const pkgJsonPath = path.join(root, target, 'package.json');
  const pkg = loadJson<{ name: string; version: string }>(pkgJsonPath);
  return { name: pkg.name, version: pkg.version };
}

function loadProgram(ts: typeof import('typescript'), pkgRoot: string): import('typescript').Program {
  const configPath = path.join(pkgRoot, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    const message = ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n');
    throw new Error(`Failed to read tsconfig: ${configPath}: ${message}`);
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    pkgRoot,
    { noEmit: true },
    configPath,
  );

  if (parsed.errors.length > 0) {
    const message = parsed.errors
      .map((diag) => ts.flattenDiagnosticMessageText(diag.messageText, '\n'))
      .join('; ');
    throw new Error(`Failed to parse tsconfig: ${configPath}: ${message}`);
  }

  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

function formatSignature(
  ts: typeof import('typescript'),
  checker: import('typescript').TypeChecker,
  signature: import('typescript').Signature,
  decl: import('typescript').Declaration,
): string {
  return checker.signatureToString(signature, decl, ts.TypeFormatFlags.NoTruncation);
}

function inferExportEntry(
  ts: typeof import('typescript'),
  checker: import('typescript').TypeChecker,
  symbol: import('typescript').Symbol,
  entrySource: import('typescript').SourceFile,
): ExportEntry | null {
  const name = symbol.getName();
  if (name === 'default') {
    return null;
  }

  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  const decl = resolved.valueDeclaration ?? resolved.declarations?.[0] ?? entrySource;
  const type = checker.getTypeOfSymbolAtLocation(resolved, decl);
  const callSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (callSignatures.length > 0) {
    return {
      name,
      kind: 'function',
      signature: callSignatures.map((sig) => formatSignature(ts, checker, sig, decl)).join(' | '),
    };
  }

  if ((resolved.flags & ts.SymbolFlags.Class) !== 0) {
    return { name, kind: 'class' };
  }
  if ((resolved.flags & ts.SymbolFlags.Interface) !== 0) {
    return { name, kind: 'interface' };
  }
  if ((resolved.flags & ts.SymbolFlags.TypeAlias) !== 0) {
    return { name, kind: 'type' };
  }
  if ((resolved.flags & ts.SymbolFlags.Enum) !== 0) {
    return { name, kind: 'enum' };
  }

  return { name, kind: 'const' };
}

function getPublicExports(
  ts: typeof import('typescript'),
  root: string,
  target: 'sdk' | 'runtime' | 'mcp',
): { entryPoint: string; exports: ExportEntry[] } {
  const pkgRoot = path.join(root, target);
  const entryPoint = path.join(pkgRoot, 'src', 'index.ts');

  const program = loadProgram(ts, pkgRoot);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryPoint);
  if (!source) {
    throw new Error(`Entry point not found: ${entryPoint}`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    return { entryPoint: path.relative(root, entryPoint), exports: [] };
  }

  const exports = checker.getExportsOfModule(moduleSymbol)
    .map((symbol) => inferExportEntry(ts, checker, symbol, source))
    .filter((entry): entry is ExportEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { entryPoint: path.relative(root, entryPoint), exports };
}

function baselinePath(root: string, target: string): string {
  return path.join(root, 'docs', 'api-baseline', `${target}.json`);
}

function detectBreakingChanges(
  pkgName: string,
  baseline: ApiBaseline,
  currentExports: ExportEntry[],
): BreakingChange[] {
  const currentByName = new Map(currentExports.map((entry) => [entry.name, entry]));
  const changes: BreakingChange[] = [];

  for (const base of baseline.exports) {
    const current = currentByName.get(base.name);
    if (!current) {
      changes.push({
        type: 'removed',
        symbol: base.name,
        package: pkgName,
        baseline: base,
        current: null,
      });
      continue;
    }

    if (base.kind !== current.kind) {
      changes.push({
        type: 'type_changed',
        symbol: base.name,
        package: pkgName,
        baseline: base,
        current,
      });
      continue;
    }

    if (base.signature !== undefined && current.signature !== undefined && base.signature !== current.signature) {
      changes.push({
        type: 'signature_changed',
        symbol: base.name,
        package: pkgName,
        baseline: base,
        current,
      });
    }
  }

  return changes;
}

function main(): void {
  const root = repoRoot();
  const ts = requireTypescript(root);

  const { mode, target } = parseArgs(process.argv.slice(2));
  const { name: pkgName, version } = readPackageJson(root, target);
  const { entryPoint, exports } = getPublicExports(ts, root, target);

  if (mode === 'generate') {
    const outDir = path.join(root, 'docs', 'api-baseline');
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
    const baseline: ApiBaseline = {
      package: pkgName,
      version,
      generatedAt: new Date().toISOString(),
      entryPoint,
      exports,
    };
    const outputPath = baselinePath(root, target);
    writeFileSync(outputPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    console.log(`Wrote baseline: ${path.relative(root, outputPath)} (${exports.length} exports)`);
    return;
  }

  const inputPath = baselinePath(root, target);
  if (!existsSync(inputPath)) {
    throw new Error(`Baseline not found: ${path.relative(root, inputPath)} (run --generate first)`);
  }

  const baseline = loadJson<ApiBaseline>(inputPath);
  const breaking = detectBreakingChanges(pkgName, baseline, exports);
  if (breaking.length > 0) {
    console.error('BREAKING CHANGES DETECTED:');
    for (const change of breaking) {
      console.error(`  ${change.type}: ${change.symbol} in ${change.package}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`No breaking changes detected for ${pkgName}.`);
}

main();

