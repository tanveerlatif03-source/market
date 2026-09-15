/**
 * Provenance — "why is this the way it is" (Q26).
 *
 * The Trace is not time travel and not a wall of live reasoning. Its job is to
 * answer one question about one thing: this file, this lane, this contract —
 * what decided it. Every entry here is derived from what the room already
 * stores. Nothing is written for the sake of the view, which is the only way it
 * stays honest.
 */

import { matchesAnyPath, normalizePath } from '../paths.ts';
import type { Room } from '../types.ts';

export type ProvenanceSubject =
  | { kind: 'file'; path: string }
  | { kind: 'lane'; laneId: string }
  | { kind: 'contract'; seamId: string };

export type ProvenanceKind =
  | 'plan'
  | 'contract'
  | 'amendment'
  | 'claim'
  | 'submission'
  | 'review'
  | 'ruling'
  | 'dissent'
  | 'evidence'
  | 'landing';

export interface ProvenanceEntry {
  at: string;
  kind: ProvenanceKind;
  /** Who did it: an agent id, a person's id, or "human". */
  by: string;
  /** What happened, in one line. */
  what: string;
  /** Why it is part of this answer. */
  because: string;
}

export interface Provenance {
  subject: ProvenanceSubject;
  /** The one-line answer, before anyone reads the chain. */
  headline: string;
  /** Oldest first: this is a story, not a feed. */
  entries: ProvenanceEntry[];
  /** Questions about this subject nobody has settled yet. */
  openQuestions: string[];
}

/** Joins a clause onto text that may already end in punctuation. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function byTime(a: ProvenanceEntry, b: ProvenanceEntry): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/** The lane that owns a path, if any. */
function laneOwning(room: Room, path: string): string | null {
  const target = normalizePath(path);
  const task = room.tasks.find(
    (candidate) => candidate.paths.length > 0 && matchesAnyPath(target, candidate.paths)
  );
  return task?.id ?? null;
}

export function provenanceOf(room: Room, subject: ProvenanceSubject): Provenance {
  if (subject.kind === 'file') return forFile(room, subject.path);
  if (subject.kind === 'contract') return forContract(room, subject.seamId);
  return forLane(room, subject.laneId);
}

function forFile(room: Room, rawPath: string): Provenance {
  const path = normalizePath(rawPath);
  const laneId = laneOwning(room, path);
  const entries: ProvenanceEntry[] = [];

  for (const claim of room.claims.filter((candidate) => normalizePath(candidate.path) === path)) {
    entries.push({
      at: claim.claimedAt,
      kind: 'claim',
      by: claim.holder,
      what:
        `${claim.holder} claimed it for "${claim.laneId}"` +
        (claim.touches > 1 ? ` and has rewritten it ${claim.touches} times` : ''),
      because: 'A file is written by whoever holds it.'
    });
  }

  // Everything the log said about this exact path.
  for (const event of room.events) {
    if (!event.summary.includes(path)) continue;
    entries.push({
      at: event.at,
      kind: event.type.startsWith('claim.') ? 'claim' : 'submission',
      by: event.actor,
      what: event.summary,
      because: 'The log names this file.'
    });
  }

  const lane = laneId === null ? null : forLane(room, laneId);
  if (lane !== null) {
    for (const entry of lane.entries) {
      if (entry.kind === 'claim') continue; // already covered, path-precise
      entries.push({
        ...entry,
        because: `${entry.because} It governs "${laneId}", which owns this file.`
      });
    }
  }

  entries.sort(byTime);
  return {
    subject: { kind: 'file', path },
    headline:
      laneId === null
        ? `No lane owns ${path}. Nothing in this room decided it.`
        : `${path} belongs to "${laneId}". ${entries.length} thing(s) shaped it.`,
    entries,
    openQuestions: lane?.openQuestions ?? []
  };
}

