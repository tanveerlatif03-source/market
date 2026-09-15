import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refusal, roomWithApprovedPlan } from './helpers.ts';
import { OWNER_ID } from '../src/room/seed.ts';

/**
 * Service-level claim behaviour. The time-dependent transitions — soft lapse,
 * dead-session sweep — are covered as pure functions in claims.test.ts, where
 * the clock can be moved. What matters here is what an agent and a human
 * actually see.
 */

describe('claiming a file through the room', () => {
  it('gives the file to the first asker and counts what it holds', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });

    const first = await room.service.claimFile(room.claude, {
      path: 'src/auth/AuthPage.tsx',
      laneId: room.ui
    });
    assert.equal(first.outcome, 'granted');
    assert.equal(first.holding, 1);

    const second = await room.service.claimFile(room.claude, {
      path: 'src/auth/fields.tsx',
      laneId: room.ui
    });
    assert.equal(second.holding, 2);
  });

  it('treats a re-claim as "still on it" rather than a new claim', async () => {
    const room = await roomWithApprovedPlan();
    const first = await room.service.claimFile(room.claude, {
      path: 'src/auth/AuthPage.tsx',
      laneId: room.ui
    });
    const again = await room.service.claimFile(room.claude, {
      path: 'src/auth/AuthPage.tsx',
      laneId: room.ui
    });

    assert.equal(again.outcome, 'refreshed');
    assert.equal(again.holding, 1, 'still one file, not two');
    assert.equal(again.claim.claimedAt, first.claim.claimedAt);
  });

  it('refuses a live collision and sends it to the human as a planning problem', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimFile(room.claude, { path: 'src/auth/api.ts', laneId: room.ui });

    const escalations: string[] = [];
    room.service.events().subscribe((event) => {
      if (event.type === 'claim.collision') escalations.push(event.summary);
    });

    const error = await refusal(
      () => room.service.claimFile(room.cursor, { path: 'src/auth/api.ts', laneId: room.api }),
      'LIVE_COLLISION'
    );
    assert.equal(error.details.heldBy, room.claude);
    assert.match(error.remedy, /split is wrong, not that you are/);

    assert.equal(escalations.length, 1);
    assert.match(escalations[0] ?? '', /both need "src\/auth\/api\.ts"/);
    assert.match(escalations[0] ?? '', /split put two agents in the same code/);
  });

  it('frees the file the moment it is released', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimFile(room.claude, { path: 'src/auth/api.ts', laneId: room.ui });
    await refusal(
      () => room.service.claimFile(room.cursor, { path: 'src/auth/api.ts', laneId: room.api }),
      'LIVE_COLLISION'
    );

    const released = await room.service.releaseFile(room.claude, { paths: ['src/auth/api.ts'] });
    assert.deepEqual(released.released, ['src/auth/api.ts']);
    assert.equal(released.holding, 0);

    const taken = await room.service.claimFile(room.cursor, {
      path: 'src/auth/api.ts',
      laneId: room.api
    });
    assert.equal(taken.outcome, 'granted');
  });

  it('says so plainly when there was nothing to release', async () => {
    const room = await roomWithApprovedPlan();
    const nothing = await room.service.releaseFile(room.claude, { paths: ['src/nowhere.ts'] });
    assert.deepEqual(nothing.released, []);
    assert.match(nothing.message, /were not holding/);
  });

  it('will not let a paused agent take a file', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.pauseAgent(OWNER_ID, room.claude, 'Hold on.');
    await refusal(
      () => room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui }),
      'AGENT_PAUSED'
    );
  });

  it('reports what an agent is holding, with each state resolved', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui });
    await room.service.claimFile(room.claude, { path: 'src/auth/fields.tsx', laneId: room.ui });

    const held = room.service.heldBy(room.claude);
    assert.deepEqual(
      held.map((row) => row.claim.path).sort(),
      ['src/auth/AuthPage.tsx', 'src/auth/fields.tsx']
    );
    assert.ok(held.every((row) => row.state === 'held'), 'nothing has gone quiet yet');
    assert.deepEqual(room.service.heldBy(room.cursor), []);
  });
});

describe('changes that skipped the claim', () => {
  it('names them on submit, so the gate is never a surprise', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui });

    const result = await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Sign-in form done.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Contract held.' }]
    });
    assert.equal(result.unclaimed, undefined, 'everything it changed, it had claimed');
  });

  it('flags a file changed without ever being claimed', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    // Note: inside its lane, so the old path check passes — only the claim is missing.
    const result = await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Wrote the form without telling anyone.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Contract held.' }]
    });
    assert.deepEqual(result.unclaimed, ['src/auth/AuthPage.tsx']);
    assert.match(result.message, /merge gate will refuse/);
  });

  it('does not credit an agent for a file another agent holds', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimFile(room.cursor, { path: 'src/auth/AuthPage.tsx', laneId: room.api });
    assert.deepEqual(room.service.strayChanges(room.claude, ['src/auth/AuthPage.tsx']), [
      'src/auth/AuthPage.tsx'
    ]);
  });
});
