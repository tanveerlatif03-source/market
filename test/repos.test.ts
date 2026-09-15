import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contractsMissingOrder,
  landingPlan,
  orderLanes,
  partialLandingSummary,
  spansRepos
} from '../src/room/repos.ts';
import type { PartialLanding } from '../src/room/repos.ts';
import { openRoom } from '../src/index.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal } from './helpers.ts';
import type { Room } from '../src/types.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * Rooms that span repositories (Q17).
 *
 * The thing under test is a refusal to pretend. Two merges into two
 * repositories are not atomic. What Agora offers instead is an order, a stated
 * window of inconsistency, and a failure that is loud.
 */

const TWO_REPO_PLAN = {
  summary: 'The page and the endpoint it calls, in two repositories.',
  tasks: [
    {
      key: 'checkout',
      title: 'Checkout page',
      repo: 'web',
      paths: ['src/checkout/**'],
      evidence: 'The page completes a checkout against the live endpoint.'
    },
    {
      key: 'quote',
      title: 'Quote endpoint',
      repo: 'api',
      paths: ['routes/quote/**'],
      evidence: 'POST /quote returns integers in minor units for a known cart.'
    }
  ],
  seams: [
    {
      title: 'POST /quote',
      body: 'Request {items}. Response 200 {subtotal, tax, total} as integers in minor units.',
      between: ['checkout', 'quote'] as [string, string],
      landFirst: 'quote',
      contract: [
        { task: 'checkout', provides: 'A cart of {sku, qty}.', expects: 'Integers, minor units.' },
        { task: 'quote', provides: 'Integers, minor units.', expects: 'A cart of {sku, qty}.' }
      ]
    }
  ]
};

