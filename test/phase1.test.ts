import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openRoom } from '../src/index.ts';
import { MergeGate } from '../src/gate/gate.ts';
import { checkout, git, openRepo } from '../src/git/repo.ts';
import type { Repo } from '../src/git/repo.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * Phase 1's acceptance test.
 *
 * "Two agents build one feature across a real contract, and the gate refuses a
 * lane violation neither agent admitted to."
 *
 * Real git, real room, two agents. The violation is deliberate and quiet: one
 * agent edits a file in the other's lane, never claims it, and leaves it out of
 * its own report. Only the diff knows.
 */

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function write(repo: Repo, path: string, body: string): Promise<void> {
  const full = join(repo.root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

/** Switch first, then write — otherwise git refuses to leave the branch. */
async function workOn(
  repo: Repo,
  branch: string,
  files: Record<string, string>,
  message: string
): Promise<void> {
  await checkout(repo, branch);
  for (const [path, body] of Object.entries(files)) await write(repo, path, body);
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', message]);
}

async function project(): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-phase1-'));
  scratch.push(dir);
  const repo = openRepo(dir);
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@agora.invalid']);
  await git(repo, ['config', 'user.name', 'Agora Test']);
  await write(repo, 'README.md', 'checkout\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  return repo;
}

interface Stage {
  repo: Repo;
  service: RoomService;
  gate: MergeGate;
  wizard: string;
  pricing: string;
  seamId: string;
}

/** A room with an approved two-lane split, one contract, and branches cut. */
async function stage(): Promise<Stage> {
  const repo = await project();
  const service = await openRoom({
    file: null,
    name: 'Checkout rebuild',
    goal: 'Replace checkout with a three-step wizard.'
  });
  await service.addAgent({ id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' });
  await service.addAgent({ id: 'cursor', displayName: 'Cursor', provider: 'cursor', role: 'peer' });

  await service.claimTask('claude', { taskId: 'plan' });
  await service.submitWork('claude', {
    taskId: 'plan',
    summary: 'Two lanes meeting at the quote object.',
    outcome: 'needs-review',
    plan: {
      summary: 'Claude takes the wizard, Cursor the pricing engine.',
      tasks: [
        {
          key: 'wizard',
          title: 'Checkout wizard',
          paths: ['src/checkout/**'],
          suggestedOwner: 'claude',
          evidence: 'The three-step flow completes for a known cart.',
          actionBudget: 40
        },
        {
          key: 'pricing',
          title: 'Quote engine',
          paths: ['src/pricing/**'],
          suggestedOwner: 'cursor',
          evidence: 'The quote for a known cart equals 4250 minor units.',
          actionBudget: 40
        }
      ],
      seams: [
        {
          title: 'The quote object',
          body: 'getQuote(cart) resolves to {subtotal, tax, total} as integers in minor units.',
          between: ['wizard', 'pricing'],
          contract: [
            { task: 'wizard', provides: 'A cart of {sku, qty}.', expects: 'Integers, minor units.' },
            { task: 'pricing', provides: 'Integers, minor units.', expects: 'A cart of {sku, qty}.' }
          ]
        }
      ]
    }
  });
  await service.approvePlan('Good split.');

  const room = service.snapshot();
  const wizard = room.tasks.find((t) => t.title === 'Checkout wizard')?.id as string;
  const pricing = room.tasks.find((t) => t.title === 'Quote engine')?.id as string;
  const seamId = room.decisions.find((d) => d.kind === 'seam')?.id as string;

  await service.claimTask('claude', { taskId: wizard });
  await service.claimTask('cursor', { taskId: pricing });

  const gate = new MergeGate(service, { repo, baseBranch: 'main' });
  await gate.openLane(wizard);
  await gate.openLane(pricing);

  return { repo, service, gate, wizard, pricing, seamId };
}

/** Does the honest half of a lane's work: claim, write, commit, submit, prove. */
async function doLaneWork(
  s: Stage,
  agent: string,
  laneId: string,
  files: Record<string, string>,
  evidenceNote: string
): Promise<void> {
  for (const path of Object.keys(files)) {
    await s.service.claimFile(agent, { path, laneId });
  }
  await workOn(s.repo, `agora/${laneId}`, files, `${laneId} work`);
  await s.service.submitWork(agent, {
    taskId: laneId,
    summary: `${laneId} done.`,
    outcome: 'complete',
    filesChanged: Object.keys(files),
    seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Integers, minor units.' }]
  });
  await s.service.produceEvidence(agent, { taskId: laneId, note: evidenceNote });
}

describe('Phase 1 — the gate refuses what nobody admitted to', () => {
  it('catches a file edited in another lane, never claimed, never declared', async () => {
    const s = await stage();

    // Cursor does its lane honestly.
    await doLaneWork(s, 'cursor', s.pricing, {
      'src/pricing/quote.ts': 'export const quote = () => 4250;\n'
    }, 'quote(knownCart) === 4250.');

    // Claude does its own lane honestly...
    await s.service.claimFile('claude', { path: 'src/checkout/Wizard.tsx', laneId: s.wizard });

    // ...and in the same commit quietly reaches into Cursor's lane. No claim was
    // ever asked for, and it will not appear in Claude's own report.
    await workOn(
      s.repo,
      `agora/${s.wizard}`,
      {
        'src/checkout/Wizard.tsx': 'export const Wizard = () => null;\n',
        'src/pricing/quote.ts': 'export const quote = () => 9999;\n'
      },
      'wizard work'
    );

    await s.service.submitWork('claude', {
      taskId: s.wizard,
      summary: 'Wizard done.',
      outcome: 'complete',
      filesChanged: ['src/checkout/Wizard.tsx'], // the stray file is not mentioned
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Sends {sku, qty}.' }]
    });
    await s.service.produceEvidence('claude', { taskId: s.wizard, note: 'Flow completes.' });

    const decision = await s.gate.evaluate(s.wizard);

    assert.equal(decision.verdict, 'refuse');
    const foreign = decision.reasons.find((r) => r.code === 'foreign-files');
    assert.ok(foreign, 'the gate must catch a file held by the other lane');
    assert.deepEqual(foreign.paths, ['src/pricing/quote.ts']);
    assert.match(foreign.detail, /cursor/);
    assert.deepEqual(
      decision.undeclared,
      ['src/pricing/quote.ts'],
      'and names it as something the agent did not report'
    );

    // Nothing landed.
    const landing = await s.gate.land(s.wizard);
    assert.equal(landing.verdict, 'refuse');
    assert.deepEqual(landing.landed, []);
  });

  it('lands both lanes together once the violation is undone', async () => {
    const s = await stage();

    await doLaneWork(s, 'cursor', s.pricing, {
      'src/pricing/quote.ts': 'export const quote = () => 4250;\n'
    }, 'quote(knownCart) === 4250.');

    await s.service.claimFile('claude', { path: 'src/checkout/Wizard.tsx', laneId: s.wizard });
    await workOn(
      s.repo,
      `agora/${s.wizard}`,
      { 'src/checkout/Wizard.tsx': 'export const Wizard = () => null;\n' },
      'wizard work'
    );
    await s.service.submitWork('claude', {
      taskId: s.wizard,
      summary: 'Wizard done.',
      outcome: 'complete',
      filesChanged: ['src/checkout/Wizard.tsx'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Sends {sku, qty}.' }]
    });
    await s.service.produceEvidence('claude', { taskId: s.wizard, note: 'Flow completes.' });

    const landing = await s.gate.land(s.wizard);
    assert.equal(landing.verdict, 'merge');
    assert.deepEqual(
      landing.landed.sort(),
      [s.pricing, s.wizard].sort(),
      'lanes sharing a contract land as a set'
    );

    await checkout(s.repo, 'main');
    const { stdout } = await git(s.repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
    const landed = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.ok(landed.includes('src/checkout/Wizard.tsx'));
    assert.ok(landed.includes('src/pricing/quote.ts'));
  });

  it('waits rather than landing half a contract', async () => {
    const s = await stage();

    // Only the wizard side is finished.
    await s.service.claimFile('claude', { path: 'src/checkout/Wizard.tsx', laneId: s.wizard });
    await workOn(
      s.repo,
      `agora/${s.wizard}`,
      { 'src/checkout/Wizard.tsx': 'export const Wizard = () => null;\n' },
      'wizard work'
    );
    await s.service.submitWork('claude', {
      taskId: s.wizard,
      summary: 'Wizard done.',
      outcome: 'complete',
      filesChanged: ['src/checkout/Wizard.tsx'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Sends {sku, qty}.' }]
    });
    await s.service.produceEvidence('claude', { taskId: s.wizard, note: 'Flow completes.' });

    const decision = await s.gate.evaluate(s.wizard);
    assert.equal(decision.verdict, 'wait');
    assert.equal(decision.reasons[0]?.code, 'seam-mate-not-ready');

    const landing = await s.gate.land(s.wizard);
    assert.deepEqual(landing.landed, [], 'a contract half-kept is worse than one that waits');
  });

  it('refuses a lane that never showed its evidence', async () => {
    const s = await stage();
    await s.service.claimFile('claude', { path: 'src/checkout/Wizard.tsx', laneId: s.wizard });
    await workOn(
      s.repo,
      `agora/${s.wizard}`,
      { 'src/checkout/Wizard.tsx': 'export const Wizard = () => null;\n' },
      'wizard work'
    );
    await s.service.submitWork('claude', {
      taskId: s.wizard,
      summary: 'Wizard done.',
      outcome: 'complete',
      filesChanged: ['src/checkout/Wizard.tsx'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Sends {sku, qty}.' }]
    });
    // No produceEvidence call.

    const decision = await s.gate.evaluate(s.wizard);
    assert.equal(decision.verdict, 'refuse');
    const missing = decision.reasons.find((r) => r.code === 'evidence-missing');
    assert.ok(missing);
    assert.match(missing.detail, /three-step flow completes/);
  });
});

describe('Phase 1 — moving a contract takes the work with it', () => {
  it('makes a signed lane stale, wakes its owner, and stops it at the gate', async () => {
    const s = await stage();

    await doLaneWork(s, 'cursor', s.pricing, {
      'src/pricing/quote.ts': 'export const quote = () => 4250;\n'
    }, 'quote(knownCart) === 4250.');
    await doLaneWork(s, 'claude', s.wizard, {
      'src/checkout/Wizard.tsx': 'export const Wizard = () => null;\n'
    }, 'Flow completes.');

    assert.equal((await s.gate.evaluate(s.wizard)).verdict, 'merge', 'clear before the amendment');

    const woken: string[][] = [];
    s.service.events().subscribe((event) => {
      if (event.type === 'seam.amended') woken.push(event.audience);
    });

    const amended = await s.service.amendSeam(s.seamId, {
      body: 'getQuote(cart) resolves to {subtotal, tax, total, currency}. Currency is required.'
    });

    assert.deepEqual(amended.stale.sort(), [s.pricing, s.wizard].sort());
    assert.deepEqual(woken[0]?.sort(), ['claude', 'cursor'], 'both owners are told at once');

    const decision = await s.gate.evaluate(s.wizard);
    assert.equal(decision.verdict, 'refuse');
    const stale = decision.reasons.find((r) => r.code === 'seam-stale');
    assert.ok(stale, 'a signature against the old version is worthless');
    assert.match(stale.detail, /v2 after this lane signed v1/);

    // Re-confirming against the new version clears it.
    await s.service.reopenTask(s.wizard, true);
    await s.service.submitWork('claude', {
      taskId: s.wizard,
      summary: 'Re-read the contract; currency added.',
      outcome: 'complete',
      filesChanged: ['src/checkout/Wizard.tsx'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Reads currency now.' }]
    });
    assert.equal(
      (await s.gate.evaluate(s.wizard)).reasons.find((r) => r.code === 'seam-stale'),
      undefined
    );
  });
});
