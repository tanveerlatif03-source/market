import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SORT, ledgerRows, sortRows } from '../src/room/ledger.ts';
import type { LedgerRow } from '../src/room/ledger.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal, roomWithApprovedPlan } from './helpers.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * The Ledger (Q19).
 *
 * A table, not a formula language. What it has to do is put every lane on one
 * screen with the problem at the top, so that someone who has never seen this
 * room can tell in one look which lane needs them and why.
 */

type Room = Awaited<ReturnType<typeof roomWithApprovedPlan>>;

async function staffed(): Promise<Room> {
  const room = await roomWithApprovedPlan();
  await room.service.addHuman(OWNER_ID, { id: 'priya', displayName: 'Priya', canMerge: true });
  await room.service.assignLaneOwner(OWNER_ID, room.ui, 'priya');
  await room.service.setRiskList(OWNER_ID, []);
  return room;
}

function rowFor(service: RoomService, laneId: string): LedgerRow {
  const row = service.ledger().find((candidate) => candidate.laneId === laneId);
  assert.ok(row, `no row for ${laneId}`);
  return row;
}

describe('one row per lane', () => {
  it('leaves the plan task out — it is not a lane', async () => {
    const room = await staffed();
    assert.deepEqual(
      room.service.ledger().map((row) => row.laneId).sort(),
      [room.api, room.ui].sort()
    );
  });

  it('says who holds it and who answers for it', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const row = rowFor(room.service, room.ui);
    assert.equal(row.agent, room.claude);
    assert.equal(row.human, 'priya');
  });

  it('counts the files a lane is holding', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui });
    assert.equal(rowFor(room.service, room.ui).filesHeld, 1);
  });

  it('tracks a lane from promised to shown (Q18)', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    assert.equal(rowFor(room.service, room.ui).evidence, 'promised');
    await room.service.produceEvidence(room.claude, { taskId: room.ui, note: 'Signed in.' });
    assert.equal(rowFor(room.service, room.ui).evidence, 'shown');
  });

  it('carries the cost without ever totalling it (Q15)', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.recordCost(room.claude, {
      laneId: room.ui,
      provenance: 'reported',
      amount: 12_000,
      unit: 'tokens'
    });
    const row = rowFor(room.service, room.ui);
    assert.equal(row.cost.lines.length, 1);
    assert.match(row.costSummary, /12000 tokens \(reported\)/);
  });
});

describe('the column that matters', () => {
  it('calls an unclaimed lane idle', async () => {
    const room = await staffed();
    assert.equal(rowFor(room.service, room.ui).health, 'idle');
    assert.match(rowFor(room.service, room.ui).blockedOn, /Nobody has claimed it/);
  });

  it('calls a lane with a question on it one that needs a person', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(OWNER_ID, room.ui, 0);
    // The lane tries to carry on and is stopped. The refusal rolls its own
    // mutation back, so this also checks the halt outlived it.
    await refusal(
      () => room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui }),
      'BUDGET_EXHAUSTED'
    );

    const row = rowFor(room.service, room.ui);
    assert.equal(row.health, 'needs-a-person');
    assert.match(row.blockedOn, /cap/);
  });

  it('calls a submitted lane waiting while its reviewer has not read it (Q13)', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Done.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Posts the body.' }]
    });
    await room.service.produceEvidence(room.claude, { taskId: room.ui, note: 'Signed in.' });

    const row = rowFor(room.service, room.ui);
    assert.equal(row.health, 'waiting');
    assert.equal(row.review, 'missing');
    assert.match(row.blockedOn, /across the contract to read it/);
  });

  it('calls it ready once everything is in', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Done.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Posts the body.' }]
    });
    await room.service.produceEvidence(room.claude, { taskId: room.ui, note: 'Signed in.' });
    await room.service.reviewLane(room.cursor, {
      laneId: room.ui,
      verdict: 'holds',
      note: 'It posts what the contract says.'
    });

    const row = rowFor(room.service, room.ui);
    assert.equal(row.health, 'ready');
    assert.match(row.blockedOn, /Nothing\. It can land/);
  });

  it('calls a lane its reviewer rejected one that needs a person', async () => {
    const room = await staffed();
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
      note: 'Posts username, not email.'
    });
    assert.equal(rowFor(room.service, room.ui).health, 'needs-a-person');
  });

  it('gives every row a blockedOn a person could act on', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    assert.ok(
      room.service.ledger().every((row) => row.blockedOn.trim().length > 0),
      'a row that cannot say what is in its way is a row nobody reads twice'
    );
  });
});

describe('sorting', () => {
  const row = (overrides: Partial<LedgerRow>): LedgerRow =>
    ({
      laneId: 'a',
      title: 'A',
      agent: null,
      human: null,
      status: 'open',
      health: 'working',
      filesHeld: 0,
      filesSoft: 0,
      actionsUsed: 0,
      actionBudget: 30,
      evidence: 'promised',
      review: 'not-applicable',
      risksOpen: 0,
      cost: { laneId: null, lines: [], caveat: '' },
      costSummary: 'not counted',
      questionsOpen: 0,
      sweep: null,
      blockedOn: '',
      updatedAt: '2026-09-15T12:00:00.000Z',
      ...overrides
    }) as LedgerRow;

  it('leads with the problem by default', () => {
    const rows = [
      row({ laneId: 'done', health: 'done' }),
      row({ laneId: 'stuck', health: 'needs-a-person' }),
      row({ laneId: 'busy', health: 'working' })
    ];
    assert.deepEqual(
      sortRows(rows, DEFAULT_SORT).map((entry) => entry.laneId),
      ['stuck', 'busy', 'done']
    );
  });

  it('sorts numbers as numbers', () => {
    const rows = [row({ laneId: 'a', filesHeld: 9 }), row({ laneId: 'b', filesHeld: 10 })];
    assert.deepEqual(
      sortRows(rows, { column: 'filesHeld', direction: 'desc' }).map((entry) => entry.laneId),
      ['b', 'a']
    );
  });

  it('breaks every tie the same way, so the table never reshuffles itself', () => {
    const rows = [
      row({ laneId: 'zebra', health: 'working' }),
      row({ laneId: 'apple', health: 'working' })
    ];
    assert.deepEqual(
      sortRows(rows, DEFAULT_SORT).map((entry) => entry.laneId),
      ['apple', 'zebra']
    );
    assert.deepEqual(
      sortRows([...rows].reverse(), DEFAULT_SORT).map((entry) => entry.laneId),
      ['apple', 'zebra']
    );
  });

  it('never mutates what it was handed', () => {
    const rows = [row({ laneId: 'b' }), row({ laneId: 'a' })];
    sortRows(rows, { column: 'laneId', direction: 'asc' });
    assert.equal(rows[0]?.laneId, 'b');
  });

  it('orders review states worst first', () => {
    const rows = [
      row({ laneId: 'ok', review: 'holds' }),
      row({ laneId: 'bad', review: 'breaks' }),
      row({ laneId: 'old', review: 'stale' })
    ];
    assert.deepEqual(
      sortRows(rows, { column: 'review', direction: 'asc' }).map((entry) => entry.laneId),
      ['bad', 'old', 'ok']
    );
  });
});

describe('derived, never stored', () => {
  it('reads the same room twice the same way', async () => {
    const room = await staffed();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const snapshot = room.service.snapshot();
    const now = Date.now();
    assert.deepEqual(ledgerRows(snapshot, now), ledgerRows(snapshot, now));
  });
});
