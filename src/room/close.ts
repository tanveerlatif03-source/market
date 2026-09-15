/**
 * Closing a room, and what survives it (Q17, Q24).
 *
 * A room is a unit of work that ends. It closes on the same gate as everything
 * else — every lane's evidence green, every lane landed, nothing still waiting
 * on a person — with a human confirming rather than a timer deciding.
 *
 * The archive then has two jobs. The first is answering *why is the code like
 * this* long after everyone has forgotten, which provenance already does. The
 * second is the one that compounds: the contracts this room agreed are the
 * starting point for the next room that touches the same seams. A team that has
 * run five rooms should not be writing the auth contract from scratch a sixth
 * time.
 */

import { unanswered } from './attention.ts';
import { reviewRequirements, seamContextOf } from './review.ts';
import { PLAN_TASK_ID } from './seed.ts';
import type { Room } from '../types.ts';

export interface CloseBlocker {
  kind: 'lane-open' | 'evidence-missing' | 'not-landed' | 'question-open' | 'no-work';
  detail: string;
  laneId: string | null;
}

export interface CloseReadiness {
  ready: boolean;
  blockers: CloseBlocker[];
  /** What a person is being asked to confirm, in one line. */
  summary: string;
}

export interface CloseInput {
  room: Room;
  /** Lanes the gate actually landed. The room does not take its own word for it. */
  landed: readonly string[];
}

export function closeReadiness(input: CloseInput): CloseReadiness {
  const { room } = input;
  const landed = new Set(input.landed);
  const blockers: CloseBlocker[] = [];
  const lanes = room.tasks.filter((task) => task.id !== PLAN_TASK_ID);

  if (lanes.length === 0) {
    blockers.push({
      kind: 'no-work',
      detail: 'This room has no lanes. There is nothing to close.',
      laneId: null
    });
  }

  for (const lane of lanes) {
    if (lane.status === 'blocked' || lane.status === 'claimed' || lane.status === 'open') {
      blockers.push({
        kind: 'lane-open',
        detail: `"${lane.id}" is ${lane.status}. It is still work in progress.`,
        laneId: lane.id
      });
      continue;
    }
    if (lane.evidence !== null && !lane.evidence.produced) {
      blockers.push({
        kind: 'evidence-missing',
        detail: `"${lane.id}" never showed what it promised: ${lane.evidence.statement}`,
        laneId: lane.id
      });
    }
    if (!landed.has(lane.id)) {
      blockers.push({
        kind: 'not-landed',
        detail: `"${lane.id}" has not landed on the base branch.`,
        laneId: lane.id
      });
    }
  }

  for (const item of unanswered(room.attention)) {
    blockers.push({
      kind: 'question-open',
      detail: `"${item.title}" is still waiting on ${item.assignedTo ?? 'anyone in the room'}.`,
      laneId: item.laneId
    });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    summary: blockersSummary(blockers, lanes.length, room.goal)
  };
}

function blockersSummary(blockers: CloseBlocker[], lanes: number, goal: string): string {
  if (blockers.length === 0) {
    return (
      `All ${lanes} lane(s) landed with their evidence shown and nothing waiting on anyone. ` +
      `The goal was: ${goal}`
    );
  }
  const first = blockers[0];
  const extra = blockers.length - 1;
  return extra > 0
    ? `Not yet: ${first?.detail} (+${extra} more)`
    : `Not yet: ${first?.detail}`;
}

/**
 * A contract, lifted out of the room that agreed it. Carries where it came from,
 * because a contract with no history is just an assertion.
 */
export interface SeedContract {
  title: string;
  body: string;
  /** How many times it was amended before it settled. Worth knowing. */
  versionsItTook: number;
  fromRoom: string;
  fromRoomName: string;
  agreedAt: string;
  /** Anyone who built to it while saying it was wrong (Q22). */
  objections: { by: string; because: string }[];
}

