import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canDo, describeAction, mergeActions, needsMergeRights } from '../src/room/rights.ts';
import type { RoomAction } from '../src/room/rights.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal, roomWithApprovedPlan, twoAgentRoom } from './helpers.ts';

/**
 * Several people in the room, and one line drawn once (Q7, Q16).
 *
 * There is no permissions screen. The team decided this already on the
 * repository, and Agora draws exactly one line across it: anything reversible
 * is open to everyone, anything that changes what merges needs merge rights.
 */

const PRIYA = { id: 'priya', displayName: 'Priya', canMerge: true };
const JUN = { id: 'jun', displayName: 'Jun', canMerge: false };

describe('the one line', () => {
  it('lets anyone in the room do anything reversible', () => {
    for (const action of ['pause-agent', 'resume-agent', 'post-message', 'name-lane-owner'] as const) {
      assert.equal(canDo(JUN, action).allowed, true, action);
    }
  });

  it('holds everything that changes what merges behind merge rights', () => {
    for (const action of mergeActions()) {
      assert.equal(canDo(JUN, action).allowed, false, action);
      assert.equal(canDo(PRIYA, action).allowed, true, action);
    }
  });

  it('refuses by saying what you can do, not only what you cannot', () => {
    const verdict = canDo(JUN, 'approve-plan');
    assert.match(verdict.why, /merge rights/);
    assert.match(verdict.why, /pausing, redirecting, answering/);
  });

  it('refuses someone who is not in the room at all, and says how to fix it', () => {
    const verdict = canDo(undefined, 'pause-agent');
    assert.equal(verdict.allowed, false);
    assert.match(verdict.why, /Anyone already in it can add you/);
  });

  it('names every action in words a person would use', () => {
    const actions: RoomAction[] = ['approve-plan', 'amend-contract', 'raise-budget', 'close-room'];
    for (const action of actions) {
      assert.match(describeAction(action), /^[a-z]/, action);
      assert.equal(needsMergeRights(action), true, action);
    }
  });
});

describe('a room opens with one person in it', () => {
  it('needs no setup: whoever opened it can merge (Q25)', async () => {
    const room = await twoAgentRoom();
    const humans = room.service.humans();
    assert.equal(humans.length, 1);
    assert.equal(humans[0]?.id, OWNER_ID);
    assert.equal(humans[0]?.canMerge, true);
  });

  it('records who opened it, rather than "the human"', async () => {
    const room = await twoAgentRoom();
    const opened = room.service.snapshot().events.find((event) => event.type === 'room.created');
    assert.match(opened?.summary ?? '', /opened by You/);
  });
});

describe('the line, enforced', () => {
  async function team(): Promise<Awaited<ReturnType<typeof roomWithApprovedPlan>>> {
    const room = await roomWithApprovedPlan();
    await room.service.addHuman(OWNER_ID, PRIYA);
    await room.service.addHuman(OWNER_ID, JUN);
    return room;
  }

  it('refuses a plan approval from someone who cannot merge', async () => {
    const room = await twoAgentRoom();
    await room.service.addHuman(OWNER_ID, JUN);
    await room.service.claimTask(room.claude, { taskId: 'plan' });
    await room.service.submitWork(room.claude, {
      taskId: 'plan',
      summary: 'Two lanes.',
      outcome: 'needs-review',
      plan: (await import('./helpers.ts')).AUTH_PAGE_PLAN
    });

    const error = await refusal(() => room.service.approvePlan('jun', 'Looks fine'), 'UNAUTHORIZED');
    assert.match(error.message, /merge rights/);
    assert.equal(room.service.snapshot().plan.status, 'proposed', 'and nothing happened');
  });

  it('lets that same person do everything reversible', async () => {
    const room = await team();
    await room.service.pauseAgent('jun', room.claude, 'Hold on, I want to read this.');
    assert.equal(room.service.snapshot().agents.find((a) => a.id === room.claude)?.paused, true);

    await room.service.assignLaneOwner('jun', room.ui, 'priya');
    assert.equal(room.service.snapshot().tasks.find((t) => t.id === room.ui)?.laneOwner, 'priya');
  });

  it('refuses raising a cap, which is the classic way round a budget', async () => {
    const room = await team();
    await refusal(() => room.service.setTaskBudget('jun', room.ui, 9999), 'UNAUTHORIZED');
    await room.service.setTaskBudget('priya', room.ui, 50);
    assert.equal(room.service.snapshot().tasks.find((t) => t.id === room.ui)?.actionBudget, 50);
  });

  it('refuses someone who is not in the room, whatever they are trying', async () => {
    const room = await team();
    await refusal(() => room.service.pauseAgent('stranger', room.claude, 'hi'), 'UNAUTHORIZED');
  });

  it('puts a refused attempt on the record', async () => {
    const room = await team();
    await refusal(() => room.service.setTaskBudget('jun', room.ui, 9999), 'UNAUTHORIZED');
    const refused = room.service
      .snapshot()
      .events.filter((event) => event.type === 'rights.refused');
    assert.equal(refused.length, 1);
    assert.match(refused[0]?.summary ?? '', /jun tried raising a lane/);
  });

  it('attributes the act to the person, not to "the human"', async () => {
    const room = await team();
    await room.service.setTaskBudget('priya', room.ui, 50);
    const event = room.service
      .snapshot()
      .events.filter((e) => e.type === 'task.budget')
      .at(-1);
    assert.equal(event?.actor, 'priya');
    assert.match(event?.summary ?? '', /^Priya set/);
  });
});

describe('handing out access', () => {
  it('will not mint a token above your own level', async () => {
    const room = await twoAgentRoom();
    await room.service.addHuman(OWNER_ID, JUN);
    await room.service.addHuman(OWNER_ID, PRIYA);

    const error = await refusal(
      () => room.service.createSupervisorToken('jun', 'for priya', 'priya'),
      'UNAUTHORIZED'
    );
    assert.match(error.message, /merge rights/);
  });

  it('lets anyone hand out access at or below their own level', async () => {
    const room = await twoAgentRoom();
    await room.service.addHuman(OWNER_ID, JUN);
    const token = await room.service.createSupervisorToken('jun', 'a second screen', 'jun');
    assert.ok(token.length > 0);
  });

  it('gives the token the rights of the person it was minted for', async () => {
    const room = await twoAgentRoom();
    await room.service.addHuman(OWNER_ID, JUN);
    const token = await room.service.createSupervisorToken(OWNER_ID, 'jun', 'jun');
    const principal = room.service.authenticate(token);
    assert.equal(principal?.humanId, 'jun');
  });

  it('refuses a token for someone who is not in the room', async () => {
    const room = await twoAgentRoom();
    await refusal(
      () => room.service.createSupervisorToken(OWNER_ID, 'ghost', 'ghost'),
      'NOT_FOUND'
    );
  });
});
