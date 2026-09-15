import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SESSION_DEAD_AFTER_MS,
  SOFT_AFTER_MS,
  abandonedClaims,
  claimStateAt,
  claimsHeldBy,
  requestClaim,
  unclaimedChanges
} from '../src/room/claims.ts';
import type { Claim, ClaimHolderActivity } from '../src/room/claims.ts';

const T0 = Date.parse('2026-09-15T12:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    path: 'src/checkout/Wizard.tsx',
    holder: 'claude',
    laneId: 'wizard',
    claimedAt: iso(0),
    touchedAt: iso(0),
    touches: 1,
    ...overrides
  };
}

function alive(latestTouchMs: number, lastSeenMs = latestTouchMs): ClaimHolderActivity {
  return { latestTouchAt: iso(latestTouchMs), lastSeenAt: iso(lastSeenMs) };
}

describe('when a claim goes soft', () => {
  it('stays held while the holder is still touching it', () => {
    const c = claim({ touchedAt: iso(0) });
    const state = claimStateAt(c, alive(0), T0 + SOFT_AFTER_MS + 1000);
    // Quiet for long enough, but the holder has not worked anywhere else.
    assert.equal(state, 'held');
  });

  it('stays held while the holder is thinking, however long it thinks', () => {
    const c = claim({ touchedAt: iso(0) });
    const anHour = 60 * 60 * 1000;
    // Heartbeating, so alive — just slow. Its latest touch is still this file.
    const state = claimStateAt(c, alive(0, anHour - 1000), T0 + anHour);
    assert.equal(state, 'held', 'a slow agent has not moved on');
  });

  it('goes soft only once the holder has both gone quiet here and worked elsewhere', () => {
    const c = claim({ touchedAt: iso(0) });
    const later = SOFT_AFTER_MS + 1000;
    const state = claimStateAt(c, alive(later - 500), T0 + later);
    assert.equal(state, 'soft');
  });

  it('does not go soft the instant the holder touches another file', () => {
    const c = claim({ touchedAt: iso(0) });
    // Moved on, but only a minute ago — an agent alternating between a
    // component and its test must not lose the component.
    const state = claimStateAt(c, alive(60_000), T0 + 61_000);
    assert.equal(state, 'held');
  });
});