async function twoRepoRoom(options: { landFirst?: string | undefined } = {}): Promise<{
  service: RoomService;
  page: string;
  endpoint: string;
  seamId: string;
}> {
  const service = await openRoom({
    file: null,
    name: 'Checkout',
    goal: 'Ship checkout across the web app and the API.',
    repos: [
      { id: 'web', name: 'web', root: '/tmp/agora-web', baseBranch: 'main' },
      { id: 'api', name: 'api', root: '/tmp/agora-api', baseBranch: 'main' }
    ]
  });
  await service.addAgent(OWNER_ID, { id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' });
  await service.addAgent(OWNER_ID, { id: 'cursor', displayName: 'Cursor', provider: 'cursor', role: 'peer' });
  await service.claimTask('claude', { taskId: 'plan' });

  const seam = { ...TWO_REPO_PLAN.seams[0] } as (typeof TWO_REPO_PLAN.seams)[0];
  if ('landFirst' in options) {
    if (options.landFirst === undefined) delete (seam as { landFirst?: string }).landFirst;
    else seam.landFirst = options.landFirst;
  }

  await service.submitWork('claude', {
    taskId: 'plan',
    summary: 'Two repositories, one contract.',
    outcome: 'needs-review',
    plan: { ...TWO_REPO_PLAN, seams: [seam] }
  });

  const room = service.snapshot();
  const page = room.tasks.find((task) => task.title === 'Checkout page')?.id as string;
  const endpoint = room.tasks.find((task) => task.title === 'Quote endpoint')?.id as string;
  const seamId = room.decisions.find((decision) => decision.kind === 'seam')?.id as string;
  return { service, page, endpoint, seamId };
}

function planFor(room: Room, laneId: string, set: string[]): ReturnType<typeof landingPlan> {
  return landingPlan({
    room,
    laneId,
    set,
    branchForLane: (id) => `agora/${id}`,
    repoFor: (id) => {
      const task = room.tasks.find((candidate) => candidate.id === id);
      const repo = room.repos.find((candidate) => candidate.id === task?.repoId) ?? room.repos[0];
      return repo === undefined
        ? undefined
        : { id: repo.id, name: repo.name, baseBranch: repo.baseBranch };
    }
  });
}

describe('a room that spans repositories', () => {
  it('puts each lane in the repository the plan named', async () => {
    const room = await twoRepoRoom();
    const snapshot = room.service.snapshot();
    assert.equal(snapshot.tasks.find((task) => task.id === room.page)?.repoId, 'web');
    assert.equal(snapshot.tasks.find((task) => task.id === room.endpoint)?.repoId, 'api');
    assert.equal(spansRepos(snapshot, room.page, room.endpoint), true);
  });

  it('refuses a lane in a repository nobody added', async () => {
    const service = await openRoom({
      file: null,
      name: 'One repo',
      goal: 'Ship it.',
      repos: [{ id: 'web', name: 'web', root: '/tmp/agora-web', baseBranch: 'main' }]
    });
    await service.addAgent(OWNER_ID, { id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' });
    await service.claimTask('claude', { taskId: 'plan' });
    const error = await refusal(
      () =>
        service.submitWork('claude', {
          taskId: 'plan',
          summary: 'One lane.',
          outcome: 'needs-review',
          plan: {
            tasks: [{ key: 'a', title: 'A', repo: 'mobile', paths: ['src/**'], evidence: 'It runs.' }],
            seams: []
          }
        }),
      'NOT_FOUND'
    );
    assert.match(error.remedy, /Known repositories: web/);
  });

  it('leaves a one-repo room exactly as it was', async () => {
    const service = await openRoom({ file: null, name: 'Solo', goal: 'Ship it.' });
    assert.deepEqual(service.repos(), []);
    assert.deepEqual(contractsMissingOrder(service.snapshot()), []);
  });
});

describe('a contract that cannot land atomically', () => {
  it('refuses a plan that never said which side goes first', async () => {
    const room = await twoRepoRoom({ landFirst: undefined });
    const error = await refusal(() => room.service.approvePlan(OWNER_ID, 'Looks fine'), 'INVALID');
    assert.match(error.message, /without saying which side lands first/);
    assert.match(error.remedy, /cannot be merged atomically/);
    assert.equal(room.service.snapshot().plan.status, 'proposed');
  });

  it('approves the same plan once it does', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    assert.equal(room.service.snapshot().plan.status, 'approved');
  });

  it('says nothing about a contract whose sides share a repository', async () => {
    const service = await openRoom({
      file: null,
      name: 'One repo',
      goal: 'Ship it.',
      repos: [{ id: 'web', name: 'web', root: '/tmp/agora-web', baseBranch: 'main' }]
    });
    await service.addAgent(OWNER_ID, { id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' });
    await service.claimTask('claude', { taskId: 'plan' });
    await service.submitWork('claude', {
      taskId: 'plan',
      summary: 'Two lanes, one repo.',
      outcome: 'needs-review',
      plan: {
        tasks: [
          { key: 'a', title: 'A', repo: 'web', paths: ['src/a/**'], evidence: 'A works.' },
          { key: 'b', title: 'B', repo: 'web', paths: ['src/b/**'], evidence: 'B works.' }
        ],
        seams: [
          {
            title: 'A to B',
            body: 'Shape.',
            between: ['a', 'b'],
            contract: [
              { task: 'a', provides: 'x', expects: 'y' },
              { task: 'b', provides: 'y', expects: 'x' }
            ]
          }
        ]
      }
    });
    assert.deepEqual(contractsMissingOrder(service.snapshot()), []);
    await service.approvePlan(OWNER_ID, 'Fine.');
  });
});

describe('the order', () => {
  it('puts the side the other would be broken without first', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    const { order, cycle } = orderLanes(room.service.snapshot(), [room.page, room.endpoint]);
    assert.equal(cycle, null);
    assert.deepEqual(
      order,
      [room.endpoint, room.page],
      '"checkout" sorts before "quote", so this can only be the contract talking'
    );
  });

  it('is stable when nothing depends on anything', async () => {
    const service = await openRoom({ file: null, name: 'x', goal: 'y' });
    const room = service.snapshot();
    assert.deepEqual(orderLanes(room, ['zebra', 'apple']).order, ['apple', 'zebra']);
  });

  it('says so rather than guessing when two sides each need the other first', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    const snapshot = structuredClone(room.service.snapshot());
    // A second contract pointing the other way. No order satisfies both.
    snapshot.decisions.push({
      id: 'dec_back',
      kind: 'seam',
      title: 'The other way',
      body: 'x',
      seam: {
        betweenTasks: [room.endpoint, room.page],
        landFirst: room.page,
        contract: []
      },
      proposedBy: 'claude',
      createdAt: '2026-09-15T12:00:00.000Z',
      version: 1
    });
    const { cycle } = orderLanes(snapshot, [room.page, room.endpoint]);
    assert.deepEqual(cycle?.sort(), [room.endpoint, room.page].sort());
  });
});

describe('the blast radius, stated before anything moves', () => {
  it('lists the merges in order, with why each one is there', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    const plan = planFor(room.service.snapshot(), room.page, [room.page, room.endpoint]);

    assert.equal(plan.atomic, false);
    assert.deepEqual(plan.steps.map((step) => step.laneId), [room.endpoint, room.page]);
    assert.deepEqual(plan.steps.map((step) => step.repoId), ['api', 'web']);
    assert.match(plan.steps[1]?.because ?? '', /would be broken without it/);
  });

  it('spells out the window where the repositories disagree', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    const plan = planFor(room.service.snapshot(), room.page, [room.page, room.endpoint]);

    assert.equal(plan.windows.length, 1);
    assert.match(plan.windows[0] as string, /api is on the new POST \/quote and web is not/);
    assert.match(plan.windows[0] as string, /Nothing rolls this back for you/);
  });

  it('refuses to call a cross-repo landing atomic', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    const plan = planFor(room.service.snapshot(), room.page, [room.page, room.endpoint]);
    assert.match(plan.summary, /cannot be atomic, and Agora will not pretend/);
  });

  it('says nothing about windows when it really is one merge set', async () => {
    const service = await openRoom({
      file: null,
      name: 'Solo',
      goal: 'Ship it.',
      repos: [{ id: 'web', name: 'web', root: '/tmp/agora-web', baseBranch: 'main' }]
    });
    const plan = planFor(service.snapshot(), 'a', ['a']);
    assert.equal(plan.atomic, true);
    assert.deepEqual(plan.windows, []);
    assert.match(plan.summary, /one merge set, or not at all/);
  });
});

