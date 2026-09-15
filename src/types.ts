import type { Claim } from './room/claims.ts';
import type { AttentionItem } from './room/attention.ts';
import type { StuckProbe } from './room/spin.ts';
import type { Review, RiskRule, RiskSignOff } from './room/review.ts';

export type { Claim, ClaimState, ClaimHolderActivity } from './room/claims.ts';
export type { AttentionItem, AttentionKind, AttentionOption, AttentionQueue } from './room/attention.ts';
export type { SpinSignal, StuckProbe, StuckVerdict } from './room/spin.ts';
export type {
  Review,
  ReviewVerdict,
  ReviewState,
  ReviewRequirement,
  RiskRule,
  RiskSignOff
} from './room/review.ts';
export type { Provenance, ProvenanceEntry, ProvenanceSubject } from './room/provenance.ts';

/**
 * Agora domain types.
 *
 * The room is one shared object holding four things: a goal, decisions (the
 * agreed plan, task ownership, and the seams), a task board where every task
 * has exactly one owner at a time, and message threads.
 */

export type AgentRole = 'lead' | 'peer';

/** Per-agent permission scope. The human controls this; agents cannot widen it. */
export interface AgentScope {
  /** Path prefixes this agent may read. `["**"]` means the whole project. */
  readPaths: string[];
  /** Task ids this agent may claim and submit against. `["*"]` means any task. */
  writeTasks: string[];
}

/**
 * Live status for the human dashboard. Agents attach a `status_note` to any
 * tool call; it lands here and never enters a thread another agent can read.
 */
export interface AgentStatus {
  state: 'idle' | 'working' | 'waiting' | 'blocked' | 'done';
  taskId: string | null;
  note: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  displayName: string;
  /** Free text: "claude-code", "codex", "cursor", ... */
  provider: string;
  role: AgentRole;
  scope: AgentScope;
  paused: boolean;
  pausedReason: string | null;
  /** Human-only. Stripped from every agent-facing view. */
  status: AgentStatus;
  joinedAt: string;
  lastSeenAt: string | null;
  /** Last time this agent claimed any file. Distinguishes "moved on" from "thinking". */
  latestTouchAt: string | null;
}

/**
 * A person in the room (Q7). Several, not one — work that runs for days pulls
 * in many people, and a single-supervisor cockpit is only half the thing.
 */
export interface Human {
  id: string;
  displayName: string;
  /**
   * Mirrors the repository (Q16). Whoever can merge to main can approve a plan,
   * settle a contract or raise a cap. Everyone else can still pause, redirect
   * and answer — anything reversible.
   */
  canMerge: boolean;
  joinedAt: string;
  lastSeenAt: string | null;
}

export type PlanStatus = 'none' | 'proposed' | 'approved' | 'rejected';

export interface Plan {
  status: PlanStatus;
  proposedBy: string | null;
  proposedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The human's note when approving or rejecting. */
  note: string | null;
  revision: number;
}

export type DecisionKind = 'plan' | 'seam' | 'general';

/** One side of a seam: what this task hands over, and what it expects back. */
export interface SeamSide {
  taskId: string;
  provides: string;
  expects: string;
}

/**
 * Where two pieces touch. Agreed before work starts and stored as a room-level
 * decision, so both sides build toward a fixed point.
 */
export interface Seam {
  betweenTasks: [string, string];
  contract: SeamSide[];
}

/** Room-wide and visible to everyone, including agents that join late. */
export interface Decision {
  id: string;
  kind: DecisionKind;
  title: string;
  body: string;
  seam: Seam | null;
  proposedBy: string;
  createdAt: string;
  /** Bumped when a decision is restated. Groundwork for decision drift (deferred). */
  version: number;
}

/** The one check that asks whether the work was any good, rather than legal. */
export interface Evidence {
  /** Stated in the plan, before any code is written. */
  statement: string;
  produced: boolean;
  /** How it was shown. Filled in when produced. */
  note: string;
  producedAt: string | null;
}

export type TaskStatus = 'draft' | 'open' | 'claimed' | 'submitted' | 'accepted' | 'blocked';

export type SubmissionOutcome = 'complete' | 'blocked' | 'needs-review';

export interface SeamCheck {
  decisionId: string;
  satisfied: boolean;
  note: string;
  /**
   * The contract version this was signed against (Q14). A later bump makes the
   * signature worthless, which is what takes the lane stale.
   */
  signedVersion: number;
}

