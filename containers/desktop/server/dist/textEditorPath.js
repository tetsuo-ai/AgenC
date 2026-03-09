import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
export function getDefaultTextEditorAllowedRoots() {
    const roots = ["/home/agenc", "/tmp"];
    const workspaceRoot = process.env.AGENC_WORKSPACE_ROOT?.trim();
    if (workspaceRoot &&
        isAbsolute(workspaceRoot) &&
        !roots.includes(workspaceRoot)) {
        roots.unshift(resolve(workspaceRoot));
    }
    return roots;
}
function getDefaultTextEditorBaseDir() {
    const workspaceRoot = process.env.AGENC_WORKSPACE_ROOT?.trim();
    if (workspaceRoot && isAbsolute(workspaceRoot)) {
        return resolve(workspaceRoot);
    }
    return "/home/agenc";
}
export async function resolveValidatedTextEditorPath(inputPath, options = {}) {
    const allowedRoots = options.allowedRoots ?? getDefaultTextEditorAllowedRoots();
    const candidatePath = resolveInputPath(inputPath, options.baseDir ?? getDefaultTextEditorBaseDir());
    const resolvedRoots = await Promise.all(allowedRoots.map((root) => resolvePolicyRoot(root)));
    const canonicalCandidate = await resolvePathForContainment(candidatePath);
    if (!resolvedRoots.some((root) => isPathWithinRoot(canonicalCandidate, root))) {
        throw new Error(`Access denied: path must be under ${allowedRoots.join(" or ")}`);
    }
    return canonicalCandidate;
}
function resolveInputPath(inputPath, baseDir) {
    return inputPath.startsWith("/")
        ? resolve(inputPath)
        : resolve(baseDir, inputPath);
}
async function resolvePolicyRoot(root) {
    try {
        return await realpath(root);
    }
    catch (error) {
        if (isPathMissingError(error)) {
            return resolve(root);
        }
        throw error;
    }
}
async function resolvePathForContainment(candidatePath) {
    try {
        return await realpath(candidatePath);
    }
    catch (error) {
        if (!isPathMissingError(error)) {
            throw error;
        }
    }
    const { path: ancestorPath, realPath: ancestorRealPath } = await findNearestExistingAncestor(candidatePath);
    return resolve(ancestorRealPath, relative(ancestorPath, candidatePath));
}
async function findNearestExistingAncestor(candidatePath) {
    let currentPath = dirname(candidatePath);
    while (true) {
        try {
            return { path: currentPath, realPath: await realpath(currentPath) };
        }
        catch (error) {
            if (!isPathMissingError(error)) {
                throw error;
            }
        }
        const parentPath = dirname(currentPath);
        if (parentPath === currentPath) {
            throw new Error(`Failed to resolve a safe parent directory for ${candidatePath}`);
        }
        currentPath = parentPath;
    }
}
function isPathWithinRoot(candidatePath, rootPath) {
    return (candidatePath === rootPath ||
        candidatePath.startsWith(`${rootPath}${sep}`));
}
function isPathMissingError(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