describe('when it goes half in', () => {
  const partial: PartialLanding = {
    laneId: 'page',
    landed: [{ laneId: 'endpoint', repoId: 'api', head: 'abc123' }],
    pending: [{ laneId: 'page', repoId: 'web' }],
    reason: '"page" would not merge into web: src/checkout/Page.tsx.',
    conflicts: ['src/checkout/Page.tsx'],
    at: '2026-09-15T12:00:00.000Z',
    attentionId: null
  };

  it('says which side is ahead, in words a person can act on', () => {
    const summary = partialLandingSummary(partial);
    assert.match(summary, /api has this change and web does not/);
    assert.match(summary, /disagree in production/);
  });

  it('turns the room red and puts it in front of somebody', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    await room.service.recordPartialLanding({
      laneId: room.page,
      landed: [{ laneId: room.endpoint, repoId: 'api', head: 'abc123' }],
      pending: [{ laneId: room.page, repoId: 'web' }],
      reason: 'It would not merge.',
      conflicts: ['src/checkout/Page.tsx']
    });

    const snapshot = room.service.snapshot();
    assert.equal(snapshot.status, 'red');
    assert.ok(snapshot.partialLanding !== null);

    const item = snapshot.attention.find((entry) => entry.title.startsWith('Half-landed'));
    assert.ok(item, 'nothing about this is allowed to be quiet');
    assert.equal(item.needsMergeRights, true);
    assert.deepEqual(item.options.map((option) => option.id), ['finish', 'roll-back', 'leave-it']);
    assert.equal(snapshot.partialLanding?.attentionId, item.id);
  });

  it('will not let the room close while it is red', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    await room.service.recordPartialLanding({
      laneId: room.page,
      landed: [{ laneId: room.endpoint, repoId: 'api', head: 'abc' }],
      pending: [{ laneId: room.page, repoId: 'web' }],
      reason: 'It would not merge.',
      conflicts: []
    });
    const readiness = room.service.closeReadiness([room.page, room.endpoint]);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.kind === 'question-open'));
  });

  it('needs merge rights to declare settled, because it is not reversible', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    await room.service.addHuman(OWNER_ID, { id: 'jun', displayName: 'Jun', canMerge: false });
    await room.service.recordPartialLanding({
      laneId: room.page,
      landed: [{ laneId: room.endpoint, repoId: 'api', head: 'abc' }],
      pending: [{ laneId: room.page, repoId: 'web' }],
      reason: 'It would not merge.',
      conflicts: []
    });
    await refusal(
      () => room.service.clearPartialLanding('jun', { how: 'finished' }),
      'UNAUTHORIZED'
    );
    assert.equal(room.service.snapshot().status, 'red');
  });

  it('clears when somebody actually finishes it', async () => {
    const room = await twoRepoRoom();
    await room.service.approvePlan(OWNER_ID, 'Endpoint first.');
    await room.service.recordPartialLanding({
      laneId: room.page,
      landed: [{ laneId: room.endpoint, repoId: 'api', head: 'abc' }],
      pending: [{ laneId: room.page, repoId: 'web' }],
      reason: 'It would not merge.',
      conflicts: []
    });
    await room.service.clearPartialLanding(OWNER_ID, { how: 'finished' });

    const snapshot = room.service.snapshot();
    assert.equal(snapshot.status, 'open');
    assert.equal(snapshot.partialLanding, null);
    assert.deepEqual(
      snapshot.attention.filter((item) => item.resolvedAt === null),
      [],
      'and the question it raised goes with it'
    );
  });
});
