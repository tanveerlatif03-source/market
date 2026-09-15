/**
 * Cross-review at the seam, and the risk list (Q13).
 *
 * Four agents write three thousand lines in an afternoon. Review it all and the
 * human is the bottleneck; review none and this is a machine for shipping
 * unread code. So the agent on the other side of a contract reviews your work —
 * it has the context and a real stake in whether you held the contract — and a
 * short, configurable risk list pulls a person onto the surfaces where being
 * wrong is expensive.
 *
 * Everything here is pure. The gate decides, the room records; this file only
 * works out what is owed and whether it has been paid.
 */

import { matchesAnyPath } from '../paths.ts';
import type { Room } from '../types.ts';

export type ReviewVerdict = 'holds' | 'breaks';

/** One agent's reading of the other side of a contract. */
export interface Review {
  id: string;
  /** The lane that was read. */
  laneId: string;
  /** The contract it was read against. */
  seamId: string;
  /** The agent across that contract. */
  by: string;
  verdict: ReviewVerdict;
  note: string;
  /**
   * The submission that was actually read. A later submission means this
   * review was of code that no longer exists.
   */
  submissionId: string;
  /** The contract version at the time. A bump makes it worthless, as in Q14. */
  seamVersion: number;
  at: string;
}

export type ReviewState =
  /** Nobody has read this lane against this contract. */
  | 'missing'
  /** Read, but the lane or the contract has moved since. */
  | 'stale'
  /** Read, and the reviewer says the contract is not held. */
  | 'breaks'
  /** Read against what is there now, and it holds. */
  | 'holds'
  /** Nobody holds the other side of this contract yet, so nobody can read it. */
  | 'unreviewable';

export interface ReviewRequirement {
  seamId: string;
  seamTitle: string;
  /** The lane across the contract. */
  partnerLaneId: string | null;
  /** The agent that owes this review, or null when that lane is unowned. */
  reviewer: string | null;
  state: ReviewState;
  review: Review | null;
  /** Written for whoever has to act on it. */
  why: string;
}

export interface LaneSeamContext {
  laneId: string;
  /** The submission the gate would be judging. Null when nothing was submitted. */
  latestSubmissionId: string | null;
  seams: readonly {
    id: string;
    title: string;
    version: number;
    partnerLaneId: string | null;
    partnerOwner: string | null;
  }[];
  reviews: readonly Review[];
}

