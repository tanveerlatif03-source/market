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
import { DEFAULT_MESSAGE_BUDGET, HUMAN_ID, PLAN_TASK_ID } from './seed.ts';
import { agentRoomView, supervisorRoomView } from './views.ts';
import type { AgentRoomView, SupervisorRoomView } from './views.ts';
import type {
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
      } else {
        task.status = 'submitted';
        task.blockedReason = null;
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
        paths: proposed.paths.map(normalizePath),
        seams: [],
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

  async setGoal(goal: string): Promise<Room> {
    return this.apply((data) => {
      data.room.goal = goal;
      return data.room;
    });
  }

  async addAgent(options: {
    id?: string;
    displayName: string;
    provider: string;
    role: 'lead' | 'peer';
    scope?: Partial<AgentScope>;
  }): Promise<{ agent: Agent; token: string }> {
    const token = newToken();
    const agent = await this.apply((data, emit) => {
      const room = data.room;
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

  async createSupervisorToken(label: string): Promise<string> {
    const token = newToken();
    await this.apply((data) => {
      data.tokens.push({
        id: shortId('tok'),
        kind: 'supervisor',
        agentId: null,
        label,
        hash: hashToken(token),
        createdAt: nowIso(),
        revokedAt: null
      });
    });
    return token;
  }

  async approvePlan(note: string | null = null): Promise<Room> {
    return this.apply((data, emit) => {
      const room = data.room;
      if (room.plan.status !== 'proposed') {
        throw new AgoraError(
          'INVALID',
          `The plan is "${room.plan.status}", so there is nothing to approve.`,
          'Wait for the lead to propose a split.'
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
      room.plan.decidedBy = HUMAN_ID;
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
        actor: HUMAN_ID,
        taskId: null,
        threadId: null,
        summary: 'The human approved the plan. Everyone is a peer executing now.',
        audience: []
      });
      return room;
    });
  }

  async rejectPlan(note: string): Promise<Room> {
    return this.apply((data, emit) => {
      const room = data.room;
      if (room.plan.status !== 'proposed') {
        throw new AgoraError(
          'INVALID',
          `The plan is "${room.plan.status}", so there is nothing to reject.`,
          'Wait for the lead to propose a split.'
        );
      }
      room.plan.status = 'rejected';
      room.plan.decidedBy = HUMAN_ID;
      room.plan.decidedAt = nowIso();
      room.plan.note = note;
      const planTask = room.tasks.find((task) => task.id === PLAN_TASK_ID);
      if (planTask !== undefined) {
        planTask.status = planTask.owner === null ? 'open' : 'claimed';
        planTask.updatedAt = nowIso();
      }
      emit({
        type: 'plan.rejected',
        actor: HUMAN_ID,
        taskId: PLAN_TASK_ID,
        threadId: null,
        summary: `The human rejected the plan: ${note}`,
        audience: []
      });
      return room;
    });
  }

  async pauseAgent(agentId: string, reason: string): Promise<Agent> {
    return this.apply((data, emit) => {
      const agent = this.agentOf(data, agentId);
      agent.paused = true;
      agent.pausedReason = reason;
      emit({
        type: 'agent.paused',
        actor: HUMAN_ID,
        taskId: agent.status.taskId,
        threadId: null,
        summary: `The human paused ${agent.displayName}: ${reason}`,
        audience: [agent.id]
      });
      return agent;
    });
  }

  async resumeAgent(agentId: string): Promise<Agent> {
    return this.apply((data, emit) => {
      const agent = this.agentOf(data, agentId);
      agent.paused = false;
      agent.pausedReason = null;
      emit({
        type: 'agent.resumed',
        actor: HUMAN_ID,
        taskId: agent.status.taskId,
        threadId: null,
        summary: `The human resumed ${agent.displayName}.`,
        audience: [agent.id]
      });
      return agent;
    });
  }

  async setAgentScope(agentId: string, scope: Partial<AgentScope>): Promise<Agent> {
    return this.apply((data, emit) => {
      const agent = this.agentOf(data, agentId);
      agent.scope = {
        readPaths: scope.readPaths ?? agent.scope.readPaths,
        writeTasks: scope.writeTasks ?? agent.scope.writeTasks
      };
      emit({
        type: 'agent.scope',
        actor: HUMAN_ID,
        taskId: null,
        threadId: null,
        summary: `The human changed ${agent.displayName}'s scope.`,
        audience: [agent.id]
      });
      return agent;
    });
  }

  /** Take a task off one agent and give it to another. */
  async assignTask(taskId: string, agentId: string): Promise<Task> {
    return this.apply((data, emit) => {
      const room = data.room;
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
        actor: HUMAN_ID,
        taskId: task.id,
        threadId: null,
        summary:
          previous === null
            ? `The human gave "${task.id}" to ${agent.displayName}.`
            : `The human moved "${task.id}" from ${previous} to ${agent.displayName}.`,
        audience: unique([agent.id, ...(previous !== null ? [previous] : [])])
      });
      return task;
    });
  }

  async acceptTask(taskId: string): Promise<Task> {
    return this.apply((data, emit) => {
      const task = this.taskOf(data.room, taskId);
      task.status = 'accepted';
      task.updatedAt = nowIso();
      emit({
        type: 'task.accepted',
        actor: HUMAN_ID,
        taskId: task.id,
        threadId: null,
        summary: `The human accepted "${task.id}".`,
        audience: task.owner !== null ? [task.owner] : []
      });
      return task;
    });
  }

  async reopenTask(taskId: string, keepOwner = false): Promise<Task> {
    return this.apply((data, emit) => {
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
        actor: HUMAN_ID,
        taskId: task.id,
        threadId: null,
        summary: `The human reopened "${task.id}".`,
        audience: unique([...(previous !== null ? [previous] : []), ...(task.owner !== null ? [task.owner] : [])])
      });
      return task;
    });
  }

  /** Raise a task's message budget and let it start talking again. */
  async setTaskBudget(taskId: string, actionBudget: number): Promise<Task> {
    return this.apply((data, emit) => {
      const task = this.taskOf(data.room, taskId);
      if (!Number.isInteger(actionBudget) || actionBudget < 0) {
        throw new AgoraError('INVALID', 'A message budget is a non-negative integer.', 'Pass a whole number.');
      }
      task.actionBudget = actionBudget;
      if (actionBudget > task.actionsUsed) task.budgetHaltedAt = null;
      task.updatedAt = nowIso();
      emit({
        type: 'task.budget',
        actor: HUMAN_ID,
        taskId: task.id,
        threadId: null,
        summary: `The human set the message budget for "${task.id}" to ${actionBudget}.`,
        audience: task.owner !== null ? [task.owner] : []
      });
      return task;
    });
  }

  /** The human answering, or redirecting, inside a thread. Never charged to the budget. */
  async postAsHuman(input: {
    taskId: string;
    to?: string[];
    threadId?: string;
    subject?: string;
    body: string;
    kind?: MessageKind;
  }): Promise<PostMessageResult> {
    return this.apply((data, emit) => {
      const room = data.room;
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

  async recordDecision(input: { title: string; body: string }): Promise<Decision> {
    return this.apply((data, emit) => {
      const decision: Decision = {
        id: shortId('dec'),
        kind: 'general',
        title: input.title,
        body: input.body,
        seam: null,
        proposedBy: HUMAN_ID,
        createdAt: nowIso(),
        version: 1
      };
      data.room.decisions.push(decision);
      emit({
        type: 'decision.recorded',
        actor: HUMAN_ID,
        taskId: null,
        threadId: null,
        summary: `The human recorded a decision: ${input.title}`,
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
      this.haltOnBudget(room, task, emit);
      throw new AgoraError(
        'BUDGET_EXHAUSTED',
        `"${task.id}" has spent all ${task.actionBudget} of its actions.`,
        'Stop and wait. The human has been asked to raise the budget or redirect the work.',
        { actionBudget: task.actionBudget, actionsUsed: task.actionsUsed }
      );
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
    decisionId: string,
    input: { body: string; note?: string }
  ): Promise<{ decision: Decision; stale: string[] }> {
    return this.apply((data, emit) => {
      const room = data.room;
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
        actor: HUMAN_ID,
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
    taskId: string,
    edits: { title?: string; description?: string; paths?: string[]; evidence?: string | null; actionBudget?: number; suggestedOwner?: string | null }
  ): Promise<Task> {
    return this.apply((data, emit) => {
      const room = data.room;
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

  // ------------------------------------------------------------- internals

  private async apply<T>(fn: (data: AgoraData, emit: EmitFn) => T): Promise<T> {
    const outcome = await this.store.mutate((data) => {
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
    for (const event of outcome.emitted) this.bus.emit(event);
    return outcome.value;
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
