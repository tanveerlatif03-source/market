import { DEFAULT_RISK_LIST } from '../room/review.ts';
import { FilePersistence, MemoryPersistence } from './persistence.ts';
import type { Persistence } from './persistence.ts';
import type { AgoraData } from '../types.ts';

/** Events are an audit log, not an archive. Keep the tail bounded. */
const MAX_EVENTS = 5000;

/**
 * Fills in collections a room file written by an older build does not have.
 * Every one of them is empty-by-default, so an absent field and an empty one
 * mean the same thing — nothing is invented here.
 */
function hydrate(data: AgoraData): AgoraData {
  const room = data.room as Partial<AgoraData['room']> & AgoraData['room'];
  room.claims ??= [];
  room.humans ??= [];
  room.attention ??= [];
  room.probes ??= {};
  room.dissents ??= [];
  room.reviews ??= [];
  room.signOffs ??= [];
  room.costs ??= [];
  room.batches ??= [];
  room.status ??= 'open';
  room.closedAt ??= null;
  room.closedBy ??= null;
  room.closeNote ??= null;
  room.seededFrom ??= null;
  room.repos ??= [];
  room.partialLanding ??= null;
  room.riskList ??= DEFAULT_RISK_LIST.map((rule) => ({ ...rule, paths: [...rule.paths] }));
  return data;
}

/** How many times a shared write will retry before giving up and saying so. */
const MAX_CAS_ATTEMPTS = 8;

/**
 * Holds the room and writes it somewhere durable.
 *
 * Two modes, and which one you get depends on where the room lives:
 *
 * **Authoritative** (a file, or memory). One process owns the room. It is held
 * in memory, mutations are serialized through a promise chain and applied to a
 * clone, so a mutation that throws leaves the live room untouched.
 *
 * **Shared** (Redis, and so anything serverless). Nobody owns the room. Each
 * mutation loads it, applies itself to that, and writes back only if nothing
 * else has written in between; if something has, it drops what it did and
 * replays against the new state. The retry is the important part — without it
 * two requests landing together would each write a room missing the other's
 * work, and the loss would be silent.
 */
export class AgoraStore {
  private data: AgoraData;
  private rev: number;
  private readonly home: Persistence;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(home: Persistence, data: AgoraData, rev: number) {
    this.home = home;
    this.data = data;
    this.rev = rev;
  }

  /** Loads the room from its home, or seeds it with `init` if it is not there. */
  static async open(file: string | null, init: () => AgoraData): Promise<AgoraStore> {
    return AgoraStore.on(file === null ? new MemoryPersistence() : new FilePersistence(file), init);
  }

  /** Loads the room from any home — a file, memory, or somewhere shared. */
  static async on(home: Persistence, init: () => AgoraData): Promise<AgoraStore> {
    const stored = await home.load();
    if (stored !== null) return new AgoraStore(home, hydrate(stored.data), stored.rev);
    const seeded = init();
    const written = await home.save(seeded, 0);
    return new AgoraStore(home, seeded, written.rev);
  }

  /** Where this room is kept, in words, for a startup line or an error. */
  get home_(): string {
    return this.home.kind;
  }

  /**
   * Reads live state. Callers must not mutate what they get back.
   *
   * In shared mode this is the room as of the last load or write by *this*
   * process, so it can be a moment behind. Every mutation re-reads before it
   * decides anything, which is where correctness actually lives.
   */
  read<T>(fn: (data: AgoraData) => T): T {
    return fn(this.data);
  }

  /** Pulls in anything other instances have written. A no-op when authoritative. */
  async refresh(): Promise<void> {
    if (this.home.authoritative) return;
    const stored = await this.home.load();
    if (stored === null) return;
    this.data = hydrate(stored.data);
    this.rev = stored.rev;
  }

  /**
   * Applies `fn` to a private copy of the room, then swaps it in and persists.
   * Mutations never interleave.
   */
  async mutate<T>(fn: (data: AgoraData) => T): Promise<T> {
    const run = this.tail.then(async () => {
      for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
        // Shared homes have no single writer, so every attempt starts from
        // whatever is actually stored rather than from what we remember.
        if (!this.home.authoritative && attempt > 1) await this.refresh();

        const draft = structuredClone(this.data);
        const result = fn(draft);
        if (draft.room.events.length > MAX_EVENTS) {
          draft.room.events = draft.room.events.slice(-MAX_EVENTS);
        }

        const written = await this.home.save(draft, this.rev);
        if (written.ok) {
          this.data = draft;
          this.rev = written.rev;
          return result;
        }
      }
      throw new Error(
        `Could not write the room to ${this.home.kind}: something else kept writing first. ` +
          'This is contention, not corruption — nothing was lost, and retrying is safe.'
      );
    });
    // Keep the chain alive even when this mutation rejects.
    this.tail = run.catch(() => undefined);
    return run;
  }
}
