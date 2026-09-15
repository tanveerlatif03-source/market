/**
 * Rooms that span repositories (Q17).
 *
 * A room is a unit of work, and work does not stop at a repository boundary: a
 * contract between a front end and the service behind it is one contract, even
 * though it lands as two merges.
 *
 * The honest part is what Agora refuses to promise. Two merges into two
 * repositories cannot be atomic, and no amount of machinery makes them so. So
 * Agora does not pretend:
 *
 *   - **Order.** The side the other would be broken without goes first. The
 *     plan states it, and the room refuses a cross-repo contract that does not.
 *   - **Blast radius.** Before anything moves, the exact window of
 *     inconsistency is spelled out: which repository is ahead of which, for how
 *     long, and what breaks if it stays that way.
 *   - **Loud failure.** If the second half does not land, the room goes red and
 *     stays red. A half-landed contract that nobody is told about is the worst
 *     outcome this system can produce, and it is the one thing the design is
 *     built to make impossible.
 */

import type { Decision, Room, Task } from '../types.ts';

/** A repository this room touches. Agora holds a working copy and the branch. */
export interface RoomRepo {
  id: string;
  name: string;
  /** Absolute path to Agora's working copy. */
  root: string;
  baseBranch: string;
  addedAt: string;
}

/** One merge, in the order it has to happen. */
export interface LandingStep {
  order: number;
  laneId: string;
  repoId: string;
  repoName: string;
  branch: string;
  baseBranch: string;
  /** Why this one goes here rather than somewhere else. */
  because: string;
}

/**
 * What landing this set will do, said before it does any of it. The window
 * lines are the part that matters: they are the cost of not being atomic,
 * stated rather than hidden.
 */
export interface LandingPlan {
  laneId: string;
  steps: LandingStep[];
  /** True when every step is in one repository, so the set lands as one merge. */
  atomic: boolean;
  /** The periods during which the repositories disagree with each other. */
  windows: string[];
  /** One line for a person about to press the button. */
  summary: string;
}

/** A landing that got half in. The room is red until this is resolved. */
export interface PartialLanding {
  /** The lane whose landing was attempted. */
  laneId: string;
  /** Steps that went in, oldest first. These are real commits on real bases. */
  landed: { laneId: string; repoId: string; head: string | null }[];
  /** Steps that did not. */
  pending: { laneId: string; repoId: string }[];
  /** Why it stopped. */
  reason: string;
  conflicts: string[];
  at: string;
  /** Who or what has been asked to deal with it. */
  attentionId: string | null;
}

export const DEFAULT_REPO_ID = 'main';

export function repoOf(room: Room, task: Task | undefined): RoomRepo | undefined {
  if (room.repos.length === 0) return undefined;
  const wanted = task?.repoId ?? null;
  if (wanted === null) return room.repos[0];
  return room.repos.find((repo) => repo.id === wanted) ?? room.repos[0];
}

/** True when these two lanes live in different repositories. */
export function spansRepos(room: Room, a: string, b: string): boolean {
  const first = repoOf(room, room.tasks.find((task) => task.id === a));
  const second = repoOf(room, room.tasks.find((task) => task.id === b));
  if (first === undefined || second === undefined) return false;
  return first.id !== second.id;
}

/**
 * Cross-repo contracts with no stated order. A plan cannot be approved while
 * any of these exist: without an order, "they land together" is a promise
 * Agora cannot keep, and pretending otherwise is how a half-landed contract
 * gets shipped quietly.
 */
export function contractsMissingOrder(room: Room): { seamId: string; title: string }[] {
  const missing: { seamId: string; title: string }[] = [];
  for (const decision of room.decisions) {
    const seam = decision.seam;
    if (seam === null || seam === undefined) continue;
    const [a, b] = seam.betweenTasks;
    if (!spansRepos(room, a, b)) continue;
    if (seam.landFirst === null) missing.push({ seamId: decision.id, title: decision.title });
  }
  return missing;
}

/**
 * Orders a set of lanes for landing.
 *
 * Every contract inside the set that names a `landFirst` is an edge. The result
 * is a topological order; a cycle is impossible to satisfy and says so rather
 * than picking arbitrarily.
 */