export interface RoomArchive {
  roomId: string;
  name: string;
  goal: string;
  openedAt: string;
  closedAt: string;
  closedBy: string;
  note: string;
  lanes: {
    laneId: string;
    title: string;
    agent: string | null;
    paths: string[];
    evidence: string | null;
    evidenceShown: string | null;
  }[];
  /** The part that compounds. */
  contracts: SeedContract[];
  /** Kept whole: the archive's other job is answering why the code is like this. */
  decisions: Room['decisions'];
  dissents: Room['dissents'];
  rulings: { title: string; resolution: string; by: string; at: string }[];
  events: Room['events'];
}

export function archiveOf(room: Room): RoomArchive {
  return {
    roomId: room.id,
    name: room.name,
    goal: room.goal,
    openedAt: room.createdAt,
    closedAt: room.closedAt ?? room.updatedAt,
    closedBy: room.closedBy ?? 'unknown',
    note: room.closeNote ?? '',
    lanes: room.tasks
      .filter((task) => task.id !== PLAN_TASK_ID)
      .map((task) => ({
        laneId: task.id,
        title: task.title,
        agent: task.owner,
        paths: [...task.paths],
        evidence: task.evidence?.statement ?? null,
        evidenceShown: task.evidence?.produced === true ? task.evidence.note : null
      })),
    contracts: contractsOf(room),
    decisions: room.decisions,
    dissents: room.dissents,
    rulings: room.attention
      .filter((item) => item.resolvedAt !== null)
      .map((item) => ({
        title: item.title,
        resolution: item.resolution ?? 'settled',
        by: item.resolvedBy ?? 'unknown',
        at: item.resolvedAt as string
      })),
    events: room.events
  };
}

/** Only contracts both sides actually signed and held are worth carrying forward. */
function contractsOf(room: Room): SeedContract[] {
  return room.decisions
    .filter((decision) => decision.kind === 'seam' && decision.seam !== null)
    .filter((decision) =>
      (decision.seam?.betweenTasks ?? []).every((laneId) =>
        reviewRequirements(seamContextOf(room, laneId)).every(
          (requirement) =>
            requirement.seamId !== decision.id || requirement.state === 'holds'
        )
      )
    )
    .map((decision) => ({
      title: decision.title,
      body: decision.body,
      versionsItTook: decision.version,
      fromRoom: room.id,
      fromRoomName: room.name,
      agreedAt: decision.createdAt,
      objections: room.dissents
        .filter(
          (dissent) =>
            dissent.about.includes(decision.title) || dissent.about.includes(decision.id)
        )
        .map((dissent) => ({ by: dissent.by, because: dissent.because }))
    }));
}

/**
 * What a new room is handed from an archive. Not the contracts themselves —
 * a starting point that this room's lead has to re-propose and this room's
 * people have to re-approve, because the last room's agreement is evidence,
 * not authority.
 */
export function seedContracts(archives: readonly RoomArchive[]): SeedContract[] {
  const byTitle = new Map<string, SeedContract>();
  for (const archive of archives) {
    for (const contract of archive.contracts) {
      const existing = byTitle.get(contract.title);
      // The most recently agreed version of a contract wins.
      if (existing === undefined || Date.parse(contract.agreedAt) > Date.parse(existing.agreedAt)) {
        byTitle.set(contract.title, contract);
      }
    }
  }
  return [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** What the lead is told on day one of a room seeded from previous work. */
export function seedBriefing(contracts: readonly SeedContract[]): string {
  if (contracts.length === 0) return '';
  return [
    `${contracts.length} contract(s) came from earlier rooms. They are a starting point, not a`,
    'ruling: propose them again if they still hold, and say so plainly if they do not.',
    '',
    ...contracts.map((contract) => {
      const objections =
        contract.objections.length === 0
          ? ''
          : ` Objected to at the time: ${contract.objections.map((o) => o.because).join(' ')}`;
      return (
        `- "${contract.title}" (from ${contract.fromRoomName}, settled at v${contract.versionsItTook}): ` +
        `${contract.body}${objections}`
      );
    })
  ].join('\n');
}
