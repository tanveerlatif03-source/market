/**
 * Wires the gate to a real repository (Q1).
 *
 * The room says what was promised; git says what happened; `evaluateMerge`
 * decides. Nothing here re-implements a rule — it only gathers the facts and
 * carries out the verdict.
 */

import {
  changedFiles,
  checkout,
  currentBranch,
  ensureBranch,
  git,
  mergeBranch,
  mergesCleanly
} from '../git/repo.ts';
import type { Repo } from '../git/repo.ts';
import { evaluateMerge, summarize } from './evaluate.ts';
import type { GateDecision, LaneUnderGate, SeamState } from './evaluate.ts';
import { reviewRequirements, risksTouched, seamContextOf, unsignedRisks } from '../room/review.ts';
import { landingPlan, repoOf } from '../room/repos.ts';
import type { LandingPlan, LandingStep, RoomRepo } from '../room/repos.ts';
import type { RoomService } from '../room/service.ts';
import type { Room, SeamCheck, Task } from '../types.ts';

export interface GateOptions {
  /**
   * The repository, for a one-repo room. A room spanning repositories declares
   * them on the room itself and the gate reads the roots from there (Q17).
   */
  repo?: Repo;
  /** The branch lanes land on, when `repo` is given. */
  baseBranch?: string;
  /** How a lane id maps to a branch. */
  branchForLane?: (laneId: string) => string;
  /**
   * Called just before each merge in a multi-step landing (Q17).
   *
   * A cross-repo landing is a sequence, and the world does not hold still while
   * it runs: the gate can check that everything merges cleanly, start, and have
   * somebody push to the second repository's base branch before it gets there.
   * That race is the whole reason the half-landed state has to exist. This hook
   * is where a caller shows progress between steps — and where a test can make
   * that race happen on purpose.
   */
  onStep?: (step: LandingStep, index: number, total: number) => void | Promise<void>;
}

export interface LandingOutcome {
  verdict: GateDecision['verdict'];
  decision: GateDecision;
  /** Lanes actually merged. A set, because lanes sharing a contract land together. */
  landed: string[];
  conflicts: string[];
  summary: string;
  /** What was going to happen, in order, before any of it did (Q17). */
  plan: LandingPlan;
  /**
   * Set when the set spanned repositories and only some of them took it. The
   * room goes red on this, and stays red. Never silently absent.
   */
  partial: boolean;
}

export class MergeGate {
  private readonly service: RoomService;
  private readonly fallback: { repo: Repo; baseBranch: string } | null;
  private readonly branchForLane: (laneId: string) => string;
  private readonly onStep: GateOptions['onStep'];

  constructor(service: RoomService, options: GateOptions = {}) {
    this.service = service;
    this.fallback =
      options.repo === undefined
        ? null
        : { repo: options.repo, baseBranch: options.baseBranch ?? 'main' };
    this.branchForLane = options.branchForLane ?? ((laneId) => `agora/${laneId}`);
    this.onStep = options.onStep;
  }

  /**
   * Where a lane's work actually lives. A room that declared repositories says
   * so per lane; a room that did not has exactly one, given to the gate.
   */
  private where(room: Room, laneId: string): { repo: Repo; baseBranch: string; repoId: string } {
    const declared: RoomRepo | undefined = repoOf(
      room,
      room.tasks.find((task) => task.id === laneId)
    );
    if (declared !== undefined) {
      return {
        repo: { root: declared.root },
        baseBranch: declared.baseBranch,
        repoId: declared.id
      };
    }
    if (this.fallback === null) {
      throw new Error(
        `No repository for "${laneId}". Add one to the room, or give the gate a repo.`
      );
    }
    return { ...this.fallback, repoId: 'repo' };
  }

  /** Cuts the branch a lane works on, off its own repository's base. */
  async openLane(laneId: string): Promise<string> {
    const room = this.service.snapshot();
    const { repo, baseBranch } = this.where(room, laneId);
    const branch = this.branchForLane(laneId);
    await ensureBranch(repo, branch, baseBranch);
    return branch;
  }

