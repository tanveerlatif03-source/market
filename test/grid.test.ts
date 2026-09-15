import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocate,
  assessSweep,
  collapseFindings,
  heldBy,
  progressOf,
  unfinishedBatches
} from '../src/room/grid.ts';
import type { Batch, RowState } from '../src/room/grid.ts';

/**
 * The grid (Q19).
 *
 * Q19 parked a formula language and kept the shape that prompted it: the same
 * check across forty files, one row each. These tests are about that shape, and
 * about the two properties that make it worth having — rows are handed out
 * rather than negotiated, and forty findings are not forty questions.
 */

const AT = '2026-09-15T12:00:00.000Z';

function batch(rows: { subject: string; state?: RowState; agent?: string; finding?: string }[]): Batch {
  return {
    id: 'grid_1',
    laneId: 'sweep',
    title: 'Replace the old logger',
    instruction: 'Swap console.log for the structured logger. Leave tests alone.',
    fromPaths: rows.map((row) => row.subject),
    rows: rows.map((row, index) => ({
      id: `row_${index}`,
      subject: row.subject,
      state: row.state ?? 'pending',
      agent: row.agent ?? null,
      finding: row.finding ?? '',
      takenAt: null,
      finishedAt: null
    })),
    openedBy: 'claude',
    openedAt: AT,
    attentionId: null
  };
}

/** Forty files, which is the number Q19 actually named. */
function forty(state: RowState = 'pending'): Batch {
  return batch(
    Array.from({ length: 40 }, (_, index) => ({ subject: `src/m${index}.ts`, state }))
  );
}

describe('handing rows out', () => {
  it('gives an agent what it asked for, and marks them taken', () => {
    const sweep = forty();
    const rows = allocate(sweep, 'claude', 5, AT);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.state === 'taken' && row.agent === 'claude'));
    assert.equal(progressOf(sweep).pending, 35);
  });

  it('never hands the same row to two agents', () => {
    const sweep = forty();
    const first = allocate(sweep, 'claude', 20, AT);
    const second = allocate(sweep, 'cursor', 20, AT);
    const third = allocate(sweep, 'codex', 20, AT);

    assert.equal(first.length + second.length + third.length, 40);
    const ids = [...first, ...second, ...third].map((row) => row.id);
    assert.equal(new Set(ids).size, 40, 'three agents, forty rows, nobody negotiated');
    assert.equal(progressOf(sweep).pending, 0);
  });

  it('hands back what is left rather than refusing', () => {
    const sweep = batch([{ subject: 'a.ts' }, { subject: 'b.ts' }]);
    assert.equal(allocate(sweep, 'claude', 10, AT).length, 2);
    assert.deepEqual(allocate(sweep, 'cursor', 10, AT), []);
  });

  it('knows what each agent is still holding', () => {
    const sweep = forty();
    allocate(sweep, 'claude', 3, AT);
    allocate(sweep, 'cursor', 2, AT);
    assert.equal(heldBy(sweep, 'claude').length, 3);
    assert.equal(heldBy(sweep, 'cursor').length, 2);
    assert.equal(heldBy(sweep, 'codex').length, 0);
  });
});

describe('where a sweep stands', () => {
  it('counts each state separately', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'done' },
      { subject: 'b.ts', state: 'skipped' },
      { subject: 'c.ts', state: 'stuck' },
      { subject: 'd.ts', state: 'taken', agent: 'claude' },
      { subject: 'e.ts' }
    ]);
    const progress = progressOf(sweep);
    assert.deepEqual(
      { done: progress.done, skipped: progress.skipped, stuck: progress.stuck, taken: progress.taken, pending: progress.pending },
      { done: 1, skipped: 1, stuck: 1, taken: 1, pending: 1 }
    );
    assert.equal(progress.finished, false);
  });

  it('is not finished while a row is still in somebody’s hands', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'done' },
      { subject: 'b.ts', state: 'taken', agent: 'claude' }
    ]);
    assert.equal(progressOf(sweep).finished, false);
  });

  it('is finished when every row has been answered for', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'done' },
      { subject: 'b.ts', state: 'skipped' }
    ]);
    assert.equal(progressOf(sweep).finished, true);
  });

  it('says where it is in one line', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'done' },
      { subject: 'b.ts', state: 'skipped' },
      { subject: 'c.ts' }
    ]);
    assert.equal(progressOf(sweep).summary, '2/3 looked at, 1 changed, 1 left alone');
  });
});

