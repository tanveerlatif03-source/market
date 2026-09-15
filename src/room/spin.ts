/**
 * Noticing an agent going in circles (Q20).
 *
 * Nobody is watching, so Agora has to see it. The detector is deliberately
 * mechanical — same file rewritten, evidence unchanged — because asking a model
 * whether it is making progress fails exactly when it matters. The model's
 * answer is used only to *confirm* a signal the arithmetic already raised, and
 * only as a concrete question with a concrete answer.
 */

import type { Claim } from './claims.ts';

/** Rewrites of one file before the arithmetic says something is wrong. */
export const REWRITE_THRESHOLD = 4;

export interface SpinSignal {
  laneId: string;
  /** The file being written over and over. */
  path: string;
  rewrites: number;
  /** Stated as a fact, never as a judgement about the agent. */
  fact: string;
}

export interface SpinInput {
  laneId: string;
  /** Claims held for this lane. */
  claims: readonly Claim[];
  /** When this lane last produced evidence, or null if it never has. */
  evidenceProducedAt: string | null;
}

/**
 * The cheap signal. A file rewritten past the threshold while the lane has
 * shown nothing since it started on that file.
 */
export function detectSpin(input: SpinInput): SpinSignal | null {
  const worst = [...input.claims]
    .filter((claim) => claim.laneId === input.laneId && claim.touches >= REWRITE_THRESHOLD)
    .sort((a, b) => b.touches - a.touches)[0];

  if (worst === undefined) return null;

  // Evidence produced after work on this file began means it is moving.
  if (
    input.evidenceProducedAt !== null &&
    Date.parse(input.evidenceProducedAt) > Date.parse(worst.claimedAt)
  ) {
    return null;
  }

  return {
    laneId: input.laneId,
    path: worst.path,
    rewrites: worst.touches,
    fact:
      `"${worst.path}" has been rewritten ${worst.touches} times and "${input.laneId}" has shown ` +
      'nothing since it started on it.'
  };
}

/** One round of the confirmation question, and what came back. */
export interface StuckProbe {
  askedAt: string;
  /** What the agent said was missing, or null while it has not answered. */
  missing: string | null;
  answeredAt: string | null;
}

export type StuckVerdict =
  | { kind: 'ask'; question: string }
  | { kind: 'waiting' }
  | { kind: 'stuck'; missing: string; rounds: number };

/**
 * Turns the signal into a decision.
 *
 * The question is concrete — *can you produce your evidence yet; if not, what
 * is missing?* — because "are you nearly done" gets an optimistic answer every
 * time. The same missing piece twice means it is not moving.
 */
export function assessStuck(signal: SpinSignal, probes: readonly StuckProbe[]): StuckVerdict {
  const answered = probes.filter((probe) => probe.missing !== null);
  const last = probes.at(-1);

  if (last !== undefined && last.missing === null) return { kind: 'waiting' };

  const latest = answered.at(-1);
  const previous = answered.at(-2);
  if (latest !== undefined && previous !== undefined && latest.missing === previous.missing) {
    return { kind: 'stuck', missing: latest.missing as string, rounds: answered.length };
  }

  return {
    kind: 'ask',
    question:
      `${signal.fact} Can you produce the evidence this lane promised yet? ` +
      'If not, name the one thing that is missing. Saying you are stuck costs you nothing — ' +
      'it is cheaper than another rewrite.'
  };
}
