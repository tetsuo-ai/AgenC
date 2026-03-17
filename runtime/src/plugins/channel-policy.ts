import type { GatewayTrustedPluginPackageConfig } from "../gateway/types.js";

const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const PACKAGE_SUBPATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const PACKAGE_SPECIFIER_RE =
  /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export const RESERVED_CHANNEL_NAMES = Object.freeze(
  new Set([
    "webchat",
    "telegram",
    "discord",
    "slack",
    "whatsapp",
    "signal",
    "matrix",
    "imessage",
  ]),
);

export interface ParsedPluginModuleSpecifier {
  readonly packageName: string;
  readonly subpath: string | null;
}

function isUnsafeSpecifierValue(value: string): boolean {
  return (
    value.includes("\\") ||
    value.includes("%") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  );
}

export function isValidTrustedPackageName(value: string): boolean {
  return PACKAGE_NAME_RE.test(value);
}

export function isValidTrustedPackageSubpath(value: string): boolean {
  return (
    PACKAGE_SUBPATH_RE.test(value) &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

export function isValidPluginModuleSpecifier(value: string): boolean {
  return !isUnsafeSpecifierValue(value) && PACKAGE_SPECIFIER_RE.test(value);
}

export function parsePluginModuleSpecifier(
  value: string,
): ParsedPluginModuleSpecifier | null {
  const specifier = value.trim();
  if (!isValidPluginModuleSpecifier(specifier)) {
    return null;
  }

  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) {
      return null;
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const subpath = parts.length > 2 ? parts.slice(2).join("/") : null;
    return { packageName, subpath };
  }

  const [packageName, ...rest] = specifier.split("/");
  return {
    packageName,
    subpath: rest.length > 0 ? rest.join("/") : null,
  };
}

export function isTrustedPluginModuleSpecifier(params: {
  readonly moduleSpecifier: string;
  readonly trustedPackages: readonly GatewayTrustedPluginPackageConfig[];
}): boolean {
  const parsed = parsePluginModuleSpecifier(params.moduleSpecifier);
  if (!parsed) {
    return false;
  }

  const trustedPackage = params.trustedPackages.find(
    (entry) => entry.packageName.trim() === parsed.packageName,
  );
  if (!trustedPackage) {
    return false;
  }

  if (parsed.subpath === null) {
    return true;
  }

  const allowedSubpaths = trustedPackage.allowedSubpaths ?? [];
  if (allowedSubpaths.length === 0) {
    return false;
  }

  return allowedSubpaths.some(
    (candidate) => candidate.trim() === parsed.subpath,
  );
}
