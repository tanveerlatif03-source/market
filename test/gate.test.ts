import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateMerge, summarize } from '../src/gate/evaluate.ts';
import type { GateInput, LaneUnderGate, SeamState } from '../src/gate/evaluate.ts';
import type { Claim } from '../src/room/claims.ts';

const AT = '2026-09-15T12:00:00.000Z';

function claim(path: string, holder: string): Claim {
  return { path, holder, laneId: 'wizard', claimedAt: AT, touchedAt: AT };
}

function seam(overrides: Partial<SeamState> = {}): SeamState {
  return { id: 'dec_quote', title: 'The quote object', currentVersion: 3, signedVersion: 3, satisfied: true, ...overrides };
}

function lane(overrides: Partial<LaneUnderGate> = {}): LaneUnderGate {
  return {
    laneId: 'wizard',
    owner: 'claude',
    submitted: true,
    changedFiles: ['src/checkout/Wizard.tsx'],
    declaredFiles: ['src/checkout/Wizard.tsx'],
    seams: [seam()],
    evidence: { statement: 'The flow completes in under three minutes.', produced: true },
    ...overrides
  };
}

function gate(overrides: Partial<GateInput> = {}): GateInput {
  return {
    lane: lane(),
    claims: [claim('src/checkout/Wizard.tsx', 'claude')],
    seamMates: [],
    mergesCleanly: true,
    ...overrides
  };
}

describe('a lane that did everything right', () => {
  it('lands', () => {
    const decision = evaluateMerge(gate());
    assert.equal(decision.verdict, 'merge');
    assert.deepEqual(decision.reasons, []);
    assert.match(summarize(decision, 'wizard'), /clear to land/);
  });
});

describe('territory', () => {
  it('refuses a file changed without ever being claimed — the headline case', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({
          changedFiles: ['src/checkout/Wizard.tsx', 'src/pricing/quote.ts'],
          // The agent quietly left the second file out of its own report.
          declaredFiles: ['src/checkout/Wizard.tsx']
        })
      })
    );

    assert.equal(decision.verdict, 'refuse');
    const refusal = decision.reasons.find((r) => r.code === 'unclaimed-files');
    assert.ok(refusal, 'an unclaimed change must be refused');
    assert.deepEqual(refusal.paths, ['src/pricing/quote.ts']);
    assert.deepEqual(
      decision.undeclared,
      ['src/pricing/quote.ts'],
      'and the omission is named, not just the violation'
    );
  });

  it('refuses a file another agent is holding', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({
          changedFiles: ['src/checkout/Wizard.tsx', 'src/pricing/quote.ts'],
          declaredFiles: ['src/checkout/Wizard.tsx', 'src/pricing/quote.ts']
        }),
        claims: [
          claim('src/checkout/Wizard.tsx', 'claude'),
          claim('src/pricing/quote.ts', 'cursor')
        ]
      })
    );

    assert.equal(decision.verdict, 'refuse');
    const refusal = decision.reasons.find((r) => r.code === 'foreign-files');
    assert.ok(refusal);
    assert.match(refusal.detail, /cursor/);
    assert.match(refusal.detail, /Claim, do not merge/);
  });

  it('notes an undeclared file it was entitled to change, without refusing', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({
          changedFiles: ['src/checkout/Wizard.tsx', 'src/checkout/Step2.tsx'],
          declaredFiles: ['src/checkout/Wizard.tsx']
        }),
        claims: [
          claim('src/checkout/Wizard.tsx', 'claude'),
          claim('src/checkout/Step2.tsx', 'claude')
        ]
      })
    );
    assert.equal(decision.verdict, 'merge', 'sloppy reporting is not a lane violation');
    assert.deepEqual(decision.undeclared, ['src/checkout/Step2.tsx']);
  });

  it('sees through a path dressed up differently', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({ changedFiles: ['./src//checkout/Wizard.tsx'], declaredFiles: ['src/checkout/Wizard.tsx'] })
      })
    );
    assert.equal(decision.verdict, 'merge');
    assert.deepEqual(decision.undeclared, []);
  });
});

