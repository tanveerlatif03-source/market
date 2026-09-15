import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openRoom } from '../src/index.ts';
import { MergeGate } from '../src/gate/gate.ts';
import { unanswered } from '../src/room/attention.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal } from './helpers.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * The grid, in a room (Q19).
 *
 * The condition this has to meet: **forty files, one check, three agents, and
 * the person is asked once rather than forty times.**
 *
 * Both halves matter. Three agents sweeping in parallel is the throughput
 * argument, and it only works because Agora hands rows out rather than making
 * agents negotiate. Being asked once is the supervision argument, and it is the
 * one that decides whether a sweep of this size is usable at all — a queue with
 * forty items in it is a queue nobody reads, which is exactly what Q8 said
 * about a room of six people and one question.
 *
 * The thing Q19 actually parked — a formula language — is not here and is not
 * wanted. Agora expands a list of paths into rows and never reads the
 * instruction it is carrying.
 */

const MODULES = Array.from({ length: 40 }, (_, index) => `src/log/m${index}.ts`);

interface Stage {
  service: RoomService;
  sweepLane: string;
  otherLane: string;
  seamId: string;
}

/** A lane whose whole job is the same change, forty times. */
async function roomWithASweep(): Promise<Stage> {
  const service = await openRoom({
    file: null,
    name: 'Logging',
    goal: 'Move every module onto the structured logger.'
  });
  await service.setRiskList(OWNER_ID, []);
  await service.addHuman(OWNER_ID, { id: 'priya', displayName: 'Priya', canMerge: true });
  for (const [id, name] of [
    ['claude', 'Claude'],
    ['cursor', 'Cursor'],
    ['codex', 'Codex']
  ] as const) {
    await service.addAgent(OWNER_ID, {
      id,
      displayName: name,
      provider: id,
      role: id === 'claude' ? 'lead' : 'peer'
    });
  }

  await service.claimTask('claude', { taskId: 'plan' });
  await service.submitWork('claude', {
    taskId: 'plan',
    summary: 'One sweeping lane, one interface lane.',
    outcome: 'needs-review',
    plan: {
      tasks: [
        {
          key: 'sweep',
          title: 'Swap the logger everywhere',
          paths: ['src/log/**'],
          suggestedOwner: 'claude',
          evidence: 'Every module logs through the structured logger and the old one is gone.',
          actionBudget: 200
        },
        {
          key: 'logger',
          title: 'The structured logger',
          paths: ['src/logger/**'],
          suggestedOwner: 'cursor',
          evidence: 'The logger emits JSON with a level and a message.',
          actionBudget: 60
        }
      ],
      seams: [
        {
          title: 'log(level, message, fields)',
          body: 'log(level, message, fields?) — level is one of debug|info|warn|error.',
          between: ['sweep', 'logger'],
          contract: [
            { task: 'sweep', provides: 'Call sites.', expects: 'log(level, message, fields?).' },
            { task: 'logger', provides: 'log(level, message, fields?).', expects: 'Call sites.' }
          ]
        }
      ]
    }
  });
  await service.approvePlan(OWNER_ID, 'Good.');

  const room = service.snapshot();
  const sweepLane = room.tasks.find((task) => task.title.startsWith('Swap'))?.id as string;
  const otherLane = room.tasks.find((task) => task.title.startsWith('The structured'))?.id as string;
  const seamId = room.decisions.find((decision) => decision.kind === 'seam')?.id as string;

  await service.assignLaneOwner(OWNER_ID, sweepLane, 'priya');
  await service.claimTask('claude', { taskId: sweepLane });
  await service.claimTask('cursor', { taskId: otherLane });

  return { service, sweepLane, otherLane, seamId };
}

async function openSweep(s: Stage): Promise<string> {
  const { batch } = await s.service.openBatch('claude', {
    laneId: s.sweepLane,
    title: 'Swap the logger',
    instruction: 'Replace console.log with log(). Leave tests alone.',
    subjects: MODULES
  });
  return batch.id;
}

