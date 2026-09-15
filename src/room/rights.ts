/**
 * Who may do what (Q7, Q16).
 *
 * There is no permissions screen, because the team already made this decision
 * once — on the repository. Agora mirrors it and draws exactly one line:
 *
 *   reversible  — pause, redirect, answer, name an owner, read. Everyone.
 *   merge       — anything that changes what gets merged. Merge rights.
 *
 * The line is not about seniority. It is about whether a mistake can be undone
 * by the next person who looks. Pausing an agent is undone by resuming it.
 * Approving a plan sends four agents down a road.
 */

export type RoomAction =
  // Changes what merges. Needs merge rights.
  | 'approve-plan'
  | 'reject-plan'
  | 'amend-contract'
  | 'edit-lane'
  | 'raise-budget'
  | 'set-risk-list'
  | 'accept-lane'
  | 'reopen-lane'
  | 'set-goal'
  | 'record-decision'
  | 'close-room'
  | 'clear-red'
  | 'mint-merge-token'
  // Undone by the next person who looks. Open to everyone in the room.
  | 'pause-agent'
  | 'resume-agent'
  | 'add-agent'
  | 'set-agent-scope'
  | 'assign-lane'
  | 'add-repo'
  | 'add-human'
  | 'name-lane-owner'
  | 'post-message'
  | 'mint-token';

/**
 * What each action is, said the way the person refused would want to hear it.
 * Keyed exhaustively so a new action cannot be added without deciding which
 * side of the line it falls on.
 */
const ACTIONS: Record<RoomAction, { merge: boolean; what: string }> = {
  'approve-plan': { merge: true, what: 'approving a plan' },
  'reject-plan': { merge: true, what: 'rejecting a plan' },
  'amend-contract': { merge: true, what: 'changing a contract' },
  'edit-lane': { merge: true, what: 'editing a lane before it is approved' },
  'raise-budget': { merge: true, what: 'raising a lane’s cap' },
  'set-risk-list': { merge: true, what: 'changing which surfaces pull a person in' },
  'accept-lane': { merge: true, what: 'accepting a lane' },
  'reopen-lane': { merge: true, what: 'reopening a lane' },
  'set-goal': { merge: true, what: 'changing the room’s goal' },
  'record-decision': { merge: true, what: 'recording a room decision' },
  'close-room': { merge: true, what: 'closing the room' },
  'clear-red': { merge: true, what: 'declaring a half-landed change settled' },
  'mint-merge-token': { merge: true, what: 'handing out merge rights' },

  'pause-agent': { merge: false, what: 'pausing an agent' },
  'resume-agent': { merge: false, what: 'resuming an agent' },
  'add-agent': { merge: false, what: 'adding an agent' },
  'set-agent-scope': { merge: false, what: 'narrowing what an agent may claim' },
  'assign-lane': { merge: false, what: 'handing a lane to another agent' },
  'add-repo': { merge: false, what: 'adding a repository to the room' },
  'add-human': { merge: false, what: 'inviting someone into the room' },
  'name-lane-owner': { merge: false, what: 'naming who answers for a lane' },
  'post-message': { merge: false, what: 'answering an agent' },
  'mint-token': { merge: false, what: 'handing out a room token' }
};

export function needsMergeRights(action: RoomAction): boolean {
  return ACTIONS[action].merge;
}

export function describeAction(action: RoomAction): string {
  return ACTIONS[action].what;
}

/** Everything that changes what merges. Useful for showing the line, not hiding it. */
export function mergeActions(): RoomAction[] {
  return (Object.keys(ACTIONS) as RoomAction[]).filter((action) => ACTIONS[action].merge).sort();
}

export interface RightsVerdict {
  allowed: boolean;
  /** Written for the person refused, and it always says what they *can* do. */
  why: string;
}

export function canDo(
  human: { id: string; displayName: string; canMerge: boolean } | undefined,
  action: RoomAction
): RightsVerdict {
  if (human === undefined) {
    return {
      allowed: false,
      why: 'You are not in this room. Anyone already in it can add you.'
    };
  }
  if (!ACTIONS[action].merge || human.canMerge) return { allowed: true, why: '' };
  return {
    allowed: false,
    why:
      `${describeAction(action)} changes what gets merged, so it mirrors the repository: ` +
      'it needs merge rights on it. Everything reversible — pausing, redirecting, answering, ' +
      'naming who answers for a lane — is open to you.'
  };
}
