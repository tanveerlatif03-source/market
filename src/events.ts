import type { RoomEvent } from './types.ts';

export type RoomEventListener = (event: RoomEvent) => void;

/**
 * In-process fan-out for room events.
 *
 * Live-ness: connected agents are woken when something they care about happens,
 * instead of polling `read_room` on a timer.
 */
export class EventBus {
  private readonly listeners = new Set<RoomEventListener>();

  subscribe(listener: RoomEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RoomEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A bad subscriber must not break the room.
      }
    }
  }
}