function forLane(room: Room, laneId: string): Provenance {
  const task = room.tasks.find((candidate) => candidate.id === laneId);
  const entries: ProvenanceEntry[] = [];

  if (task === undefined) {
    return {
      subject: { kind: 'lane', laneId },
      headline: `There is no lane called "${laneId}".`,
      entries: [],
      openQuestions: []
    };
  }

  if (room.plan.decidedAt !== null) {
    entries.push({
      at: room.plan.decidedAt,
      kind: 'plan',
      by: room.plan.decidedBy ?? 'human',
      what:
        sentence(
          `The split was ${room.plan.status}` +
            (room.plan.note !== null ? `: ${room.plan.note}` : '')
        ) + ` "${task.title}" owns ${task.paths.join(', ') || 'nothing yet'}.`,
      because: 'Every lane starts as a line in an approved plan.'
    });
  }

  for (const seamId of task.seams) {
    const decision = room.decisions.find((candidate) => candidate.id === seamId);
    if (decision === undefined) continue;
    entries.push({
      at: decision.createdAt,
      kind: 'contract',
      by: decision.proposedBy,
      what: `"${decision.title}" (v${decision.version}): ${decision.body}`,
      because: 'This lane built toward it.'
    });
  }

  for (const event of room.events) {
    if (event.taskId !== laneId) continue;
    if (event.type === 'seam.amended') {
      entries.push({
        at: event.at,
        kind: 'amendment',
        by: event.actor,
        what: event.summary,
        because: 'Moving a contract moves what this lane had to build.'
      });
    }
  }
  // An amendment is room-wide, so it is logged without a lane. Pick up the ones
  // that name a contract this lane signed.
  for (const event of room.events.filter((candidate) => candidate.type === 'seam.amended')) {
    const touchesLane = task.seams.some((seamId) => {
      const decision = room.decisions.find((candidate) => candidate.id === seamId);
      return decision !== undefined && event.summary.includes(decision.title);
    });
    if (!touchesLane || event.taskId === laneId) continue;
    entries.push({
      at: event.at,
      kind: 'amendment',
      by: event.actor,
      what: event.summary,
      because: 'Moving a contract moves what this lane had to build.'
    });
  }

  for (const submission of task.submissions) {
    entries.push({
      at: submission.createdAt,
      kind: 'submission',
      by: submission.by,
      what: `Submitted ${submission.outcome}: ${submission.summary}`,
      because: 'This is what the lane says it did.'
    });
  }

  for (const review of room.reviews.filter((candidate) => candidate.laneId === laneId)) {
    entries.push({
      at: review.at,
      kind: 'review',
      by: review.by,
      what:
        review.verdict === 'holds'
          ? `Read it across the contract and says it holds: ${review.note}`
          : `Read it across the contract and says it breaks: ${review.note}`,
      because: 'The agent on the other side of a contract reviews this one (Q13).'
    });
  }

  for (const item of room.attention.filter((candidate) => candidate.laneId === laneId)) {
    if (item.resolvedAt === null) continue;
    entries.push({
      at: item.resolvedAt,
      kind: 'ruling',
      by: item.resolvedBy ?? 'human',
      what: `${item.title} — ${item.resolution ?? 'settled'}`,
      because: 'A person ruled on it, and the lane carried on from there.'
    });
  }

  for (const dissent of room.dissents.filter((candidate) => candidate.laneId === laneId)) {
    entries.push({
      at: dissent.at,
      kind: 'dissent',
      by: dissent.by,
      what: `Complied but objected to ${dissent.about}: ${dissent.because}`,
      because: 'An objection on the record is part of why this looks the way it does (Q22).'
    });
  }

  if (task.evidence !== null && task.evidence.producedAt !== null) {
    entries.push({
      at: task.evidence.producedAt,
      kind: 'evidence',
      by: task.owner ?? 'unknown',
      what: `Showed it worked: ${task.evidence.note || task.evidence.statement}`,
      because: 'Nothing lands without it (Q18).'
    });
  }

  entries.sort(byTime);

  const openQuestions = room.attention
    .filter((item) => item.laneId === laneId && item.resolvedAt === null)
    .map((item) => `${item.title} — waiting on ${item.assignedTo ?? 'anyone in the room'}.`);

  return {
    subject: { kind: 'lane', laneId },
    headline:
      `"${task.title}" is ${task.status}, held by ${task.owner ?? 'nobody'}, ` +
      `answering to ${task.laneOwner ?? 'the room'}.`,
    entries,
    openQuestions
  };
}

function forContract(room: Room, seamId: string): Provenance {
  const decision = room.decisions.find((candidate) => candidate.id === seamId);
  if (decision === undefined) {
    return {
      subject: { kind: 'contract', seamId },
      headline: `There is no contract called "${seamId}".`,
      entries: [],
      openQuestions: []
    };
  }

  const entries: ProvenanceEntry[] = [
    {
      at: decision.createdAt,
      kind: 'contract',
      by: decision.proposedBy,
      what: `"${decision.title}": ${decision.body}`,
      because: 'This is the contract as first written.'
    }
  ];

  for (const event of room.events) {
    if (event.type !== 'seam.amended') continue;
    if (!event.summary.includes(decision.title)) continue;
    entries.push({
      at: event.at,
      kind: 'amendment',
      by: event.actor,
      what: event.summary,
      because: 'Each amendment is a version, and it invalidated every signature below it (Q14).'
    });
  }

  const lanes = decision.seam?.betweenTasks ?? [];
  for (const laneId of lanes) {
    const task = room.tasks.find((candidate) => candidate.id === laneId);
    for (const submission of task?.submissions ?? []) {
      const check = submission.seamChecks.find((candidate) => candidate.decisionId === seamId);
      if (check === undefined) continue;
      entries.push({
        at: submission.createdAt,
        kind: 'submission',
        by: submission.by,
        what:
          `"${laneId}" signed v${check.signedVersion} and says it ` +
          `${check.satisfied ? 'holds' : 'does not hold'}: ${check.note}`,
        because: 'A signature is against one version of the contract.'
      });
    }
  }

  for (const review of room.reviews.filter((candidate) => candidate.seamId === seamId)) {
    entries.push({
      at: review.at,
      kind: 'review',
      by: review.by,
      what: `Read "${review.laneId}" against v${review.seamVersion}: ${review.verdict} — ${review.note}`,
      because: 'Each side checks the other across this contract.'
    });
  }

  // An agent refers to a contract however it is easiest — by id or by title.
  for (const dissent of room.dissents.filter(
    (candidate) =>
      candidate.about.includes(decision.title) || candidate.about.includes(decision.id)
  )) {
    entries.push({
      at: dissent.at,
      kind: 'dissent',
      by: dissent.by,
      what: `Objected: ${dissent.because}`,
      because: 'Someone built to this contract while saying it was wrong (Q22).'
    });
  }

  entries.sort(byTime);

  const openQuestions = room.attention
    .filter((item) => item.resolvedAt === null && item.detail.includes(decision.title))
    .map((item) => `${item.title} — waiting on ${item.assignedTo ?? 'anyone in the room'}.`);

  return {
    subject: { kind: 'contract', seamId },
    headline:
      `"${decision.title}" is at v${decision.version}, between ${lanes.join(' and ') || 'nobody'}.`,
    entries,
    openQuestions
  };
}