export interface Submission {
  id: string;
  taskId: string;
  by: string;
  summary: string;
  filesChanged: string[];
  seamChecks: SeamCheck[];
  outcome: SubmissionOutcome;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  /** Exactly one owner at a time. Claim, don't merge. */
  owner: string | null;
  /** Who the lead proposed for this lane. Advisory: ownership still has to be claimed. */
  suggestedOwner: string | null;
  status: TaskStatus;
  /** This task's lane: the paths it owns. */
  paths: string[];
  /** Ids of the seam decisions this task must build toward. */
  seams: string[];
  /** The named human answering for this lane (Q8). */
  laneOwner: string | null;
  /**
   * What this lane said would prove it worked (Q18). Null when there is
   * nothing to prove — a solo lane may still declare one.
   */
  evidence: Evidence | null;
  /** Agents don't get bored, so every lane has an action budget (Q15). */
  actionBudget: number;
  actionsUsed: number;
  /** Set when the budget ran out and the task stopped to ask the human. */
  budgetHaltedAt: string | null;
  blockedReason: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
  submissions: Submission[];
}

/** Only declared messages travel between agents: the ask and the answer. */
export type MessageKind = 'ask' | 'answer' | 'handoff' | 'fyi';

export interface Message {
  id: string;
  threadId: string;
  taskId: string;
  from: string;
  kind: MessageKind;
  body: string;
  createdAt: string;
}

/**
 * Thread-scoped visibility: a thread is visible to its participants and to the
 * human. Not end-to-end encryption — Agora can always read it.
 */
export interface Thread {
  id: string;
  taskId: string;
  subject: string;
  participants: string[];
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

/** Complying and objecting at the same time (Q22). */
export interface Dissent {
  id: string;
  by: string;
  /** What was ruled, as the agent understood it. */
  about: string;
  /** Why the agent thinks it is wrong. */
  because: string;
  laneId: string | null;
  at: string;
}

export type RoomEventType =
  | 'room.created'
  | 'agent.joined'
  | 'agent.status'
  | 'agent.paused'
  | 'agent.resumed'
  | 'agent.scope'
  | 'plan.proposed'
  | 'plan.approved'
  | 'plan.rejected'
  | 'decision.recorded'
  | 'task.created'
  | 'task.claimed'
  | 'task.assigned'
  | 'task.submitted'
  | 'task.accepted'
  | 'task.reopened'
  | 'task.blocked'
  | 'task.budget'
  | 'message.posted'
  | 'budget.exhausted'
  | 'claim.granted'
  | 'claim.taken'
  | 'claim.released'
  | 'claim.collision'
  | 'claim.swept'
  | 'evidence.produced'
  | 'seam.amended'
  | 'plan.edited'
  | 'human.joined'
  | 'attention.raised'
  | 'attention.answered'
  | 'attention.opened'
  | 'dissent.recorded'
  | 'spin.detected'
  | 'spin.stuck'
  | 'review.recorded'
  | 'review.requested'
  | 'risk.flagged'
  | 'risk.signed'
  | 'lane.landed';

export interface RoomEvent {
  seq: number;
  at: string;
  type: RoomEventType;
  /** Agent id, or "human" for supervisor actions. */
  actor: string;
  taskId: string | null;
  threadId: string | null;
  summary: string;
  /** Agents woken by this event. Empty means nobody in particular. */
  audience: string[];
}

export interface Room {
  id: string;
  name: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  /** One agent is lead for the room: it proposes the split, the human approves. */
  lead: string | null;
  plan: Plan;
  defaultMessageBudget: number;
  agents: Agent[];
  decisions: Decision[];
  tasks: Task[];
  /** Per-file claims (Q2-Q5). One claim per path, room-wide. */
  claims: Claim[];
  /** The people in the room (Q7). */
  humans: Human[];
  /** Everything waiting on a person (Q8, Q11). */
  attention: AttentionItem[];
  /** Rounds of the "what is missing" question, per lane (Q20). */
  probes: Record<string, StuckProbe[]>;
  /** Objections agents registered while complying (Q22). */
  dissents: Dissent[];
  /** Readings of one lane by the agent across its contract (Q13). */
  reviews: Review[];
  /** Surfaces that always pull a person in, whatever the agents say (Q13). */
  riskList: RiskRule[];
  /** People having looked at those surfaces, per submission (Q13). */
  signOffs: RiskSignOff[];
  threads: Thread[];
  events: RoomEvent[];
  eventSeq: number;
}

/** Token records live outside the room: they are secrets, not room state. */
export interface TokenRecord {
  id: string;
  kind: 'agent' | 'supervisor';
  agentId: string | null;
  label: string;
  /** sha256 of the token. The token itself is shown once, at creation. */
  hash: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface AgoraData {
  version: 1;
  room: Room;
  tokens: TokenRecord[];
}
