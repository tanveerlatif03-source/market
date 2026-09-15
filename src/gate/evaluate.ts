/**
 * The merge gate (Q1, Q12, Q14, Q18).
 *
 * One pure function. It is handed what git saw, what the room believes, and
 * what the agent said, and it returns a verdict with every reason spelled out.
 * Nothing here talks to git or mutates a room, so every refusal path can be
 * tested directly.
 *
 * The rule that matters: `changedFiles` comes from the diff, `declaredFiles`
 * comes from the agent. They are compared, not conflated. An agent that edited
 * a file it never claimed cannot get past this by leaving it out of its own
 * report.
 */

import type { Claim } from '../room/claims.ts';
import type { ReviewRequirement, RiskRule } from '../room/review.ts';
import { normalizePath } from '../paths.ts';

export type MergeVerdict = 'merge' | 'refuse' | 'wait';

export type GateCode =
  | 'not-submitted'
  | 'unclaimed-files'
  | 'foreign-files'
  | 'seam-unsigned'
  | 'seam-stale'
  | 'seam-unsatisfied'
  | 'cross-review-missing'
  | 'cross-review-stale'
  | 'cross-review-breaks'
  | 'risk-unsigned'
  | 'sweep-unfinished'
  | 'evidence-missing'
  | 'conflicts'
  | 'seam-mate-not-ready';

export interface GateReason {
  code: GateCode;
  /** Written for the person or agent who has to act on it. */
  detail: string;
  paths?: string[];
  seamId?: string;
  laneId?: string;
}

export interface SeamState {
  id: string;
  title: string;
  /** The contract's version right now. */
  currentVersion: number;
  /** The version this lane signed against, or null if it never signed. */
  signedVersion: number | null;
  satisfied: boolean;
}

export interface LaneUnderGate {
  laneId: string;
  owner: string | null;
  submitted: boolean;
  /** From the diff. The truth. */
  changedFiles: readonly string[];
  /** From the agent's own submission. Compared against the diff, never trusted. */
  declaredFiles: readonly string[];
  seams: readonly SeamState[];
  /** What the agent across each contract owes this lane, and whether it paid (Q13). */
  reviews: readonly ReviewRequirement[];
  /**
   * Risk rules this lane's *diff* trips that no live human sign-off covers
   * (Q13). Computed from the diff, not from what the agent declared — hiding a
   * risky file in your own report does not get you past this.
   */
  unsignedRisks: readonly { rule: RiskRule; paths: string[] }[];
  /** Sweeps on this lane that still have rows nobody has answered for (Q19). */
  unfinishedSweeps: readonly { title: string; summary: string }[];
  /** What this lane said would prove it worked (Q18), and whether it has. */
  evidence: { statement: string; produced: boolean } | null;
}

export interface GateInput {
  lane: LaneUnderGate;
  claims: readonly Claim[];
  /** Lanes sharing a contract with this one. They land together (Q12). */
  seamMates: readonly { laneId: string; ready: boolean }[];
  /** Whether git can merge this branch without conflict. */
  mergesCleanly: boolean;
}

export interface GateDecision {
  verdict: MergeVerdict;
  reasons: GateReason[];
  /** Files git saw that the agent did not mention. Surfaced, never fatal alone. */
  undeclared: string[];
}

