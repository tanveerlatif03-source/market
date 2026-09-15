import { nowIso, shortId } from '../ids.ts';
import { DEFAULT_RISK_LIST } from './review.ts';
import { seedBriefing } from './close.ts';
import type { SeedContract } from './close.ts';
import type { RoomRepo } from './repos.ts';
import type { AgoraData, Human, Room, Task } from '../types.ts';

/**
 * The lead's own task. It exists from the moment the room does, so proposing
 * the plan uses the same four verbs as everything else: claim it, discuss the
 * seams in a thread, submit the split for the human to approve.
 */
export const PLAN_TASK_ID = 'plan';

/** Reserved recipient. Addressing the human is not the same as addressing an agent. */
export const HUMAN_ID = 'human';

/**
 * The person who opened the room (Q25). There is no setup step and no
 * permissions screen: whoever opened it can merge, and everyone added after
 * that carries whatever the repository says about them.
 */
export const OWNER_ID = 'owner';

export const DEFAULT_MESSAGE_BUDGET = 30;
export const PLAN_MESSAGE_BUDGET = 40;

function planTask(at: string, briefing: string): Task {
  return {
    id: PLAN_TASK_ID,
    title: 'Propose the task split and the seams',
    description:
      'The lead proposes how the work divides, which paths each task owns, and ' +
      'exactly where the pieces touch. Submit it with submit_work; the human approves it.' +
      (briefing === '' ? '' : `\n\n${briefing}`),
    owner: null,
    suggestedOwner: null,
    status: 'open',
    repoId: null,
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

export interface CreateRoomOptions {
  name: string;
  goal: string;
  /** Whoever opened it. Defaults to one person called "You", which is day one (Q25). */
  owner?: { id?: string; displayName?: string };
  /** Contracts carried over from a room that already closed (Q24). */
  seededContracts?: readonly SeedContract[];
  /** The archive they came from, for the record. */
  seededFrom?: string | null;
  /** The repositories this room touches (Q17). One is the common case. */
  repos?: readonly Omit<RoomRepo, 'addedAt'>[];
}

export function createRoom(options: CreateRoomOptions): Room {
  const at = nowIso();
  const owner: Human = {
    id: options.owner?.id ?? OWNER_ID,
    displayName: options.owner?.displayName ?? 'You',
    canMerge: true,
    joinedAt: at,
    lastSeenAt: null
  };
  const seeded = options.seededContracts ?? [];
  const briefing = seedBriefing(seeded);

  return {
    id: shortId('room'),
    name: options.name,
    goal: options.goal,
    createdAt: at,
    updatedAt: at,
    status: 'open',
    closedAt: null,
    closedBy: null,
    closeNote: null,
    seededFrom: options.seededFrom ?? null,
    repos: (options.repos ?? []).map((repo) => ({ ...repo, addedAt: at })),
    partialLanding: null,
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
    // Carried in as notes, never as signed seams: a previous room's agreement
    // is evidence, not authority. The lead re-proposes what still holds.
    decisions: seeded.map((contract) => ({
      id: shortId('dec'),
      kind: 'general' as const,
      title: `From ${contract.fromRoomName}: ${contract.title}`,
      body:
        `${contract.body}\n\nSettled at v${contract.versionsItTook} in a previous room. ` +
        'Propose it again if it still holds.',
      seam: null,
      proposedBy: owner.id,
      createdAt: at,
      version: 1
    })),
    tasks: [planTask(at, briefing)],
    claims: [],
    humans: [owner],
    attention: [],
    probes: {},
    dissents: [],
    reviews: [],
    riskList: DEFAULT_RISK_LIST.map((rule) => ({ ...rule, paths: [...rule.paths] })),
    signOffs: [],
    costs: [],
    batches: [],
    threads: [],
    events: [
      {
        seq: 1,
        at,
        type: 'room.created',
        actor: owner.id,
        taskId: null,
        threadId: null,
        summary:
          `Room "${options.name}" opened by ${owner.displayName}` +
          (seeded.length > 0 ? `, carrying ${seeded.length} contract(s) from earlier work.` : '.'),
        audience: []
      }
    ],
    eventSeq: 1
  };
}

export function createAgoraData(options: CreateRoomOptions): AgoraData {
  return { version: 1, room: createRoom(options), tokens: [] };
}
