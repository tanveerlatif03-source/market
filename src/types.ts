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

export type TaskStatus = 'draft' | 'open' | 'claimed' | 'submitted' | 'accepted' | 'blocked';

export type SubmissionOutcome = 'complete' | 'blocked' | 'needs-review';

export interface SeamCheck {
  decisionId: string;
  satisfied: boolean;
  note: string;
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
  /** Agents don't get bored, so every task has a message budget. */
  messageBudget: number;
  messagesUsed: number;
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
  | 'budget.exhausted';

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
