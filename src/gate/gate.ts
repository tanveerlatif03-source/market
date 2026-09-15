/**
 * Wires the gate to a real repository (Q1).
 *
 * The room says what was promised; git says what happened; `evaluateMerge`
 * decides. Nothing here re-implements a rule — it only gathers the facts and
 * carries out the verdict.
 */

import { changedFiles, ensureBranch, mergeBranch, mergesCleanly } from '../git/repo.ts';
import type { Repo } from '../git/repo.ts';
import { evaluateMerge, summarize } from './evaluate.ts';
import type { GateDecision, LaneUnderGate, SeamState } from './evaluate.ts';
import { reviewRequirements, risksTouched, seamContextOf, unsignedRisks } from '../room/review.ts';
import type { RoomService } from '../room/service.ts';
import type { Room, SeamCheck, Task } from '../types.ts';

export interface GateOptions {
  repo: Repo;
  /** The branch lanes land on. */
  baseBranch?: string;
  /** How a lane id maps to a branch. */
  branchForLane?: (laneId: string) => string;
}

export interface LandingOutcome {
  verdict: GateDecision['verdict'];
  decision: GateDecision;
  /** Lanes actually merged. A set, because lanes sharing a contract land together. */
  landed: string[];
  conflicts: string[];
  summary: string;
}

export class MergeGate {
  private readonly service: RoomService;
  private readonly repo: Repo;
  private readonly baseBranch: string;
  private readonly branchForLane: (laneId: string) => string;

  constructor(service: RoomService, options: GateOptions) {
    this.service = service;
    this.repo = options.repo;
    this.baseBranch = options.baseBranch ?? 'main';
    this.branchForLane = options.branchForLane ?? ((laneId) => `agora/${laneId}`);
  }

  /** Cuts the branch a lane works on, off the base. Safe to call repeatedly. */
  async openLane(laneId: string): Promise<string> {
    const branch = this.branchForLane(laneId);
    await ensureBranch(this.repo, branch, this.baseBranch);
    return branch;
  }

  /**
   * What the gate would say right now. Read-only — an agent can ask before it
   * submits, and find out what is missing while it can still fix it.
   */
  async evaluate(laneId: string): Promise<GateDecision> {
    const room = this.service.snapshot();
    const own = await this.ownReadiness(room, laneId);
    if (own.verdict === 'refuse') return own;

    // Only lanes sharing a contract have to wait for each other (Q12), and a
    // mate's own readiness is what counts — asking it to evaluate in full would
    // just bounce back here.
    const mates = seamMatesOf(room, laneId);
    const readiness = await Promise.all(
      mates.map(async (mate) => ({
        laneId: mate,
        ready: (await this.ownReadiness(room, mate)).verdict !== 'refuse'
      }))
    );

    return evaluateMerge({
      ...(await this.factsFor(room, laneId)),
      seamMates: readiness
    });
  }

  /**
   * Lands a lane, and every lane that shares a contract with it, or lands
   * nothing at all. A contract that ships half-kept is worse than one that
   * waits.
   */
  async land(laneId: string): Promise<LandingOutcome> {
    const decision = await this.evaluate(laneId);
    if (decision.verdict !== 'merge') {
      return {
        verdict: decision.verdict,
        decision,
        landed: [],
        conflicts: [],
        summary: summarize(decision, laneId)
      };
    }

    const room = this.service.snapshot();
    const set = [laneId, ...seamMatesOf(room, laneId)];
    const landed: string[] = [];
    const conflicts: string[] = [];

    for (const lane of set) {
      const outcome = await mergeBranch(
        this.repo,
        this.branchForLane(lane),
        this.baseBranch,
        `Agora: land "${lane}"`
      );
      if (outcome.merged) {
        landed.push(lane);
      } else {
        conflicts.push(...outcome.conflicts);
        break;
      }
    }

    return {
      verdict: conflicts.length > 0 ? 'refuse' : 'merge',
      decision,
      landed,
      conflicts,
      summary:
        conflicts.length > 0
          ? `Landed ${landed.join(', ') || 'nothing'} before hitting a conflict in ${conflicts.join(', ')}.`
          : `Landed ${landed.join(', ')}.`
    };
  }

  /** This lane judged on its own merits, with no regard for its partners. */
  private async ownReadiness(room: Room, laneId: string): Promise<GateDecision> {
    return evaluateMerge({ ...(await this.factsFor(room, laneId)), seamMates: [] });
  }

  private async factsFor(
    room: Room,
    laneId: string
  ): Promise<{ lane: LaneUnderGate; claims: Room['claims']; mergesCleanly: boolean }> {
    const task = room.tasks.find((candidate) => candidate.id === laneId);
    if (task === undefined) {
      throw new Error(`No lane "${laneId}" on this board.`);
    }
    const branch = this.branchForLane(laneId);
    const [changed, clean] = await Promise.all([
      changedFiles(this.repo, this.baseBranch, branch).catch(() => [] as string[]),
      mergesCleanly(this.repo, branch, this.baseBranch)
    ]);

    const last = task.submissions.at(-1);
    return {
      lane: {
        laneId,
        owner: task.owner,
        submitted: task.status === 'submitted' || task.status === 'accepted',
        changedFiles: changed,
        declaredFiles: last?.filesChanged ?? [],
        seams: seamStates(room, task, last?.seamChecks ?? []),
        reviews: reviewRequirements(seamContextOf(room, laneId)),
        // The diff decides which risky surfaces were touched, not the report.
        unsignedRisks: unsignedRisks(
          risksTouched(changed, room.riskList),
          room.signOffs,
          { laneId, latestSubmissionId: last?.id ?? null }
        ),
        evidence:
          task.evidence === null
            ? null
            : { statement: task.evidence.statement, produced: task.evidence.produced }
      },
      claims: room.claims,
      mergesCleanly: clean
    };
  }
}

function seamStates(room: Room, task: Task, checks: readonly SeamCheck[]): SeamState[] {
  return task.seams.flatMap((seamId) => {
    const decision = room.decisions.find((candidate) => candidate.id === seamId);
    if (decision === undefined) return [];
    const check = checks.find((candidate) => candidate.decisionId === seamId);
    return [
      {
        id: decision.id,
        title: decision.title,
        currentVersion: decision.version,
        signedVersion: check?.signedVersion ?? null,
        satisfied: check?.satisfied ?? false
      }
    ];
  });
}

/** Lanes on the other side of every contract this lane touches. */
export function seamMatesOf(room: Room, laneId: string): string[] {
  const task = room.tasks.find((candidate) => candidate.id === laneId);
  if (task === undefined) return [];
  const mates = new Set<string>();
  for (const seamId of task.seams) {
    const decision = room.decisions.find((candidate) => candidate.id === seamId);
    for (const other of decision?.seam?.betweenTasks ?? []) {
      if (other !== laneId) mates.add(other);
    }
  }
  return [...mates].sort();
}
