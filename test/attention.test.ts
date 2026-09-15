import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OPENS_TO_ROOM_AFTER_MS,
  canAnswer,
  hasOpenedToRoom,
  longestWait,
  queueFor,
  reachFor,
  unanswered
} from '../src/room/attention.ts';
import type { AttentionItem } from '../src/room/attention.ts';
import { REWRITE_THRESHOLD, assessStuck, detectSpin } from '../src/room/spin.ts';
import type { StuckProbe } from '../src/room/spin.ts';
import type { Claim } from '../src/room/claims.ts';

const T0 = Date.parse('2026-09-15T12:00:00.000Z');
const iso = (offset: number): string => new Date(T0 + offset).toISOString();

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'att_1',
    kind: 'ruling',
    laneId: 'pricing',
    title: 'Token lifetime',
    detail: 'Cursor wants fifteen minutes; the UI was built against twenty-four hours.',
    options: [
      { id: 'keep', label: 'Keep v3', effect: 'Cursor rebuilds against the current contract.' },
      { id: 'amend', label: 'Take the amendment', effect: 'Nine files go stale and get a second look.' }
    ],
    assignedTo: 'priya',
    openedAt: iso(0),
    opensToRoomAt: iso(OPENS_TO_ROOM_AFTER_MS),
    needsMergeRights: true,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    ...overrides
  };
}

const priya = { id: 'priya', canMerge: true };
const sam = { id: 'sam', canMerge: true };
const junior = { id: 'junior', canMerge: false };

describe('whose question is it', () => {
  it('is the named person’s, immediately', () => {
    assert.equal(reachFor(item(), 'priya', T0 + 1000), 'yours');
  });

  it('is nobody else’s while their window is open', () => {
    assert.equal(reachFor(item(), 'sam', T0 + 1000), 'waiting');
    assert.equal(hasOpenedToRoom(item(), T0 + 1000), false);
  });

  it('opens to the room once the fifteen minutes are up', () => {
    const later = T0 + OPENS_TO_ROOM_AFTER_MS + 1;
    assert.equal(reachFor(item(), 'sam', later), 'room');
    assert.equal(hasOpenedToRoom(item(), later), true, 'a named person asleep is a dead lane');
  });

  it('belongs to everyone when it was never named to anyone', () => {
    const open = item({ assignedTo: null, opensToRoomAt: null });
    assert.equal(reachFor(open, 'sam', T0), 'room');
    assert.equal(hasOpenedToRoom(open, T0), true);
  });
});

describe('the two queues', () => {
  it('splits what is yours from what is the room’s', () => {
    const items = [
      item({ id: 'mine', assignedTo: 'priya' }),
      item({ id: 'theirs', assignedTo: 'sam' }),
      item({ id: 'loose', assignedTo: null, opensToRoomAt: null })
    ];
    const queue = queueFor(items, priya, T0 + 1000);

    assert.deepEqual(queue.yours.map((i) => i.id), ['mine']);
    assert.deepEqual(queue.room.map((i) => i.id), ['loose']);
    assert.deepEqual(queue.waiting.map((i) => i.id), ['theirs'], 'shown, so nobody duplicates it');
  });

  it('moves a timed-out item into the room queue for everyone else', () => {
    const items = [item({ id: 'stale', assignedTo: 'priya' })];
    const queue = queueFor(items, sam, T0 + OPENS_TO_ROOM_AFTER_MS + 1);
    assert.deepEqual(queue.room.map((i) => i.id), ['stale']);
  });

  it('hides a merge-rights question from someone who cannot merge', () => {
    const items = [
      item({ id: 'ruling', needsMergeRights: true, assignedTo: null, opensToRoomAt: null }),
      item({ id: 'question', kind: 'question', needsMergeRights: false, assignedTo: null, opensToRoomAt: null })
    ];
    const queue = queueFor(items, junior, T0 + 1000);
    assert.deepEqual(queue.room.map((i) => i.id), ['question']);
  });

  it('drops anything already settled', () => {
    const done = item({ resolvedAt: iso(500), resolvedBy: 'priya', resolution: 'keep' });
    const queue = queueFor([done], priya, T0 + 1000);
    assert.deepEqual([...queue.yours, ...queue.room, ...queue.waiting], []);
  });

  it('puts the oldest first, because that is what has been ignored longest', () => {
    const items = [
      item({ id: 'new', openedAt: iso(9000), assignedTo: 'priya' }),
      item({ id: 'old', openedAt: iso(10), assignedTo: 'priya' })
    ];
    assert.deepEqual(queueFor(items, priya, T0 + 20_000).yours.map((i) => i.id), ['old', 'new']);
  });
});