describe('asking for a file', () => {
  const activity = { claude: alive(0) };

  it('grants an unclaimed file', () => {
    const outcome = requestClaim({
      claims: [],
      path: 'src/checkout/Wizard.tsx',
      agentId: 'claude',
      laneId: 'wizard',
      activity: {},
      now: T0
    });
    assert.equal(outcome.kind, 'granted');
    assert.equal(outcome.claim.holder, 'claude');
  });

  it('normalizes the path so ./a//b and a/b are the same file', () => {
    const outcome = requestClaim({
      claims: [claim({ path: 'src/checkout/Wizard.tsx', holder: 'cursor' })],
      path: './src//checkout/Wizard.tsx',
      agentId: 'claude',
      laneId: 'wizard',
      activity: { cursor: alive(0) },
      now: T0 + 1000
    });
    assert.equal(outcome.kind, 'collision', 'the same file dressed differently is still taken');
  });

  it('treats a re-claim by the holder as a touch, not a new claim', () => {
    const original = claim({ claimedAt: iso(0), touchedAt: iso(0) });
    const outcome = requestClaim({
      claims: [original],
      path: original.path,
      agentId: 'claude',
      laneId: 'wizard',
      activity,
      now: T0 + 30_000
    });
    assert.equal(outcome.kind, 'refreshed');
    assert.equal(outcome.claim.claimedAt, iso(0), 'held since the original claim');
    assert.equal(outcome.claim.touchedAt, iso(30_000), 'but touched just now');
  });

  it('refuses a live collision instead of arbitrating it', () => {
    const outcome = requestClaim({
      claims: [claim({ holder: 'claude' })],
      path: 'src/checkout/Wizard.tsx',
      agentId: 'cursor',
      laneId: 'pricing',
      activity: { claude: alive(0) },
      now: T0 + 60_000
    });
    assert.equal(outcome.kind, 'collision');
    if (outcome.kind !== 'collision') return;
    assert.equal(outcome.heldBy, 'claude');
  });

  it('hands over a soft claim instantly, and names who lost it', () => {
    const later = SOFT_AFTER_MS + 5000;
    const outcome = requestClaim({
      claims: [claim({ holder: 'claude', touchedAt: iso(0) })],
      path: 'src/checkout/Wizard.tsx',
      agentId: 'cursor',
      laneId: 'pricing',
      activity: { claude: alive(later - 1000) },
      now: T0 + later
    });
    assert.equal(outcome.kind, 'taken');
    if (outcome.kind !== 'taken') return;
    assert.equal(outcome.previousHolder, 'claude');
    assert.equal(outcome.claim.holder, 'cursor');
    assert.equal(outcome.claim.laneId, 'pricing', 'it comes across to the taker’s lane');
  });

  it('hands over a dead session’s file even if it was never quiet', () => {
    const outcome = requestClaim({
      claims: [claim({ holder: 'claude', touchedAt: iso(0) })],
      path: 'src/checkout/Wizard.tsx',
      agentId: 'cursor',
      laneId: 'pricing',
      // Touched a moment ago, but no heartbeat since — the laptop closed.
      activity: { claude: alive(0, 0) },
      now: T0 + SESSION_DEAD_AFTER_MS + 1000
    });
    assert.equal(outcome.kind, 'taken');
  });

  it('hands over a file whose holder Agora has never seen', () => {
    const outcome = requestClaim({
      claims: [claim({ holder: 'ghost' })],
      path: 'src/checkout/Wizard.tsx',
      agentId: 'cursor',
      laneId: 'pricing',
      activity: {},
      now: T0 + 1000
    });
    assert.equal(outcome.kind, 'taken');
  });
});

describe('what an agent is holding', () => {
  it('reports each file with its state resolved', () => {
    const later = SOFT_AFTER_MS + 5000;
    const held = [
      claim({ path: 'src/a.ts', touchedAt: iso(0) }),
      claim({ path: 'src/b.ts', touchedAt: iso(later - 500) }),
      claim({ path: 'src/c.ts', holder: 'cursor' })
    ];
    const rows = claimsHeldBy(held, 'claude', { claude: alive(later - 500) }, T0 + later);

    assert.deepEqual(
      rows.map((row) => [row.claim.path, row.state]),
      [
        ['src/a.ts', 'soft'],
        ['src/b.ts', 'held']
      ]
    );
  });
});

describe('sweeping dead sessions', () => {
  it('collects every claim whose holder stopped heartbeating', () => {
    const claims = [
      claim({ path: 'src/a.ts', holder: 'claude' }),
      claim({ path: 'src/b.ts', holder: 'cursor' })
    ];
    const now = T0 + SESSION_DEAD_AFTER_MS + 1000;
    const dropped = abandonedClaims(
      claims,
      { claude: alive(0, now - 1000), cursor: alive(0, 0) },
      now
    );
    assert.deepEqual(dropped.map((c) => c.holder), ['cursor']);
  });
});

describe('the merge gate backstop', () => {
  it('names files an agent changed but never claimed', () => {
    const claims = [claim({ path: 'src/checkout/Wizard.tsx', holder: 'claude' })];
    const stray = unclaimedChanges(
      claims,
      ['./src/checkout/Wizard.tsx', 'src/pricing/quote.ts'],
      'claude'
    );
    assert.deepEqual(stray, ['src/pricing/quote.ts']);
  });

  it('does not credit an agent for a file someone else holds', () => {
    const claims = [claim({ path: 'src/pricing/quote.ts', holder: 'cursor' })];
    assert.deepEqual(unclaimedChanges(claims, ['src/pricing/quote.ts'], 'claude'), [
      'src/pricing/quote.ts'
    ]);
  });
});