describe('contracts', () => {
  it('refuses a contract this lane never confirmed', () => {
    const decision = evaluateMerge(
      gate({ lane: lane({ seams: [seam({ signedVersion: null })] }) })
    );
    assert.equal(decision.verdict, 'refuse');
    assert.equal(decision.reasons[0]?.code, 'seam-unsigned');
  });

  it('refuses a signature against a version that has since moved', () => {
    const decision = evaluateMerge(
      gate({ lane: lane({ seams: [seam({ currentVersion: 4, signedVersion: 3 })] }) })
    );
    assert.equal(decision.verdict, 'refuse');
    const stale = decision.reasons.find((r) => r.code === 'seam-stale');
    assert.ok(stale);
    assert.match(stale.detail, /v4 after this lane signed v3/);
    assert.match(stale.detail, /may no longer hold/);
  });

  it('refuses a lane that says outright it does not hold the contract', () => {
    const decision = evaluateMerge(
      gate({ lane: lane({ seams: [seam({ satisfied: false })] }) })
    );
    assert.equal(decision.verdict, 'refuse');
    assert.equal(decision.reasons[0]?.code, 'seam-unsatisfied');
  });

  it('reports unsigned, stale and unsatisfied separately when several seams fail', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({
          seams: [
            seam({ id: 'a', signedVersion: null }),
            seam({ id: 'b', currentVersion: 5, signedVersion: 2 }),
            seam({ id: 'c', satisfied: false })
          ]
        })
      })
    );
    assert.deepEqual(
      decision.reasons.map((r) => r.code),
      ['seam-unsigned', 'seam-stale', 'seam-unsatisfied']
    );
  });
});

describe('evidence', () => {
  it('refuses a lane that never showed its work', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({
          evidence: { statement: 'The quote for a known cart equals a known number.', produced: false }
        })
      })
    );
    assert.equal(decision.verdict, 'refuse');
    const missing = decision.reasons.find((r) => r.code === 'evidence-missing');
    assert.ok(missing);
    assert.match(missing.detail, /known cart/, 'the promise is quoted back');
  });

  it('lets a lane with nothing to prove through', () => {
    assert.equal(evaluateMerge(gate({ lane: lane({ evidence: null }) })).verdict, 'merge');
  });
});

describe('lanes that share a contract', () => {
  it('waits rather than refusing, when this lane is sound and its partner is not', () => {
    const decision = evaluateMerge(gate({ seamMates: [{ laneId: 'pricing', ready: false }] }));
    assert.equal(decision.verdict, 'wait');
    assert.equal(decision.reasons[0]?.code, 'seam-mate-not-ready');
    assert.match(decision.reasons[0]?.detail ?? '', /They land together/);
    assert.match(summarize(decision, 'wizard'), /waiting on the lane it shares a contract with/);
  });

  it('lands both once the partner is ready', () => {
    const decision = evaluateMerge(gate({ seamMates: [{ laneId: 'pricing', ready: true }] }));
    assert.equal(decision.verdict, 'merge');
  });

  it('refuses before it waits — its own problems come first', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({ seams: [seam({ satisfied: false })] }),
        seamMates: [{ laneId: 'pricing', ready: false }]
      })
    );
    assert.equal(decision.verdict, 'refuse');
    assert.ok(!decision.reasons.some((r) => r.code === 'seam-mate-not-ready'));
  });
});

describe('the rest of the gate', () => {
  it('refuses work that was never submitted', () => {
    const decision = evaluateMerge(gate({ lane: lane({ submitted: false }) }));
    assert.equal(decision.verdict, 'refuse');
    assert.equal(decision.reasons[0]?.code, 'not-submitted');
  });

  it('refuses a branch that no longer merges cleanly', () => {
    const decision = evaluateMerge(gate({ mergesCleanly: false }));
    assert.equal(decision.verdict, 'refuse');
    assert.equal(decision.reasons.find((r) => r.code === 'conflicts')?.code, 'conflicts');
  });

  it('gives every reason at once, so a lane is not fixed one round trip at a time', () => {
    const decision = evaluateMerge(
      gate({
        lane: lane({
          changedFiles: ['src/checkout/Wizard.tsx', 'src/pricing/quote.ts'],
          declaredFiles: [],
          seams: [seam({ signedVersion: null })],
          evidence: { statement: 'Under three minutes.', produced: false }
        }),
        mergesCleanly: false
      })
    );
    assert.deepEqual(
      decision.reasons.map((r) => r.code).sort(),
      ['conflicts', 'evidence-missing', 'seam-unsigned', 'unclaimed-files']
    );
    assert.match(summarize(decision, 'wizard'), /\(\+3 more\)/);
  });
});
