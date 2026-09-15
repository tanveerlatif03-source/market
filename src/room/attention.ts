/**
 * What needs a person, who it is addressed to, and when it stops being theirs
 * alone (Q7, Q8, Q11, Q16).
 *
 * Supervision is episodic — nobody is watching. So anything that needs a human
 * becomes an item with a name on it. Named, because a question posted to a room
 * of six is a question nobody answers. Timered, because a named person asleep
 * is a dead lane.
 *
 * Every item carries the answers available from the notification itself. If
 * settling something needs the app open, the timer expires every time.
 */

export const OPENS_TO_ROOM_AFTER_MS = 15 * 60 * 1000;

export type AttentionKind =
  | 'plan'
  | 'ruling'
  | 'collision'
  | 'budget'
  | 'stuck'
  | 'blocked'
  | 'review'
  | 'question';

/** One answer a person can give without opening anything. */
export interface AttentionOption {
  id: string;
  label: string;
  /** What Agora does if this is chosen. Written for the person, not the log. */
  effect: string;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  laneId: string | null;
  title: string;
  detail: string;
  options: AttentionOption[];
  /** The named first responder. Null when it was always the room's. */
  assignedTo: string | null;
  openedAt: string;
  /** When the named person's exclusive window closes. */
  opensToRoomAt: string | null;
  /** Only someone who can merge may answer this (Q16). */
  needsMergeRights: boolean;
  /**
   * Present when answering this item *is* a risk sign-off (Q13): the submission
   * the person was shown, and the rules they are signing for. A later
   * submission is not covered by it, which is the whole point.
   */
  signOff?: { submissionId: string; ruleIds: string[] };
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Which option was chosen, and anything they typed. For the record (Q26). */
  resolution: string | null;
}

export type Reach = 'yours' | 'room' | 'waiting';

/**
 * Whose is it, from where this person stands?
 *
 *   yours   — named to them, or it has opened up and they can take it
 *   waiting — named to someone else, still inside their window
 *   room    — open to anyone
 */
export function reachFor(item: AttentionItem, humanId: string, now: number): Reach {
  if (item.resolvedAt !== null) return 'room';
  if (item.assignedTo === humanId) return 'yours';
  if (item.assignedTo === null) return 'room';
  if (item.opensToRoomAt === null) return 'waiting';
  return Date.parse(item.opensToRoomAt) <= now ? 'room' : 'waiting';
}

export function hasOpenedToRoom(item: AttentionItem, now: number): boolean {
  if (item.assignedTo === null) return true;
  if (item.opensToRoomAt === null) return false;
  return Date.parse(item.opensToRoomAt) <= now;
}

export interface AttentionQueue {
  /** Named to this person and still theirs. */
  yours: AttentionItem[];
  /** Open to anyone, including things that timed out on someone else. */
  room: AttentionItem[];
  /** Named to someone else, inside their window. Shown so nobody duplicates work. */
  waiting: AttentionItem[];
}

/** Two queues plus a courtesy third, which is the whole of Q8's interface. */
export function queueFor(
  items: readonly AttentionItem[],
  human: { id: string; canMerge: boolean },
  now: number
): AttentionQueue {
  const open = items.filter((item) => item.resolvedAt === null);
  const queue: AttentionQueue = { yours: [], room: [], waiting: [] };

  for (const item of open) {
    if (item.needsMergeRights && !human.canMerge) continue;
    const reach = reachFor(item, human.id, now);
    if (reach === 'yours') queue.yours.push(item);
    else if (reach === 'room') queue.room.push(item);
    else queue.waiting.push(item);
  }

  const byAge = (a: AttentionItem, b: AttentionItem): number =>
    Date.parse(a.openedAt) - Date.parse(b.openedAt);
  queue.yours.sort(byAge);
  queue.room.sort(byAge);
  queue.waiting.sort(byAge);
  return queue;
}

/** Open items nobody has answered, oldest first. What "stalled" looks like. */
export function unanswered(items: readonly AttentionItem[]): AttentionItem[] {
  return items
    .filter((item) => item.resolvedAt === null)
    .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
}

/** How long the oldest open item has been sitting there, in ms. */
export function longestWait(items: readonly AttentionItem[], now: number): number {
  const oldest = unanswered(items)[0];
  return oldest === undefined ? 0 : now - Date.parse(oldest.openedAt);
}

export function canAnswer(
  item: AttentionItem,
  human: { id: string; canMerge: boolean },
  now: number
): { allowed: boolean; why: string } {
  if (item.resolvedAt !== null) {
    return { allowed: false, why: `Already settled by ${item.resolvedBy ?? 'someone'}.` };
  }
  if (item.needsMergeRights && !human.canMerge) {
    return {
      allowed: false,
      why:
        'This changes what gets merged, so it needs merge rights on the repository. ' +
        'Anything reversible — pausing, redirecting, answering a question — is open to you.'
    };
  }
  const reach = reachFor(item, human.id, now);
  if (reach === 'waiting') {
    return {
      allowed: false,
      why: `${item.assignedTo} has this until ${item.opensToRoomAt}. It opens to the room then.`
    };
  }
  return { allowed: true, why: '' };
}
