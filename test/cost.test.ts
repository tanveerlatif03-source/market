import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { costReport, quotaWarnings, summarizeCost } from '../src/room/cost.ts';
import type { CostEntry, CostReport } from '../src/room/cost.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal, roomWithApprovedPlan } from './helpers.ts';

/**
 * What the work cost (Q15).
 *
 * The rule under test is a refusal: three different kinds of fact about the
 * same work are never added together, because the sum would be the only number
 * on the screen and it would be made up.
 */

let counter = 0;
function entry(overrides: Partial<CostEntry> = {}): CostEntry {
  counter += 1;
  return {
    id: `cost_${counter}`,
    laneId: 'login',
    agentId: 'claude',
    provenance: 'reported',
    amount: 1000,
    unit: 'tokens',
    limit: null,
    note: '',
    at: '2026-09-15T12:00:00.000Z',
    ...overrides
  };
}

describe('three kinds of fact, kept apart', () => {
  it('has no total, and cannot grow one by accident', () => {
    const report: CostReport = costReport([
      entry({ provenance: 'metered', amount: 420, unit: 'usd-cents' }),
      entry({ provenance: 'reported', amount: 90_000, unit: 'tokens' }),
      entry({ provenance: 'quota', amount: 180, unit: 'requests', limit: 200 })
    ]);
    assert.equal('total' in report, false, 'a blended total would hide the whole difference');
    assert.equal(report.lines.length, 3);
    assert.match(report.caveat, /do not add up, on purpose/);
  });

  it('adds up two readings of the same kind, and only those', () => {
    const report = costReport([
      entry({ provenance: 'reported', amount: 1000, unit: 'tokens' }),
      entry({ provenance: 'reported', amount: 500, unit: 'tokens' }),
      entry({ provenance: 'reported', amount: 7, unit: 'requests' })
    ]);
    const tokens = report.lines.find((line) => line.unit === 'tokens');
    const requests = report.lines.find((line) => line.unit === 'requests');
    assert.equal(tokens?.amount, 1500);
    assert.equal(requests?.amount, 7, 'tokens and requests are not the same number either');
  });

  it('treats a quota as a level, not a running total', () => {
    const report = costReport([
      entry({ provenance: 'quota', amount: 40, unit: 'requests', limit: 200 }),
      entry({ provenance: 'quota', amount: 150, unit: 'requests', limit: 200 })
    ]);
    const quota = report.lines[0];
    assert.equal(quota?.amount, 150, 'the latest reading is what is left, not 190');
    assert.equal(quota?.limit, 200);
  });

  it('says how much each figure is worth, rather than implying it', () => {
    const report = costReport([
      entry({ provenance: 'metered', amount: 5, unit: 'usd-cents' }),
      entry({ provenance: 'reported', amount: 5, unit: 'tokens' })
    ]);
    const metered = report.lines.find((line) => line.provenance === 'metered');
    const reported = report.lines.find((line) => line.provenance === 'reported');
    assert.match(metered?.confidence ?? '', /Exact/);
    assert.match(reported?.confidence ?? '', /their count, not ours/);
  });

  it('does not pretend nothing counted means nothing spent', () => {
    const report = costReport([]);
    assert.deepEqual(report.lines, []);
    assert.match(report.caveat, /not the same as it being free/);
  });

  it('scopes to one lane when asked', () => {
    const entries = [
      entry({ laneId: 'login', amount: 100 }),
      entry({ laneId: 'sessions', amount: 900 })
    ];
    assert.equal(costReport(entries, 'login').lines[0]?.amount, 100);
  });
});

describe('the one that actually stops the work', () => {
  it('warns when a quota is nearly gone', () => {
    const report = costReport([
      entry({ provenance: 'quota', amount: 190, unit: 'requests', limit: 200 })
    ]);
    const warnings = quotaWarnings(report);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /stops the work rather than costing more/);
  });

  it('says nothing about a quota with room left', () => {
    const report = costReport([
      entry({ provenance: 'quota', amount: 10, unit: 'requests', limit: 200 })
    ]);
    assert.deepEqual(quotaWarnings(report), []);
  });

  it('never warns about tokens, which do not run out', () => {
    const report = costReport([entry({ provenance: 'reported', amount: 9_000_000 })]);
    assert.deepEqual(quotaWarnings(report), []);
  });
});

describe('one line for a table cell', () => {
  it('shows a quota as level over ceiling', () => {
    const report = costReport([
      entry({ provenance: 'quota', amount: 150, unit: 'requests', limit: 200 })
    ]);
    assert.equal(summarizeCost(report), '150/200 requests (quota)');
  });

  it('keeps the provenances separate even on one line', () => {
    const report = costReport([
      entry({ provenance: 'metered', amount: 420, unit: 'usd-cents' }),
      entry({ provenance: 'reported', amount: 90_000, unit: 'tokens' })
    ]);
    assert.equal(summarizeCost(report), '420 usd-cents (metered) · 90000 tokens (reported)');
  });

  it('says so when nothing was counted', () => {
    assert.equal(summarizeCost(costReport([])), 'not counted');
  });
});

describe('an agent reporting what it used', () => {
  it('records the figure with where it came from', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const { entry: recorded } = await room.service.recordCost(room.claude, {
      laneId: room.ui,
      provenance: 'reported',
      amount: 41_000,
      unit: 'tokens',
      note: 'Through the wizard rewrite.'
    });
    assert.equal(recorded.provenance, 'reported');
    assert.equal(recorded.limit, null);
    assert.equal(room.service.costFor(room.ui).lines[0]?.amount, 41_000);
  });

  it('refuses a quota with no ceiling, because it would say nothing', async () => {
    const room = await roomWithApprovedPlan();
    const error = await refusal(
      () =>
        room.service.recordCost(room.claude, {
          provenance: 'quota',
          amount: 150,
          unit: 'requests'
        }),
      'INVALID'
    );
    assert.match(error.remedy, /a quota with no limit says nothing/);
  });

  it('gets a person involved before the quota runs out, not after', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.addHuman(OWNER_ID, { id: 'priya', displayName: 'Priya', canMerge: true });
    await room.service.assignLaneOwner(OWNER_ID, room.ui, 'priya');
    await room.service.claimTask(room.claude, { taskId: room.ui });

    await room.service.recordCost(room.claude, {
      laneId: room.ui,
      provenance: 'quota',
      amount: 195,
      unit: 'requests',
      limit: 200
    });

    const item = room.service.attentionFor('priya').yours.find((entry) => entry.kind === 'budget');
    assert.ok(item, 'running out mid-lane is worse than being told beforehand');
    assert.equal(item.needsMergeRights, false, 'and it is reversible, so anyone can answer it');
    assert.deepEqual(item.options.map((option) => option.id), ['carry-on', 'reassign', 'pause']);
  });

  it('asks once, not once per reading', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    for (const amount of [191, 193, 197]) {
      await room.service.recordCost(room.claude, {
        laneId: room.ui,
        provenance: 'quota',
        amount,
        unit: 'requests',
        limit: 200
      });
    }
    const raised = room.service
      .snapshot()
      .attention.filter((item) => item.kind === 'budget' && item.laneId === room.ui);
    assert.equal(raised.length, 1);
  });
});
