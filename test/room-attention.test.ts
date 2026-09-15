import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refusal, roomWithApprovedPlan } from './helpers.ts';
import { OPENS_TO_ROOM_AFTER_MS } from '../src/room/attention.ts';
import { REWRITE_THRESHOLD } from '../src/room/spin.ts';
import type { RoomService } from '../src/room/service.ts';
import { OWNER_ID } from '../src/room/seed.ts';

/**
 * Phase 2 at the room level: nothing that needs a person is left without one,
 * and nothing that stalls does so quietly.
 */

async function staffed(): Promise<
  Awaited<ReturnType<typeof roomWithApprovedPlan>> & { service: RoomService }
> {
  const room = await roomWithApprovedPlan();
  await room.service.addHuman(OWNER_ID, { id: 'priya', displayName: 'Priya', canMerge: true });
  await room.service.addHuman(OWNER_ID, { id: 'sam', displayName: 'Sam', canMerge: true });
  await room.service.addHuman(OWNER_ID, { id: 'junior', displayName: 'Jun', canMerge: false });
  await room.service.assignLaneOwner(OWNER_ID, room.ui, 'priya');
  await room.service.assignLaneOwner(OWNER_ID, room.api, 'sam');
  return room;
}

describe('nothing needs a person without naming one', () => {
  it('puts a live collision in the named owner’s queue, not the room’s', async () => {
    const room = await staffed();
    await room.service.claimFile(room.claude, { path: 'src/auth/api.ts', laneId: room.ui });
    await refusal(
      () => room.service.claimFile(room.cursor, { path: 'src/auth/api.ts', laneId: room.api }),
      'LIVE_COLLISION'
    );

    // It lands with the owner of the *blocked* lane — Cursor is the one that
    // cannot proceed, and its lane is Sam's.
    const sam = room.service.attentionFor('sam');
    assert.equal(sam.yours.length, 1);
    const item = sam.yours[0];
    assert.equal(item?.kind, 'collision');
    assert.match(item?.detail ?? '', /planning problem/);
    assert.deepEqual(
      item?.options.map((o) => o.id),
      ['wait', 'hand-over', 'resplit'],
      'answerable from the notification, without opening anything'
    );

    // Priya can see it exists, but it is not hers to answer yet.
    const priya = room.service.attentionFor('priya');
    assert.deepEqual(priya.yours, []);
    assert.equal(priya.waiting.length, 1);
  });

  it('raises a spent budget with a way out', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(OWNER_ID, room.ui, 1);
    await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: [room.cursor],
      kind: 'ask',
      body: 'Token or cookie?'
    });

    const item = room.service.attentionFor('priya').yours.find((i) => i.kind === 'budget');
    assert.ok(item, 'a stopped lane must reach a person');
    assert.match(item.title, /spent its budget/);
    assert.ok(item.options.some((o) => o.id === 'raise'));
  });

  it('raises an agent that stopped itself, without needing merge rights', async () => {
    const room = await staffed();
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'No session secret in the environment.',
      outcome: 'blocked',
      filesChanged: []
    });

    const item = room.service.attentionFor('sam').yours.find((i) => i.kind === 'blocked');
    assert.ok(item);
    assert.equal(item.needsMergeRights, false);
    // Answering a blocked agent is reversible, so it is open to everyone (Q16).
    assert.ok(
      room.service.attentionFor('junior').waiting.some((i) => i.id === item.id),
      'someone without merge rights can still see and eventually take it'
    );
  });

  it('keeps a merge-rights question away from someone who cannot merge', async () => {
    const room = await staffed();
    await room.service.claimFile(room.claude, { path: 'src/auth/api.ts', laneId: room.ui });
    await refusal(
      () => room.service.claimFile(room.cursor, { path: 'src/auth/api.ts', laneId: room.api }),
      'LIVE_COLLISION'
    );

    const junior = room.service.attentionFor('junior');
    assert.deepEqual([...junior.yours, ...junior.room, ...junior.waiting], []);
  });
});

