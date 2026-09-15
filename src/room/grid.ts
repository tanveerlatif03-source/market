/**
 * The grid (Q19).
 *
 * Q19 parked a *formula language* and said why: inventing a small language,
 * forever, to do what a button already does. It did not park the shape that
 * prompted the question — *the same check across forty files, one row each* —
 * which it called genuinely grid-shaped. This is that, and only that.
 *
 * The line matters, so it is worth stating exactly. Nothing here evaluates
 * anything. A batch has an instruction written in prose, which Agora never
 * reads; a set of subjects, which comes from expanding a path pattern against
 * real files; and one row per subject. There are no expressions, no references
 * from one row to another, and no dependency graph between cells. Agora hands
 * rows out, collects what came back, and adds up. That is a button.
 *
 * What the shape buys, and why a table would not:
 *
 *   - **Rows are handed out, never negotiated.** Three agents can sweep forty
 *     files at once because Agora allocates; nobody asks anybody for a turn.
 *     This is Q5's rule applied at a different grain.
 *   - **Forty findings are not forty questions.** A person asked forty times is
 *     a person who stops reading. Identical findings collapse into one, which is
 *     the only reason a sweep of this size is supervisable at all (Q8).
 *   - **A sweep that changes nothing is a signal.** Forty rows all reporting
 *     "nothing to do" usually means the instruction was wrong, not that the
 *     codebase was perfect. That is worth saying out loud (Q20's instinct, at
 *     batch scale).
 */

export type RowState =
  /** Nobody has taken it. */
  | 'pending'
  /** An agent has it right now. */
  | 'taken'
  /** Changed, and said what changed. */
  | 'done'
  /** Looked at, deliberately left alone, with a reason. */
  | 'skipped'
  /** Tried, could not, and said why. A person decides. */
  | 'stuck';

export interface BatchRow {
  id: string;
  /** What this row is about — a file path, in the case Q19 named. */
  subject: string;
  state: RowState;
  /** The agent holding or finished with it. */
  agent: string | null;
  /** What came back. The row's whole output, in the agent's words. */
  finding: string;
  takenAt: string | null;
  finishedAt: string | null;
}

export interface Batch {
  id: string;
  laneId: string;
  title: string;
  /**
   * What to do to each subject, in prose. Agora does not read this, does not
   * parse it, and never will. It is handed to whichever agent takes a row.
   */
  instruction: string;
  /** The pattern the subjects came from, kept so the sweep can be explained. */
  fromPaths: string[];
  rows: BatchRow[];
  openedBy: string;
  openedAt: string;
  /** The attention item raised about this batch, if one is open. */
  attentionId: string | null;
}

export interface BatchProgress {
  total: number;
  pending: number;
  taken: number;
  done: number;
  skipped: number;
  stuck: number;
  /** Every row has been looked at and none is still in hand. */
  finished: boolean;
  /** One line for a table cell. */
  summary: string;
}

export function progressOf(batch: Batch): BatchProgress {
  const count = (state: RowState): number =>
    batch.rows.filter((row) => row.state === state).length;

  const total = batch.rows.length;
  const pending = count('pending');
  const taken = count('taken');
  const done = count('done');
  const skipped = count('skipped');
  const stuck = count('stuck');
  const finished = total > 0 && pending === 0 && taken === 0;

  return {
    total,
    pending,
    taken,
    done,
    skipped,
    stuck,
    finished,
    summary:
      total === 0
        ? 'no rows'
        : `${done + skipped + stuck}/${total} looked at` +
          (done > 0 ? `, ${done} changed` : '') +
          (skipped > 0 ? `, ${skipped} left alone` : '') +
          (stuck > 0 ? `, ${stuck} stuck` : '') +
          (taken > 0 ? `, ${taken} in hand` : '')
  };
}

/**
 * Hands out rows. The whole point: an agent asks for work and gets some, rather
 * than asking another agent whether it may have some.
 */
