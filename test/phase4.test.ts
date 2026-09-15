import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openRoom } from '../src/index.ts';
import { MergeGate } from '../src/gate/gate.ts';
import { checkout, git, openRepo } from '../src/git/repo.ts';
import type { Repo } from '../src/git/repo.ts';
import { unanswered } from '../src/room/attention.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * Phase 4's acceptance test.
 *
 * "A front-end and a back-end repo ship one contract together, and the failure
 * case is loud rather than half-landed and quiet."
 *
 * Two real repositories, one real contract. The first half of this is the easy
 * half: put the endpoint in before the page that calls it, and both sides ship.
 *
 * The second half is the one that matters. Two merges into two repositories
 * cannot be atomic. No design makes them so. The only question a system like
 * this gets to answer is what happens when the second merge does not take — and
 * the answer has to be that everybody knows immediately, not that the room
 * quietly carries on with production disagreeing with itself.
 *
 * So the failure is arranged deliberately: somebody lands something else on the
 * web repository's main branch while the lane is out, and the lane no longer
 * merges. The API is already in. That is the worst state this system can
 * produce, and every assertion below is about it being impossible to miss.
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

async function project(label: string, seed: Record<string, string>): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), `agora-phase4-${label}-`));
  scratch.push(dir);
  const repo = openRepo(dir);
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@agora.invalid']);
  await git(repo, ['config', 'user.name', 'Agora Test']);
  for (const [path, body] of Object.entries(seed)) await write(repo, path, body);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  return repo;
}

interface Stage {
  web: Repo;
  api: Repo;
  service: RoomService;
  gate: MergeGate;
  page: string;
  endpoint: string;
  seamId: string;
}

const PAGE_FILE = 'src/checkout/Page.tsx';
const ENDPOINT_FILE = 'routes/quote.ts';

