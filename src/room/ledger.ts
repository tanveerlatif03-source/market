/**
 * The Ledger (Q19).
 *
 * A table, not a formula language. The thing a person needs on walking in is
 * every lane on one screen with the same columns, sortable — not a small
 * language for delegating work, which is a decade of maintenance to do what a
 * button already does.
 *
 * One row per lane. Every column is derived; nothing here is stored. The row
 * exists to answer one question fast: which lane needs me, and why.
 */

import { claimStateAt } from './claims.ts';
import type { ClaimHolderActivity } from './claims.ts';
import { costReport, summarizeCost } from './cost.ts';
import type { CostReport } from './cost.ts';
import { reviewRequirements, risksTouched, seamContextOf, unsignedRisks } from './review.ts';
import type { ReviewState } from './review.ts';
import { PLAN_TASK_ID } from './seed.ts';
import type { Room } from '../types.ts';

export type LaneHealth =
  /** Somebody has to do something before this moves. */
  | 'needs-a-person'
  /** Moving, nothing owed. */
  | 'working'
  /** Done its part and waiting on something that is not a person. */
  | 'waiting'
  /** Clear to land. */
  | 'ready'
  /** Landed or accepted. */
  | 'done'
  /** Nobody has picked it up. */
  | 'idle';

export interface LedgerRow {
  laneId: string;
  title: string;
  /** The agent holding it. */
  agent: string | null;
  /** The person who answers for it (Q8). */
  human: string | null;
  status: string;
  health: LaneHealth;
  /** Files held right now, and how many of those have gone soft. */
  filesHeld: number;
  filesSoft: number;
  actionsUsed: number;
  actionBudget: number;
  /** What the lane promised, and whether it has shown it (Q18). */
  evidence: 'none-declared' | 'promised' | 'shown';
  /** Worst state across this lane's contracts (Q13). */
  review: ReviewState | 'not-applicable';
  /** Risk rules this lane trips that nobody has signed off (Q13). */
  risksOpen: number;
  cost: CostReport;
  costSummary: string;
  /** Open attention items about this lane. */
  questionsOpen: number;
  /** The one thing standing between this lane and landing, in a person's words. */
  blockedOn: string;
  updatedAt: string;
}

export type LedgerColumn =
  | 'laneId'
  | 'title'
  | 'agent'
  | 'human'
  | 'health'
  | 'filesHeld'
  | 'actionsUsed'
  | 'evidence'
  | 'review'
  | 'risksOpen'
  | 'questionsOpen'
  | 'updatedAt';

export interface LedgerSort {
  column: LedgerColumn;
  direction: 'asc' | 'desc';
}

/** Worst first, because a table a person walks into should lead with the problem. */
const HEALTH_ORDER: LaneHealth[] = [
  'needs-a-person',
  'idle',
  'working',
  'waiting',
  'ready',
  'done'
];

const EVIDENCE_ORDER = ['none-declared', 'promised', 'shown'];
const REVIEW_ORDER = ['breaks', 'missing', 'stale', 'unreviewable', 'holds', 'not-applicable'];

function worstReview(states: readonly ReviewState[]): ReviewState | 'not-applicable' {
  if (states.length === 0) return 'not-applicable';
  return [...states].sort(
    (a, b) => REVIEW_ORDER.indexOf(a) - REVIEW_ORDER.indexOf(b)
  )[0] as ReviewState;
}

function activityOf(room: Room): Record<string, ClaimHolderActivity> {
  const activity: Record<string, ClaimHolderActivity> = {};
  for (const agent of room.agents) {
    // An agent that has never touched anything has not moved on from anything
    // either, so its claims are judged from when it joined.
    activity[agent.id] = {
      latestTouchAt: agent.latestTouchAt ?? agent.joinedAt,
      lastSeenAt: agent.lastSeenAt
    };
  }
  return activity;
}

