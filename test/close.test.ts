import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openRoom } from '../src/index.ts';
import { seedBriefing, seedContracts } from '../src/room/close.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal, roomWithApprovedPlan } from './helpers.ts';

/**
 * A room is a unit of work that ends (Q17, Q24).
 *
 * It closes on the same gate as everything else, with a person confirming. The
 * archive then has two jobs: answering why the code is like this long after
 * everyone has forgotten, and seeding the next room's contracts. The second one
 * is the one that compounds.
 */

type Room = Awaited<ReturnType<typeof roomWithApprovedPlan>>;

/** Both lanes finished honestly: submitted, evidenced, cross-reviewed. */
async function finishedRoom(): Promise<Room> {
  const room = await roomWithApprovedPlan();
  await room.service.setRiskList(OWNER_ID, []);
  await room.service.claimTask(room.claude, { taskId: room.ui });
  await room.service.claimTask(room.cursor, { taskId: room.api });

  for (const [agent, laneId, file, note] of [
    [room.claude, room.ui, 'src/auth/AuthPage.tsx', 'Signed in and reached the dashboard.'],
    [room.cursor, room.api, 'src/auth/api.ts', '200 for a known user, 401 for a bad password.']
  ] as const) {
    await room.service.claimFile(agent, { path: file, laneId });
    await room.service.submitWork(agent, {
      taskId: laneId,
      summary: `${laneId} done.`,
      outcome: 'complete',
      filesChanged: [file],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Matches the contract.' }]
    });
    await room.service.produceEvidence(agent, { taskId: laneId, note });
  }

  await room.service.reviewLane(room.cursor, {
    laneId: room.ui,
    verdict: 'holds',
    note: 'Posts {email, password} as agreed.'
  });
  await room.service.reviewLane(room.claude, {
    laneId: room.api,
    verdict: 'holds',
    note: 'Returns the shape the form reads.'
  });
  await room.service.acceptTask(OWNER_ID, room.ui);
  await room.service.acceptTask(OWNER_ID, room.api);
  return room;
}

describe('whether a room can close', () => {
  it('refuses while a lane is still being worked on', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const readiness = room.service.closeReadiness([]);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.kind === 'lane-open'));
    assert.match(readiness.summary, /still work in progress/);
  });

  it('refuses while a lane never showed what it promised (Q18)', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.setRiskList(OWNER_ID, []);
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Done.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Posts the body.' }]
    });
    const readiness = room.service.closeReadiness([room.ui, room.api]);
    const missing = readiness.blockers.find((blocker) => blocker.kind === 'evidence-missing');
    assert.ok(missing);
    assert.match(missing.detail, /Signing in with a good password/);
  });

  it('refuses while a lane has not actually landed', async () => {
    const room = await finishedRoom();
    const readiness = room.service.closeReadiness([room.ui]);
    const notLanded = readiness.blockers.find((blocker) => blocker.kind === 'not-landed');
    assert.ok(notLanded, 'the room does not take its own word for what landed');
    assert.equal(notLanded.laneId, room.api);
  });

  it('refuses while anything is still waiting on a person', async () => {
    const room = await finishedRoom();
    await room.service.addHuman(OWNER_ID, { id: 'priya', displayName: 'Priya', canMerge: true });
    await room.service.assignLaneOwner(OWNER_ID, room.ui, 'priya');
    await room.service.reopenTask(OWNER_ID, room.ui, true);
    await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Actually, I need a decision on the copy.',
      outcome: 'blocked',
      filesChanged: []
    });
    const readiness = room.service.closeReadiness([room.ui, room.api]);
    assert.ok(readiness.blockers.some((blocker) => blocker.kind === 'question-open'));
  });

  it('agrees once the evidence is green and both lanes landed', async () => {
    const room = await finishedRoom();
    const readiness = room.service.closeReadiness([room.ui, room.api]);
    assert.equal(readiness.ready, true, readiness.summary);
    assert.match(readiness.summary, /All 2 lane\(s\) landed/);
    assert.match(readiness.summary, /Ship a working auth page/);
  });

  it('says there is nothing to close when there is no work', async () => {
    const room = await openRoom({ file: null, name: 'Empty', goal: 'Nothing yet.' });
    assert.ok(room.closeReadiness([]).blockers.some((blocker) => blocker.kind === 'no-work'));
  });
});

describe('closing it', () => {
  it('needs merge rights, because it is not reversible (Q16)', async () => {
    const room = await finishedRoom();
    await room.service.addHuman(OWNER_ID, { id: 'jun', displayName: 'Jun', canMerge: false });
    const error = await refusal(
      () => room.service.closeRoom('jun', { landed: [room.ui, room.api] }),
      'UNAUTHORIZED'
    );
    assert.match(error.message, /merge rights/);
    assert.equal(room.service.snapshot().status, 'open');
  });

  it('refuses to close over something unfinished without being told to', async () => {
    const room = await finishedRoom();
    const error = await refusal(
      () => room.service.closeRoom(OWNER_ID, { landed: [] }),
      'INVALID'
    );
    assert.match(error.remedy, /close it anyway with force/);
  });

  it('will close over it when told, and says so on the record', async () => {
    const room = await finishedRoom();
    const { room: closed } = await room.service.closeRoom(OWNER_ID, {
      landed: [],
      note: 'Shipping the rest next week.',
      force: true
    });
    assert.equal(closed.status, 'closed');
    assert.match(closed.closeNote ?? '', /unfinished/);
    const event = room.service.snapshot().events.find((entry) => entry.type === 'room.closed');
    assert.match(event?.summary ?? '', /with 2 thing\(s\) unfinished/);
  });

  it('records who closed it and when', async () => {
    const room = await finishedRoom();
    const { room: closed } = await room.service.closeRoom(OWNER_ID, {
      landed: [room.ui, room.api],
      note: 'Shipped.'
    });
    assert.equal(closed.closedBy, OWNER_ID);
    assert.ok(closed.closedAt !== null);
    assert.equal(closed.closeNote, 'Shipped.');
  });

  it('cannot be closed twice', async () => {
    const room = await finishedRoom();
    await room.service.closeRoom(OWNER_ID, { landed: [room.ui, room.api] });
    const error = await refusal(
      () => room.service.closeRoom(OWNER_ID, { landed: [room.ui, room.api] }),
      'INVALID'
    );
    assert.match(error.remedy, /Open a new room/);
  });
});