/** What this lane still owes before anyone should merge it. */
export function reviewRequirements(context: LaneSeamContext): ReviewRequirement[] {
  return context.seams.map((seam) => {
    const base = {
      seamId: seam.id,
      seamTitle: seam.title,
      partnerLaneId: seam.partnerLaneId,
      reviewer: seam.partnerOwner
    };

    if (seam.partnerOwner === null) {
      return {
        ...base,
        state: 'unreviewable' as const,
        review: null,
        why:
          `Nobody holds the other side of "${seam.title}" yet, so nobody can check it. ` +
          'The lane across the contract has to be claimed first.'
      };
    }

    // The newest reading by the agent across the contract. Older ones are
    // history; only the last word counts.
    const review = [...context.reviews]
      .filter(
        (candidate) =>
          candidate.laneId === context.laneId &&
          candidate.seamId === seam.id &&
          candidate.by === seam.partnerOwner
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .at(-1);

    if (review === undefined) {
      return {
        ...base,
        state: 'missing' as const,
        review: null,
        why: `${seam.partnerOwner} has not read this lane against "${seam.title}" yet.`
      };
    }

    if (review.seamVersion !== seam.version) {
      return {
        ...base,
        state: 'stale' as const,
        review,
        why:
          `${seam.partnerOwner} read this against "${seam.title}" v${review.seamVersion}; ` +
          `the contract is now v${seam.version}. It has to be read again.`
      };
    }

    if (
      context.latestSubmissionId !== null &&
      review.submissionId !== context.latestSubmissionId
    ) {
      return {
        ...base,
        state: 'stale' as const,
        review,
        why:
          `${seam.partnerOwner} read an earlier submission of this lane. ` +
          'The code changed after the review, so the review is of code that is gone.'
      };
    }

    if (review.verdict === 'breaks') {
      return {
        ...base,
        state: 'breaks' as const,
        review,
        why: `${seam.partnerOwner} says this does not hold "${seam.title}": ${review.note}`
      };
    }

    return { ...base, state: 'holds' as const, review, why: '' };
  });
}

/**
 * A surface where being wrong is expensive enough that a person looks (Q13).
 * Default light on purpose; a team that will not take the bet sets it to `**`.
 */
export interface RiskRule {
  id: string;
  label: string;
  /** Path patterns, the same syntax lanes use. */
  paths: string[];
  /** Said to the person who is being pulled in, not to the log. */
  why: string;
}

export const DEFAULT_RISK_LIST: RiskRule[] = [
  {
    id: 'auth',
    label: 'Authentication',
    paths: ['**/auth/**', 'auth/**', '**/session/**', 'session/**', '**/*auth*.ts', '**/*auth*.tsx'],
    why: 'Getting this wrong lets the wrong person in, and nothing downstream catches it.'
  },
  {
    id: 'payments',
    label: 'Payments',
    paths: ['**/payment*/**', 'payment*/**', '**/billing/**', 'billing/**', '**/checkout/**', 'checkout/**'],
    why: 'Money moves here. Mistakes are visible to customers and hard to unwind.'
  },
  {
    id: 'schema',
    label: 'Database schema',
    // `**/x` does not match a root-level `x`, so anything that can sit at the
    // top of a repository is listed both ways.
    paths: ['**/migrations/**', 'migrations/**', 'schema.*', '**/schema.*', '**/*.sql', '*.sql', 'prisma/**'],
    why: 'A migration that lands wrong is not revertible by reverting the commit.'
  },
  {
    id: 'public-api',
    label: 'Public API',
    paths: ['**/api/public/**', 'api/public/**', 'openapi.*', '**/openapi.*', '**/*.proto', '*.proto'],
    why: 'Other people build against this. Breaking it breaks them, silently.'
  }
];

/** The rules a set of changed files trips. */
export function risksTouched(
  changedFiles: readonly string[],
  rules: readonly RiskRule[]
): { rule: RiskRule; paths: string[] }[] {
  const hits: { rule: RiskRule; paths: string[] }[] = [];
  for (const rule of rules) {
    const paths = changedFiles.filter((path) => matchesAnyPath(path, rule.paths));
    if (paths.length > 0) hits.push({ rule, paths });
  }
  return hits;
}

/** A person having looked at a risky surface, for one specific submission. */
export interface RiskSignOff {
  id: string;
  laneId: string;
  /** Which submission they signed off. A later one is not covered. */
  submissionId: string;
  /** The rule ids they were shown. A rule tripped later is not covered either. */
  ruleIds: string[];
  by: string;
  note: string;
  at: string;
}

/** Rules the diff trips that no live sign-off covers. */
export function unsignedRisks(
  hits: readonly { rule: RiskRule; paths: string[] }[],
  signOffs: readonly RiskSignOff[],
  lane: { laneId: string; latestSubmissionId: string | null }
): { rule: RiskRule; paths: string[] }[] {
  const covered = new Set(
    signOffs
      .filter(
        (signOff) =>
          signOff.laneId === lane.laneId &&
          lane.latestSubmissionId !== null &&
          signOff.submissionId === lane.latestSubmissionId
      )
      .flatMap((signOff) => signOff.ruleIds)
  );
  return hits.filter((hit) => !covered.has(hit.rule.id));
}

/** The seams of one lane, shaped for `reviewRequirements`. */
export function seamContextOf(room: Room, laneId: string): LaneSeamContext {
  const task = room.tasks.find((candidate) => candidate.id === laneId);
  const seams = (task?.seams ?? []).flatMap((seamId) => {
    const decision = room.decisions.find((candidate) => candidate.id === seamId);
    if (decision === undefined) return [];
    const partnerLaneId =
      decision.seam?.betweenTasks.find((other) => other !== laneId) ?? null;
    const partner =
      partnerLaneId === null
        ? undefined
        : room.tasks.find((candidate) => candidate.id === partnerLaneId);
    return [
      {
        id: decision.id,
        title: decision.title,
        version: decision.version,
        partnerLaneId,
        partnerOwner: partner?.owner ?? null
      }
    ];
  });

  return {
    laneId,
    latestSubmissionId: task?.submissions.at(-1)?.id ?? null,
    seams,
    reviews: room.reviews
  };
}

/** Lanes this agent owes a review on, and why it is owed. */
export function reviewsOwedBy(
  room: Room,
  agentId: string
): { laneId: string; seamId: string; seamTitle: string; why: string }[] {
  const owed: { laneId: string; seamId: string; seamTitle: string; why: string }[] = [];
  for (const task of room.tasks) {
    // Nothing to read until the lane says it is finished.
    if (task.status !== 'submitted' && task.status !== 'accepted') continue;
    for (const requirement of reviewRequirements(seamContextOf(room, task.id))) {
      if (requirement.reviewer !== agentId) continue;
      if (requirement.state === 'missing' || requirement.state === 'stale') {
        owed.push({
          laneId: task.id,
          seamId: requirement.seamId,
          seamTitle: requirement.seamTitle,
          why: requirement.why
        });
      }
    }
  }
  return owed;
}