describe('forty files, three agents', () => {
  it('makes one row per file, and no language to go with it', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const [sweep] = s.service.batchesFor(s.sweepLane);

    assert.equal(sweep?.batch.id, id);
    assert.equal(sweep?.progress.total, 40);
    // The instruction is prose, stored and handed on untouched. Agora does not
    // read it, which is the whole of what Q19 parked.
    assert.equal(sweep?.batch.instruction, 'Replace console.log with log(). Leave tests alone.');
  });

  it('lets three agents work it at once without anyone asking anyone', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);

    const claude = await s.service.takeRows('claude', { batchId: id, count: 15 });
    const cursor = await s.service.takeRows('cursor', { batchId: id, count: 15 });
    const codex = await s.service.takeRows('codex', { batchId: id, count: 15 });

    assert.equal(claude.rows.length, 15);
    assert.equal(cursor.rows.length, 15);
    assert.equal(codex.rows.length, 10, 'the third agent gets what is left, not an argument');

    const subjects = [...claude.rows, ...cursor.rows, ...codex.rows].map((row) => row.subject);
    assert.equal(new Set(subjects).size, 40, 'nobody got the same file twice');
    assert.equal(s.service.batchesFor(s.sweepLane)[0]?.progress.pending, 0);
  });

  it('hands every agent the same instruction, once', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const cursor = await s.service.takeRows('cursor', { batchId: id, count: 1 });
    assert.match(cursor.instruction, /Replace console\.log/);
  });

  it('lets an agent that does not own the lane hold its ground while on a row', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const taken = await s.service.takeRows('codex', { batchId: id, count: 1 });
    const subject = taken.rows[0]?.subject as string;

    // Territory belongs to the lane; holding a row is holding a right to it.
    const claimed = await s.service.claimFile('codex', { path: subject, laneId: s.sweepLane });
    assert.equal(claimed.outcome, 'granted');
    assert.equal(s.service.snapshot().claims.find((c) => c.path === subject)?.laneId, s.sweepLane);
  });

  it('still refuses an agent with no business in the lane at all', async () => {
    const s = await roomWithASweep();
    await openSweep(s);
    const error = await refusal(
      () => s.service.claimFile('codex', { path: 'src/log/m0.ts', laneId: s.sweepLane }),
      'NOT_OWNER'
    );
    assert.match(error.remedy, /take a row of its grid/);
  });

  it('refuses a sweep over files outside its lane', async () => {
    const s = await roomWithASweep();
    const error = await refusal(
      () =>
        s.service.openBatch('claude', {
          laneId: s.sweepLane,
          title: 'Reach',
          instruction: 'Do it.',
          subjects: ['src/log/m0.ts', 'src/logger/index.ts']
        }),
      'OUT_OF_SCOPE'
    );
    assert.match(error.message, /outside the lane/);
  });

  it('refuses a sweep on a lane somebody else owns', async () => {
    const s = await roomWithASweep();
    await refusal(
      () =>
        s.service.openBatch('codex', {
          laneId: s.sweepLane,
          title: 'Not mine',
          instruction: 'Do it.',
          subjects: MODULES
        }),
      'NOT_OWNER'
    );
  });
});

