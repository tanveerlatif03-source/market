import { nowIso, shortId } from '../ids.ts';
import type { AgoraData, Room, Task } from '../types.ts';

/**
 * The lead's own task. It exists from the moment the room does, so proposing
 * the plan uses the same four verbs as everything else: claim it, discuss the
 * seams in a thread, submit the split for the human to approve.
 */
export const PLAN_TASK_ID = 'plan';

/** Reserved recipient. Addressing the human is not the same as addressing an agent. */
export const HUMAN_ID = 'human';

export const DEFAULT_MESSAGE_BUDGET = 30;
export const PLAN_MESSAGE_BUDGET = 40;

function planTask(at: string): Task {
  return {
    id: PLAN_TASK_ID,
    title: 'Propose the task split and the seams',
    description:
      'The lead proposes how the work divides, which paths each task owns, and ' +
      'exactly where the pieces touch. Submit it with submit_work; the human approves it.',
    owner: null,
    suggestedOwner: null,
    status: 'open',
    paths: [],
    seams: [],
    laneOwner: null,
    evidence: null,
    actionBudget: PLAN_MESSAGE_BUDGET,
    actionsUsed: 0,
    budgetHaltedAt: null,
    blockedReason: null,
    claimedAt: null,
    createdAt: at,
    updatedAt: at,
    submissions: []
  };
}

export function createRoom(options: { name: string; goal: string }): Room {
  const at = nowIso();
  return {
    id: shortId('room'),
    name: options.name,
    goal: options.goal,
    createdAt: at,
    updatedAt: at,
    lead: null,
    plan: {
      status: 'none',
      proposedBy: null,
      proposedAt: null,
      decidedBy: null,
      decidedAt: null,
      note: null,
      revision: 0
    },
    defaultMessageBudget: DEFAULT_MESSAGE_BUDGET,
    agents: [],
    decisions: [],
    tasks: [planTask(at)],
    claims: [],
    humans: [],
    attention: [],
    probes: {},
    dissents: [],
    threads: [],
    events: [
      {
        seq: 1,
        at,
        type: 'room.created',
        actor: HUMAN_ID,
        taskId: null,
        threadId: null,
        summary: `Room "${options.name}" opened.`,
        audience: []
      }
    ],
    eventSeq: 1
  };
}

export function createAgoraData(options: { name: string; goal: string }): AgoraData {
  return { version: 1, room: createRoom(options), tokens: [] };
}