export function allocate(
  batch: Batch,
  agentId: string,
  count: number,
  now: string
): BatchRow[] {
  const wanted = Math.max(0, Math.floor(count));
  const handed: BatchRow[] = [];
  for (const row of batch.rows) {
    if (handed.length >= wanted) break;
    if (row.state !== 'pending') continue;
    row.state = 'taken';
    row.agent = agentId;
    row.takenAt = now;
    handed.push(row);
  }
  return handed;
}

/** Rows an agent is holding but has not answered for. */
export function heldBy(batch: Batch, agentId: string): BatchRow[] {
  return batch.rows.filter((row) => row.state === 'taken' && row.agent === agentId);
}

export interface Finding {
  /** The text, exactly as some agent wrote it. */
  finding: string;
  /** Every row that came back with it. */
  subjects: string[];
  /** Whether those rows were changed, left alone, or stuck. */
  state: RowState;
}

/**
 * The same answer on many rows is one answer.
 *
 * This is the function that makes a forty-row sweep supervisable. Without it a
 * person is asked forty times and answers none of them; with it they are asked
 * once and told how many rows it covers.
 */
export function collapseFindings(batch: Batch, states: readonly RowState[]): Finding[] {
  const groups = new Map<string, Finding>();
  for (const row of batch.rows) {
    if (!states.includes(row.state)) continue;
    const key = `${row.state}:${normalizeFinding(row.finding)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { finding: row.finding, subjects: [row.subject], state: row.state });
    } else {
      existing.subjects.push(row.subject);
    }
  }
  // Most rows first: the thing forty files agree on is the thing to read.
  return [...groups.values()].sort(
    (a, b) => b.subjects.length - a.subjects.length || a.finding.localeCompare(b.finding)
  );
}

/** Whitespace and case are not a different answer. */
function normalizeFinding(finding: string): string {
  return finding.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface SweepVerdict {
  kind: 'working' | 'needs-a-person' | 'changed-nothing' | 'finished';
  /** Said to a person, in one line. */
  detail: string;
  /** The collapsed findings behind it, so nobody has to open forty rows. */
  findings: Finding[];
}

/**
 * What, if anything, a person needs to know about this sweep.
 *
 * Deliberately asked once about the whole batch rather than once per row. A
 * sweep of forty files raising forty items is a queue nobody reads, which is
 * the same failure Q8 named at a smaller scale.
 */
export function assessSweep(batch: Batch): SweepVerdict {
  const progress = progressOf(batch);
  const stuck = collapseFindings(batch, ['stuck']);

  if (stuck.length > 0) {
    const worst = stuck[0] as Finding;
    return {
      kind: 'needs-a-person',
      detail:
        `${progress.stuck} of ${progress.total} rows in "${batch.title}" are stuck. ` +
        `${worst.subjects.length === 1 ? 'One says' : `${worst.subjects.length} of them say the same thing`}: ` +
        worst.finding,
      findings: stuck
    };
  }

  if (!progress.finished) {
    return { kind: 'working', detail: progress.summary, findings: [] };
  }

  // Everything was looked at and nothing was changed. Usually the instruction
  // was wrong rather than the codebase being perfect.
  if (progress.done === 0 && progress.total > 0) {
    return {
      kind: 'changed-nothing',
      detail:
        `Every one of the ${progress.total} rows in "${batch.title}" came back with nothing to ` +
        'do. That is either a codebase that was already right, or an instruction that did not ' +
        'ask for what you meant. Worth one look before it is called finished.',
      findings: collapseFindings(batch, ['skipped'])
    };
  }

  return {
    kind: 'finished',
    detail:
      `"${batch.title}" is finished: ${progress.done} changed, ${progress.skipped} left alone, ` +
      `across ${progress.total} rows.`,
    findings: collapseFindings(batch, ['done', 'skipped'])
  };
}

/** Batches on a lane that are not finished. A lane cannot land over these. */
export function unfinishedBatches(batches: readonly Batch[], laneId: string): Batch[] {
  return batches.filter((batch) => batch.laneId === laneId && !progressOf(batch).finished);
}