export function orderLanes(
  room: Room,
  lanes: readonly string[]
): { order: string[]; cycle: string[] | null } {
  const inSet = new Set(lanes);
  const edges = new Map<string, Set<string>>();
  for (const laneId of lanes) edges.set(laneId, new Set());

  for (const decision of room.decisions) {
    const seam = decision.seam;
    if (seam === null || seam === undefined || seam.landFirst === null) continue;
    const [a, b] = seam.betweenTasks;
    if (!inSet.has(a) || !inSet.has(b)) continue;
    const first = seam.landFirst;
    const second = first === a ? b : a;
    // "second depends on first": first has to be in before second.
    edges.get(second)?.add(first);
  }

  const order: string[] = [];
  const done = new Set<string>();
  const remaining = new Set(lanes);

  while (remaining.size > 0) {
    // Stable: among everything whose dependencies are in, take the lowest id.
    const ready = [...remaining]
      .filter((laneId) => [...(edges.get(laneId) ?? [])].every((dep) => done.has(dep)))
      .sort();
    if (ready.length === 0) return { order, cycle: [...remaining].sort() };
    const next = ready[0] as string;
    order.push(next);
    done.add(next);
    remaining.delete(next);
  }

  return { order, cycle: null };
}

/** What the contract between two lanes actually promises, for the window text. */
function contractBetween(room: Room, a: string, b: string): Decision | undefined {
  return room.decisions.find((decision) => {
    const between = decision.seam?.betweenTasks;
    return between !== undefined && between.includes(a) && between.includes(b);
  });
}

export interface LandingPlanInput {
  room: Room;
  laneId: string;
  /** The whole set that lands together: this lane and its contract partners. */
  set: readonly string[];
  branchForLane: (laneId: string) => string;
  /**
   * Where a lane lands. The gate supplies this rather than the plan reading the
   * registry, because a one-repo room declares no repositories at all — it just
   * has the one, handed to the gate.
   */
  repoFor: (laneId: string) => { id: string; name: string; baseBranch: string } | undefined;
}

export function landingPlan(input: LandingPlanInput): LandingPlan {
  const { room, laneId } = input;
  const { order, cycle } = orderLanes(room, input.set);

  const steps: LandingStep[] = order.flatMap((id, index) => {
    const repo = input.repoFor(id);
    if (repo === undefined) return [];
    const ahead = order.slice(0, index).find((other) => {
      const seam = contractBetween(room, id, other)?.seam;
      return seam?.landFirst === other;
    });
    return [
      {
        order: index + 1,
        laneId: id,
        repoId: repo.id,
        repoName: repo.name,
        branch: input.branchForLane(id),
        baseBranch: repo.baseBranch,
        because:
          ahead === undefined
            ? 'Nothing in this set has to be in place before it.'
            : `"${ahead}" has to be in place first — this side would be broken without it.`
      }
    ];
  });

  const repos = new Set(steps.map((step) => step.repoId));
  const atomic = repos.size <= 1;

  const windows: string[] = [];
  if (!atomic) {
    for (let index = 0; index < steps.length - 1; index += 1) {
      const done = steps.slice(0, index + 1);
      const next = steps[index + 1];
      if (next === undefined) continue;
      const contract = contractBetween(room, done[index]?.laneId ?? '', next.laneId);
      windows.push(
        `After step ${index + 1}, ${done.map((step) => step.repoName).join(' and ')} ` +
          `${done.length === 1 ? 'is' : 'are'} on the new ${contract?.title ?? 'contract'} and ` +
          `${next.repoName} is not. That window is open until step ${index + 2} lands. ` +
          'Nothing rolls this back for you.'
      );
    }
  }

  const summary =
    cycle !== null
      ? `These lanes each have to land before the other: ${cycle.join(', ')}. ` +
        'A contract cannot say that. One side has to be able to go first.'
      : atomic
        ? `${steps.length} lane(s) in one repository. They land as one merge set, or not at all.`
        : `${steps.length} lane(s) across ${repos.size} repositories, in order: ` +
          `${steps.map((step) => `${step.order}. ${step.laneId} (${step.repoName})`).join(', ')}. ` +
          'These are separate merges. They cannot be atomic, and Agora will not pretend they are.';

  return { laneId, steps, atomic, windows, summary };
}

/** The line a person needs when a room has gone red. */
export function partialLandingSummary(partial: PartialLanding): string {
  return (
    `${partial.landed.map((step) => step.repoId).join(', ')} ${partial.landed.length === 1 ? 'has' : 'have'} ` +
    `this change and ${partial.pending.map((step) => step.repoId).join(', ')} ` +
    `${partial.pending.length === 1 ? 'does' : 'do'} not. ${partial.reason} ` +
    'Until that is fixed, the two sides of a contract disagree in production.'
  );
}