describe('forty findings are not forty questions', () => {
  it('collapses rows that came back with the same thing', () => {
    const sweep = batch(
      Array.from({ length: 12 }, (_, index) => ({
        subject: `src/m${index}.ts`,
        state: 'stuck' as RowState,
        finding: 'There is no logger import in this package.'
      }))
    );
    const findings = collapseFindings(sweep, ['stuck']);
    assert.equal(findings.length, 1, 'twelve rows, one question');
    assert.equal(findings[0]?.subjects.length, 12);
  });

  it('does not treat whitespace or case as a different answer', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'stuck', finding: 'No logger import.' },
      { subject: 'b.ts', state: 'stuck', finding: '  no   LOGGER import.  ' }
    ]);
    assert.equal(collapseFindings(sweep, ['stuck']).length, 1);
  });

  it('keeps genuinely different answers apart', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'stuck', finding: 'No logger import.' },
      { subject: 'b.ts', state: 'stuck', finding: 'This file is generated.' }
    ]);
    assert.equal(collapseFindings(sweep, ['stuck']).length, 2);
  });

  it('leads with whatever the most rows agree on', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'stuck', finding: 'Rare thing.' },
      { subject: 'b.ts', state: 'stuck', finding: 'Common thing.' },
      { subject: 'c.ts', state: 'stuck', finding: 'Common thing.' },
      { subject: 'd.ts', state: 'stuck', finding: 'Common thing.' }
    ]);
    const findings = collapseFindings(sweep, ['stuck']);
    assert.equal(findings[0]?.finding, 'Common thing.');
    assert.equal(findings[0]?.subjects.length, 3);
  });

  it('never mixes a "done" finding with an identical "stuck" one', () => {
    const sweep = batch([
      { subject: 'a.ts', state: 'done', finding: 'Same words.' },
      { subject: 'b.ts', state: 'stuck', finding: 'Same words.' }
    ]);
    assert.equal(collapseFindings(sweep, ['done', 'stuck']).length, 2);
  });
});

describe('what a person is told about a sweep', () => {
  it('says nothing at all while it is just working', () => {
    const sweep = forty();
    allocate(sweep, 'claude', 5, AT);
    assert.equal(assessSweep(sweep).kind, 'working');
  });

  it('asks once about rows that are all stuck on the same thing', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      subject: `src/m${index}.ts`,
      state: (index < 9 ? 'stuck' : 'done') as RowState,
      finding: index < 9 ? 'There is no logger in this package.' : 'Swapped it.'
    }));
    const verdict = assessSweep(batch(rows));

    assert.equal(verdict.kind, 'needs-a-person');
    assert.match(verdict.detail, /9 of 40 rows/);
    assert.match(verdict.detail, /9 of them say the same thing/);
    assert.equal(verdict.findings.length, 1, 'one question, not nine');
  });

  it('says so when a whole sweep changed nothing', () => {
    const verdict = assessSweep(
      batch(
        Array.from({ length: 40 }, (_, index) => ({
          subject: `src/m${index}.ts`,
          state: 'skipped' as RowState,
          finding: 'No console.log here.'
        }))
      )
    );
    assert.equal(verdict.kind, 'changed-nothing');
    assert.match(verdict.detail, /an instruction that did not ask for what you meant/);
  });

  it('is quiet about a sweep that did its job', () => {
    const verdict = assessSweep(
      batch([
        { subject: 'a.ts', state: 'done', finding: 'Swapped it.' },
        { subject: 'b.ts', state: 'skipped', finding: 'Generated file.' }
      ])
    );
    assert.equal(verdict.kind, 'finished');
    assert.match(verdict.detail, /1 changed, 1 left alone/);
  });

  it('puts stuck rows ahead of everything else', () => {
    // A sweep can be otherwise complete and still need a person.
    const verdict = assessSweep(
      batch([
        { subject: 'a.ts', state: 'done', finding: 'Swapped.' },
        { subject: 'b.ts', state: 'stuck', finding: 'Cannot parse this file.' }
      ])
    );
    assert.equal(verdict.kind, 'needs-a-person');
  });
});

describe('a lane cannot land over a half-swept sweep', () => {
  it('names the unfinished ones', () => {
    const half = batch([{ subject: 'a.ts', state: 'done' }, { subject: 'b.ts' }]);
    const whole = { ...batch([{ subject: 'c.ts', state: 'done' }]), id: 'grid_2' };
    assert.deepEqual(
      unfinishedBatches([half, whole], 'sweep').map((entry) => entry.id),
      ['grid_1']
    );
  });

  it('says nothing about a lane with no sweeps', () => {
    assert.deepEqual(unfinishedBatches([], 'anything'), []);
  });
});
