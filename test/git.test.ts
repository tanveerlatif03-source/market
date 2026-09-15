import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  branchExists,
  changedFiles,
  checkout,
  currentBranch,
  ensureBranch,
  git,
  isRepo,
  mergeBranch,
  mergesCleanly,
  openRepo,
  uncommittedFiles
} from '../src/git/repo.ts';
import type { Repo } from '../src/git/repo.ts';

/** Real git, in a real repository. The gate reads the diff, so the diff is tested. */

const scratch: string[] = [];

after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function fixture(): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-git-'));
  scratch.push(dir);
  const repo = openRepo(dir);
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@agora.invalid']);
  await git(repo, ['config', 'user.name', 'Agora Test']);
  await write(repo, 'README.md', 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  return repo;
}

async function write(repo: Repo, path: string, body: string): Promise<void> {
  const full = join(repo.root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

async function commit(repo: Repo, message: string): Promise<void> {
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', message]);
}

describe('opening a repository', () => {
  it('recognises one, and says no to a plain directory', async () => {
    const repo = await fixture();
    assert.equal(await isRepo(repo), true);

    const plain = await mkdtemp(join(tmpdir(), 'agora-plain-'));
    scratch.push(plain);
    assert.equal(await isRepo(openRepo(plain)), false);
  });

  it('reports the branch it is on', async () => {
    const repo = await fixture();
    assert.equal(await currentBranch(repo), 'main');
  });
});

describe('branches', () => {
  it('creates one only if it is missing', async () => {
    const repo = await fixture();
    assert.equal(await branchExists(repo, 'lane/wizard'), false);
    await ensureBranch(repo, 'lane/wizard', 'main');
    assert.equal(await branchExists(repo, 'lane/wizard'), true);
    await ensureBranch(repo, 'lane/wizard', 'main');
    assert.equal(await branchExists(repo, 'lane/wizard'), true, 'calling twice is safe');
  });
});

describe('what a lane actually changed', () => {
  it('reads it from the diff, not from anyone’s word for it', async () => {
    const repo = await fixture();
    await ensureBranch(repo, 'lane/wizard', 'main');
    await checkout(repo, 'lane/wizard');
    await write(repo, 'src/checkout/Wizard.tsx', 'export const Wizard = () => null;\n');
    await write(repo, 'src/pricing/quote.ts', 'export const quote = () => 0;\n');
    await commit(repo, 'wizard work');

    assert.deepEqual(await changedFiles(repo, 'main', 'lane/wizard'), [
      'src/checkout/Wizard.tsx',
      'src/pricing/quote.ts'
    ]);
  });

  it('does not charge a lane for files that moved on main while it worked', async () => {
    const repo = await fixture();
    await ensureBranch(repo, 'lane/wizard', 'main');
    await checkout(repo, 'lane/wizard');
    await write(repo, 'src/checkout/Wizard.tsx', 'lane work\n');
    await commit(repo, 'wizard work');

    await checkout(repo, 'main');
    await write(repo, 'docs/unrelated.md', 'someone else, elsewhere\n');
    await commit(repo, 'unrelated');

    assert.deepEqual(
      await changedFiles(repo, 'main', 'lane/wizard'),
      ['src/checkout/Wizard.tsx'],
      'the merge base is what matters, not a straight two-dot diff'
    );
  });

  it('sees work that has not been committed yet', async () => {
    const repo = await fixture();
    await write(repo, 'src/checkout/Step2.tsx', 'half done\n');
    assert.deepEqual(await uncommittedFiles(repo), ['src/checkout/Step2.tsx']);
  });
});

describe('merging', () => {
  it('lands a clean lane and reports the new head', async () => {
    const repo = await fixture();
    await ensureBranch(repo, 'lane/wizard', 'main');
    await checkout(repo, 'lane/wizard');
    await write(repo, 'src/checkout/Wizard.tsx', 'wizard\n');
    await commit(repo, 'wizard');
    await checkout(repo, 'main');

    assert.equal(await mergesCleanly(repo, 'lane/wizard', 'main'), true);
    const outcome = await mergeBranch(repo, 'lane/wizard', 'main', 'land wizard');
    assert.equal(outcome.merged, true);
    assert.deepEqual(outcome.conflicts, []);
    assert.ok(outcome.head);
    assert.equal(await currentBranch(repo), 'main');
  });

  it('refuses a conflict and leaves the target branch untouched', async () => {
    const repo = await fixture();
    await ensureBranch(repo, 'lane/wizard', 'main');
    await checkout(repo, 'lane/wizard');
    await write(repo, 'src/shared.ts', 'lane version\n');
    await commit(repo, 'lane edit');

    await checkout(repo, 'main');
    await write(repo, 'src/shared.ts', 'main version\n');
    await commit(repo, 'main edit');
    const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

    assert.equal(await mergesCleanly(repo, 'lane/wizard', 'main'), false);
    const outcome = await mergeBranch(repo, 'lane/wizard', 'main', 'land wizard');

    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflicts, ['src/shared.ts']);
    assert.equal(
      (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(),
      headBefore,
      'a room may be red, but main must never be left ambiguous'
    );
  });

  it('puts you back on the branch you started from', async () => {
    const repo = await fixture();
    await ensureBranch(repo, 'lane/wizard', 'main');
    await checkout(repo, 'lane/wizard');
    await write(repo, 'a.txt', 'a\n');
    await commit(repo, 'a');
    await mergeBranch(repo, 'lane/wizard', 'main', 'land');
    assert.equal(await currentBranch(repo), 'lane/wizard');
  });
});