  /**
   * What landing this lane would do, in order, and what would be inconsistent
   * while it happened (Q17). Read-only: a person can look before pressing.
   */
  landingPlan(laneId: string): LandingPlan {
    const room = this.service.snapshot();
    return landingPlan({
      room,
      laneId,
      set: [laneId, ...seamMatesOf(room, laneId)],
      branchForLane: this.branchForLane,
      repoFor: (id) => {
        const declared = repoOf(room, room.tasks.find((task) => task.id === id));
        if (declared !== undefined) {
          return { id: declared.id, name: declared.name, baseBranch: declared.baseBranch };
        }
        if (this.fallback === null) return undefined;
        return { id: 'repo', name: 'the repository', baseBranch: this.fallback.baseBranch };
      }
    });
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
   * Lands a lane and every lane that shares a contract with it.
   *
   * Inside one repository this is all-or-nothing: the merges go in one at a
   * time and a conflict stops the rest, which is what "they land together"
   * means. Across repositories it cannot be all-or-nothing, and Agora does not
   * pretend it is (Q17). It goes in the order the plan stated, and if the
   * second half does not take, the room goes red and stays red until somebody
   * finishes it or reverts it.
   */
  async land(laneId: string): Promise<LandingOutcome> {
    const room = this.service.snapshot();
    const plan = this.landingPlan(laneId);
    const decision = await this.evaluate(laneId);

    if (decision.verdict !== 'merge') {
      return {
        verdict: decision.verdict,
        decision,
        landed: [],
        conflicts: [],
        plan,
        partial: false,
        summary: summarize(decision, laneId)
      };
    }

    if (plan.steps.length === 0) {
      throw new Error(`No repository for "${laneId}". Add one to the room, or give the gate a repo.`);
    }

    const landed: { laneId: string; repoId: string; head: string | null }[] = [];
    const conflicts: string[] = [];
    let stoppedBy: string | null = null;

    for (const [index, step] of plan.steps.entries()) {
      await this.onStep?.(step, index, plan.steps.length);
      const outcome = await mergeBranch(
        { root: this.rootOf(room, step.repoId) },
        step.branch,
        step.baseBranch,
        `Agora: land "${step.laneId}"`
      );
      if (outcome.merged) {
        landed.push({ laneId: step.laneId, repoId: step.repoId, head: outcome.head });
      } else {
        conflicts.push(...outcome.conflicts);
        stoppedBy = step.laneId;
        break;
      }
    }

    const pending = plan.steps
      .filter((step) => !landed.some((done) => done.laneId === step.laneId))
      .map((step) => ({ laneId: step.laneId, repoId: step.repoId }));

    // Half in, across repositories. This is the case the whole design is built
    // to make loud rather than quiet.
    const repos = new Set(plan.steps.map((step) => step.repoId));
    const partial = pending.length > 0 && landed.length > 0 && repos.size > 1;
    if (partial) {
      await this.service.recordPartialLanding({
        laneId,
        landed,
        pending,
        reason:
          `"${stoppedBy}" would not merge into ${pending[0]?.repoId ?? 'its repository'}` +
          (conflicts.length > 0 ? `: ${conflicts.join(', ')}.` : '.'),
        conflicts
      });
    }

    const names = landed.map((step) => step.laneId);
    return {
      verdict: pending.length > 0 ? 'refuse' : 'merge',
      decision,
      landed: names,
      conflicts,
      plan,
      partial,
      summary:
        pending.length === 0
          ? `Landed ${names.join(', ')}.`
          : partial
            ? `The room is red: ${names.join(', ')} landed and ${pending
                .map((step) => step.laneId)
                .join(', ')} did not. Two repositories now disagree about a contract.`
            : `Landed nothing. "${stoppedBy}" hit a conflict in ${conflicts.join(', ')}.`
    };
  }

  /**
   * Retries the halves that did not land. The set is still gated — nothing
   * slips through because an earlier attempt got partway.
   */
  async resume(): Promise<LandingOutcome | null> {
    const partial = this.service.snapshot().partialLanding;
    if (partial === null) return null;
    const outcome = await this.land(partial.laneId);
    return outcome;
  }

  /**
   * Puts back what landed, with a revert commit on each base. Never a force
   * push: somebody has that history checked out.
   */
  async rollback(by: string): Promise<{ reverted: string[]; failed: string[] }> {
    const room = this.service.snapshot();
    const partial = room.partialLanding;
    if (partial === null) return { reverted: [], failed: [] };

    const reverted: string[] = [];
    const failed: string[] = [];
    // Newest first, so each revert applies to the tree the one before it left.
    for (const step of [...partial.landed].reverse()) {
      if (step.head === null) {
        failed.push(step.repoId);
        continue;
      }
      const repo = { root: this.rootOf(room, step.repoId) };
      const previous = await currentBranch(repo).catch(() => null);
      const base = room.repos.find((entry) => entry.id === step.repoId)?.baseBranch ?? 'main';
      try {
        await checkout(repo, base);
        await git(repo, [
          'revert',
          '--no-edit',
          '-m',
          '1',
          step.head
        ]);
        reverted.push(step.repoId);
      } catch {
        await git(repo, ['revert', '--abort']).catch(() => undefined);
        failed.push(step.repoId);
      } finally {
        if (previous !== null) await checkout(repo, previous).catch(() => undefined);
      }
    }

    if (failed.length === 0) {
      await this.service.clearPartialLanding(by, {
        how: 'rolled-back',
        note: `Reverted in ${reverted.join(', ')}.`
      });
    }
    return { reverted, failed };
  }

  private rootOf(room: Room, repoId: string): string {
    const declared = room.repos.find((repo) => repo.id === repoId);
    if (declared !== undefined) return declared.root;
    if (this.fallback === null) throw new Error(`No repository "${repoId}" in this room.`);
    return this.fallback.repo.root;
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
    const { repo, baseBranch } = this.where(room, laneId);
    const [changed, clean] = await Promise.all([
      changedFiles(repo, baseBranch, branch).catch(() => [] as string[]),
      mergesCleanly(repo, branch, baseBranch)
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