export function evaluateMerge(input: GateInput): GateDecision {
  const { lane, claims } = input;
  const reasons: GateReason[] = [];

  const changed = [...new Set(lane.changedFiles.map(normalizePath))].sort();
  const declared = new Set(lane.declaredFiles.map(normalizePath));
  const undeclared = changed.filter((path) => !declared.has(path));

  if (!lane.submitted) {
    reasons.push({
      code: 'not-submitted',
      detail: `"${lane.laneId}" has not been submitted yet.`,
      laneId: lane.laneId
    });
  }

  // Territory. A file this lane changed must have been claimed *for this lane*.
  //
  // For the lane, not by its owner: a grid sweep has several agents working
  // rows of one lane at once (Q19), and each of them claims the file it is on.
  // The lane is what owns ground; the holder is who is writing this minute. The
  // room enforces that only the lane's owner or someone holding one of its rows
  // can claim for it, so this is not a way in.
  const claimByPath = new Map(claims.map((claim) => [claim.path, claim]));
  const unclaimed: string[] = [];
  const foreign: { path: string; holder: string; laneId: string }[] = [];
  for (const path of changed) {
    const claim = claimByPath.get(path);
    if (claim === undefined) {
      unclaimed.push(path);
    } else if (claim.laneId !== lane.laneId) {
      foreign.push({ path, holder: claim.holder, laneId: claim.laneId });
    }
  }

  if (unclaimed.length > 0) {
    reasons.push({
      code: 'unclaimed-files',
      detail:
        `${unclaimed.length} file(s) were changed without being claimed: ${unclaimed.join(', ')}. ` +
        'Claim a file before you write to it, so a collision is caught in seconds rather than here.',
      paths: unclaimed,
      laneId: lane.laneId
    });
  }

  if (foreign.length > 0) {
    reasons.push({
      code: 'foreign-files',
      detail:
        'These files belong to someone else right now: ' +
        foreign.map((hit) => `${hit.path} (${hit.holder}, for "${hit.laneId}")`).join(', ') +
        '. Claim, do not merge.',
      paths: foreign.map((hit) => hit.path),
      laneId: lane.laneId
    });
  }

  // Contracts. Unsigned, stale and unsatisfied are three different failures.
  for (const seam of lane.seams) {
    if (seam.signedVersion === null) {
      reasons.push({
        code: 'seam-unsigned',
        detail: `"${seam.title}" was never confirmed by this lane.`,
        seamId: seam.id,
        laneId: lane.laneId
      });
    } else if (seam.signedVersion !== seam.currentVersion) {
      reasons.push({
        code: 'seam-stale',
        detail:
          `"${seam.title}" moved to v${seam.currentVersion} after this lane signed v${seam.signedVersion}. ` +
          'Re-read the contract and confirm again — what you built may no longer hold.',
        seamId: seam.id,
        laneId: lane.laneId
      });
    } else if (!seam.satisfied) {
      reasons.push({
        code: 'seam-unsatisfied',
        detail: `This lane says it does not hold "${seam.title}".`,
        seamId: seam.id,
        laneId: lane.laneId
      });
    }
  }

  // Cross-review. The agent across the contract has read this, against the
  // contract as it stands and the code as it stands (Q13).
  for (const requirement of lane.reviews) {
    if (requirement.state === 'holds') continue;
    if (requirement.state === 'unreviewable') {
      // Nobody holds the other side yet. That lane is not ready either, so the
      // set cannot land — say the true thing rather than a second one.
      reasons.push({
        code: 'cross-review-missing',
        detail: requirement.why,
        seamId: requirement.seamId,
        laneId: lane.laneId
      });
      continue;
    }
    reasons.push({
      code:
        requirement.state === 'breaks'
          ? ('cross-review-breaks' as const)
          : requirement.state === 'stale'
            ? ('cross-review-stale' as const)
            : ('cross-review-missing' as const),
      detail: requirement.why,
      seamId: requirement.seamId,
      laneId: lane.laneId
    });
  }

  // The risk list. A short list of surfaces where a person looks whatever the
  // agents agreed between themselves (Q13).
  for (const hit of lane.unsignedRisks) {
    reasons.push({
      code: 'risk-unsigned',
      detail:
        `${hit.rule.label} is on this room's risk list and nobody has signed off on ` +
        `${hit.paths.join(', ')}. ${hit.rule.why}`,
      paths: hit.paths,
      laneId: lane.laneId
    });
  }

  // A sweep half-swept is a lane that does not know what it did (Q19). Landing
  // over it would ship "we changed some of the forty files" as if it were done.
  for (const sweep of lane.unfinishedSweeps) {
    reasons.push({
      code: 'sweep-unfinished',
      detail: `"${sweep.title}" is not finished: ${sweep.summary}.`,
      laneId: lane.laneId
    });
  }

  // Evidence. The only check that asks whether the work was any good (Q18).
  if (lane.evidence !== null && !lane.evidence.produced) {
    reasons.push({
      code: 'evidence-missing',
      detail: `Nothing has shown this worked yet. The lane promised: ${lane.evidence.statement}`,
      laneId: lane.laneId
    });
  }

  if (!input.mergesCleanly) {
    reasons.push({
      code: 'conflicts',
      detail: 'This branch no longer merges cleanly. Bring the base branch in and resolve it.',
      laneId: lane.laneId
    });
  }

  if (reasons.length > 0) {
    return { verdict: 'refuse', reasons, undeclared };
  }

  // Everything about this lane is sound. The only thing left is its partners:
  // lanes sharing a contract land together, because that is what the contract
  // means — not a policy we could soften.
  const waiting = input.seamMates.filter((mate) => !mate.ready);
  if (waiting.length > 0) {
    return {
      verdict: 'wait',
      undeclared,
      reasons: waiting.map((mate) => ({
        code: 'seam-mate-not-ready' as const,
        detail:
          `Ready, but "${mate.laneId}" shares a contract with this lane and is not. ` +
          'They land together.',
        laneId: mate.laneId
      }))
    };
  }

  return { verdict: 'merge', reasons: [], undeclared };
}

/** One line a human or an agent can act on, without reading the whole decision. */
export function summarize(decision: GateDecision, laneId: string): string {
  if (decision.verdict === 'merge') return `"${laneId}" is clear to land.`;
  if (decision.verdict === 'wait') {
    return `"${laneId}" is ready and waiting on the lane it shares a contract with.`;
  }
  const first = decision.reasons[0];
  const extra = decision.reasons.length - 1;
  return extra > 0
    ? `"${laneId}" cannot land: ${first?.detail} (+${extra} more)`
    : `"${laneId}" cannot land: ${first?.detail}`;
}