describe('the person is asked once', () => {
  /** Nine of the forty hit the same wall; the rest go through. */
  async function nineStuck(s: Stage, id: string): Promise<void> {
    for (const agent of ['claude', 'cursor', 'codex']) {
      let taken = await s.service.takeRows(agent, { batchId: id, count: 14 });
      while (taken.rows.length > 0) {
        for (const row of taken.rows) {
          const index = Number(/m(\d+)\.ts$/.exec(row.subject)?.[1] ?? '0');
          await s.service.finishRow(agent, {
            rowId: row.id,
            outcome: index < 9 ? 'stuck' : 'done',
            finding:
              index < 9
                ? 'This package has no logger dependency.'
                : 'Swapped console.log for log().'
          });
        }
        taken = await s.service.takeRows(agent, { batchId: id, count: 14 });
      }
    }
  }

  it('raises one question for nine stuck rows, not nine', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    await nineStuck(s, id);

    const open = unanswered(s.service.snapshot().attention);
    assert.equal(open.length, 1, 'nine rows stuck on one thing is one question');

    const item = open[0];
    assert.match(item?.title ?? '', /stuck on 9 row\(s\)/);
    assert.match(item?.detail ?? '', /9 of them say the same thing/);
    assert.match(item?.detail ?? '', /no logger dependency/);
    assert.deepEqual(item?.options.map((option) => option.id), ['answer', 'skip-them', 'drop']);
  });

  it('does not raise a second question as more rows hit the same wall', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    await nineStuck(s, id);
    const first = unanswered(s.service.snapshot().attention)[0];

    // The lane owner sends a stuck row round again and it gets stuck the same way.
    await s.service.answerAttention('priya', {
      itemId: first?.id as string,
      optionId: 'answer',
      note: 'Add the logger to the package first, then swap.'
    });
    const again = await s.service.takeRows('claude', { batchId: id, count: 9 });
    for (const row of again.rows) {
      await s.service.finishRow('claude', {
        rowId: row.id,
        outcome: 'stuck',
        finding: 'This package has no logger dependency.'
      });
    }

    assert.equal(
      unanswered(s.service.snapshot().attention).length,
      1,
      'still one, refreshed rather than piled up'
    );
  });

  it('carries one answer onto every row it covers', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    await nineStuck(s, id);

    const item = unanswered(s.service.snapshot().attention)[0];
    await s.service.answerAttention('priya', {
      itemId: item?.id as string,
      optionId: 'answer',
      note: 'Add the logger to the package first, then swap.'
    });

    const rows = s.service.batchesFor(s.sweepLane)[0]?.batch.rows ?? [];
    const settled = rows.filter((row) => row.finding.startsWith('A person answered this'));
    assert.equal(settled.length, 9, 'one answer, nine rows');
    assert.ok(settled.every((row) => row.state === 'pending'), 'and they go back to be redone');
    assert.match(settled[0]?.finding ?? '', /Add the logger to the package first/);
  });

  it('can settle them all the other way, in one answer', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    await nineStuck(s, id);

    const item = unanswered(s.service.snapshot().attention)[0];
    await s.service.answerAttention('priya', {
      itemId: item?.id as string,
      optionId: 'skip-them',
      note: 'Those packages are being retired anyway.'
    });

    const sweep = s.service.batchesFor(s.sweepLane)[0];
    assert.equal(sweep?.progress.stuck, 0);
    assert.equal(sweep?.progress.skipped, 9);
    assert.equal(sweep?.progress.finished, true);
    assert.deepEqual(unanswered(s.service.snapshot().attention), []);
  });

  it('says so when the whole sweep changed nothing', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);

    let taken = await s.service.takeRows('claude', { batchId: id, count: 40 });
    for (const row of taken.rows) {
      await s.service.finishRow('claude', {
        rowId: row.id,
        outcome: 'skipped',
        finding: 'No console.log in this file.'
      });
    }
    taken = await s.service.takeRows('claude', { batchId: id, count: 1 });
    assert.equal(taken.rows.length, 0);

    const item = unanswered(s.service.snapshot().attention)[0];
    assert.ok(item, 'forty rows finding nothing is worth one look');
    assert.match(item.title, /changed nothing, across every row/);
    assert.match(item.detail, /an instruction that did not ask for what you meant/);
    assert.deepEqual(item.options.map((option) => option.id), ['accept', 'reword', 'drop']);
  });

  it('puts every row back when the instruction turns out to be the problem', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const taken = await s.service.takeRows('claude', { batchId: id, count: 40 });
    for (const row of taken.rows) {
      await s.service.finishRow('claude', {
        rowId: row.id,
        outcome: 'skipped',
        finding: 'No console.log in this file.'
      });
    }

    const item = unanswered(s.service.snapshot().attention)[0];
    await s.service.answerAttention('priya', {
      itemId: item?.id as string,
      optionId: 'reword',
      note: 'Replace every logging call, not only console.log.'
    });

    const sweep = s.service.batchesFor(s.sweepLane)[0];
    assert.equal(sweep?.progress.pending, 40, 'all forty go round again');
    assert.match(sweep?.batch.instruction ?? '', /not only console\.log/);
  });

  it('asks nothing at all about a sweep that did its job', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const taken = await s.service.takeRows('claude', { batchId: id, count: 40 });
    for (const row of taken.rows) {
      await s.service.finishRow('claude', {
        rowId: row.id,
        outcome: 'done',
        finding: 'Swapped console.log for log().'
      });
    }
    assert.deepEqual(unanswered(s.service.snapshot().attention), []);
    const done = s.service.snapshot().events.find((event) => event.type === 'batch.finished');
    assert.match(done?.summary ?? '', /40 changed/);
  });
});

