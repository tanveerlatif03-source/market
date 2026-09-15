import { AgoraError } from '../errors.ts';
import { EventBus } from '../events.ts';
import { AgoraStore } from '../store/store.ts';
import { hashToken, newToken, nowIso, shortId, slugify } from '../ids.ts';
import { normalizePath, ownersOfPaths, pathsOutsideLane } from '../paths.ts';
import {
  abandonedClaims,
  claimsHeldBy,
  requestClaim,
  unclaimedChanges
} from './claims.ts';
import type { Claim, ClaimHolderActivity, ClaimState } from './claims.ts';
import { DEFAULT_MESSAGE_BUDGET, HUMAN_ID, OWNER_ID, PLAN_TASK_ID } from './seed.ts';
import { agentRoomView, supervisorRoomView } from './views.ts';
import type { AgentRoomView, SupervisorRoomView } from './views.ts';
import { OPENS_TO_ROOM_AFTER_MS, canAnswer, queueFor } from './attention.ts';
import { canDo, describeAction } from './rights.ts';
import type { RoomAction } from './rights.ts';
import type { AttentionItem, AttentionQueue } from './attention.ts';
import { assessStuck, detectSpin } from './spin.ts';
import type { StuckVerdict } from './spin.ts';
import {
  reviewRequirements,
  reviewsOwedBy,
  risksTouched,
  seamContextOf,
  unsignedRisks
} from './review.ts';
import type { Review, ReviewRequirement, ReviewVerdict, RiskRule } from './review.ts';
import { provenanceOf } from './provenance.ts';
import type { Provenance, ProvenanceSubject } from './provenance.ts';
import { costReport, quotaWarnings } from './cost.ts';
import type { BrokerUsage } from '../broker/broker.ts';
import type { CostEntry, CostProvenance, CostReport } from './cost.ts';
import { DEFAULT_SORT, ledgerRows, sortRows } from './ledger.ts';
import type { LedgerRow, LedgerSort } from './ledger.ts';
import { archiveOf, closeReadiness } from './close.ts';
import type { CloseReadiness, RoomArchive } from './close.ts';
import { contractsMissingOrder, partialLandingSummary, repoOf } from './repos.ts';
import type { PartialLanding, RoomRepo } from './repos.ts';
import type {
  Dissent,
  Human,
  Agent,
  AgentScope,
  AgentStatus,
  Decision,
  AgoraData,
  MessageKind,
  Room,
  RoomEvent,
  SeamCheck,
  Submission,
  SubmissionOutcome,
  Task,
  Thread,
  TokenRecord
} from '../types.ts';

/** An ask or an answer, not a transcript of how you got there. */
const MAX_MESSAGE_CHARS = 2000;

export interface Principal {
  kind: 'agent' | 'supervisor';
  agentId: string | null;
  /** For a supervisor token: the person it acts as, and therefore its rights (Q16). */
  humanId: string | null;
  label: string;
  tokenId: string;
}

export interface StatusInput {
  /** Goes to the human only. Never enters a thread. */
  statusNote?: string;
}

export interface ReadRoomInput extends StatusInput {
  sinceSeq?: number;
}

export interface ClaimTaskInput extends StatusInput {
  taskId: string;
}

export interface PostMessageInput extends StatusInput {
  taskId: string;
  to?: string[];
  threadId?: string;
  subject?: string;
  kind: MessageKind;
  body: string;
}

export interface PlanProposalTask {
  key: string;
  title: string;
  description?: string;
  /** Which repository these paths are in (Q17). Omitted in a one-repo room. */
  repo?: string;
  paths: string[];
  suggestedOwner?: string;
  actionBudget?: number;
  /** What would demonstrate this lane worked. Approved alongside the split. */
  evidence?: string;
}

export interface PlanProposalSeam {
  title: string;
  body: string;
  /** The two task keys whose pieces touch. */
  between: [string, string];
  /**
   * Which side has to be in place first (Q17). Required when the two sides are
   * in different repositories, because those cannot land atomically and the
   * order is the only thing Agora can actually promise.
   */
  landFirst?: string;
  contract: { task: string; provides: string; expects: string }[];
}

export interface PlanProposal {
  summary?: string;
  tasks: PlanProposalTask[];
  seams: PlanProposalSeam[];
  decisions?: { title: string; body: string }[];
}

export type UnsignedSeamCheck = Omit<SeamCheck, 'signedVersion'>;

export interface SubmitWorkInput extends StatusInput {
  taskId: string;
  summary: string;
  filesChanged?: string[];
  /** Agents do not supply the version — the room stamps whatever is current. */
  seamChecks?: UnsignedSeamCheck[];
  outcome: SubmissionOutcome;
  plan?: PlanProposal;
}

export interface ClaimTaskResult {
  task: Task;
  message: string;
}

export interface PostMessageResult {
  threadId: string;
  messageId: string;
  delivered: string[];
  budgetRemaining: number;
  message: string;
}

export interface SubmitWorkResult {
  task: Task;
  submissionId: string | null;
  message: string;
  nextStep: string;
  /**
   * Files this agent changed without ever claiming them. Advisory here — the
   * merge gate is what refuses them (Q1). Surfaced now so it is visible.
   */
  unclaimed?: string[];
}

type EmitFn = (event: Omit<RoomEvent, 'seq' | 'at'>) => void;

/**
 * Work that belongs to a mutation that failed, and must outlive it. A refusal
 * rolls its own mutation back — so anything the refusal itself produced (the
 * lane that stopped, the person who was told) has to be re-applied afterwards.
 */
type Repair = (data: AgoraData, emit: EmitFn) => void;

const REPAIR = Symbol('agora.repair');

function attachRepair(error: AgoraError, repair: Repair): void {
  (error as AgoraError & { [REPAIR]?: Repair })[REPAIR] = repair;
}