/** Two repositories, one contract, both halves finished and cross-reviewed. */
async function twoRepos(): Promise<Stage> {
  const web = await project('web', { [PAGE_FILE]: 'export const Page = () => null;\n' });
  const api = await project('api', { [ENDPOINT_FILE]: 'export const quote = () => 0;\n' });

  const service = await openRoom({
    file: null,
    name: 'Checkout across two repos',
    goal: 'Move checkout onto the new quote endpoint.',
    repos: [
      { id: 'web', name: 'web', root: web.root, baseBranch: 'main' },
      { id: 'api', name: 'api', root: api.root, baseBranch: 'main' }
    ]
  });
  await service.setRiskList(OWNER_ID, []);
  await service.addAgent(OWNER_ID, { id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' });
  await service.addAgent(OWNER_ID, { id: 'cursor', displayName: 'Cursor', provider: 'cursor', role: 'peer' });

  await service.claimTask('claude', { taskId: 'plan' });
  await service.submitWork('claude', {
    taskId: 'plan',
    summary: 'The page and the endpoint it calls, in two repositories.',
    outcome: 'needs-review',
    plan: {
      summary: 'Claude takes the page, Cursor the endpoint.',
      tasks: [
        {
          key: 'checkout',
          title: 'Checkout page',
          repo: 'web',
          paths: ['src/checkout/**'],
          suggestedOwner: 'claude',
          evidence: 'The page completes a checkout against the live endpoint.',
          actionBudget: 60
        },
        {
          key: 'quote',
          title: 'Quote endpoint',
          repo: 'api',
          paths: ['routes/**'],
          suggestedOwner: 'cursor',
          evidence: 'POST /quote returns 4250 for a known cart.',
          actionBudget: 60
        }
      ],
      seams: [
        {
          title: 'POST /quote',
          body: 'Request {items}. Response 200 {subtotal, tax, total} as integers in minor units.',
          between: ['checkout', 'quote'],
          // The page calls the endpoint. Ship the page first and it calls
          // something that is not there yet.
          landFirst: 'quote',
          contract: [
            { task: 'checkout', provides: 'A cart of {sku, qty}.', expects: 'Integers, minor units.' },
            { task: 'quote', provides: 'Integers, minor units.', expects: 'A cart of {sku, qty}.' }
          ]
        }
      ]
    }
  });
  await service.approvePlan(OWNER_ID, 'Endpoint first, then the page.');

  const room = service.snapshot();
  const page = room.tasks.find((task) => task.title === 'Checkout page')?.id as string;
  const endpoint = room.tasks.find((task) => task.title === 'Quote endpoint')?.id as string;
  const seamId = room.decisions.find((decision) => decision.kind === 'seam')?.id as string;

  await service.claimTask('claude', { taskId: page });
  await service.claimTask('cursor', { taskId: endpoint });

  const gate = new MergeGate(service);
  await gate.openLane(page);
  await gate.openLane(endpoint);

  // Both sides do their half, honestly, in their own repository.
  await service.claimFile('cursor', { path: ENDPOINT_FILE, laneId: endpoint });
  await workOn(
    api,
    `agora/${endpoint}`,
    { [ENDPOINT_FILE]: 'export const quote = () => ({ subtotal: 4000, tax: 250, total: 4250 });\n' },
    'quote endpoint'
  );
  await service.submitWork('cursor', {
    taskId: endpoint,
    summary: 'Returns integers in minor units.',
    outcome: 'complete',
    filesChanged: [ENDPOINT_FILE],
    seamChecks: [{ decisionId: seamId, satisfied: true, note: 'Integers, minor units.' }]
  });
  await service.produceEvidence('cursor', { taskId: endpoint, note: 'quote(knownCart).total === 4250.' });

  await service.claimFile('claude', { path: PAGE_FILE, laneId: page });
  await workOn(
    web,
    `agora/${page}`,
    { [PAGE_FILE]: 'export const Page = () => fetch("/quote");\n' },
    'checkout page'
  );
  await service.submitWork('claude', {
    taskId: page,
    summary: 'Calls POST /quote and renders the total.',
    outcome: 'complete',
    filesChanged: [PAGE_FILE],
    seamChecks: [{ decisionId: seamId, satisfied: true, note: 'Sends {items}, reads integers.' }]
  });
  await service.produceEvidence('claude', { taskId: page, note: 'Checkout completes end to end.' });

  await service.reviewLane('claude', {
    laneId: endpoint,
    verdict: 'holds',
    note: 'Integers in minor units, as agreed.'
  });
  await service.reviewLane('cursor', {
    laneId: page,
    verdict: 'holds',
    note: 'Sends the body the contract describes.'
  });

  return { web, api, service, gate, page, endpoint, seamId };
}

async function filesOn(repo: Repo, branch: string): Promise<string> {
  const { stdout } = await git(repo, ['show', `${branch}:${PAGE_FILE}`]).catch(async () =>
    git(repo, ['show', `${branch}:${ENDPOINT_FILE}`])
  );
  return stdout;
}

describe('Phase 4 — two repositories, one contract', () => {
  it('says what it is about to do, in order, before it does any of it', async () => {
    const s = await twoRepos();
    const plan = s.gate.landingPlan(s.page);

    assert.equal(plan.atomic, false);
    assert.deepEqual(
      plan.steps.map((step) => step.laneId),
      [s.endpoint, s.page],
      'the contract decides the order — "checkout" sorts first alphabetically and still goes second'
    );
    assert.deepEqual(plan.steps.map((step) => step.repoId), ['api', 'web']);
    assert.match(plan.steps[1]?.because ?? '', /would be broken without it/);

    // The cost of not being atomic, said out loud rather than discovered.
    assert.equal(plan.windows.length, 1);
    assert.match(plan.windows[0] as string, /api is on the new POST \/quote and web is not/);
    assert.match(plan.summary, /cannot be atomic, and Agora will not pretend they are/);
  });

  it('ships both halves, in the order the contract asked for', async () => {
    const s = await twoRepos();
    const outcome = await s.gate.land(s.page);

    assert.equal(outcome.verdict, 'merge', outcome.summary);
    assert.equal(outcome.partial, false);
    assert.deepEqual(outcome.landed, [s.endpoint, s.page], 'the endpoint goes in first');

    // Both repositories actually have it, checked against git rather than the room.
    assert.match(await filesOn(s.api, 'main'), /total: 4250/);
    assert.match(await filesOn(s.web, 'main'), /fetch\("\/quote"\)/);
    assert.equal(s.service.snapshot().status, 'open');
    assert.equal(s.service.snapshot().partialLanding, null);
  });

  it('holds both halves back when either one is not ready', async () => {
    const s = await twoRepos();
    // The endpoint side goes back for more work, so nothing should move.
    await s.service.reopenTask(OWNER_ID, s.endpoint, true);

    const outcome = await s.gate.land(s.page);
    assert.notEqual(outcome.verdict, 'merge');
    assert.deepEqual(outcome.landed, []);
    assert.equal(outcome.partial, false, 'nothing went in, so nothing is half in');
    await assert.rejects(() => filesOn(s.api, 'main').then((body) => assert.match(body, /4250/)));
  });
});

describe('Phase 4 — the failure case is loud', () => {
  /**
   * The race that makes a half-landing real.
   *
   * The gate checks that every branch merges cleanly before it starts, so a
   * conflict it can see coming stops everything and nothing goes in — which is
   * the other test above. The dangerous case is the one it cannot see: it
   * checks, starts, lands the API, and while it is doing that somebody pushes
   * to the web repository's main branch. Now the second merge fails and the
   * first is already in. That is arranged here on purpose.
   */
  async function halfLanded(): Promise<Stage & { outcome: Awaited<ReturnType<MergeGate['land']>> }> {
    const base = await twoRepos();
    let raced = false;
    const s: Stage = {
      ...base,
      gate: new MergeGate(base.service, {
        onStep: async (step) => {
          // Once. A resume later must find the world as the race left it, not
          // get raced a second time.
          if (step.repoId !== 'web' || raced) return;
          raced = true;
          // Between the first merge and the second, someone else ships.
          await workOn(
            base.web,
            'main',
            { [PAGE_FILE]: 'export const Page = () => "something else entirely";\n' },
            'unrelated work on main, mid-landing'
          );
        }
      })
    };

    const outcome = await s.gate.land(s.page);
    return { ...s, outcome };
  }

  it('gets the first half in and stops, rather than carrying on', async () => {
    const s = await halfLanded();

    assert.equal(s.outcome.partial, true);
    assert.deepEqual(s.outcome.landed, [s.endpoint]);
    assert.equal(s.outcome.verdict, 'refuse');
    assert.match(s.outcome.summary, /The room is red/);
    assert.match(s.outcome.summary, /Two repositories now disagree about a contract/);

    assert.match(await filesOn(s.api, 'main'), /total: 4250/, 'the API really did take it');
    assert.doesNotMatch(await filesOn(s.web, 'main'), /fetch\("\/quote"\)/, 'and the web really did not');
  });

  it('turns the room red and keeps it red', async () => {
    const s = await halfLanded();
    const room = s.service.snapshot();

    assert.equal(room.status, 'red');
    assert.ok(room.partialLanding !== null);
    assert.deepEqual(room.partialLanding.landed.map((step) => step.repoId), ['api']);
    assert.deepEqual(room.partialLanding.pending.map((step) => step.repoId), ['web']);
    assert.ok(room.partialLanding.conflicts.includes(PAGE_FILE));
  });

  it('puts it in front of a person who can actually fix it', async () => {
    const s = await halfLanded();
    const item = unanswered(s.service.snapshot().attention).find((entry) =>
      entry.title.startsWith('Half-landed')
    );

    assert.ok(item, 'a half-landed contract nobody is told about is the worst thing this can do');
    assert.equal(item.needsMergeRights, true);
    assert.match(item.detail, /api has this change and web does not/);
    assert.match(item.detail, /disagree in production/);
    assert.deepEqual(item.options.map((option) => option.id), ['finish', 'roll-back', 'leave-it']);
    assert.ok(
      item.options.every((option) => option.effect.trim().length > 0),
      'each answer says what it will actually do'
    );
  });

  it('says it in the log, the ledger and the room status — three places, not one', async () => {
    const s = await halfLanded();

    const event = s.service.snapshot().events.find((entry) => entry.type === 'landing.partial');
    assert.ok(event);
    assert.match(event.summary, /The room is red/);

    const row = s.service.ledger().find((entry) => entry.laneId === s.page);
    assert.equal(row?.health, 'needs-a-person');

    assert.equal(s.service.snapshot().status, 'red');
  });

  it('will not let the room close while the halves disagree', async () => {
    const s = await halfLanded();
    const readiness = s.service.closeReadiness([s.endpoint, s.page]);
    assert.equal(readiness.ready, false);
    assert.ok(
      readiness.blockers.some((blocker) => blocker.kind === 'question-open'),
      'a room cannot be finished while production is inconsistent'
    );
  });

  it('finishes the landing once the conflict is resolved', async () => {
    const s = await halfLanded();

    // The lane merges main in and resolves it, which is the normal fix.
    await checkout(s.web, `agora/${s.page}`);
    await git(s.web, ['merge', '-X', 'ours', '--no-edit', 'main']).catch(async () => {
      await git(s.web, ['merge', '--abort']).catch(() => undefined);
    });

    const outcome = await s.gate.resume();
    assert.ok(outcome !== null);
    assert.equal(outcome.verdict, 'merge', outcome.summary);
    assert.match(await filesOn(s.web, 'main'), /fetch\("\/quote"\)/);

    await s.service.clearPartialLanding(OWNER_ID, { how: 'finished' });
    const room = s.service.snapshot();
    assert.equal(room.status, 'open');
    assert.equal(room.partialLanding, null);
    assert.deepEqual(unanswered(room.attention), [], 'and the red question goes with it');
  });

  it('can put the landed half back instead, with a revert rather than a rewrite', async () => {
    const s = await halfLanded();
    const before = await git(s.api, ['rev-parse', 'main']);

    const outcome = await s.gate.rollback(OWNER_ID);
    assert.deepEqual(outcome.reverted, ['api']);
    assert.deepEqual(outcome.failed, []);

    // The endpoint is gone from main...
    assert.doesNotMatch(await filesOn(s.api, 'main'), /total: 4250/);
    // ...but the history it was in is still there. Nobody's checkout broke.
    const after = await git(s.api, ['rev-parse', 'main']);
    assert.notEqual(before.stdout.trim(), after.stdout.trim());
    const { stdout: log } = await git(s.api, ['log', '--oneline', 'main']);
    assert.match(log, /Revert/);

    const room = s.service.snapshot();
    assert.equal(room.status, 'open', 'nothing shipped half, so the room is not red any more');
    assert.equal(room.partialLanding, null);
    const settled = room.attention.find((item) => item.title.startsWith('Half-landed'));
    assert.match(settled?.resolution ?? '', /Rolled back/);
  });

  it('never leaves a repository half-merged, whatever else happens', async () => {
    const s = await halfLanded();
    // The gate aborts a conflicted merge rather than leaving it staged. A room
    // can be red; a base branch cannot be ambiguous.
    const { stdout } = await git(s.web, ['status', '--porcelain']);
    assert.equal(stdout.trim(), '', 'the web repository is clean, not mid-merge');
  });
});
