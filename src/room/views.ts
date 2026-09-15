import { HUMAN_ID, PLAN_TASK_ID } from './seed.ts';
import { reviewsOwedBy } from './review.ts';
import type { Agent, Decision, Room, RoomEvent, Task, Thread } from '../types.ts';

/**
 * Visibility model.
 *
 * Room-wide: the goal, the decisions (the plan, the ownership, the seams) and
 * the task board. A late-joining agent reads those, not the whole chat history.
 *
 * Directed: threads are visible to their participants and to the human.
 *
 * Human-only: every agent's live status note. Reasoning goes to the human, never
 * to another agent.
 */

export interface AgentRosterEntry {
  id: string;
  displayName: string;
  provider: string;
  role: string;
  paused: boolean;
}

export interface AgentRoomView {
  room: {
    id: string;
    name: string;
    goal: string;
    plan: Room['plan'];
    defaultMessageBudget: number;
    updatedAt: string;
    eventSeq: number;
  };
  you: {
    id: string;
    displayName: string;
    provider: string;
    role: string;
    paused: boolean;
    pausedReason: string | null;
    scope: Agent['scope'];
    ownedTasks: string[];
    claimableTasks: string[];
    /** Lanes across your contracts that are waiting on you to read them (Q13). */
    reviewsDue: { laneId: string; seamId: string; seamTitle: string; why: string }[];
  };
  /** Sweeps with rows left. Any agent may take from these (Q19). */
  sweeps: { id: string; laneId: string; title: string; instruction: string; pending: number }[];
  agents: AgentRosterEntry[];
  decisions: Decision[];
  tasks: Task[];
  threads: Thread[];
  events: RoomEvent[];
  guidance: string[];
}

export interface SupervisorRoomView {
  room: Room;
  attention: string[];
}

export function rosterEntry(agent: Agent): AgentRosterEntry {
  return {
    id: agent.id,
    displayName: agent.displayName,
    provider: agent.provider,
    role: agent.role,
    paused: agent.paused
  };
}

export function threadsVisibleTo(room: Room, agentId: string): Thread[] {
  return room.threads.filter((thread) => thread.participants.includes(agentId));
}

/** Room-wide events, plus the directed ones this agent is an audience for. */
export function eventsVisibleTo(room: Room, agentId: string, sinceSeq: number): RoomEvent[] {
  return room.events.filter((event) => {
    if (event.seq <= sinceSeq) return false;
    if (event.type === 'agent.status') return false;
    if (event.audience.length === 0) return true;
    return event.audience.includes(agentId) || event.actor === agentId;
  });
}

/** Agents that still owe this lane a review. */
function reviewersAwaited(room: Room, task: Task): string[] {
  const waiting = new Set<string>();
  for (const agent of room.agents) {
    for (const due of reviewsOwedBy(room, agent.id)) {
      if (due.laneId === task.id) waiting.add(agent.id);
    }
  }
  return [...waiting].sort();
}

