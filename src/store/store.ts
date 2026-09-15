import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_RISK_LIST } from '../room/review.ts';
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

/**
 * Holds the whole room in memory and persists it as one JSON file.
 *
 * Every mutation is serialized through a promise chain and applied to a clone,
 * so a mutation that throws leaves the live room untouched.
 */
export class AgoraStore {
  private data: AgoraData;
  private readonly file: string | null;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(file: string | null, data: AgoraData) {
    this.file = file;
    this.data = data;
  }

  /** Loads the room from disk, or seeds it with `init` if the file is absent. */
  static async open(file: string | null, init: () => AgoraData): Promise<AgoraStore> {
    if (file === null) return new AgoraStore(null, init());
    try {
      const raw = await readFile(file, 'utf8');
      return new AgoraStore(file, hydrate(JSON.parse(raw) as AgoraData));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const store = new AgoraStore(file, init());
      await store.persist();
      return store;
    }
  }

  /** Reads live state. Callers must not mutate what they get back. */
  read<T>(fn: (data: AgoraData) => T): T {
    return fn(this.data);
  }

  /**
   * Applies `fn` to a private copy of the room, then swaps it in and persists.
   * Mutations never interleave.
   */
  async mutate<T>(fn: (data: AgoraData) => T): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.data);
      const result = fn(draft);
      if (draft.room.events.length > MAX_EVENTS) {
        draft.room.events = draft.room.events.slice(-MAX_EVENTS);
      }
      this.data = draft;
      await this.persist();
      return result;
    });
    // Keep the chain alive even when this mutation rejects.
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    if (this.file === null) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }
}
