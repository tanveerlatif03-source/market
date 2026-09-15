/**
 * Per-file claims (Q2–Q5).
 *
 * A lane is intent — "I'm on checkout". A claim is fact — "I hold these six
 * files, right now". Agents discover what they need to touch as they work, so
 * territory is a live ragged set rather than a shape drawn up front.
 *
 * The rules in one place:
 *
 *   held  — nobody may take it. Refusing a second agent here means the *plan*
 *           put two agents in the same code, so it goes to a human.
 *   soft  — the holder has moved on. Anyone may take it instantly, and the
 *           previous holder is told it lost it. Agents never negotiate.
 *   gone  — the holder's session died, or it released.
 *
 * Everything here is pure. State is derived from timestamps rather than swept
 * by a background job, so the same inputs always produce the same answer and a
 * test can simply move the clock.
 */

import { normalizePath } from '../paths.ts';

/** A file untouched for this long, while its holder worked elsewhere, goes soft. */
export const SOFT_AFTER_MS = 10 * 60 * 1000;

/** No heartbeat for this long and the session is treated as dead. */
export const SESSION_DEAD_AFTER_MS = 2 * 60 * 1000;

export type ClaimState = 'held' | 'soft';

export interface Claim {
  /** Repository-relative, normalized. One claim per path, room-wide. */
  path: string;
  holder: string;
  /** The lane it was claimed for. Intent, not enforcement. */
  laneId: string;
  claimedAt: string;
  /** Last time the holder claimed this exact file. Claiming is touching (Q2). */
  touchedAt: string;
}

export type ClaimOutcome =
  | { kind: 'granted'; claim: Claim; previousHolder: null }
  | { kind: 'refreshed'; claim: Claim; previousHolder: null }
  | { kind: 'taken'; claim: Claim; previousHolder: string }
  | { kind: 'collision'; claim: Claim; heldBy: string };

export interface ClaimHolderActivity {
  /** The holder's most recent touch on *any* file, as an ISO timestamp. */
  latestTouchAt: string;
  /** The holder's last heartbeat, or null if it has never been seen. */
  lastSeenAt: string | null;
}

function ms(at: string): number {
  return Date.parse(at);
}

/**
 * Is this claim still hard?
 *
 * Soft needs two things to be true at once: the file has gone quiet, *and* its
 * holder has been working on something else since. That distinction is the
 * whole point — an agent that has moved on is done in all but name, but an
 * agent that is merely thinking for ten minutes has not moved on at all, and
 * taking its file would be theft.
 */
export function claimStateAt(
  claim: Claim,
  activity: ClaimHolderActivity,
  now: number
): ClaimState {
  const quietFor = now - ms(claim.touchedAt);
  if (quietFor < SOFT_AFTER_MS) return 'held';
  const workedElsewhereSince = ms(activity.latestTouchAt) > ms(claim.touchedAt);
  return workedElsewhereSince ? 'soft' : 'held';
}

/** A session that stopped heartbeating is gone, and so are its claims. */
export function isSessionDead(activity: ClaimHolderActivity, now: number): boolean {
  if (activity.lastSeenAt === null) return true;
  return now - ms(activity.lastSeenAt) >= SESSION_DEAD_AFTER_MS;
}

export interface ClaimRequest {
  claims: readonly Claim[];
  path: string;
  agentId: string;
  laneId: string;
  /** Activity for every agent holding a claim, keyed by agent id. */
  activity: Readonly<Record<string, ClaimHolderActivity>>;
  now: number;
}

/**
 * Decides what happens when an agent asks for a file, without mutating
 * anything. The caller applies the outcome.
 */
export function requestClaim(request: ClaimRequest): ClaimOutcome {
  const path = normalizePath(request.path);
  const at = new Date(request.now).toISOString();
  const existing = request.claims.find((claim) => claim.path === path);

  if (existing === undefined) {
    return {
      kind: 'granted',
      previousHolder: null,
      claim: {
        path,
        holder: request.agentId,
        laneId: request.laneId,
        claimedAt: at,
        touchedAt: at
      }
    };
  }

  // Claiming a file you already hold is how you say you are still on it.
  if (existing.holder === request.agentId) {
    return {
      kind: 'refreshed',
      previousHolder: null,
      claim: { ...existing, laneId: request.laneId, touchedAt: at }
    };
  }

  const holderActivity = request.activity[existing.holder];
  const dead =
    holderActivity === undefined || isSessionDead(holderActivity, request.now);
  const state = dead ? 'soft' : claimStateAt(existing, holderActivity, request.now);

  if (state === 'soft') {
    return {
      kind: 'taken',
      previousHolder: existing.holder,
      claim: {
        path,
        holder: request.agentId,
        laneId: request.laneId,
        claimedAt: at,
        touchedAt: at
      }
    };
  }

  return { kind: 'collision', claim: existing, heldBy: existing.holder };
}

/** Everything `agentId` holds, with each claim's state resolved. */
export function claimsHeldBy(
  claims: readonly Claim[],
  agentId: string,
  activity: Readonly<Record<string, ClaimHolderActivity>>,
  now: number
): { claim: Claim; state: ClaimState }[] {
  return claims
    .filter((claim) => claim.holder === agentId)
    .map((claim) => {
      const holderActivity = activity[agentId];
      const state =
        holderActivity === undefined ? 'soft' : claimStateAt(claim, holderActivity, now);
      return { claim, state };
    });
}

/** Claims whose holder has stopped heartbeating. The caller drops them. */
export function abandonedClaims(
  claims: readonly Claim[],
  activity: Readonly<Record<string, ClaimHolderActivity>>,
  now: number
): Claim[] {
  return claims.filter((claim) => {
    const holderActivity = activity[claim.holder];
    return holderActivity === undefined || isSessionDead(holderActivity, now);
  });
}

/**
 * Files an agent changed that it never held. The merge gate's backstop for
 * anything that skipped the claim (Q1, Q2).
 */
export function unclaimedChanges(
  claims: readonly Claim[],
  filesChanged: readonly string[],
  agentId: string
): string[] {
  const held = new Set(
    claims.filter((claim) => claim.holder === agentId).map((claim) => claim.path)
  );
  return filesChanged.map(normalizePath).filter((path) => !held.has(path));
}