/** Joins a sentence onto a reason that may already end in punctuation. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function canClaim(task: Task, agent: Agent, room: Room): boolean {
  if (task.status !== 'open') return false;
  if (task.id === PLAN_TASK_ID) return agent.role === 'lead';
  if (room.plan.status !== 'approved') return false;
  if (agent.scope.writeTasks.includes('*')) return true;
  return agent.scope.writeTasks.includes(task.id);
}

function buildGuidance(
  room: Room,
  agent: Agent,
  owned: Task[],
  claimable: Task[],
  owed: { laneId: string; seamTitle: string }[] = []
): string[] {
  const guidance: string[] = [];

  if (agent.paused) {
    guidance.push(
      `You are paused by the human${agent.pausedReason ? `: ${agent.pausedReason}` : ''}. ` +
        'Stop working and wait to be resumed.'
    );
    return guidance;
  }

  if (room.plan.status !== 'approved') {
    if (agent.role === 'lead' && room.plan.status !== 'proposed') {
      guidance.push(
        `Claim "${PLAN_TASK_ID}" and submit a task split with submit_work. ` +
          'Name the seam between every pair of tasks that touch before work starts.'
      );
    } else if (room.plan.status === 'proposed') {
      guidance.push('The plan is with the human for approval. Nothing to claim until it lands.');
    } else {
      guidance.push(
        `The lead has not proposed a plan yet. You can discuss the seams with post_message on "${PLAN_TASK_ID}".`
      );
    }
    if (room.plan.status === 'rejected' && room.plan.note !== null) {
      guidance.push(`The human rejected the last plan: ${room.plan.note}`);
    }
  }

  // A sweep with rows left is work anyone can pick up without asking (Q19).
  for (const batch of room.batches) {
    const pending = batch.rows.filter((row) => row.state === 'pending').length;
    if (pending === 0) continue;
    guidance.push(
      `"${batch.title}" has ${pending} row(s) nobody has taken. take_rows and work them — ` +
        'you do not need anyone’s permission, and you are not treading on whoever else is on it.'
    );
  }

  // Put this above your own lanes: someone else is stopped until you do it.
  for (const due of owed) {
    guidance.push(
      `Read "${due.laneId}" against "${due.seamTitle}" with review_lane. ` +
        'Neither of you lands until you do.'
    );
  }

  for (const task of owned) {
    if (task.budgetHaltedAt !== null) {
      guidance.push(
        `Task "${task.id}" spent its message budget and stopped. The human has been asked; wait.`
      );
    } else if (task.status === 'claimed') {
      const remaining = task.actionBudget - task.actionsUsed;
      guidance.push(
        `You own "${task.id}". Work only inside ${task.paths.join(', ') || 'no declared paths'} ` +
          `and finish with submit_work. ${remaining} message(s) left on this task.`
      );
    } else if (task.status === 'submitted') {
      const reviewers = reviewersAwaited(room, task);
      guidance.push(
        reviewers.length > 0
          ? `"${task.id}" is submitted and waiting on ${reviewers.join(' and ')} to read it ` +
            'across the contract.'
          : `"${task.id}" is submitted and waiting for the human to accept it.`
      );
    } else if (task.status === 'blocked') {
      guidance.push(`"${task.id}" is blocked: ${sentence(task.blockedReason ?? 'no reason recorded')}`);
    }
  }

  if (claimable.length > 0) {
    guidance.push(`Claimable now: ${claimable.map((task) => task.id).join(', ')}.`);
  } else if (owned.length === 0 && room.plan.status === 'approved') {
    guidance.push('Nothing is claimable by you right now. Ask in a thread before touching another lane.');
  }

  return guidance;
}

export function agentRoomView(
  room: Room,
  agent: Agent,
  options: { sinceSeq?: number } = {}
): AgentRoomView {
  const sinceSeq = options.sinceSeq ?? 0;
  const owned = room.tasks.filter((task) => task.owner === agent.id);
  const claimable = room.tasks.filter((task) => canClaim(task, agent, room));
  const owed = reviewsOwedBy(room, agent.id);

  return {
    room: {
      id: room.id,
      name: room.name,
      goal: room.goal,
      plan: room.plan,
      defaultMessageBudget: room.defaultMessageBudget,
      updatedAt: room.updatedAt,
      eventSeq: room.eventSeq
    },
    you: {
      id: agent.id,
      displayName: agent.displayName,
      provider: agent.provider,
      role: agent.role,
      paused: agent.paused,
      pausedReason: agent.pausedReason,
      scope: agent.scope,
      ownedTasks: owned.map((task) => task.id),
      claimableTasks: claimable.map((task) => task.id),
      reviewsDue: owed
    },
    sweeps: room.batches
      .map((batch) => ({
        id: batch.id,
        laneId: batch.laneId,
        title: batch.title,
        instruction: batch.instruction,
        pending: batch.rows.filter((row) => row.state === 'pending').length
      }))
      .filter((batch) => batch.pending > 0),
    agents: room.agents.map(rosterEntry),
    decisions: room.decisions,
    tasks: room.tasks,
    threads: threadsVisibleTo(room, agent.id),
    events: eventsVisibleTo(room, agent.id, sinceSeq),
    guidance: buildGuidance(room, agent, owned, claimable, owed)
  };
}

/** What the human needs to look at, in the order it matters. */
export function attentionItems(room: Room): string[] {
  const items: string[] = [];

  if (room.plan.status === 'proposed') {
    items.push('The lead proposed a plan. Approve or reject it.');
  }
  for (const task of room.tasks) {
    if (task.budgetHaltedAt !== null) {
      items.push(`"${task.id}" spent its message budget and stopped. Raise the budget or redirect.`);
    }
    if (task.status === 'submitted') {
      const reviewers = reviewersAwaited(room, task);
      items.push(
        reviewers.length > 0
          ? `"${task.id}" was submitted by ${task.owner ?? 'nobody'}; ${reviewers.join(' and ')} ` +
            'still has to read it across the contract.'
          : `"${task.id}" was submitted by ${task.owner ?? 'nobody'} and needs accepting.`
      );
    }
    if (task.status === 'blocked') {
      items.push(`"${task.id}" is blocked: ${sentence(task.blockedReason ?? 'no reason recorded')}`);
    }
  }
  for (const thread of room.threads) {
    if (!thread.participants.includes(HUMAN_ID)) continue;
    const last = thread.messages.at(-1);
    if (last !== undefined && last.from !== HUMAN_ID && last.kind === 'ask') {
      items.push(`${last.from} asked you something on "${thread.taskId}": ${thread.subject}`);
    }
  }
  for (const agent of room.agents) {
    if (agent.paused) items.push(`${agent.displayName} is paused.`);
  }

  return items;
}

export function supervisorRoomView(room: Room): SupervisorRoomView {
  return { room, attention: attentionItems(room) };
}
