import path from 'node:path';
import { PolicyError } from './errors.ts';

export function isPathWithinRoot(rootDir: string, candidatePath: string): boolean {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);

  if (candidate === root) {
    return true;
  }

  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(rootWithSep);
}

export function resolveScopedPath(
  rootDir: string,
  inputPath: string,
  allowOutsideCwd: boolean,
): string {
  const resolved = path.resolve(rootDir, inputPath);

  if (!allowOutsideCwd && !isPathWithinRoot(rootDir, resolved)) {
    throw new PolicyError(
      `Path is outside current workspace: ${inputPath}. Pass --allow-outside-cwd to override.`,
    );
  }

  return resolved;
}

export function resolveBashCwd(
  rootDir: string,
  requestedCwd: string | undefined,
  allowOutsideCwd: boolean,
): string {
  const base = requestedCwd ? path.resolve(rootDir, requestedCwd) : rootDir;

  if (!allowOutsideCwd && !isPathWithinRoot(rootDir, base)) {
    throw new PolicyError(
      `Bash cwd is outside current workspace: ${base}. Pass --allow-outside-cwd to override.`,
    );
  }

  return base;
}

export function truncateForPreview(value: string, maxChars = 280): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}