describe('answering', () => {
  it('settles an item and records who and what', async () => {
    const room = await staffed();
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'Needs a decision on rounding.',
      outcome: 'blocked',
      filesChanged: []
    });
    const item = room.service.attentionFor('sam').yours[0];
    assert.ok(item);

    const answered = await room.service.answerAttention('sam', {
      itemId: item.id,
      optionId: 'answer',
      note: 'Round the line, then sum.'
    });
    assert.match(answered.item.resolution ?? '', /Round the line/);
    assert.equal(answered.item.resolvedBy, 'sam');
    assert.deepEqual(room.service.attentionFor('sam').yours, [], 'and it leaves the queue');
  });

  it('refuses someone whose turn has not come, and says when it will', async () => {
    const room = await staffed();
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'Blocked.',
      outcome: 'blocked',
      filesChanged: []
    });
    const item = room.service.attentionFor('sam').yours[0];
    assert.ok(item);

    const error = await refusal(
      () => room.service.answerAttention('priya', { itemId: item.id, optionId: 'answer' }),
      'UNAUTHORIZED'
    );
    assert.match(error.message, /sam has this until/);
  });

  it('refuses an answer that was never on offer', async () => {
    const room = await staffed();
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'Blocked.',
      outcome: 'blocked',
      filesChanged: []
    });
    const item = room.service.attentionFor('sam').yours[0];
    assert.ok(item);
    const error = await refusal(
      () => room.service.answerAttention('sam', { itemId: item.id, optionId: 'shrug' }),
      'INVALID'
    );
    assert.match(error.remedy, /answer, reassign, drop/);
  });

  it('opens to the room once the named person’s window has passed', async () => {
    const room = await staffed();
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'Blocked.',
      outcome: 'blocked',
      filesChanged: []
    });

    const snapshot = room.service.snapshot();
    const item = snapshot.attention.find((i) => i.kind === 'blocked');
    assert.ok(item);
    assert.ok(item.opensToRoomAt, 'a named item always carries its deadline');
    assert.equal(
      Date.parse(item.opensToRoomAt) - Date.parse(item.openedAt),
      OPENS_TO_ROOM_AFTER_MS,
      'fifteen minutes, then anyone'
    );
  });
});

describe('an agent going in circles', () => {
  it('asks a concrete question after enough rewrites', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(OWNER_ID, room.ui, 50);

    for (let i = 0; i < REWRITE_THRESHOLD; i += 1) {
      await room.service.claimFile(room.claude, {
        path: 'src/auth/AuthPage.tsx',
        laneId: room.ui
      });
    }

    const probes = room.service.snapshot().probes[room.ui] ?? [];
    assert.equal(probes.length, 1, 'asked once, not once per rewrite');
    assert.equal(probes[0]?.missing, null);
  });

  it('escalates to a person when the same thing is missing twice', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(OWNER_ID, room.ui, 50);
    for (let i = 0; i < REWRITE_THRESHOLD; i += 1) {
      await room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui });
    }

    await room.service.answerProbe(room.claude, { laneId: room.ui, missing: 'the error copy' });
    await room.service.checkForSpin(room.ui);
    await room.service.answerProbe(room.claude, { laneId: room.ui, missing: 'the error copy' });
    const verdict = await room.service.checkForSpin(room.ui);

    assert.equal(verdict?.kind, 'stuck');
    const item = room.service.attentionFor('priya').yours.find((i) => i.kind === 'stuck');
    assert.ok(item, 'the named person is told, with the specific fact');
    assert.match(item.detail, /the error copy/);
    assert.match(item.detail, /rewritten/);
  });

  it('says nothing about a lane that is making progress', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(OWNER_ID, room.ui, 50);
    for (let i = 0; i < REWRITE_THRESHOLD + 2; i += 1) {
      await room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui });
    }
    await room.service.produceEvidence(room.claude, { taskId: room.ui, note: 'Sign-in works.' });

    assert.equal(await room.service.checkForSpin(room.ui), null);
  });
});

describe('dissent', () => {
  it('lets an agent comply and object at the same time', async () => {
    const room = await staffed();
    const dissent = await room.service.recordDissent(room.cursor, {
      about: 'Ruling: keep the 24-hour token.',
      because: 'Our security review says provisioning tokens over an hour cannot ship.',
      laneId: room.api
    });

    assert.equal(dissent.by, room.cursor);
    const recorded = room.service.snapshot().dissents;
    assert.equal(recorded.length, 1);
    assert.match(recorded[0]?.because ?? '', /security review/);

    // It is on the record for the human, and it does not stop the work.
    const claimed = await room.service.claimFile(room.cursor, {
      path: 'src/auth/api.ts',
      laneId: room.api
    });
    assert.equal(claimed.outcome, 'granted', 'objecting is not refusing');
  });
});
