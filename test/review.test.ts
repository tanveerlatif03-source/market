import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RISK_LIST,
  reviewRequirements,
  risksTouched,
  unsignedRisks
} from '../src/room/review.ts';
import type { LaneSeamContext, Review, RiskSignOff } from '../src/room/review.ts';
import { refusal, roomWithApprovedPlan } from './helpers.ts';
import { OWNER_ID } from '../src/room/seed.ts';

/**
 * Cross-review at the seam (Q13).
 *
 * The bet: the agent across a contract catches most of what matters, because it
 * has the context and a stake in the answer. These tests are about the part
 * that has to be mechanical — who owes the review, and when a review stops
 * counting.
 */

const AT = '2026-09-15T12:00:00.000Z';
const LATER = '2026-09-15T13:00:00.000Z';

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'rev_1',
    laneId: 'wizard',
    seamId: 'dec_quote',
    by: 'cursor',
    verdict: 'holds',
    note: 'Sends {sku, qty}.',
    submissionId: 'sub_1',
    seamVersion: 1,
    at: AT,
    ...overrides
  };
}

function context(overrides: Partial<LaneSeamContext> = {}): LaneSeamContext {
  return {
    laneId: 'wizard',
    latestSubmissionId: 'sub_1',
    seams: [
      {
        id: 'dec_quote',
        title: 'The quote object',
        version: 1,
        partnerLaneId: 'pricing',
        partnerOwner: 'cursor'
      }
    ],
    reviews: [],
    ...overrides
  };
}

describe('who owes a review', () => {
  it('names the agent across the contract, and says nothing has been read', () => {
    const [requirement] = reviewRequirements(context());
    assert.equal(requirement?.reviewer, 'cursor');
    assert.equal(requirement?.state, 'missing');
    assert.match(requirement?.why ?? '', /has not read this lane/);
  });

  it('passes a lane that was read against what is there now', () => {
    const [requirement] = reviewRequirements(context({ reviews: [review()] }));
    assert.equal(requirement?.state, 'holds');
    assert.equal(requirement?.why, '');
  });

  it('asks for nothing when a lane shares no contract', () => {
    assert.deepEqual(reviewRequirements(context({ seams: [] })), []);
  });

  it('says so plainly when nobody holds the other side yet', () => {
    const [requirement] = reviewRequirements(
      context({
        seams: [
          {
            id: 'dec_quote',
            title: 'The quote object',
            version: 1,
            partnerLaneId: 'pricing',
            partnerOwner: null
          }
        ]
      })
    );
    assert.equal(requirement?.state, 'unreviewable');
    assert.match(requirement?.why ?? '', /has to be claimed first/);
  });

  it('ignores a review by anyone but the agent across the contract', () => {
    // A third agent reading it is welcome to, but it does not discharge this.
    const [requirement] = reviewRequirements(context({ reviews: [review({ by: 'codex' })] }));
    assert.equal(requirement?.state, 'missing');
  });
});

describe('a review that stopped counting', () => {
  it('goes stale when the contract moves under it (Q14)', () => {
    const [requirement] = reviewRequirements(
      context({
        seams: [
          {
            id: 'dec_quote',
            title: 'The quote object',
            version: 2,
            partnerLaneId: 'pricing',
            partnerOwner: 'cursor'
          }
        ],
        reviews: [review({ seamVersion: 1 })]
      })
    );
    assert.equal(requirement?.state, 'stale');
    assert.match(requirement?.why ?? '', /v1; the contract is now v2/);
  });

  it('goes stale when the lane resubmits after being read', () => {
    const [requirement] = reviewRequirements(
      context({ latestSubmissionId: 'sub_2', reviews: [review({ submissionId: 'sub_1' })] })
    );
    assert.equal(requirement?.state, 'stale');
    assert.match(requirement?.why ?? '', /code that is gone/);
  });

  it('takes only the reviewer’s last word', () => {
    const [requirement] = reviewRequirements(
      context({
        reviews: [
          review({ id: 'rev_1', verdict: 'breaks', note: 'Sends strings.', at: AT }),
          review({ id: 'rev_2', verdict: 'holds', note: 'Fixed; integers now.', at: LATER })
        ]
      })
    );
    assert.equal(requirement?.state, 'holds');
  });

  it('carries a refusal through with the reason the reviewer gave', () => {
    const [requirement] = reviewRequirements(
      context({ reviews: [review({ verdict: 'breaks', note: 'Totals come back as floats.' })] })
    );
    assert.equal(requirement?.state, 'breaks');
    assert.match(requirement?.why ?? '', /floats/);
  });
});