describe('a row always answers for itself', () => {
  it('refuses a finding of nothing at all', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const taken = await s.service.takeRows('claude', { batchId: id, count: 1 });
    const error = await refusal(
      () =>
        s.service.finishRow('claude', {
          rowId: taken.rows[0]?.id as string,
          outcome: 'skipped',
          finding: '   '
        }),
      'INVALID'
    );
    assert.match(error.remedy, /"Nothing" on forty rows is itself/);
  });

  it('refuses an agent answering for a row it never took', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const taken = await s.service.takeRows('claude', { batchId: id, count: 1 });
    await refusal(
      () =>
        s.service.finishRow('cursor', {
          rowId: taken.rows[0]?.id as string,
          outcome: 'done',
          finding: 'Not mine to answer.'
        }),
      'NOT_OWNER'
    );
  });

  it('stops handing out rows once the lane has spent its cap', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    await s.service.setTaskBudget(OWNER_ID, s.sweepLane, 1);
    await refusal(() => s.service.takeRows('cursor', { batchId: id, count: 5 }), 'BUDGET_EXHAUSTED');
  });
});

describe('a lane cannot land over a half-swept sweep', () => {
  it('refuses at the gate, and says where the sweep got to', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const taken = await s.service.takeRows('claude', { batchId: id, count: 5 });
    for (const row of taken.rows) {
      await s.service.finishRow('claude', { rowId: row.id, outcome: 'done', finding: 'Swapped.' });
    }

    const gate = new MergeGate(s.service, { repo: { root: '/tmp/agora-nowhere' } });
    const decision = await gate.evaluate(s.sweepLane);
    const reason = decision.reasons.find((entry) => entry.code === 'sweep-unfinished');
    assert.ok(reason, 'shipping "we did some of the forty" as finished is the failure here');
    assert.match(reason.detail, /5\/40 looked at/);
  });

  it('shows it in the Ledger, where a person walks in', async () => {
    const s = await roomWithASweep();
    const id = await openSweep(s);
    const taken = await s.service.takeRows('claude', { batchId: id, count: 5 });
    for (const row of taken.rows) {
      await s.service.finishRow('claude', { rowId: row.id, outcome: 'done', finding: 'Swapped.' });
    }

    const row = s.service.ledger().find((entry) => entry.laneId === s.sweepLane);
    assert.equal(row?.sweep?.finished, false);
    assert.match(row?.sweep?.summary ?? '', /5\/40 looked at/);
    assert.match(row?.blockedOn ?? '', /rows nobody has answered for/);
  });

  it('tells any agent there is a sweep with rows going spare', async () => {
    const s = await roomWithASweep();
    await openSweep(s);
    const view = await s.service.readRoom('codex', {});
    assert.equal(view.sweeps.length, 1);
    assert.equal(view.sweeps[0]?.pending, 40);
    assert.ok(
      view.guidance.some((line) => /row\(s\) nobody has taken/.test(line)),
      'work anyone can pick up should not need to be discovered'
    );
  });
});