function repairOf(error: unknown): Repair | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { [REPAIR]?: Repair })[REPAIR];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameParticipants(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function scopeAllows(agent: Agent, taskId: string): boolean {
  return agent.scope.writeTasks.includes('*') || agent.scope.writeTasks.includes(taskId);
}

/**
 * Every rule in Agora lives here: who owns what, who may say what to whom,
 * what a seam costs to cross, and when an agent has to stop and ask the human.
 */
export class RoomService {
  private readonly store: AgoraStore;
  private readonly bus: EventBus;

  constructor(store: AgoraStore, bus: EventBus) {
    this.store = store;
    this.bus = bus;
  }

  events(): EventBus {
    return this.bus;
  }

  // ---------------------------------------------------------------- identity

  authenticate(token: string): Principal | null {
    if (token.length === 0) return null;
    const hash = hashToken(token);
    return this.store.read((data) => {
      const record = data.tokens.find((entry) => entry.hash === hash && entry.revokedAt === null);
      if (record === undefined) return null;
      if (record.kind === 'agent') {
        const agent = data.room.agents.find((candidate) => candidate.id === record.agentId);
        if (agent === undefined) return null;
      }
      return {
        kind: record.kind,
        agentId: record.agentId,
        // A token minted before people were named acts as whoever opened the
        // room — which is the only person there was at the time.
        humanId:
          record.kind === 'supervisor'
            ? (record.humanId ?? data.room.humans[0]?.id ?? OWNER_ID)
            : null,
        label: record.label,
        tokenId: record.id
      } satisfies Principal;
    });
  }

  snapshot(): Room {
    return this.store.read((data) => data.room);
  }

  // ------------------------------------------------------------ the four tools

  /** What the room looks like from where this agent sits. */
  async readRoom(agentId: string, input: ReadRoomInput = {}): Promise<AgentRoomView> {
    return this.apply((data, emit) => {
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      this.touchStatus(agent, emit, { note: input.statusNote });
      return agentRoomView(data.room, agent, { sinceSeq: input.sinceSeq ?? 0 });
    });
  }

  /** Take exactly one task. Nobody else may touch it until it is handed back. */
  async claimTask(agentId: string, input: ClaimTaskInput): Promise<ClaimTaskResult> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      this.requireActive(agent);
      const task = this.taskOf(room, input.taskId);

      if (task.id === PLAN_TASK_ID) {
        if (agent.role !== 'lead') {
          throw new AgoraError(
            'NOT_LEAD',
            'Only the room lead proposes the plan.',
            `Wait for ${room.lead ?? 'the lead'} to propose a split, or discuss the seams with post_message.`,
            { lead: room.lead }
          );
        }
      } else {
        if (room.plan.status !== 'approved') {
          throw new AgoraError(
            'PLAN_NOT_APPROVED',
            `The plan is "${room.plan.status}", so no task is claimable yet.`,
            'Wait for the human to approve the plan, then claim again.',
            { planStatus: room.plan.status }
          );
        }
        if (!scopeAllows(agent, task.id)) {
          throw new AgoraError(
            'OUT_OF_SCOPE',
            `Your permission scope does not cover "${task.id}".`,
            'Ask the human to widen your scope, or claim a task you are scoped for.',
            { writeTasks: agent.scope.writeTasks }
          );
        }
      }

      if (task.owner === agent.id) {
        this.touchStatus(agent, emit, { note: input.statusNote, state: 'working', taskId: task.id });
        return { task, message: `You already own "${task.id}".` };
      }

      if (task.owner !== null) {
        throw new AgoraError(
          'TASK_OWNED',
          `"${task.id}" is owned by ${task.owner}.`,
          `One owner per task. Ask ${task.owner} in the thread: post_message with task_id "${task.id}" and kind "ask".`,
          { owner: task.owner, status: task.status }
        );
      }

      if (task.status !== 'open') {
        throw new AgoraError(
          'INVALID',
          `"${task.id}" is ${task.status}, not open.`,
          'Ask the human to reopen it if it needs more work.',
          { status: task.status }
        );
      }

      const at = nowIso();
      task.owner = agent.id;
      task.status = 'claimed';
      task.claimedAt = at;
      task.updatedAt = at;

      emit({
        type: 'task.claimed',
        actor: agent.id,
        taskId: task.id,
        threadId: null,
        summary: `${agent.displayName} claimed "${task.id}".`,
        audience: []
      });
      this.touchStatus(agent, emit, { note: input.statusNote, state: 'working', taskId: task.id });

      const lane = task.paths.length > 0 ? task.paths.join(', ') : 'no declared paths';
      return {
        task,
        message: `You own "${task.id}". Your lane is ${lane}. Finish with submit_work.`
      };
    });
  }

  /** Coordination between agents. Attached to a task, and paid for out of its budget. */
  async postMessage(agentId: string, input: PostMessageInput): Promise<PostMessageResult> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      this.requireActive(agent);
      const task = this.taskOf(room, input.taskId);

      const body = input.body.trim();
      if (body.length === 0) {
        throw new AgoraError('INVALID', 'The message body is empty.', 'Say the ask or the answer.');
      }
      if (body.length > MAX_MESSAGE_CHARS) {
        throw new AgoraError(
          'INVALID',
          `The message is ${body.length} characters; the limit is ${MAX_MESSAGE_CHARS}.`,
          'Send the ask or the answer, not the reasoning behind it. Reasoning belongs in status_note, which only the human reads.',
          { limit: MAX_MESSAGE_CHARS }
        );
      }

      if (task.actionsUsed >= task.actionBudget) {
        this.haltOnBudget(room, task, emit);
        throw new AgoraError(
          'BUDGET_EXHAUSTED',
          `"${task.id}" has used all ${task.actionBudget} of its messages.`,
          'Stop and wait. The human has been asked to raise the budget or redirect the work.',
          { actionBudget: task.actionBudget, actionsUsed: task.actionsUsed }
        );
      }

      const thread = this.resolveThread(room, agent, task, input);
      const at = nowIso();
      const message = {
        id: shortId('msg'),
        threadId: thread.id,
        taskId: task.id,
        from: agent.id,
        kind: input.kind,
        body,
        createdAt: at
      };
      thread.messages.push(message);
      thread.updatedAt = at;
      task.actionsUsed += 1;
      task.updatedAt = at;

      const delivered = thread.participants.filter((participant) => participant !== agent.id);
      emit({
        type: 'message.posted',
        actor: agent.id,
        taskId: task.id,
        threadId: thread.id,
        summary: `${agent.displayName} sent an ${input.kind} to ${delivered.join(', ')} on "${task.id}".`,
        audience: delivered
      });

      if (task.actionsUsed >= task.actionBudget) {
        this.haltOnBudget(room, task, emit);
      }

      this.touchStatus(agent, emit, {
        note: input.statusNote,
        state: input.kind === 'ask' ? 'waiting' : 'working',
        taskId: task.id
      });

      const remaining = task.actionBudget - task.actionsUsed;
      return {
        threadId: thread.id,
        messageId: message.id,
        delivered,
        budgetRemaining: remaining,
        message:
          remaining > 0
            ? `Delivered to ${delivered.join(', ')}. ${remaining} message(s) left on "${task.id}".`
            : `Delivered. "${task.id}" has now spent its message budget and has stopped to ask the human.`
      };
    });
  }

  /** Hand the work back: the plan, if this is the plan task, otherwise the result. */
  async submitWork(agentId: string, input: SubmitWorkInput): Promise<SubmitWorkResult> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      this.requireActive(agent);
      const task = this.taskOf(room, input.taskId);

      if (task.owner !== agent.id) {
        throw new AgoraError(
          'NOT_OWNER',
          `"${task.id}" is owned by ${task.owner ?? 'nobody'}.`,
          task.owner === null
            ? 'Claim it first with claim_task.'
            : `Ask ${task.owner} in the thread rather than submitting on their behalf.`,
          { owner: task.owner }
        );
      }

      if (task.id === PLAN_TASK_ID) {
        return this.submitPlan(room, agent, task, input, emit);
      }

      if (room.plan.status !== 'approved') {
        throw new AgoraError(
          'PLAN_NOT_APPROVED',
          `The plan is "${room.plan.status}".`,
          'Wait for the human to approve the plan before submitting work.',
          { planStatus: room.plan.status }
        );
      }

      const filesChanged = (input.filesChanged ?? []).map(normalizePath);
      const outside = pathsOutsideLane(filesChanged, task.paths);
      if (outside.length > 0) {
        const owners = ownersOfPaths(outside, room.tasks, task.id);
        const owner = owners.find((hit) => hit.owner !== null);
        throw new AgoraError(
          'OUT_OF_SCOPE',
          `These files are outside the lane of "${task.id}": ${outside.join(', ')}.`,
          owner === undefined
            ? 'Claim, do not merge. Ask the human to widen this task or open a task that owns those paths.'
            : `"${owner.path}" belongs to "${owner.taskId}". Ask ${owner.owner} in the thread instead of editing it.`,
          { outside, lane: task.paths, owners }
        );
      }

      const signed: SeamCheck[] = (input.seamChecks ?? []).map((check) => ({
        ...check,
        signedVersion:
          room.decisions.find((decision) => decision.id === check.decisionId)?.version ?? 0
      }));
      const seamChecks = signed;
      for (const check of seamChecks) {
        if (!room.decisions.some((decision) => decision.id === check.decisionId)) {
          throw new AgoraError(
            'NOT_FOUND',
            `No decision "${check.decisionId}" in this room.`,
            'Use the decision ids from read_room.',
            { decisionId: check.decisionId }
          );
        }
      }

      if (input.outcome === 'complete' && task.seams.length > 0) {
        const checked = new Map(seamChecks.map((check) => [check.decisionId, check]));
        const missing = task.seams.filter((seamId) => !checked.has(seamId));
        if (missing.length > 0) {
          throw new AgoraError(
            'INVALID',
            `"${task.id}" touches ${task.seams.length} seam(s); ${missing.join(', ')} went unconfirmed.`,
            'Both sides build toward a fixed point, so confirm each seam in seam_checks before calling this complete.',
            { missing }
          );
        }
        const unsatisfied = task.seams.filter((seamId) => checked.get(seamId)?.satisfied === false);
        if (unsatisfied.length > 0) {
          throw new AgoraError(
            'INVALID',
            `Seam(s) ${unsatisfied.join(', ')} are not satisfied, so this is not complete.`,
            'Submit with outcome "needs-review" or "blocked", and say in the thread what changed on your side.',
            { unsatisfied }
          );
        }
      }

      this.spendAction(room, task, emit);

      const at = nowIso();
      const submission: Submission = {
        id: shortId('sub'),
        taskId: task.id,
        by: agent.id,
        summary: input.summary,
        filesChanged,
        seamChecks,
        outcome: input.outcome,
        createdAt: at
      };
      task.submissions.push(submission);
      task.updatedAt = at;

      if (input.outcome === 'blocked') {
        task.status = 'blocked';
        task.blockedReason = input.summary;
        this.raise(room, emit, {
          kind: 'blocked',
          laneId: task.id,
          title: `"${task.id}" stopped itself`,
          detail: input.summary,
          needsMergeRights: false,
          options: [
            { id: 'answer', label: 'Answer it', effect: 'You supply what it is waiting on and it resumes.' },
            { id: 'reassign', label: 'Give it to someone else', effect: 'Another agent picks the lane up.' },
            { id: 'drop', label: 'Drop the lane', effect: 'The work is abandoned and the files released.' }
          ]
        });
      } else {
        task.status = 'submitted';
        task.blockedReason = null;
        // Finishing is not the end of the lane: the agent across each contract
        // still has to read it (Q13), and a risky surface still pulls a person.
        this.requestReviews(room, task, emit);
        this.flagRisks(room, task, submission, filesChanged, emit);
      }

      const audience = unique([
        ...this.seamPartnerAgents(room, task),
        ...(room.lead !== null ? [room.lead] : []),
        HUMAN_ID
      ]).filter((id) => id !== agent.id);

      emit({
        type: input.outcome === 'blocked' ? 'task.blocked' : 'task.submitted',
        actor: agent.id,
        taskId: task.id,
        threadId: null,
        summary:
          input.outcome === 'blocked'
            ? `${agent.displayName} is blocked on "${task.id}": ${input.summary}`
            : `${agent.displayName} submitted "${task.id}" (${input.outcome}).`,
        audience
      });

      this.touchStatus(agent, emit, {
        note: input.statusNote,
        state: input.outcome === 'blocked' ? 'blocked' : input.outcome === 'complete' ? 'done' : 'waiting',
        taskId: task.id
      });

      const stray = unclaimedChanges(room.claims, filesChanged, agentId);

      return {
        task,
        submissionId: submission.id,
        ...(stray.length > 0 ? { unclaimed: stray } : {}),
        message:
          stray.length > 0
            ? `Submitted "${task.id}" as ${input.outcome}. ${stray.length} file(s) were changed ` +
              'without being claimed first; the merge gate will refuse those.'
            : `Submitted "${task.id}" as ${input.outcome}.`,
        nextStep:
          input.outcome === 'blocked'
            ? 'The human has been told you are blocked. Wait to be unblocked or redirected.'
            : this.reviewersOf(room, task).length > 0
              ? `Submitted. ${this.reviewersOf(room, task).join(' and ')} now read it across the ` +
                'contract; nothing lands until they do. Do not start another lane without claiming it.'
              : 'The human reviews and accepts it. Do not start another lane without claiming it.'
      };
    });
  }

  // ------------------------------------------------------------- planning

  private submitPlan(
    room: Room,
    agent: Agent,
    planTask: Task,
    input: SubmitWorkInput,
    emit: EmitFn
  ): SubmitWorkResult {
    if (agent.role !== 'lead') {
      throw new AgoraError('NOT_LEAD', 'Only the room lead proposes the plan.', 'Leave the plan to the lead.');
    }
    if (room.plan.status === 'approved') {
      throw new AgoraError(
        'INVALID',
        'The plan is already approved.',
        'Ask the human to reopen the plan before changing the split; others have built on it.'
      );
    }
    const proposal = input.plan;
    if (proposal === undefined || proposal.tasks.length === 0) {
      throw new AgoraError(
        'INVALID',
        'A plan proposal needs at least one task.',
        'Pass a "plan" object with the task split and the seam between every pair of tasks that touch.'
      );
    }

    const keys = proposal.tasks.map((task) => task.key);
    if (new Set(keys).size !== keys.length) {
      throw new AgoraError('INVALID', 'Task keys must be unique.', 'Give every task in the split its own key.');
    }
    for (const seam of proposal.seams) {
      for (const key of seam.between) {
        if (!keys.includes(key)) {
          throw new AgoraError(
            'INVALID',
            `Seam "${seam.title}" refers to unknown task key "${key}".`,
            'Seams may only join tasks in this proposal.',
            { key }
          );
        }
      }
      for (const side of seam.contract) {
        if (!seam.between.includes(side.task)) {
          throw new AgoraError(
            'INVALID',
            `Seam "${seam.title}" has a contract for "${side.task}", which is not one of its two sides.`,
            'A seam contract describes exactly the two tasks that touch.',
            { task: side.task }
          );
        }
      }
    }

    const at = nowIso();

    // A re-proposal replaces the previous one wholesale. General decisions the
    // human recorded stay; the previous split and its seams do not.
    room.tasks = room.tasks.filter((task) => task.id === PLAN_TASK_ID);
    room.decisions = room.decisions.filter((decision) => decision.kind === 'general');
    const liveTaskIds = new Set(room.tasks.map((task) => task.id));
    room.threads = room.threads.filter((thread) => liveTaskIds.has(thread.taskId));

    const idByKey = new Map<string, string>();
    for (const proposed of proposal.tasks) {
      const id = this.uniqueTaskId(room, slugify(proposed.key || proposed.title));
      idByKey.set(proposed.key, id);
      room.tasks.push({
        id,
        title: proposed.title,
        description: proposed.description ?? '',
        owner: null,
        suggestedOwner: proposed.suggestedOwner ?? null,
        status: 'draft',
        repoId: this.repoIdFor(room, proposed.repo),
        paths: proposed.paths.map(normalizePath),
        seams: [],
        laneOwner: null,
        evidence:
          proposed.evidence === undefined || proposed.evidence.trim() === ''
            ? null
            : { statement: proposed.evidence.trim(), produced: false, note: '', producedAt: null },
        actionBudget: proposed.actionBudget ?? room.defaultMessageBudget,
        actionsUsed: 0,
        budgetHaltedAt: null,
        blockedReason: null,
        claimedAt: null,
        createdAt: at,
        updatedAt: at,
        submissions: []
      });
      emit({
        type: 'task.created',
        actor: agent.id,
        taskId: id,
        threadId: null,
        summary: `"${id}" — ${proposed.title} (${proposed.paths.join(', ') || 'no paths'})`,
        audience: []
      });
    }

    for (const seam of proposal.seams) {
      const left = idByKey.get(seam.between[0]) as string;
      const right = idByKey.get(seam.between[1]) as string;
      const decision: Decision = {
        id: shortId('dec'),
        kind: 'seam',
        title: seam.title,
        body: seam.body,
        seam: {
          betweenTasks: [left, right],
          landFirst: seam.landFirst === undefined ? null : (idByKey.get(seam.landFirst) ?? null),
          contract: seam.contract.map((side) => ({
            taskId: idByKey.get(side.task) as string,
            provides: side.provides,
            expects: side.expects
          }))
        },
        proposedBy: agent.id,
        createdAt: at,
        version: 1
      };
      room.decisions.push(decision);
      for (const taskId of [left, right]) {
        const task = room.tasks.find((candidate) => candidate.id === taskId);
        if (task !== undefined) task.seams.push(decision.id);
      }
      emit({
        type: 'decision.recorded',
        actor: agent.id,
        taskId: null,
        threadId: null,
        summary: `Seam "${seam.title}" between "${left}" and "${right}".`,
        audience: []
      });
    }

    for (const extra of proposal.decisions ?? []) {
      room.decisions.push({
        id: shortId('dec'),
        kind: 'general',
        title: extra.title,
        body: extra.body,
        seam: null,
        proposedBy: agent.id,
        createdAt: at,
        version: 1
      });
    }

    room.decisions.push({
      id: shortId('dec'),
      kind: 'plan',
      title: `Task split, revision ${room.plan.revision + 1}`,
      body:
        proposal.summary ??
        proposal.tasks.map((task) => `${idByKey.get(task.key)}: ${task.title}`).join('\n'),
      seam: null,
      proposedBy: agent.id,
      createdAt: at,
      version: room.plan.revision + 1
    });

    room.plan = {
      status: 'proposed',
      proposedBy: agent.id,
      proposedAt: at,
      decidedBy: null,
      decidedAt: null,
      note: null,
      revision: room.plan.revision + 1
    };

    const submission: Submission = {
      id: shortId('sub'),
      taskId: planTask.id,
      by: agent.id,
      summary: input.summary,
      filesChanged: [],
      seamChecks: [],
      outcome: 'needs-review',
      createdAt: at
    };
    planTask.submissions.push(submission);
    planTask.status = 'submitted';
    planTask.updatedAt = at;

    const unseamed = room.tasks.filter(
      (task) => task.id !== PLAN_TASK_ID && task.seams.length === 0
    );

    emit({
      type: 'plan.proposed',
      actor: agent.id,
      taskId: null,
      threadId: null,
      summary: `${agent.displayName} proposed a ${proposal.tasks.length}-task split with ${proposal.seams.length} seam(s).`,
      audience: []
    });
    this.touchStatus(agent, emit, { note: input.statusNote, state: 'waiting', taskId: planTask.id });

    return {
      task: planTask,
      submissionId: submission.id,
      message: `Proposed ${proposal.tasks.length} task(s) and ${proposal.seams.length} seam(s).`,
      nextStep:
        unseamed.length > 0
          ? `The human approves in one tap. Note that ${unseamed
              .map((task) => `"${task.id}"`)
              .join(', ')} declared no seam — if those pieces touch anything, agree the seam now, not at merge time.`
          : 'The human approves in one tap, and then everyone is a peer executing.'
    };
  }

  // ------------------------------------------------------- human controls

  supervisorView(): SupervisorRoomView {
    return this.store.read((data) => supervisorRoomView(data.room));
  }

  async setGoal(by: string, goal: string): Promise<Room> {
    return this.apply((data, emit) => {
      this.requireRight(data.room, by, 'set-goal', emit);
      data.room.goal = goal;
      return data.room;
    });
  }

  async addAgent(
    by: string,
    options: {
      id?: string;
      displayName: string;
      provider: string;
      role: 'lead' | 'peer';
      scope?: Partial<AgentScope>;
    }
  ): Promise<{ agent: Agent; token: string }> {
    const token = newToken();
    const agent = await this.apply((data, emit) => {
      const room = data.room;
      this.requireRight(room, by, 'add-agent', emit);
      const id = slugify(options.id ?? options.displayName, 'agent');
      if (room.agents.some((existing) => existing.id === id)) {
        throw new AgoraError('INVALID', `An agent "${id}" is already in this room.`, 'Pick another id.');
      }
      if (options.role === 'lead' && room.lead !== null) {
        throw new AgoraError(
          'INVALID',
          `"${room.lead}" is already lead of this room.`,
          'A room has one lead. Add this agent as a peer.'
        );
      }
      const at = nowIso();
      const created: Agent = {
        id,
        displayName: options.displayName,
        provider: options.provider,
        role: options.role,
        scope: {
          readPaths: options.scope?.readPaths ?? ['**'],
          writeTasks: options.scope?.writeTasks ?? ['*']
        },
        paused: false,
        pausedReason: null,
        status: { state: 'idle', taskId: null, note: '', updatedAt: at },
        joinedAt: at,
        lastSeenAt: null,
        latestTouchAt: null
      };
      room.agents.push(created);
      if (options.role === 'lead') room.lead = id;

      const record: TokenRecord = {
        id: shortId('tok'),
        kind: 'agent',
        agentId: id,
        label: `${options.displayName} (${options.provider})`,
        hash: hashToken(token),
        createdAt: at,
        revokedAt: null
      };
      data.tokens.push(record);

      emit({
        type: 'agent.joined',
        actor: id,
        taskId: null,
        threadId: null,
        summary: `${options.displayName} (${options.provider}) was added as ${options.role}.`,
        audience: []
      });
      return created;
    });
    return { agent, token };
  }

  /**
   * Mints a token for a person. It carries that person's rights and no more —
   * you cannot hand out access above your own level, which is the only way the
   * merge line survives contact with a token (Q16).
   */
  async createSupervisorToken(by: string, label: string, forHuman?: string): Promise<string> {
    const token = newToken();
    await this.apply((data, emit) => {
      const room = data.room;
      const subject = forHuman ?? by;
      const target = room.humans.find((human) => human.id === subject);
      this.requireRight(
        room,
        by,
        target?.canMerge === true ? 'mint-merge-token' : 'mint-token',
        emit
      );
      if (target === undefined) {
        throw new AgoraError(
          'NOT_FOUND',
          `No one called ${subject} is in this room.`,
          'Add them first; anyone in the room can.'
        );
      }
      data.tokens.push({
        id: shortId('tok'),
        kind: 'supervisor',
        agentId: null,
        humanId: target.id,
        label,
        hash: hashToken(token),
        createdAt: nowIso(),
        revokedAt: null
      });
    });
    return token;
  }

  async approvePlan(by: string, note: string | null = null): Promise<Room> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = this.requireRight(room, by, 'approve-plan', emit);
      if (room.plan.status !== 'proposed') {
        throw new AgoraError(
          'INVALID',
          `The plan is "${room.plan.status}", so there is nothing to approve.`,
          'Wait for the lead to propose a split.'
        );
      }
      // A cross-repo contract with no stated order is a promise Agora cannot
      // keep: those two merges will not be atomic, so somebody has to say which
      // side goes first (Q17).
      const unordered = contractsMissingOrder(room);
      if (unordered.length > 0) {
        throw new AgoraError(
          'INVALID',
          `These contracts cross repositories without saying which side lands first: ${unordered
            .map((entry) => `"${entry.title}"`)
            .join(', ')}.`,
          'Two repositories cannot be merged atomically. Ask the lead to name the side the other ' +
            'would be broken without, and it goes first.',
          { contracts: unordered }
        );
      }

      const naked = this.lanesWithoutEvidence(room);
      if (naked.length > 0) {
        throw new AgoraError(
          'INVALID',
          `These lanes promise nothing: ${naked.join(', ')}.`,
          'Every lane states what would demonstrate it worked, before work starts. Add evidence ' +
            'to each, or ask the lead to redraft.',
          { lanes: naked }
        );
      }

      const at = nowIso();
      room.plan.status = 'approved';
      room.plan.decidedBy = human.id;
      room.plan.decidedAt = at;
      room.plan.note = note;
      for (const task of room.tasks) {
        if (task.status === 'draft') {
          task.status = 'open';
          task.updatedAt = at;
        }
      }
      const planTask = room.tasks.find((task) => task.id === PLAN_TASK_ID);
      if (planTask !== undefined) {
        planTask.status = 'accepted';
        planTask.updatedAt = at;
      }
      emit({
        type: 'plan.approved',
        actor: human.id,
        taskId: null,
        threadId: null,
        summary: `${human.displayName} approved the plan. Everyone is a peer executing now.`,
        audience: []
      });
      return room;
    });
  }

  async rejectPlan(by: string, note: string): Promise<Room> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = this.requireRight(room, by, 'reject-plan', emit);
      if (room.plan.status !== 'proposed') {
        throw new AgoraError(
          'INVALID',
          `The plan is "${room.plan.status}", so there is nothing to reject.`,
          'Wait for the lead to propose a split.'
        );
      }
      room.plan.status = 'rejected';
      room.plan.decidedBy = human.id;
      room.plan.decidedAt = nowIso();
      room.plan.note = note;
      const planTask = room.tasks.find((task) => task.id === PLAN_TASK_ID);
      if (planTask !== undefined) {
        planTask.status = planTask.owner === null ? 'open' : 'claimed';
        planTask.updatedAt = nowIso();
      }
      emit({
        type: 'plan.rejected',
        actor: human.id,
        taskId: PLAN_TASK_ID,
        threadId: null,
        summary: `${human.displayName} rejected the plan: ${note}`,
        audience: []
      });
      return room;
    });
  }

  async pauseAgent(by: string, agentId: string, reason: string): Promise<Agent> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'pause-agent', emit);
      const agent = this.agentOf(data, agentId);
      agent.paused = true;
      agent.pausedReason = reason;
      emit({
        type: 'agent.paused',
        actor: human.id,
        taskId: agent.status.taskId,
        threadId: null,
        summary: `${human.displayName} paused ${agent.displayName}: ${reason}`,
        audience: [agent.id]
      });
      return agent;
    });
  }

  async resumeAgent(by: string, agentId: string): Promise<Agent> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'resume-agent', emit);
      const agent = this.agentOf(data, agentId);
      agent.paused = false;
      agent.pausedReason = null;
      emit({
        type: 'agent.resumed',
        actor: human.id,
        taskId: agent.status.taskId,
        threadId: null,
        summary: `${human.displayName} resumed ${agent.displayName}.`,
        audience: [agent.id]
      });
      return agent;
    });
  }

  async setAgentScope(by: string, agentId: string, scope: Partial<AgentScope>): Promise<Agent> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'set-agent-scope', emit);
      const agent = this.agentOf(data, agentId);
      agent.scope = {
        readPaths: scope.readPaths ?? agent.scope.readPaths,
        writeTasks: scope.writeTasks ?? agent.scope.writeTasks
      };
      emit({
        type: 'agent.scope',
        actor: human.id,
        taskId: null,
        threadId: null,
        summary: `${human.displayName} changed ${agent.displayName}'s scope.`,
        audience: [agent.id]
      });
      return agent;
    });
  }

  /** Take a task off one agent and give it to another. */
  async assignTask(by: string, taskId: string, agentId: string): Promise<Task> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = this.requireRight(room, by, 'assign-lane', emit);
      const task = this.taskOf(room, taskId);
      const agent = this.agentOf(data, agentId);
      if (task.status === 'accepted') {
        throw new AgoraError(
          'INVALID',
          `"${task.id}" is already accepted.`,
          'Reopen it first if it needs more work.'
        );
      }
      const previous = task.owner;
      const at = nowIso();
      task.owner = agent.id;
      task.status = 'claimed';
      task.claimedAt = at;
      task.blockedReason = null;
      task.updatedAt = at;
      emit({
        type: 'task.assigned',
        actor: human.id,
        taskId: task.id,
        threadId: null,
        summary:
          previous === null
            ? `${human.displayName} gave "${task.id}" to ${agent.displayName}.`
            : `${human.displayName} moved "${task.id}" from ${previous} to ${agent.displayName}.`,
        audience: unique([agent.id, ...(previous !== null ? [previous] : [])])
      });
      return task;
    });
  }

  async acceptTask(by: string, taskId: string): Promise<Task> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'accept-lane', emit);
      const task = this.taskOf(data.room, taskId);
      task.status = 'accepted';
      task.updatedAt = nowIso();
      emit({
        type: 'task.accepted',
        actor: human.id,
        taskId: task.id,
        threadId: null,
        summary: `${human.displayName} accepted "${task.id}".`,
        audience: task.owner !== null ? [task.owner] : []
      });
      return task;
    });
  }

  async reopenTask(by: string, taskId: string, keepOwner = false): Promise<Task> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'reopen-lane', emit);
      const task = this.taskOf(data.room, taskId);
      const previous = task.owner;
      task.status = keepOwner && task.owner !== null ? 'claimed' : 'open';
      if (!keepOwner) {
        task.owner = null;
        task.claimedAt = null;
      }
      task.blockedReason = null;
      task.updatedAt = nowIso();
      emit({
        type: 'task.reopened',
        actor: human.id,
        taskId: task.id,
        threadId: null,
        summary: `${human.displayName} reopened "${task.id}".`,
        audience: unique([...(previous !== null ? [previous] : []), ...(task.owner !== null ? [task.owner] : [])])
      });
      return task;
    });
  }

  /** Raise a task's message budget and let it start talking again. */
  async setTaskBudget(by: string, taskId: string, actionBudget: number): Promise<Task> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'raise-budget', emit);
      const task = this.taskOf(data.room, taskId);
      if (!Number.isInteger(actionBudget) || actionBudget < 0) {
        throw new AgoraError('INVALID', 'A message budget is a non-negative integer.', 'Pass a whole number.');
      }
      task.actionBudget = actionBudget;
      if (actionBudget > task.actionsUsed) task.budgetHaltedAt = null;
      task.updatedAt = nowIso();
      emit({
        type: 'task.budget',
        actor: human.id,
        taskId: task.id,
        threadId: null,
        summary: `${human.displayName} set the message budget for "${task.id}" to ${actionBudget}.`,
        audience: task.owner !== null ? [task.owner] : []
      });
      return task;
    });
  }

  /** The human answering, or redirecting, inside a thread. Never charged to the budget. */
  async postAsHuman(by: string, input: {
    taskId: string;
    to?: string[];
    threadId?: string;
    subject?: string;
    body: string;
    kind?: MessageKind;
  }): Promise<PostMessageResult> {
    return this.apply((data, emit) => {
      const room = data.room;
      this.requireRight(room, by, 'post-message', emit);
      const task = this.taskOf(room, input.taskId);
      const humanAgent: Agent = {
        id: HUMAN_ID,
        displayName: 'the human',
        provider: 'human',
        role: 'lead',
        scope: { readPaths: ['**'], writeTasks: ['*'] },
        paused: false,
        pausedReason: null,
        status: { state: 'idle', taskId: null, note: '', updatedAt: nowIso() },
        joinedAt: room.createdAt,
        lastSeenAt: nowIso(),
        latestTouchAt: null
      };
      const thread = this.resolveThread(room, humanAgent, task, input);
      const at = nowIso();
      const message = {
        id: shortId('msg'),
        threadId: thread.id,
        taskId: task.id,
        from: HUMAN_ID,
        kind: input.kind ?? 'answer',
        body: input.body,
        createdAt: at
      };
      thread.messages.push(message);
      thread.updatedAt = at;

      const delivered = thread.participants.filter((participant) => participant !== HUMAN_ID);
      emit({
        type: 'message.posted',
        actor: HUMAN_ID,
        taskId: task.id,
        threadId: thread.id,
        summary: `The human answered on "${task.id}".`,
        audience: delivered
      });
      return {
        threadId: thread.id,
        messageId: message.id,
        delivered,
        budgetRemaining: task.actionBudget - task.actionsUsed,
        message: `Delivered to ${delivered.join(', ')}.`
      };
    });
  }

  async recordDecision(by: string, input: { title: string; body: string }): Promise<Decision> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'record-decision', emit);
      const decision: Decision = {
        id: shortId('dec'),
        kind: 'general',
        title: input.title,
        body: input.body,
        seam: null,
        proposedBy: human.id,
        createdAt: nowIso(),
        version: 1
      };
      data.room.decisions.push(decision);
      emit({
        type: 'decision.recorded',
        actor: human.id,
        taskId: null,
        threadId: null,
        summary: `${human.displayName} recorded a decision: ${input.title}`,
        audience: []
      });
      return decision;
    });
  }

  // ---------------------------------------------------------------- claims

  /**
   * Take a file before writing to it (Q2). Answers instantly: granted, handed
   * over from someone who had moved on, or refused because two agents are in
   * the same code right now — which is a planning problem, so it goes up.
   */
  async claimFile(
    agentId: string,
    input: { path: string; laneId: string; statusNote?: string }
  ): Promise<{ claim: Claim; outcome: string; message: string; holding: number }> {
    const result = await this.apply<
      | { collision: { path: string; heldBy: string } }
      | { claim: Claim; outcome: string; message: string; holding: number }
    >((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      this.requireActive(agent);

      const now = Date.now();
      this.sweepAbandoned(room, now, emit);

      const outcome = requestClaim({
        claims: room.claims,
        path: input.path,
        agentId,
        laneId: input.laneId,
        activity: this.activity(room),
        now
      });

      // A refusal must not swallow the escalation. Throwing here would roll the
      // whole mutation back, taking the collision event with it — so the
      // mutation commits the event and the caller raises the error afterwards.
      if (outcome.kind === 'collision') {
        emit({
          type: 'claim.collision',
          actor: agentId,
          taskId: input.laneId,
          threadId: null,
          summary:
            `${agent.displayName} and ${outcome.heldBy} both need "${outcome.claim.path}" ` +
            'right now. The split put two agents in the same code.',
          audience: unique([HUMAN_ID, outcome.heldBy])
        });
        this.raise(room, emit, {
          kind: 'collision',
          laneId: input.laneId,
          title: `Two agents need ${outcome.claim.path}`,
          detail:
            `${agent.displayName} and ${outcome.heldBy} both need "${outcome.claim.path}" right now. ` +
            'That is a planning problem: the split put two agents in the same code.',
          needsMergeRights: true,
          options: [
            { id: 'wait', label: `Let ${outcome.heldBy} finish`, effect: `${agent.displayName} works elsewhere until it is released.` },
            { id: 'hand-over', label: `Give it to ${agent.displayName}`, effect: `${outcome.heldBy} loses the file and is told why.` },
            { id: 'resplit', label: 'Redraw the split', effect: 'The lead redrafts so the two lanes stop overlapping.' }
          ]
        });
        this.touchStatus(agent, emit, {
          note: input.statusNote,
          state: 'blocked',
          taskId: input.laneId
        });
        return { collision: { path: outcome.claim.path, heldBy: outcome.heldBy } };
      }

      // Taking new ground costs an action. Re-claiming a file you already hold
      // is the heartbeat that keeps it — charging for that would punish exactly
      // the behaviour the lock system depends on.
      if (outcome.kind !== 'refreshed') {
        const lane = room.tasks.find((candidate) => candidate.id === input.laneId);
        if (lane !== undefined) this.spendAction(room, lane, emit);
      }

      // Claiming is touching: it is how an agent says it is still on a file.
      agent.latestTouchAt = new Date(now).toISOString();
      room.claims = room.claims.filter((claim) => claim.path !== outcome.claim.path);
      room.claims.push(outcome.claim);

      if (outcome.kind === 'taken') {
        emit({
          type: 'claim.taken',
          actor: agentId,
          taskId: input.laneId,
          threadId: null,
          summary:
            `${agent.displayName} took "${outcome.claim.path}" from ${outcome.previousHolder}, ` +
            'which had moved on.',
          audience: [outcome.previousHolder]
        });
      } else if (outcome.kind === 'granted') {
        emit({
          type: 'claim.granted',
          actor: agentId,
          taskId: input.laneId,
          threadId: null,
          summary: `${agent.displayName} took "${outcome.claim.path}".`,
          audience: []
        });
      }

      this.touchStatus(agent, emit, {
        note: input.statusNote,
        state: 'working',
        taskId: input.laneId
      });

      // Cheap enough to check on every touch, which is the point (Q20).
      const spinning = detectSpin({
        laneId: input.laneId,
        claims: room.claims,
        evidenceProducedAt:
          room.tasks.find((t) => t.id === input.laneId)?.evidence?.producedAt ?? null
      });
      if (spinning !== null) {
        const probes = room.probes[input.laneId] ?? [];
        const verdict = assessStuck(spinning, probes);
        if (verdict.kind === 'ask') {
          room.probes[input.laneId] = [...probes, { askedAt: nowIso(), missing: null, answeredAt: null }];
          emit({
            type: 'spin.detected',
            actor: agentId,
            taskId: input.laneId,
            threadId: null,
            summary: spinning.fact,
            audience: [agentId]
          });
        }
      }

      const holding = room.claims.filter((claim) => claim.holder === agentId).length;
      const message =
        outcome.kind === 'taken'
          ? `"${outcome.claim.path}" is yours. ${outcome.previousHolder} had moved on and has been told.`
          : outcome.kind === 'refreshed'
            ? `Still yours. ${holding} file(s) in hand.`
            : `"${outcome.claim.path}" is yours. ${holding} file(s) in hand.`;

      return { claim: outcome.claim, outcome: outcome.kind, message, holding };
    });

    if ('collision' in result) {
      throw new AgoraError(
        'LIVE_COLLISION',
        `"${result.collision.path}" is being written by ${result.collision.heldBy} right now.`,
        'Work on something else in your lane. A human has been asked, because two agents ' +
          'needing one file at the same moment means the split is wrong, not that you are.',
        { path: result.collision.path, heldBy: result.collision.heldBy }
      );
    }
    return result;
  }

  /** Hand files back. Always safe, always cheap — the opposite of hoarding. */
  async releaseFile(
    agentId: string,
    input: { paths: string[]; statusNote?: string }
  ): Promise<{ released: string[]; holding: number; message: string }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);

      const wanted = new Set(input.paths.map(normalizePath));
      const released = room.claims
        .filter((claim) => claim.holder === agentId && wanted.has(claim.path))
        .map((claim) => claim.path);
      room.claims = room.claims.filter(
        (claim) => !(claim.holder === agentId && wanted.has(claim.path))
      );

      if (released.length > 0) {
        emit({
          type: 'claim.released',
          actor: agentId,
          taskId: agent.status.taskId,
          threadId: null,
          summary: `${agent.displayName} let go of ${released.join(', ')}.`,
          audience: []
        });
      }
      this.touchStatus(agent, emit, { note: input.statusNote });

      const holding = room.claims.filter((claim) => claim.holder === agentId).length;
      return {
        released,
        holding,
        message:
          released.length === 0
            ? 'You were not holding any of those.'
            : `Released ${released.length} file(s). ${holding} still in hand.`
      };
    });
  }

  /** What an agent holds right now, each with its state resolved. */
  heldBy(agentId: string): { claim: Claim; state: ClaimState }[] {
    return this.store.read((data) =>
      claimsHeldBy(data.room.claims, agentId, this.activity(data.room), Date.now())
    );
  }

  /** Files an agent changed without ever claiming them. The gate's backstop. */
  strayChanges(agentId: string, filesChanged: readonly string[]): string[] {
    return this.store.read((data) => unclaimedChanges(data.room.claims, filesChanged, agentId));
  }

  private activity(room: Room): Record<string, ClaimHolderActivity> {
    const map: Record<string, ClaimHolderActivity> = {};
    for (const agent of room.agents) {
      map[agent.id] = {
        latestTouchAt: agent.latestTouchAt ?? agent.joinedAt,
        lastSeenAt: agent.lastSeenAt
      };
    }
    return map;
  }

  /** A session that stopped heartbeating does not get to keep its files. */
  private sweepAbandoned(room: Room, now: number, emit: EmitFn): void {
    const dropped = abandonedClaims(room.claims, this.activity(room), now);
    if (dropped.length === 0) return;
    const droppedPaths = new Set(dropped.map((claim) => claim.path));
    room.claims = room.claims.filter((claim) => !droppedPaths.has(claim.path));
    for (const claim of dropped) {
      emit({
        type: 'claim.swept',
        actor: HUMAN_ID,
        taskId: claim.laneId,
        threadId: null,
        summary: `"${claim.path}" was let go: ${claim.holder} stopped answering.`,
        audience: [claim.holder]
      });
    }
  }

  /**
   * Charges one action to a lane (Q15). Actions are the one thing countable
   * with certainty, and they are what stops a runaway loop.
   */
  private spendAction(room: Room, task: Task, emit: EmitFn): void {
    if (task.actionsUsed >= task.actionBudget) {
      const error = new AgoraError(
        'BUDGET_EXHAUSTED',
        `"${task.id}" has spent all ${task.actionBudget} of its actions.`,
        'Stop and wait. The human has been asked to raise the budget or redirect the work.',
        { actionBudget: task.actionBudget, actionsUsed: task.actionsUsed }
      );
      // A lane that stops has to reach a person, and this refusal discards
      // everything written alongside it — so the halt is applied afterwards,
      // against state that still exists. A lane stopping quietly is the one
      // outcome Phase 2 rules out.
      const taskId = task.id;
      attachRepair(error, (data, repairEmit) => {
        const live = data.room.tasks.find((candidate) => candidate.id === taskId);
        if (live !== undefined) this.haltOnBudget(data.room, live, repairEmit);
      });
      throw error;
    }
    task.actionsUsed += 1;
    task.updatedAt = nowIso();
    if (task.actionsUsed >= task.actionBudget) this.haltOnBudget(room, task, emit);
  }

  // ------------------------------------------------- evidence and contracts

  /** An agent showing its work (Q18). Nothing lands until this happens. */
  async produceEvidence(
    agentId: string,
    input: { taskId: string; note: string; statusNote?: string }
  ): Promise<{ task: Task; message: string }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      this.requireActive(agent);
      const task = this.taskOf(room, input.taskId);

      if (task.owner !== agentId) {
        throw new AgoraError(
          'NOT_OWNER',
          `"${task.id}" is owned by ${task.owner ?? 'nobody'}.`,
          'Only the lane that promised the evidence can show it.',
          { owner: task.owner }
        );
      }
      if (task.evidence === null) {
        throw new AgoraError(
          'INVALID',
          `"${task.id}" never declared any evidence.`,
          'Nothing to show. Ask the human to add it to the plan if this lane needs proving.'
        );
      }

      const at = nowIso();
      task.evidence = { ...task.evidence, produced: true, note: input.note, producedAt: at };
      task.updatedAt = at;

      emit({
        type: 'evidence.produced',
        actor: agentId,
        taskId: task.id,
        threadId: null,
        summary: `${agent.displayName} showed "${task.id}" works: ${input.note}`,
        audience: []
      });
      this.touchStatus(agent, emit, { note: input.statusNote, state: 'done', taskId: task.id });

      return { task, message: `Recorded. "${task.id}" has shown its evidence.` };
    });
  }

  /**
   * Moving a contract (Q14). Every signature against the old version becomes
   * worthless, so the lanes that signed it go stale — the gate stops them, and
   * they are woken now rather than finding out at merge.
   */
  async amendSeam(
    by: string,
    decisionId: string,
    input: { body: string; note?: string }
  ): Promise<{ decision: Decision; stale: string[] }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = this.requireRight(room, by, 'amend-contract', emit);
      const decision = room.decisions.find((candidate) => candidate.id === decisionId);
      if (decision === undefined) {
        throw new AgoraError('NOT_FOUND', `No decision "${decisionId}".`, 'Use an id from read_room.');
      }

      const from = decision.version;
      decision.version = from + 1;
      decision.body = input.body;

      // Whoever signed the old version has work that may no longer hold.
      const stale: string[] = [];
      const woken: string[] = [];
      for (const task of room.tasks) {
        if (!task.seams.includes(decisionId)) continue;
        const signed = task.submissions
          .at(-1)
          ?.seamChecks.find((check) => check.decisionId === decisionId);
        if (signed !== undefined && signed.signedVersion < decision.version) {
          stale.push(task.id);
          if (task.owner !== null) woken.push(task.owner);
        }
      }

      emit({
        type: 'seam.amended',
        actor: human.id,
        taskId: null,
        threadId: null,
        summary:
          `"${decision.title}" moved to v${decision.version}.` +
          (stale.length > 0
            ? ` ${stale.join(', ')} signed the old version and must confirm again.`
            : ' Nothing had signed the old version.'),
        audience: unique(woken)
      });

      return { decision, stale };
    });
  }

  /** The human correcting a drafted plan before approving it (Q10). */
  async editPlannedLane(
    by: string,
    taskId: string,
    edits: { title?: string; description?: string; paths?: string[]; evidence?: string | null; actionBudget?: number; suggestedOwner?: string | null }
  ): Promise<Task> {
    return this.apply((data, emit) => {
      const room = data.room;
      this.requireRight(room, by, 'edit-lane', emit);
      const task = this.taskOf(room, taskId);
      if (task.status !== 'draft') {
        throw new AgoraError(
          'INVALID',
          `"${task.id}" is ${task.status}, not a draft.`,
          'A plan can only be edited before it is approved. Amend the contract instead.'
        );
      }
      if (edits.title !== undefined) task.title = edits.title;
      if (edits.description !== undefined) task.description = edits.description;
      if (edits.paths !== undefined) task.paths = edits.paths.map(normalizePath);
      if (edits.actionBudget !== undefined) task.actionBudget = edits.actionBudget;
      if (edits.suggestedOwner !== undefined) task.suggestedOwner = edits.suggestedOwner;
      if (edits.evidence !== undefined) {
        task.evidence =
          edits.evidence === null || edits.evidence.trim() === ''
            ? null
            : { statement: edits.evidence.trim(), produced: false, note: '', producedAt: null };
      }
      task.updatedAt = nowIso();

      emit({
        type: 'plan.edited',
        actor: HUMAN_ID,
        taskId: task.id,
        threadId: null,
        summary: `The human edited "${task.id}" before approving the plan.`,
        audience: []
      });
      return task;
    });
  }

  /** Refuses to approve a split where a lane promises nothing (Q18). */
  private lanesWithoutEvidence(room: Room): string[] {
    return room.tasks
      .filter((task) => task.status === 'draft' && task.evidence === null)
      .map((task) => task.id);
  }

  // ----------------------------------------------------- people and attention

  /** Adds a person to the room. Merge rights mirror the repository (Q16). */
  async addHuman(
    by: string,
    input: { id: string; displayName: string; canMerge: boolean }
  ): Promise<Human> {
    return this.apply((data, emit) => {
      const room = data.room;
      this.requireRight(room, by, 'add-human', emit);
      if (room.humans.some((human) => human.id === input.id)) {
        throw new AgoraError('INVALID', `${input.id} is already in this room.`, 'Pick another id.');
      }
      const human: Human = {
        id: input.id,
        displayName: input.displayName,
        canMerge: input.canMerge,
        joinedAt: nowIso(),
        lastSeenAt: null
      };
      room.humans.push(human);
      emit({
        type: 'human.joined',
        actor: input.id,
        taskId: null,
        threadId: null,
        summary: `${input.displayName} joined${input.canMerge ? ' and can merge' : ''}.`,
        audience: []
      });
      return human;
    });
  }

  /** Names the person who answers for a lane first (Q8). */
  async assignLaneOwner(by: string, taskId: string, humanId: string | null): Promise<Task> {
    return this.apply((data, emit) => {
      this.requireRight(data.room, by, 'name-lane-owner', emit);
      const task = this.taskOf(data.room, taskId);
      if (humanId !== null && !data.room.humans.some((human) => human.id === humanId)) {
        throw new AgoraError('NOT_FOUND', `No one called ${humanId} is in this room.`, 'Add them first.');
      }
      task.laneOwner = humanId;
      task.updatedAt = nowIso();
      emit({
        type: 'attention.opened',
        actor: by,
        taskId: task.id,
        threadId: null,
        summary:
          humanId === null
            ? `"${task.id}" has no named person; its questions go straight to the room.`
            : `${humanId} answers for "${task.id}" first.`,
        audience: humanId === null ? [] : [humanId]
      });
      return task;
    });
  }

  /** What is waiting on this person, and what has opened up to everyone (Q8). */
  attentionFor(humanId: string): AttentionQueue {
    return this.store.read((data) => {
      const human = data.room.humans.find((candidate) => candidate.id === humanId);
      return queueFor(
        data.room.attention,
        { id: humanId, canMerge: human?.canMerge ?? false },
        Date.now()
      );
    });
  }

  /** Answering from the notification, which is the only way the timer is ever beaten (Q11). */
  async answerAttention(
    humanId: string,
    input: { itemId: string; optionId: string; note?: string }
  ): Promise<{ item: AttentionItem; message: string }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = room.humans.find((candidate) => candidate.id === humanId);
      if (human === undefined) {
        throw new AgoraError('UNAUTHORIZED', `${humanId} is not in this room.`, 'Ask to be added.');
      }
      const item = room.attention.find((candidate) => candidate.id === input.itemId);
      if (item === undefined) {
        throw new AgoraError('NOT_FOUND', `No open question "${input.itemId}".`, 'It may already be settled.');
      }

      const verdict = canAnswer(item, human, Date.now());
      if (!verdict.allowed) {
        throw new AgoraError('UNAUTHORIZED', verdict.why, 'Someone else has this one.');
      }
      const option = item.options.find((candidate) => candidate.id === input.optionId);
      if (option === undefined) {
        throw new AgoraError(
          'INVALID',
          `"${input.optionId}" is not one of the answers.`,
          `Choose one of: ${item.options.map((o) => o.id).join(', ')}.`
        );
      }

      item.resolvedAt = nowIso();
      item.resolvedBy = humanId;
      item.resolution = input.note ? `${option.label} — ${input.note}` : option.label;
      human.lastSeenAt = item.resolvedAt;

      // Approving a risk item *is* the sign-off, and it covers exactly the
      // submission this person was shown (Q13).
      if (item.signOff !== undefined && input.optionId === 'approve' && item.laneId !== null) {
        room.signOffs.push({
          id: shortId('sig'),
          laneId: item.laneId,
          submissionId: item.signOff.submissionId,
          ruleIds: [...item.signOff.ruleIds],
          by: humanId,
          note: input.note ?? '',
          at: item.resolvedAt
        });
        emit({
          type: 'risk.signed',
          actor: humanId,
          taskId: item.laneId,
          threadId: null,
          summary:
            `${human.displayName} signed off ${item.signOff.ruleIds.join(', ')} on this ` +
            `submission of "${item.laneId}". A later submission needs looking at again.`,
          audience: []
        });
      }

      emit({
        type: 'attention.answered',
        actor: humanId,
        taskId: item.laneId,
        threadId: null,
        summary: `${human.displayName} settled "${item.title}": ${item.resolution}`,
        audience: []
      });

      return { item, message: `Settled. ${option.effect}` };
    });
  }

  /**
   * Taking a question that is named to someone else (Q7, Q8).
   *
   * The fifteen-minute timer is the automatic path, for when nobody says
   * anything. This is the human one: a second person walks in, sees the first
   * is not around, and says they have it. Without it, someone who is standing
   * right there has to wait out a timer designed for someone who is asleep.
   *
   * It takes exactly the rights the question itself takes, so taking something
   * is never a way round the merge line.
   */
  async takeAttention(
    humanId: string,
    input: { itemId: string; because?: string }
  ): Promise<{ item: AttentionItem; message: string }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = room.humans.find((candidate) => candidate.id === humanId);
      if (human === undefined) {
        throw new AgoraError('UNAUTHORIZED', `${humanId} is not in this room.`, 'Ask to be added.');
      }
      const item = room.attention.find((candidate) => candidate.id === input.itemId);
      if (item === undefined) {
        throw new AgoraError('NOT_FOUND', `No open question "${input.itemId}".`, 'It may already be settled.');
      }
      if (item.resolvedAt !== null) {
        throw new AgoraError(
          'INVALID',
          `${item.resolvedBy ?? 'Someone'} already settled that one.`,
          'Nothing to take.'
        );
      }
      if (item.needsMergeRights && !human.canMerge) {
        throw new AgoraError(
          'UNAUTHORIZED',
          canDo(human, 'approve-plan').why,
          'Someone with merge rights has to take this one.'
        );
      }
      if (item.assignedTo === humanId) {
        return { item, message: 'It was already yours.' };
      }

      const from = item.assignedTo;
      const fromName =
        from === null
          ? null
          : (room.humans.find((candidate) => candidate.id === from)?.displayName ?? from);
      item.assignedTo = humanId;
      item.opensToRoomAt = new Date(Date.now() + OPENS_TO_ROOM_AFTER_MS).toISOString();
      human.lastSeenAt = nowIso();

      emit({
        type: 'attention.opened',
        actor: humanId,
        taskId: item.laneId,
        threadId: null,
        summary:
          `${human.displayName} took "${item.title}"` +
          (fromName === null ? ' from the room.' : ` from ${fromName}.`) +
          (input.because !== undefined ? ` ${input.because}` : ''),
        audience: from === null ? [] : [from]
      });

      return {
        item,
        message:
          fromName === null
            ? 'Yours. Nobody else will pick it up.'
            : `Yours. ${fromName} has been told, in case they were halfway through it.`
      };
    });
  }

  /** Complying and objecting at once (Q22). Cheap on purpose. */
  async recordDissent(
    agentId: string,
    input: { about: string; because: string; laneId?: string }
  ): Promise<Dissent> {
    return this.apply((data, emit) => {
      const agent = this.agentOf(data, agentId);
      const dissent: Dissent = {
        id: shortId('dis'),
        by: agentId,
        about: input.about,
        because: input.because,
        laneId: input.laneId ?? null,
        at: nowIso()
      };
      data.room.dissents.push(dissent);
      emit({
        type: 'dissent.recorded',
        actor: agentId,
        taskId: dissent.laneId,
        threadId: null,
        summary: `${agent.displayName} complied but objects: ${input.because}`,
        audience: [HUMAN_ID]
      });
      return dissent;
    });
  }

  /**
   * Looks for a lane going in circles, and acts on what it finds (Q20). Cheap
   * enough to run on every submission or claim.
   */
  async checkForSpin(laneId: string): Promise<StuckVerdict | null> {
    return this.apply((data, emit) => {
      const room = data.room;
      const task = room.tasks.find((candidate) => candidate.id === laneId);
      if (task === undefined || task.owner === null) return null;

      const signal = detectSpin({
        laneId,
        claims: room.claims,
        evidenceProducedAt: task.evidence?.producedAt ?? null
      });
      if (signal === null) return null;

      const probes = room.probes[laneId] ?? [];
      const verdict = assessStuck(signal, probes);

      if (verdict.kind === 'ask') {
        room.probes[laneId] = [...probes, { askedAt: nowIso(), missing: null, answeredAt: null }];
        emit({
          type: 'spin.detected',
          actor: task.owner,
          taskId: laneId,
          threadId: null,
          summary: signal.fact,
          audience: [task.owner]
        });
      } else if (verdict.kind === 'stuck') {
        this.raise(room, emit, {
          kind: 'stuck',
          laneId,
          title: `"${laneId}" is not moving`,
          detail:
            `${signal.fact} Asked twice what was missing; both times: ${verdict.missing}.`,
          needsMergeRights: false,
          options: [
            { id: 'redirect', label: 'Redirect it', effect: 'You tell the lane what to do instead.' },
            { id: 'unblock', label: 'Answer what is missing', effect: `You supply: ${verdict.missing}.` },
            { id: 'reassign', label: 'Give the lane to someone else', effect: 'The work moves to another agent.' },
            { id: 'stop', label: 'Stop the lane', effect: 'It is dropped and its files are released.' }
          ]
        });
        emit({
          type: 'spin.stuck',
          actor: task.owner,
          taskId: laneId,
          threadId: null,
          summary: `"${laneId}" is stuck on ${verdict.missing}.`,
          audience: [HUMAN_ID, task.owner]
        });
      }
      return verdict;
    });
  }

  /** The agent naming what it is missing, which is how the loop closes. */
  async answerProbe(
    agentId: string,
    input: { laneId: string; missing: string }
  ): Promise<{ message: string }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      const probes = room.probes[input.laneId] ?? [];
      const open = probes.at(-1);
      if (open === undefined || open.missing !== null) {
        throw new AgoraError(
          'INVALID',
          'Nothing was asked of this lane.',
          'You can always raise it yourself with post_message.'
        );
      }
      open.missing = input.missing;
      open.answeredAt = nowIso();
      emit({
        type: 'agent.status',
        actor: agentId,
        taskId: input.laneId,
        threadId: null,
        summary: `${agent.displayName} is missing: ${input.missing}`,
        audience: [HUMAN_ID]
      });
      return { message: 'Noted. Saying so was cheaper than another rewrite.' };
    });
  }

  // -------------------------------------------------------- cross-review (Q13)

  /**
   * The agent across a contract reads the other side's work.
   *
   * Not a courtesy: nothing lands until it happens. The reviewer is chosen by
   * the contract, not by policy — it is the one party with both the context to
   * judge the work and a stake in whether the contract was held.
   */
  async reviewLane(
    agentId: string,
    input: { laneId: string; seamId?: string; verdict: ReviewVerdict; note: string } & StatusInput
  ): Promise<{ review: Review; message: string }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      this.requireActive(agent);
      const task = this.taskOf(room, input.laneId);

      if (task.owner === agentId) {
        throw new AgoraError(
          'INVALID',
          'You cannot review your own lane.',
          'Cross-review means the agent on the other side of the contract reads it.'
        );
      }
      if (task.status !== 'submitted' && task.status !== 'accepted') {
        throw new AgoraError(
          'INVALID',
          `"${task.id}" is ${task.status}; there is nothing finished to read yet.`,
          'Wait for it to submit. You are told when it does.'
        );
      }

      const requirements = reviewRequirements(seamContextOf(room, task.id));
      const mine = requirements.filter((requirement) => requirement.reviewer === agentId);
      if (mine.length === 0) {
        throw new AgoraError(
          'UNAUTHORIZED',
          `You share no contract with "${task.id}", so its work is not yours to pass or fail.`,
          'Review the lanes across your own seams. read_room lists them.',
          { owed: reviewsOwedBy(room, agentId) }
        );
      }

      const requirement =
        input.seamId === undefined
          ? mine[0]
          : mine.find((candidate) => candidate.seamId === input.seamId);
      if (requirement === undefined) {
        throw new AgoraError(
          'NOT_FOUND',
          `"${input.seamId}" is not a contract between you and "${task.id}".`,
          `Yours with this lane: ${mine.map((entry) => entry.seamId).join(', ')}.`
        );
      }

      const decision = room.decisions.find((candidate) => candidate.id === requirement.seamId);
      const submission = task.submissions.at(-1);
      if (decision === undefined || submission === undefined) {
        throw new AgoraError('INVALID', 'There is nothing to review against.', 'Wait for a submission.');
      }

      const review: Review = {
        id: shortId('rev'),
        laneId: task.id,
        seamId: requirement.seamId,
        by: agentId,
        verdict: input.verdict,
        note: input.note,
        submissionId: submission.id,
        seamVersion: decision.version,
        at: nowIso()
      };
      room.reviews.push(review);

      emit({
        type: 'review.recorded',
        actor: agentId,
        taskId: task.id,
        threadId: null,
        summary:
          `${agent.displayName} read "${task.id}" against "${decision.title}" v${decision.version}: ` +
          `${input.verdict === 'holds' ? 'it holds' : 'it breaks'} — ${input.note}`,
        audience: unique([HUMAN_ID, ...(task.owner !== null ? [task.owner] : [])])
      });

      // Two agents disagreeing about a contract is exactly the kind of thing a
      // person is for. It is also the kind of thing neither of them can settle.
      if (input.verdict === 'breaks') {
        this.raise(room, emit, {
          kind: 'ruling',
          laneId: task.id,
          title: `${agentId} says "${task.id}" breaks "${decision.title}"`,
          detail: `${input.note} The contract reads: ${decision.body}`,
          needsMergeRights: true,
          options: [
            { id: 'side-with-reviewer', label: `${agentId} is right`, effect: `"${task.id}" reworks its side.` },
            { id: 'side-with-lane', label: `"${task.id}" is right`, effect: 'The review is overruled and the lane can land.' },
            { id: 'amend', label: 'The contract is wrong', effect: 'You change the contract; both sides go stale and re-sign.' }
          ]
        });
      }

      this.touchStatus(agent, emit, { note: input.statusNote });
      return {
        review,
        message:
          input.verdict === 'holds'
            ? `Recorded. "${task.id}" can land once everything else clears.`
            : `Recorded, and a person has been asked to rule on it. "${task.id}" cannot land meanwhile.`
      };
    });
  }

  /** What this agent owes a review on, and why. Cheap enough to show on every read. */
  reviewsDue(agentId: string): { laneId: string; seamId: string; seamTitle: string; why: string }[] {
    return this.store.read((data) => reviewsOwedBy(data.room, agentId));
  }

  /** Where each lane stands on the reviews it owes. */
  reviewStateOf(laneId: string): ReviewRequirement[] {
    return this.store.read((data) => reviewRequirements(seamContextOf(data.room, laneId)));
  }

  /** The surfaces that always pull a person in (Q13). The human's call, not an agent's. */
  async setRiskList(by: string, rules: RiskRule[]): Promise<RiskRule[]> {
    return this.apply((data, emit) => {
      const human = this.requireRight(data.room, by, 'set-risk-list', emit);
      data.room.riskList = rules.map((rule) => ({ ...rule, paths: [...rule.paths] }));
      emit({
        type: 'risk.flagged',
        actor: human.id,
        taskId: null,
        threadId: null,
        summary:
          rules.length === 0
            ? 'The risk list is empty: no surface pulls a person in automatically.'
            : `The risk list is now ${rules.map((rule) => rule.label).join(', ')}.`,
        audience: []
      });
      return data.room.riskList;
    });
  }

  /** Why is this the way it is (Q26). Derived, never stored. */
  provenance(subject: ProvenanceSubject): Provenance {
    return this.store.read((data) => provenanceOf(data.room, subject));
  }

  /** The agents who owe this lane a review right now. */
  private reviewersOf(room: Room, task: Task): string[] {
    return unique(
      reviewRequirements(seamContextOf(room, task.id))
        .map((requirement) => requirement.reviewer)
        .filter((reviewer): reviewer is string => reviewer !== null)
    );
  }

  /** Tells the agent across each contract that there is something to read. */
  private requestReviews(room: Room, task: Task, emit: EmitFn): void {
    for (const requirement of reviewRequirements(seamContextOf(room, task.id))) {
      if (requirement.reviewer === null || requirement.reviewer === task.owner) continue;
      emit({
        type: 'review.requested',
        actor: task.owner ?? HUMAN_ID,
        taskId: task.id,
        threadId: null,
        summary:
          `${requirement.reviewer}: read "${task.id}" against "${requirement.seamTitle}". ` +
          'It cannot land until you do.',
        audience: [requirement.reviewer]
      });
    }
  }

  /**
   * Pulls a person onto a risky surface (Q13).
   *
   * What the agent declared is used here, because that is all the room knows at
   * submission time. The gate recomputes it from the diff, so a risky file left
   * out of the report is caught there instead — later, but not missed.
   */
  private flagRisks(
    room: Room,
    task: Task,
    submission: Submission,
    filesChanged: readonly string[],
    emit: EmitFn
  ): void {
    const claimed = room.claims
      .filter((claim) => claim.laneId === task.id)
      .map((claim) => claim.path);
    const hits = risksTouched(unique([...filesChanged, ...claimed]), room.riskList);
    const open = unsignedRisks(hits, room.signOffs, {
      laneId: task.id,
      latestSubmissionId: submission.id
    });
    if (open.length === 0) return;

    const item = this.raise(room, emit, {
      kind: 'review',
      laneId: task.id,
      title: `"${task.id}" touches ${open.map((hit) => hit.rule.label).join(' and ')}`,
      detail:
        open
          .map((hit) => `${hit.rule.label}: ${hit.paths.join(', ')}. ${hit.rule.why}`)
          .join(' ') + ` The lane says: ${submission.summary}`,
      needsMergeRights: true,
      options: [
        { id: 'approve', label: 'I have looked; it can land', effect: 'This submission is signed off and the gate stops asking.' },
        { id: 'changes', label: 'Send it back', effect: 'The lane reopens and works on it again.' },
        { id: 'hold', label: 'Hold it', effect: 'Nothing lands until you come back to it.' }
      ]
    });
    item.signOff = { submissionId: submission.id, ruleIds: open.map((hit) => hit.rule.id) };

    emit({
      type: 'risk.flagged',
      actor: task.owner ?? HUMAN_ID,
      taskId: task.id,
      threadId: null,
      summary:
        `"${task.id}" touches ${open.map((hit) => hit.rule.label).join(', ')}; ` +
        'a person has to look before it lands.',
      audience: [HUMAN_ID]
    });
  }

  // ------------------------------------------------------ repositories (Q17)

  /**
   * Adds a repository to the room. Agora holds a working copy and the branch in
   * each one, because a room is a unit of work and work does not stop at a
   * repository boundary.
   */
  async addRepo(
    by: string,
    input: { id: string; name?: string; root: string; baseBranch?: string }
  ): Promise<RoomRepo> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = this.requireRight(room, by, 'add-repo', emit);
      const id = slugify(input.id, 'repo');
      if (room.repos.some((repo) => repo.id === id)) {
        throw new AgoraError('INVALID', `"${id}" is already in this room.`, 'Pick another id.');
      }
      const repo: RoomRepo = {
        id,
        name: input.name ?? id,
        root: input.root,
        baseBranch: input.baseBranch ?? 'main',
        addedAt: nowIso()
      };
      room.repos.push(repo);
      emit({
        type: 'repo.added',
        actor: human.id,
        taskId: null,
        threadId: null,
        summary:
          `${human.displayName} added the repository "${repo.name}" (${repo.baseBranch}).` +
          (room.repos.length > 1
            ? ' Contracts crossing repositories now need a stated landing order.'
            : ''),
        audience: []
      });
      return repo;
    });
  }

  repos(): RoomRepo[] {
    return this.store.read((data) => data.room.repos);
  }

  /** Which repository a lane's paths live in. */
  repoFor(laneId: string): RoomRepo | undefined {
    return this.store.read((data) =>
      repoOf(data.room, data.room.tasks.find((task) => task.id === laneId))
    );
  }

  private repoIdFor(room: Room, wanted: string | undefined): string | null {
    if (wanted === undefined) return null;
    const id = slugify(wanted, 'repo');
    if (!room.repos.some((repo) => repo.id === id)) {
      throw new AgoraError(
        'NOT_FOUND',
        `There is no repository "${wanted}" in this room.`,
        room.repos.length === 0
          ? 'This room has one repository and lanes do not name it. Drop "repo" from the plan.'
          : `Known repositories: ${room.repos.map((repo) => repo.id).join(', ')}.`,
        { known: room.repos.map((repo) => repo.id) }
      );
    }
    return id;
  }

  /**
   * Records a landing that got half in (Q17). The room goes red and stays red:
   * two repositories disagreeing about a contract is not a state anything is
   * allowed to be quiet about.
   */
  async recordPartialLanding(
    input: Omit<PartialLanding, 'at' | 'attentionId'>
  ): Promise<PartialLanding> {
    return this.apply((data, emit) => {
      const room = data.room;
      const partial: PartialLanding = { ...input, at: nowIso(), attentionId: null };
      const detail = partialLandingSummary(partial);

      const item = this.raise(room, emit, {
        kind: 'ruling',
        laneId: input.laneId,
        title: `Half-landed: ${input.landed.map((step) => step.repoId).join(', ')} is ahead`,
        detail,
        needsMergeRights: true,
        options: [
          { id: 'finish', label: 'Finish the landing', effect: 'Agora retries the repositories that did not land.' },
          { id: 'roll-back', label: 'Undo what landed', effect: 'A revert commit goes onto each repository that did land. Nothing is force-pushed.' },
          { id: 'leave-it', label: 'Leave it, I am on it', effect: 'The room stays red and says so until somebody clears it.' }
        ]
      });

      partial.attentionId = item.id;
      room.partialLanding = partial;
      room.status = 'red';

      emit({
        type: 'landing.partial',
        actor: HUMAN_ID,
        taskId: input.laneId,
        threadId: null,
        summary: `The room is red. ${detail}`,
        audience: [HUMAN_ID]
      });
      return partial;
    });
  }

  /** Clears the red state once both halves are actually in, or both are out. */
  async clearPartialLanding(
    by: string,
    input: { how: 'finished' | 'rolled-back'; note?: string }
  ): Promise<Room> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = this.requireRight(room, by, 'clear-red', emit);
      const partial = room.partialLanding;
      if (partial === null) {
        throw new AgoraError('INVALID', 'This room is not red.', 'Nothing to clear.');
      }
      room.partialLanding = null;
      room.status = 'open';

      const item = room.attention.find((candidate) => candidate.id === partial.attentionId);
      if (item !== undefined && item.resolvedAt === null) {
        item.resolvedAt = nowIso();
        item.resolvedBy = human.id;
        item.resolution =
          input.how === 'finished' ? 'Finished the landing.' : 'Rolled back what had landed.';
      }

      emit({
        type: input.how === 'finished' ? 'landing.recovered' : 'landing.rolledback',
        actor: human.id,
        taskId: partial.laneId,
        threadId: null,
        summary:
          input.how === 'finished'
            ? `${human.displayName} got the rest of "${partial.laneId}" in. The repositories agree again.`
            : `${human.displayName} reverted "${partial.laneId}" where it had landed. Nothing shipped half.` +
              (input.note !== undefined ? ` ${input.note}` : ''),
        audience: []
      });
      return room;
    });
  }

  // --------------------------------------------------- cost, ledger, closing

  /**
   * Records what something cost, with where the figure came from (Q15).
   *
   * Nothing here converts between provenances or adds them up. A tool's own
   * token count and a quota reading are different kinds of fact about the same
   * work, and the moment they are blended the number stops meaning anything.
   */
  async recordCost(
    agentId: string,
    input: {
      laneId?: string;
      provenance: CostProvenance;
      amount: number;
      unit: string;
      limit?: number;
      note?: string;
    }
  ): Promise<{ entry: CostEntry; report: CostReport; warnings: string[] }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);
      if (!Number.isFinite(input.amount) || input.amount < 0) {
        throw new AgoraError(
          'INVALID',
          'A cost is a non-negative number.',
          'Report what you actually counted, or do not report it.'
        );
      }
      if (input.provenance === 'quota' && input.limit === undefined) {
        throw new AgoraError(
          'INVALID',
          'A quota reading needs the ceiling as well as the level.',
          'Pass "limit" — a quota with no limit says nothing about what is left.'
        );
      }

      const entry: CostEntry = {
        id: shortId('cost'),
        laneId: input.laneId ?? null,
        agentId,
        provenance: input.provenance,
        amount: input.amount,
        unit: input.unit,
        limit: input.provenance === 'quota' ? (input.limit as number) : null,
        note: input.note ?? '',
        at: nowIso()
      };
      room.costs.push(entry);

      const report = costReport(room.costs, entry.laneId);
      const warnings = quotaWarnings(report);

      emit({
        type: 'cost.reported',
        actor: agentId,
        taskId: entry.laneId,
        threadId: null,
        summary:
          `${agent.displayName} reported ${entry.amount} ${entry.unit} (${entry.provenance})` +
          (entry.laneId !== null ? ` on "${entry.laneId}".` : ' for the room.'),
        audience: []
      });

      // A quota is the one that actually stops the work, so it reaches a person
      // before it runs out rather than after.
      if (warnings.length > 0 && entry.laneId !== null) {
        const already = room.attention.some(
          (item) => item.kind === 'budget' && item.laneId === entry.laneId && item.resolvedAt === null
        );
        if (!already) {
          this.raise(room, emit, {
            kind: 'budget',
            laneId: entry.laneId,
            title: `${agent.displayName} is nearly out of quota`,
            detail: warnings.join(' '),
            needsMergeRights: false,
            options: [
              { id: 'carry-on', label: 'Carry on', effect: 'The lane keeps going until the quota actually runs out.' },
              { id: 'reassign', label: 'Move the lane', effect: 'Another agent, on another plan, picks it up.' },
              { id: 'pause', label: 'Pause it', effect: 'The lane stops now rather than halfway through something.' }
            ]
          });
        }
      }

      return { entry, report, warnings };
    });
  }

  /**
   * Records a call Agora made on an agent's behalf (Q15).
   *
   * This is the only place a `metered` figure comes from, because it is the
   * only place Agora did the counting. The action is charged whether or not the
   * provider answered: a loop of failures is still a loop, and the cap is what
   * stops it.
   */
  async recordBrokeredCall(
    agentId: string,
    input: {
      laneId: string | null;
      provider: string;
      usage: BrokerUsage | null;
      status: number;
    }
  ): Promise<{ entries: CostEntry[]; report: CostReport }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const agent = this.agentOf(data, agentId);
      this.touchPresence(agent, emit);

      const at = nowIso();
      const entries: CostEntry[] = [];
      const add = (amount: number, unit: string, note: string): void => {
        const entry: CostEntry = {
          id: shortId('cost'),
          laneId: input.laneId,
          agentId,
          provenance: 'metered',
          amount,
          unit,
          limit: null,
          note,
          at
        };
        room.costs.push(entry);
        entries.push(entry);
      };

      if (input.usage !== null) {
        const model = input.usage.model ?? 'an unnamed model';
        const tokens = input.usage.inputTokens + input.usage.outputTokens;
        if (tokens > 0) add(tokens, 'tokens', `${input.provider}, ${model}`);
        // Money only where a price was configured. A plausible figure with no
        // price behind it would be the exact thing Q15 refuses to print.
        if (input.usage.cents !== null) {
          add(Math.round(input.usage.cents), 'usd-cents', `${input.provider}, ${model}`);
        }
      }

      emit({
        type: 'cost.metered',
        actor: agentId,
        taskId: input.laneId,
        threadId: null,
        summary:
          input.usage === null
            ? `${agent.displayName} made a call through ${input.provider} (${input.status}); ` +
              'nothing countable came back.'
            : `${agent.displayName} used ${input.usage.inputTokens} in / ` +
              `${input.usage.outputTokens} out via ${input.provider}` +
              (input.usage.cents === null
                ? '. No price is configured, so this is tokens and no money.'
                : `, ${Math.round(input.usage.cents)} cents.`),
        audience: []
      });

      // Charged last, so the call above is recorded even when this is the one
      // that trips the cap.
      const lane =
        input.laneId === null
          ? undefined
          : room.tasks.find((task) => task.id === input.laneId);
      if (lane !== undefined) this.spendAction(room, lane, emit);

      return { entries, report: costReport(room.costs, input.laneId) };
    });
  }

  /** What has been counted, per provenance, never as one number (Q15). */
  costFor(laneId: string | null = null): CostReport {
    return this.store.read((data) => costReport(data.room.costs, laneId));
  }

  /** Every lane on one screen, worst first (Q19). */
  ledger(sort: LedgerSort = DEFAULT_SORT): LedgerRow[] {
    return this.store.read((data) => sortRows(ledgerRows(data.room), sort));
  }

  /** Whether this room can close, and what is in the way (Q24). */
  closeReadiness(landed: readonly string[] = []): CloseReadiness {
    return this.store.read((data) => closeReadiness({ room: data.room, landed }));
  }

  /**
   * Closes the room. The same gate as everything else, with a person
   * confirming rather than a timer deciding (Q24).
   */
  async closeRoom(
    by: string,
    input: { landed: readonly string[]; note?: string; force?: boolean }
  ): Promise<{ room: Room; archive: RoomArchive }> {
    return this.apply((data, emit) => {
      const room = data.room;
      const human = this.requireRight(room, by, 'close-room', emit);
      if (room.status === 'closed') {
        throw new AgoraError(
          'INVALID',
          `This room was closed by ${room.closedBy ?? 'someone'} already.`,
          'Open a new room; its contracts can be seeded from this one.'
        );
      }

      const readiness = closeReadiness({ room, landed: input.landed });
      if (!readiness.ready && input.force !== true) {
        throw new AgoraError(
          'INVALID',
          readiness.summary,
          'Finish those, or close it anyway with force — which is on the record as a choice.',
          { blockers: readiness.blockers }
        );
      }

      const at = nowIso();
      room.status = 'closed';
      room.closedAt = at;
      room.closedBy = human.id;
      room.closeNote =
        readiness.ready
          ? (input.note ?? '')
          : `${input.note ?? ''} (Closed with ${readiness.blockers.length} thing(s) unfinished.)`.trim();

      emit({
        type: 'room.closed',
        actor: human.id,
        taskId: null,
        threadId: null,
        summary:
          readiness.ready
            ? `${human.displayName} closed the room. ${readiness.summary}`
            : `${human.displayName} closed the room with ${readiness.blockers.length} thing(s) unfinished.`,
        audience: []
      });

      return { room, archive: archiveOf(room) };
    });
  }

  /** The room as it will be remembered: why the code is like this, and what to reuse. */
  archive(): RoomArchive {
    return this.store.read((data) => archiveOf(data.room));
  }

  /** Puts something in front of a person, named if the lane has an owner (Q8). */
  private raise(
    room: Room,
    emit: EmitFn,
    input: {
      kind: AttentionItem['kind'];
      laneId: string | null;
      title: string;
      detail: string;
      options: AttentionItem['options'];
      needsMergeRights: boolean;
    }
  ): AttentionItem {
    const at = nowIso();
    const lane = input.laneId === null ? undefined : room.tasks.find((t) => t.id === input.laneId);
    const assignedTo = lane?.laneOwner ?? null;
    const item: AttentionItem = {
      id: shortId('att'),
      kind: input.kind,
      laneId: input.laneId,
      title: input.title,
      detail: input.detail,
      options: input.options,
      assignedTo,
      openedAt: at,
      opensToRoomAt:
        assignedTo === null ? null : new Date(Date.parse(at) + OPENS_TO_ROOM_AFTER_MS).toISOString(),
      needsMergeRights: input.needsMergeRights,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null
    };
    room.attention.push(item);
    emit({
      type: 'attention.raised',
      actor: HUMAN_ID,
      taskId: input.laneId,
      threadId: null,
      summary:
        assignedTo === null
          ? `The room is asked: ${input.title}`
          : `${assignedTo} is asked: ${input.title} (opens to the room in 15 minutes)`,
      audience: assignedTo === null ? [] : [assignedTo]
    });
    return item;
  }

  // ------------------------------------------------------------- internals

  private async apply<T>(fn: (data: AgoraData, emit: EmitFn) => T): Promise<T> {
    let outcome;
    try {
      outcome = await this.store.mutate((data) => {
        const emitted: RoomEvent[] = [];
        const emit: EmitFn = (partial) => {
          data.room.eventSeq += 1;
          const event: RoomEvent = { seq: data.room.eventSeq, at: nowIso(), ...partial };
          data.room.events.push(event);
          emitted.push(event);
        };
        const value = fn(data, emit);
        data.room.updatedAt = nowIso();
        return { value, emitted };
      });
    } catch (error) {
      // Some refusals have to leave something behind: the person who was
      // refused, or the lane that just stopped. Nothing written inside the
      // failed mutation survives it, so that work rides on the error and is
      // applied here, against fresh state, once the rollback is done.
      const repair = repairOf(error);
      if (repair !== undefined) await this.applyRepair(repair);
      throw error;
    }
    for (const event of outcome.emitted) this.bus.emit(event);
    return outcome.value;
  }

  /** Runs the part of a failed mutation that has to survive it. */
  private async applyRepair(repair: Repair): Promise<void> {
    const emitted = await this.store.mutate((data) => {
      const events: RoomEvent[] = [];
      const emit: EmitFn = (partial) => {
        data.room.eventSeq += 1;
        const event: RoomEvent = { seq: data.room.eventSeq, at: nowIso(), ...partial };
        data.room.events.push(event);
        events.push(event);
      };
      repair(data, emit);
      data.room.updatedAt = nowIso();
      return events;
    });
    for (const event of emitted) this.bus.emit(event);
  }

  /**
   * The one permission check in Agora (Q16). It refuses by saying what the
   * person *can* do, because a refusal that only says no teaches people to stop
   * reading refusals.
   */
  private requireRight(room: Room, by: string, action: RoomAction, _emit: EmitFn): Human {
    const human = room.humans.find((candidate) => candidate.id === by);
    const verdict = canDo(human, action);
    if (!verdict.allowed || human === undefined) {
      // The refusal rolls the whole mutation back, so the event cannot be
      // emitted here — it would be discarded with everything else. It rides on
      // the error instead, and `apply` writes it once the mutation is gone.
      const error = new AgoraError(
        'UNAUTHORIZED',
        verdict.why,
        'Ask someone with merge rights on the repository.',
        { action, by }
      );
      attachRepair(error, (_data, emit) => {
        emit({
          type: 'rights.refused',
          actor: by,
          taskId: null,
          threadId: null,
          summary: `${by} tried ${describeAction(action)} without the rights for it.`,
          audience: []
        });
      });
      throw error;
    }
    human.lastSeenAt = nowIso();
    return human;
  }

  /** Who is in the room, and what each of them may do. */
  humans(): Human[] {
    return this.store.read((data) => data.room.humans);
  }

  private agentOf(data: AgoraData, agentId: string): Agent {
    const agent = data.room.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      throw new AgoraError(
        'UNAUTHORIZED',
        `No agent "${agentId}" in this room.`,
        'Ask the human for a room token for this agent.'
      );
    }
    return agent;
  }

  private taskOf(room: Room, taskId: string): Task {
    const task = room.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      throw new AgoraError(
        'NOT_FOUND',
        `No task "${taskId}" on this board.`,
        `Call read_room for the board. Known tasks: ${room.tasks.map((entry) => entry.id).join(', ')}.`,
        { known: room.tasks.map((entry) => entry.id) }
      );
    }
    return task;
  }

  private requireActive(agent: Agent): void {
    if (agent.paused) {
      throw new AgoraError(
        'AGENT_PAUSED',
        `The human paused you${agent.pausedReason !== null ? `: ${agent.pausedReason}` : ''}.`,
        'Stop working and wait to be resumed. Do not retry.',
        { pausedReason: agent.pausedReason }
      );
    }
  }

  private touchPresence(agent: Agent, emit: EmitFn): void {
    const at = nowIso();
    if (agent.lastSeenAt === null) {
      emit({
        type: 'agent.joined',
        actor: agent.id,
        taskId: null,
        threadId: null,
        summary: `${agent.displayName} (${agent.provider}) joined the room.`,
        audience: []
      });
    }
    agent.lastSeenAt = at;
  }

  private touchStatus(
    agent: Agent,
    emit: EmitFn,
    update: { note?: string; state?: AgentStatus['state']; taskId?: string | null }
  ): void {
    if (update.note === undefined && update.state === undefined) return;
    agent.status = {
      state: update.state ?? agent.status.state,
      taskId: update.taskId === undefined ? agent.status.taskId : update.taskId,
      note: update.note ?? agent.status.note,
      updatedAt: nowIso()
    };
    emit({
      type: 'agent.status',
      actor: agent.id,
      taskId: agent.status.taskId,
      threadId: null,
      summary: `${agent.displayName} is ${agent.status.state}${agent.status.note !== '' ? `: ${agent.status.note}` : ''}`,
      audience: [HUMAN_ID]
    });
  }

  private haltOnBudget(room: Room, task: Task, emit: EmitFn): void {
    if (task.budgetHaltedAt !== null) return;
    task.budgetHaltedAt = nowIso();
    this.raise(room, emit, {
      kind: 'budget',
      laneId: task.id,
      title: `"${task.id}" has spent its budget`,
      detail: `${task.actionsUsed} of ${task.actionBudget} actions used. The lane has stopped.`,
      needsMergeRights: true,
      options: [
        { id: 'raise', label: 'Give it more', effect: 'The lane resumes with a larger budget.' },
        { id: 'redirect', label: 'Redirect it', effect: 'You tell the lane what to do with what is left.' },
        { id: 'stop', label: 'Leave it stopped', effect: 'The lane stays halted and its files are released.' }
      ]
    });
    emit({
      type: 'budget.exhausted',
      actor: task.owner ?? HUMAN_ID,
      taskId: task.id,
      threadId: null,
      summary: `"${task.id}" spent its ${task.actionBudget}-message budget and stopped to ask the human.`,
      audience: unique([HUMAN_ID, ...(task.owner !== null ? [task.owner] : [])])
    });
  }

  private resolveThread(
    room: Room,
    sender: Agent,
    task: Task,
    input: { to?: string[]; threadId?: string; subject?: string }
  ): Thread {
    if (input.threadId !== undefined) {
      const thread = room.threads.find((candidate) => candidate.id === input.threadId);
      if (thread === undefined || !thread.participants.includes(sender.id)) {
        throw new AgoraError(
          'NOT_FOUND',
          `No thread "${input.threadId}" is visible to you.`,
          'Threads are visible only to the agents in them. Start a new one by naming recipients in "to".'
        );
      }
      if (thread.taskId !== task.id) {
        throw new AgoraError(
          'INVALID',
          `Thread "${thread.id}" belongs to task "${thread.taskId}", not "${task.id}".`,
          'Every message attaches to one task. Use that task_id, or start a new thread.'
        );
      }
      return thread;
    }

    const recipients = unique(input.to ?? []).filter((id) => id !== sender.id);
    if (recipients.length === 0) {
      throw new AgoraError(
        'INVALID',
        'A new thread needs at least one recipient.',
        `Pass "to" with agent ids, or "${HUMAN_ID}" to ask the human.`
      );
    }
    for (const recipient of recipients) {
      if (recipient === HUMAN_ID) continue;
      if (!room.agents.some((agent) => agent.id === recipient)) {
        throw new AgoraError(
          'NOT_FOUND',
          `No agent "${recipient}" in this room.`,
          `Known agents: ${room.agents.map((agent) => agent.id).join(', ')}.`,
          { known: room.agents.map((agent) => agent.id) }
        );
      }
    }

    const participants = unique([sender.id, ...recipients]).sort();
    const existing = room.threads.find(
      (thread) => thread.taskId === task.id && sameParticipants(thread.participants, participants)
    );
    if (existing !== undefined) return existing;

    const at = nowIso();
    const thread: Thread = {
      id: shortId('thr'),
      taskId: task.id,
      subject: input.subject ?? task.title,
      participants,
      createdAt: at,
      updatedAt: at,
      messages: []
    };
    room.threads.push(thread);
    return thread;
  }

  private seamPartnerAgents(room: Room, task: Task): string[] {
    const partners: string[] = [];
    for (const seamId of task.seams) {
      const decision = room.decisions.find((candidate) => candidate.id === seamId);
      if (decision?.seam === undefined || decision.seam === null) continue;
      for (const other of decision.seam.betweenTasks) {
        if (other === task.id) continue;
        const partner = room.tasks.find((candidate) => candidate.id === other);
        if (partner?.owner != null) partners.push(partner.owner);
      }
    }
    return unique(partners);
  }

  private uniqueTaskId(room: Room, base: string): string {
    const taken = new Set(room.tasks.map((task) => task.id));
    if (base !== PLAN_TASK_ID && !taken.has(base)) return base;
    let index = 2;
    while (taken.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }
}

export type { AgentRoomView, SupervisorRoomView };
export { DEFAULT_MESSAGE_BUDGET, HUMAN_ID, PLAN_TASK_ID };
