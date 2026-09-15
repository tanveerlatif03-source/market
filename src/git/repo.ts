/**
 * The git side of the merge gate (Q1).
 *
 * Agora holds the branch, so what a lane actually changed is read from the
 * diff — never from what the agent said it changed. That difference is the
 * whole point of the gate: an agent that quietly edited a file it never
 * claimed does not get to omit it from its own report.
 *
 * Thin on purpose. Every call shells out to git, so there is no second model
 * of the repository to drift out of step with the real one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizePath } from '../paths.ts';

const run = promisify(execFile);

export interface Repo {
  /** Absolute path to the working tree. */
  root: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  args: string[];
  stderr: string;

  constructor(args: string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

export async function git(repo: Repo, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd: repo.root,
      maxBuffer: 32 * 1024 * 1024
    });
    return { stdout, stderr };
  } catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new GitError(args, failure.stderr ?? failure.message);
  }
}

export function openRepo(root: string): Repo {
  return { root };
}

export async function isRepo(repo: Repo): Promise<boolean> {
  try {
    const { stdout } = await git(repo, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(repo: Repo): Promise<string> {
  const { stdout } = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

export async function branchExists(repo: Repo, name: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Creates `name` off `from` if it isn't there yet. Idempotent. */
export async function ensureBranch(repo: Repo, name: string, from: string): Promise<void> {
  if (await branchExists(repo, name)) return;
  await git(repo, ['branch', name, from]);
}

export async function checkout(repo: Repo, name: string): Promise<void> {
  await git(repo, ['checkout', name]);
}

/**
 * Files that differ between two refs, as git sees them.
 *
 * Uses the merge base rather than a straight two-dot diff, so a lane isn't
 * charged for files that moved on the base branch while it was working.
 */
export async function changedFiles(repo: Repo, base: string, head: string): Promise<string[]> {
  const { stdout } = await git(repo, ['diff', '--name-only', `${base}...${head}`]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(normalizePath)
    .sort();
}

/** Files changed in the working tree and index, for a lane that hasn't committed yet. */
export async function uncommittedFiles(repo: Repo): Promise<string[]> {
  const { stdout } = await git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => normalizePath(line.slice(3).trim()))
    .sort();
}

export interface MergeOutcome {
  merged: boolean;
  /** Paths git could not reconcile. Empty when `merged` is true. */
  conflicts: string[];
  head: string | null;
}

/**
 * Merges `branch` into `into`. On conflict the merge is aborted so the target
 * branch is never left half-merged — a room can be red, but main cannot be
 * ambiguous.
 */
export async function mergeBranch(
  repo: Repo,
  branch: string,
  into: string,
  message: string
): Promise<MergeOutcome> {
  const previous = await currentBranch(repo);
  await checkout(repo, into);
  try {
    await git(repo, ['merge', '--no-ff', '-m', message, branch]);
    const { stdout } = await git(repo, ['rev-parse', 'HEAD']);
    return { merged: true, conflicts: [], head: stdout.trim() };
  } catch {
    const conflicts = await conflictedPaths(repo);
    await git(repo, ['merge', '--abort']).catch(() => undefined);
    return { merged: false, conflicts, head: null };
  } finally {
    await checkout(repo, previous).catch(() => undefined);
  }
}

async function conflictedPaths(repo: Repo): Promise<string[]> {
  try {
    const { stdout } = await git(repo, ['diff', '--name-only', '--diff-filter=U']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(normalizePath)
      .sort();
  } catch {
    return [];
  }
}

/** True when `branch` can be merged into `into` without conflict. Non-destructive. */
export async function mergesCleanly(repo: Repo, branch: string, into: string): Promise<boolean> {
  try {
    const base = await mergeBase(repo, into, branch);
    const { stdout } = await git(repo, ['merge-tree', base, into, branch]);
    return !stdout.includes('<<<<<<<');
  } catch {
    return false;
  }
}

export async function mergeBase(repo: Repo, a: string, b: string): Promise<string> {
  const { stdout } = await git(repo, ['merge-base', a, b]);
  return stdout.trim();
}