describe('the risk list', () => {
  it('catches the four surfaces the design named', () => {
    const hits = risksTouched(
      [
        'src/auth/session.ts',
        'src/checkout/Wizard.tsx',
        'db/migrations/003_add_users.sql',
        'openapi.yaml',
        'src/util/format.ts'
      ],
      DEFAULT_RISK_LIST
    );
    assert.deepEqual(hits.map((hit) => hit.rule.id).sort(), [
      'auth',
      'payments',
      'public-api',
      'schema'
    ]);
  });

  it('leaves ordinary work alone — default light is the point', () => {
    assert.deepEqual(risksTouched(['src/util/format.ts', 'README.md'], DEFAULT_RISK_LIST), []);
  });

  it('can be turned all the way up by a team that will not take the bet', () => {
    const everything = [{ id: 'all', label: 'Everything', paths: ['**'], why: 'We read it all.' }];
    assert.equal(risksTouched(['src/util/format.ts'], everything).length, 1);
  });
});

describe('signing off a risky surface', () => {
  const hits = risksTouched(['src/auth/session.ts'], DEFAULT_RISK_LIST);
  const signOff = (overrides: Partial<RiskSignOff> = {}): RiskSignOff => ({
    id: 'sig_1',
    laneId: 'login',
    submissionId: 'sub_1',
    ruleIds: ['auth'],
    by: 'priya',
    note: 'Read it.',
    at: AT,
    ...overrides
  });

  it('clears the rule a person actually looked at', () => {
    assert.deepEqual(
      unsignedRisks(hits, [signOff()], { laneId: 'login', latestSubmissionId: 'sub_1' }),
      []
    );
  });

  it('does not carry over to the next submission', () => {
    const open = unsignedRisks(hits, [signOff()], { laneId: 'login', latestSubmissionId: 'sub_2' });
    assert.deepEqual(open.map((hit) => hit.rule.id), ['auth']);
  });

  it('covers only the rules the person was shown', () => {
    const both = risksTouched(['src/auth/session.ts', 'prisma/schema.prisma'], DEFAULT_RISK_LIST);
    const open = unsignedRisks(both, [signOff()], { laneId: 'login', latestSubmissionId: 'sub_1' });
    assert.deepEqual(open.map((hit) => hit.rule.id), ['schema']);
  });
});

describe('recording a review in a room', () => {
  async function submitted(): Promise<Awaited<ReturnType<typeof roomWithApprovedPlan>>> {
    const room = await roomWithApprovedPlan();
    await room.service.setRiskList(OWNER_ID, []);
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Form posts and renders both states.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Posts {email, password}.' }]
    });
    return room;
  }

  it('lets the agent across the contract read it, and tells the lane owner', async () => {
    const room = await submitted();
    const { review: recorded } = await room.service.reviewLane(room.cursor, {
      laneId: room.ui,
      verdict: 'holds',
      note: 'It posts the body the contract says it does.'
    });
    assert.equal(recorded.by, room.cursor);
    assert.equal(recorded.seamId, room.seamId);
    assert.deepEqual(room.service.reviewsDue(room.cursor), []);
  });

  it('refuses an agent reviewing its own work', async () => {
    const room = await submitted();
    const error = await refusal(
      () => room.service.reviewLane(room.claude, { laneId: room.ui, verdict: 'holds', note: 'Fine.' }),
      'INVALID'
    );
    assert.match(error.message, /cannot review your own lane/);
  });

  it('refuses an agent that shares no contract with the lane', async () => {
    const room = await submitted();
    await room.service.addAgent(OWNER_ID, {
      id: 'codex',
      displayName: 'Codex',
      provider: 'codex',
      role: 'peer'
    });
    const error = await refusal(
      () => room.service.reviewLane('codex', { laneId: room.ui, verdict: 'breaks', note: 'No.' }),
      'UNAUTHORIZED'
    );
    assert.match(error.message, /not yours to pass or fail/);
  });

  it('refuses to review work that has not been finished', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });
    const error = await refusal(
      () => room.service.reviewLane(room.cursor, { laneId: room.ui, verdict: 'holds', note: 'Fine.' }),
      'INVALID'
    );
    assert.match(error.message, /nothing finished to read/);
  });

  it('puts a disagreement about a contract in front of a person', async () => {
    const room = await submitted();
    await room.service.addHuman(OWNER_ID, { id: 'priya', displayName: 'Priya', canMerge: true });
    await room.service.assignLaneOwner(OWNER_ID, room.ui, 'priya');

    await room.service.reviewLane(room.cursor, {
      laneId: room.ui,
      verdict: 'breaks',
      note: 'It posts {username, password}; the contract says {email, password}.'
    });

    const item = room.service.attentionFor('priya').yours.find((entry) => entry.kind === 'ruling');
    assert.ok(item, 'two agents cannot settle a contract between themselves');
    assert.match(item.detail, /username/);
    assert.deepEqual(item.options.map((option) => option.id), [
      'side-with-reviewer',
      'side-with-lane',
      'amend'
    ]);
  });

  it('tells the reviewer what it owes, unprompted', async () => {
    const room = await submitted();
    const view = await room.service.readRoom(room.cursor, {});
    assert.equal(view.you.reviewsDue.length, 1);
    assert.equal(view.you.reviewsDue[0]?.laneId, room.ui);
    assert.ok(
      view.guidance.some((line) => /review_lane/.test(line)),
      'and says so before it says anything about its own lane'
    );
  });
});
