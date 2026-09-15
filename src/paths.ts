/**
 * Path matching for task lanes.
 *
 * A task owns a set of path patterns. Work submitted outside those patterns is
 * refused: one owner per task, and you ask in the thread for anything outside
 * your lane.
 */

export function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

function patternToRegExp(pattern: string): RegExp {
  const body = normalizePath(pattern)
    .split('**')
    .map((segment) =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
    )
    .join('.*');
  return new RegExp(`^${body}$`);
}

/** True when `path` falls inside any of `patterns`. */
export function matchesAnyPath(path: string, patterns: readonly string[]): boolean {
  const target = normalizePath(path);
  return patterns.some((pattern) => {
    const normalized = normalizePath(pattern);
    if (normalized === '**' || normalized === '') return true;
    if (target === normalized) return true;
    // A bare directory owns everything under it.
    if (normalized.endsWith('/')) return target.startsWith(normalized);
    return patternToRegExp(normalized).test(target);
  });
}

/** The paths in `candidates` that fall outside `patterns`. */
export function pathsOutsideLane(
  candidates: readonly string[],
  patterns: readonly string[]
): string[] {
  return candidates.filter((path) => !matchesAnyPath(path, patterns));
}

/** Tasks other than `excludeTaskId` that own any of `paths` — who to go ask. */
export function ownersOfPaths(
  paths: readonly string[],
  tasks: readonly { id: string; paths: string[]; owner: string | null }[],
  excludeTaskId: string
): { path: string; taskId: string; owner: string | null }[] {
  const hits: { path: string; taskId: string; owner: string | null }[] = [];
  for (const path of paths) {
    for (const task of tasks) {
      if (task.id === excludeTaskId) continue;
      if (matchesAnyPath(path, task.paths)) {
        hits.push({ path, taskId: task.id, owner: task.owner });
        break;
      }
    }
  }
  return hits;
}