describe('answering', () => {
  it('refuses someone whose turn it is not yet, and says when it will be', () => {
    const verdict = canAnswer(item(), sam, T0 + 1000);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.why, /priya has this until/);
  });

  it('refuses a ruling from someone who cannot merge, and says what they can do', () => {
    const verdict = canAnswer(item({ assignedTo: null, opensToRoomAt: null }), junior, T0);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.why, /merge rights/);
    assert.match(verdict.why, /reversible/, 'it names what is still open to them');
  });

  it('lets the named person answer straight away', () => {
    assert.equal(canAnswer(item(), priya, T0 + 1000).allowed, true);
  });

  it('lets anyone answer once it has opened up', () => {
    assert.equal(canAnswer(item(), sam, T0 + OPENS_TO_ROOM_AFTER_MS + 1).allowed, true);
  });

  it('will not let the same thing be settled twice', () => {
    const done = item({ resolvedAt: iso(100), resolvedBy: 'priya' });
    assert.match(canAnswer(done, sam, T0 + 200).why, /Already settled by priya/);
  });
});

describe('what has been ignored', () => {
  it('measures the longest wait, which is what "stalled" means', () => {
    const items = [item({ id: 'a', openedAt: iso(0) }), item({ id: 'b', openedAt: iso(60_000) })];
    assert.equal(longestWait(items, T0 + 120_000), 120_000);
    assert.equal(unanswered(items).length, 2);
  });

  it('is zero when everything has been answered', () => {
    const done = item({ resolvedAt: iso(10) });
    assert.equal(longestWait([done], T0 + 999_999), 0);
  });
});

// --------------------------------------------------------------- spinning

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    path: 'src/pricing/quote.ts',
    holder: 'cursor',
    laneId: 'pricing',
    claimedAt: iso(0),
    touchedAt: iso(0),
    touches: 1,
    ...overrides
  };
}

describe('noticing an agent going in circles', () => {
  it('says nothing while a file is being written a normal number of times', () => {
    const signal = detectSpin({
      laneId: 'pricing',
      claims: [claim({ touches: REWRITE_THRESHOLD - 1 })],
      evidenceProducedAt: null
    });
    assert.equal(signal, null);
  });

  it('raises a fact, not a judgement, past the threshold', () => {
    const signal = detectSpin({
      laneId: 'pricing',
      claims: [claim({ touches: REWRITE_THRESHOLD })],
      evidenceProducedAt: null
    });
    assert.ok(signal);
    assert.equal(signal.path, 'src/pricing/quote.ts');
    assert.match(signal.fact, /rewritten 4 times/);
    assert.match(signal.fact, /has shown nothing since/);
  });

  it('stays quiet when the lane has shown something since it started on that file', () => {
    const signal = detectSpin({
      laneId: 'pricing',
      claims: [claim({ touches: 9, claimedAt: iso(0) })],
      evidenceProducedAt: iso(60_000)
    });
    assert.equal(signal, null, 'rewriting a lot while making progress is just work');
  });

  it('ignores files belonging to another lane', () => {
    const signal = detectSpin({
      laneId: 'pricing',
      claims: [claim({ laneId: 'wizard', touches: 20 })],
      evidenceProducedAt: null
    });
    assert.equal(signal, null);
  });
});

describe('confirming it is stuck', () => {
  const signal = {
    laneId: 'pricing',
    path: 'src/pricing/quote.ts',
    rewrites: 5,
    fact: '"src/pricing/quote.ts" has been rewritten 5 times and "pricing" has shown nothing since it started on it.'
  };

  it('asks a concrete question first, never "are you nearly done"', () => {
    const verdict = assessStuck(signal, []);
    assert.equal(verdict.kind, 'ask');
    if (verdict.kind !== 'ask') return;
    assert.match(verdict.question, /name the one thing that is missing/);
    assert.match(verdict.question, /costs you nothing/, 'admitting it must be cheap');
  });

  it('waits rather than nagging while a question is outstanding', () => {
    const probes: StuckProbe[] = [{ askedAt: iso(0), missing: null, answeredAt: null }];
    assert.equal(assessStuck(signal, probes).kind, 'waiting');
  });

  it('asks again when the missing piece changed — that is progress', () => {
    const probes: StuckProbe[] = [
      { askedAt: iso(0), missing: 'the tax table', answeredAt: iso(10) },
      { askedAt: iso(20), missing: 'the rounding rule', answeredAt: iso(30) }
    ];
    assert.equal(assessStuck(signal, probes).kind, 'ask');
  });

  it('calls it stuck when the same thing is missing twice', () => {
    const probes: StuckProbe[] = [
      { askedAt: iso(0), missing: 'the rounding rule', answeredAt: iso(10) },
      { askedAt: iso(20), missing: 'the rounding rule', answeredAt: iso(30) }
    ];
    const verdict = assessStuck(signal, probes);
    assert.equal(verdict.kind, 'stuck');
    if (verdict.kind !== 'stuck') return;
    assert.equal(verdict.missing, 'the rounding rule');
    assert.equal(verdict.rounds, 2);
  });
});