describe('what survives it', () => {
  it('answers why the code is like this', async () => {
    const room = await finishedRoom();
    await room.service.recordDissent(room.cursor, {
      about: 'POST /api/auth/login',
      because: 'A 24-hour token cannot pass our security review.',
      laneId: room.api
    });
    const { archive } = await room.service.closeRoom(OWNER_ID, { landed: [room.ui, room.api] });

    assert.equal(archive.goal, 'Ship a working auth page.');
    assert.equal(archive.lanes.length, 2);
    assert.ok(archive.lanes.every((lane) => lane.evidenceShown !== null), 'with the proof attached');
    assert.equal(archive.dissents.length, 1, 'including what somebody said was wrong at the time');
    assert.ok(archive.events.length > 0);
  });

  it('carries forward only the contracts both sides actually held', async () => {
    const room = await finishedRoom();
    const { archive } = await room.service.closeRoom(OWNER_ID, { landed: [room.ui, room.api] });
    assert.equal(archive.contracts.length, 1);
    assert.equal(archive.contracts[0]?.title, 'POST /api/auth/login');
    assert.equal(archive.contracts[0]?.fromRoomName, 'Auth page');
  });

  it('leaves behind a contract one side said was broken', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.setRiskList(OWNER_ID, []);
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Done.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Posts the body.' }]
    });
    await room.service.reviewLane(room.cursor, {
      laneId: room.ui,
      verdict: 'breaks',
      note: 'It posts username, not email.'
    });
    const archive = room.service.archive();
    assert.deepEqual(archive.contracts, [], 'an unheld contract is not worth anyone reusing');
  });

  it('keeps the objection attached to the contract it was about (Q22)', async () => {
    const room = await finishedRoom();
    await room.service.recordDissent(room.cursor, {
      about: 'POST /api/auth/login',
      because: 'A 24-hour token cannot pass our security review.',
      laneId: room.api
    });
    const archive = room.service.archive();
    assert.equal(archive.contracts[0]?.objections.length, 1);
    assert.match(archive.contracts[0]?.objections[0]?.because ?? '', /security review/);
  });
});

describe('seeding the next room', () => {
  it('takes the most recently agreed version of a contract', async () => {
    const older = {
      title: 'POST /api/auth/login',
      body: 'Old shape.',
      versionsItTook: 1,
      fromRoom: 'room_1',
      fromRoomName: 'First',
      agreedAt: '2026-01-01T00:00:00.000Z',
      objections: []
    };
    const newer = { ...older, body: 'Current shape.', fromRoomName: 'Second', agreedAt: '2026-06-01T00:00:00.000Z' };
    const seeded = seedContracts([
      { contracts: [older] } as never,
      { contracts: [newer] } as never
    ]);
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0]?.body, 'Current shape.');
  });

  it('tells the lead it is a starting point, not a ruling', () => {
    const briefing = seedBriefing([
      {
        title: 'POST /api/auth/login',
        body: 'Request {email, password}.',
        versionsItTook: 3,
        fromRoom: 'room_1',
        fromRoomName: 'Auth page',
        agreedAt: '2026-01-01T00:00:00.000Z',
        objections: [{ by: 'cursor', because: 'The token lifetime is too long.' }]
      }
    ]);
    assert.match(briefing, /starting point, not a/);
    assert.match(briefing, /settled at v3/);
    assert.match(briefing, /Objected to at the time/);
  });

  it('says nothing at all when there is nothing to carry', () => {
    assert.equal(seedBriefing([]), '');
  });

  it('carries them into the next room as notes, never as signed seams', async () => {
    const first = await finishedRoom();
    const { archive } = await first.service.closeRoom(OWNER_ID, {
      landed: [first.ui, first.api]
    });

    const next = await openRoom({
      file: null,
      name: 'Password reset',
      goal: 'Let people reset a forgotten password.',
      seededContracts: seedContracts([archive]),
      seededFrom: archive.roomId
    });
    const room = next.snapshot();

    assert.equal(room.seededFrom, archive.roomId);
    assert.equal(room.decisions.length, 1);
    assert.equal(room.decisions[0]?.kind, 'general', 'a note the lead re-proposes, not a live seam');
    assert.equal(room.decisions[0]?.seam, null);
    assert.match(room.decisions[0]?.title ?? '', /^From Auth page:/);

    const plan = room.tasks.find((task) => task.id === 'plan');
    assert.match(plan?.description ?? '', /starting point, not a/);
  });
});