export function ledgerRows(room: Room, now: number = Date.now()): LedgerRow[] {
  const activity = activityOf(room);

  return room.tasks
    .filter((task) => task.id !== PLAN_TASK_ID)
    .map((task) => {
      const claims = room.claims.filter((claim) => claim.laneId === task.id);
      const soft = claims.filter((claim) => {
        const holder = activity[claim.holder];
        return holder !== undefined && claimStateAt(claim, holder, now) === 'soft';
      });

      const requirements = reviewRequirements(seamContextOf(room, task.id));
      const review = worstReview(requirements.map((requirement) => requirement.state));

      const last = task.submissions.at(-1);
      const declared = last?.filesChanged ?? claims.map((claim) => claim.path);
      const risksOpen = unsignedRisks(risksTouched(declared, room.riskList), room.signOffs, {
        laneId: task.id,
        latestSubmissionId: last?.id ?? null
      }).length;

      const questions = room.attention.filter(
        (item) => item.laneId === task.id && item.resolvedAt === null
      );

      const evidence =
        task.evidence === null
          ? ('none-declared' as const)
          : task.evidence.produced
            ? ('shown' as const)
            : ('promised' as const);

      const cost = costReport(room.costs, task.id);
      const blockedOn = whatIsBlocking(task.status, {
        questions: questions.length,
        halted: task.budgetHaltedAt !== null,
        blockedReason: task.blockedReason,
        evidence,
        review,
        risksOpen,
        owner: task.owner
      });

      return {
        laneId: task.id,
        title: task.title,
        agent: task.owner,
        human: task.laneOwner,
        status: task.status,
        health: healthOf(task.status, {
          questions: questions.length,
          halted: task.budgetHaltedAt !== null,
          evidence,
          review,
          risksOpen,
          owner: task.owner
        }),
        filesHeld: claims.length,
        filesSoft: soft.length,
        actionsUsed: task.actionsUsed,
        actionBudget: task.actionBudget,
        evidence,
        review,
        risksOpen,
        cost,
        costSummary: summarizeCost(cost),
        questionsOpen: questions.length,
        blockedOn,
        updatedAt: task.updatedAt
      };
    });
}

interface LaneFacts {
  questions: number;
  halted: boolean;
  evidence: 'none-declared' | 'promised' | 'shown';
  review: ReviewState | 'not-applicable';
  risksOpen: number;
  owner: string | null;
}

function healthOf(status: string, facts: LaneFacts): LaneHealth {
  if (facts.questions > 0 || facts.halted || status === 'blocked') return 'needs-a-person';
  if (facts.risksOpen > 0) return 'needs-a-person';
  if (status === 'accepted') return 'done';
  if (facts.owner === null) return 'idle';
  if (status === 'submitted') {
    if (facts.review === 'breaks') return 'needs-a-person';
    if (facts.review === 'missing' || facts.review === 'stale') return 'waiting';
    if (facts.evidence === 'promised') return 'working';
    return 'ready';
  }
  return 'working';
}

function whatIsBlocking(status: string, facts: LaneFacts & { blockedReason: string | null }): string {
  if (facts.halted) return 'Spent its cap. A person has to raise it or redirect it.';
  if (facts.blockedReason !== null && status === 'blocked') {
    return `Stopped itself: ${facts.blockedReason}`;
  }
  // A question raised *by* a broken contract is better named by its cause than
  // by its count — "one question waiting" tells nobody what to go and read.
  if (facts.review === 'breaks') return 'The agent across the contract says it breaks it.';
  if (facts.questions > 0) {
    return `${facts.questions} question(s) waiting on a person.`;
  }
  if (facts.risksOpen > 0) {
    return `${facts.risksOpen} risky surface(s) nobody has looked at.`;
  }
  if (facts.owner === null) return 'Nobody has claimed it.';
  if (status !== 'submitted' && status !== 'accepted') return 'Being worked on.';
  if (facts.review === 'missing') return 'Waiting on the agent across the contract to read it.';
  if (facts.review === 'stale') return 'Read, but the code or the contract moved since.';
  if (facts.review === 'unreviewable') return 'Nobody holds the other side of its contract yet.';
  if (facts.evidence === 'promised') return 'Has not shown its evidence yet.';
  if (status === 'accepted') return 'Landed.';
  return 'Nothing. It can land.';
}

function compare(a: LedgerRow, b: LedgerRow, column: LedgerColumn): number {
  switch (column) {
    case 'health':
      return HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health);
    case 'evidence':
      return EVIDENCE_ORDER.indexOf(a.evidence) - EVIDENCE_ORDER.indexOf(b.evidence);
    case 'review':
      return REVIEW_ORDER.indexOf(a.review) - REVIEW_ORDER.indexOf(b.review);
    case 'filesHeld':
      return a.filesHeld - b.filesHeld;
    case 'actionsUsed':
      return a.actionsUsed - b.actionsUsed;
    case 'risksOpen':
      return a.risksOpen - b.risksOpen;
    case 'questionsOpen':
      return a.questionsOpen - b.questionsOpen;
    case 'updatedAt':
      return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    default: {
      const left = a[column] ?? '';
      const right = b[column] ?? '';
      return String(left).localeCompare(String(right));
    }
  }
}

export function sortRows(rows: readonly LedgerRow[], sort: LedgerSort): LedgerRow[] {
  const sign = sort.direction === 'desc' ? -1 : 1;
  // Lane id breaks every tie, so the same data always produces the same table.
  return [...rows].sort((a, b) => {
    const primary = compare(a, b, sort.column);
    return primary !== 0 ? sign * primary : a.laneId.localeCompare(b.laneId);
  });
}

/** The default a person who just walked in should see: worst first. */
export const DEFAULT_SORT: LedgerSort = { column: 'health', direction: 'asc' };
