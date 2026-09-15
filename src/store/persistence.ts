/**
 * Where a room is kept.
 *
 * Agora was built around one long-lived process holding the room in memory and
 * writing a JSON file next to it. That is the right shape for a room running on
 * a machine that also has the repositories checked out — which is what the
 * merge gate needs anyway.
 *
 * It is the wrong shape for a serverless host. There, every request may be a
 * fresh process on a fresh machine: memory is not shared, and the filesystem is
 * per-instance and thrown away. A room kept that way would silently lose work,
 * which is the one failure this project spends its whole design avoiding.
 *
 * So the room's home is a port with two implementations:
 *
 *   - **file** — one process is the authority. Fast, and what `agora serve` uses.
 *   - **shared** — nobody is the authority. Every mutation reads the room, applies
 *     itself, and writes back only if nothing else changed underneath it. Slower
 *     per call and correct under concurrency, which is the trade a serverless
 *     host forces on you whether or not you notice.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgoraData } from '../types.ts';

export interface Stored {
  data: AgoraData;
  /** Bumped on every write. What a compare-and-set compares. */
  rev: number;
}

export interface SaveOutcome {
  /** False when somebody else wrote first. The caller re-reads and tries again. */
  ok: boolean;
  rev: number;
}

export interface Persistence {
  /** For error messages, so a misconfiguration says where it was looking. */
  readonly kind: string;
  /** True when a single process owns the room and can cache it in memory. */
  readonly authoritative: boolean;
  load(): Promise<Stored | null>;
  /** Writes only if the stored revision is still `expected`. */
  save(data: AgoraData, expected: number): Promise<SaveOutcome>;
}

/**
 * One process, one file. The room lives in memory and the file is its backup,
 * written whole with a temp-and-rename so a crash never leaves half a room.
 */
export class FilePersistence implements Persistence {
  readonly kind: string;
  readonly authoritative = true;
  private readonly file: string;
  private rev = 0;

  constructor(file: string) {
    this.file = file;
    this.kind = `the file at ${file}`;
  }

  async load(): Promise<Stored | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return { data: JSON.parse(raw) as AgoraData, rev: this.rev };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(data: AgoraData, expected: number): Promise<SaveOutcome> {
    // No compare-and-set: this process is the only writer by construction.
    void expected;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
    this.rev += 1;
    return { ok: true, rev: this.rev };
  }
}

/** Nothing is written anywhere. For tests, and for `--file null`. */
export class MemoryPersistence implements Persistence {
  readonly kind = 'memory';
  readonly authoritative = true;
  async load(): Promise<Stored | null> {
    return null;
  }
  async save(): Promise<SaveOutcome> {
    return { ok: true, rev: 0 };
  }
}

/**
 * Compare-and-set, done inside Redis so it is actually atomic.
 *
 * The revision lives in its own field so the check never has to parse the room
 * to find it. `-1` means somebody else wrote first; the store re-reads and
 * replays. Anything else is the new revision.
 */
const CAS = `
local rev = redis.call('HGET', KEYS[1], 'rev')
if rev == false then rev = '0' end
if rev ~= ARGV[1] then return -1 end
local next = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rev', next, 'data', ARGV[2])
return next
`.trim();

export interface RedisOptions {
  /** The REST endpoint. Vercel KV and Upstash both give you one. */
  url: string;
  token: string;
  /** Which room. One deployment can hold several. */
  key?: string;
  fetchImpl?: typeof fetch;
}

/**
 * A room in Redis, over Upstash's REST protocol — which is what Vercel KV
 * speaks, and what a serverless function can reach without holding a socket
 * open between invocations.
 */
export class RedisPersistence implements Persistence {
  readonly kind: string;
  readonly authoritative = false;
  private readonly url: string;
  private readonly token: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RedisOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.key = options.key ?? 'agora:room';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.kind = `Redis at ${this.url} (key ${this.key})`;
  }

  private async command(parts: (string | number)[]): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(parts.map(String))
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${this.kind} refused ${parts[0]}: ${response.status} ${text.slice(0, 200)}`);
    }
    const payload = JSON.parse(text) as { result?: unknown; error?: string };
    if (payload.error !== undefined) {
      throw new Error(`${this.kind} refused ${parts[0]}: ${payload.error}`);
    }
    return payload.result;
  }

  async load(): Promise<Stored | null> {
    const fields = (await this.command(['HMGET', this.key, 'rev', 'data'])) as
      | (string | null)[]
      | null;
    const rev = fields?.[0];
    const data = fields?.[1];
    if (rev === null || rev === undefined || data === null || data === undefined) return null;
    return { data: JSON.parse(data) as AgoraData, rev: Number(rev) };
  }

  async save(data: AgoraData, expected: number): Promise<SaveOutcome> {
    const result = await this.command([
      'EVAL',
      CAS,
      1,
      this.key,
      String(expected),
      JSON.stringify(data)
    ]);
    const rev = Number(result);
    return rev < 0 ? { ok: false, rev: expected } : { ok: true, rev };
  }
}

/**
 * Picks a home from the environment.
 *
 * Redis wins when it is configured, because the only reason to configure it is
 * that the filesystem will not do. `KV_REST_API_URL` is what Vercel KV sets;
 * `UPSTASH_REDIS_REST_URL` is what Upstash sets directly.
 */
export function persistenceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallbackFile?: string
): Persistence {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL ?? env.AGORA_REDIS_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN ?? env.AGORA_REDIS_TOKEN;
  if (url !== undefined && url !== '' && token !== undefined && token !== '') {
    return new RedisPersistence({
      url,
      token,
      ...(env.AGORA_ROOM_KEY !== undefined ? { key: env.AGORA_ROOM_KEY } : {})
    });
  }
  if (fallbackFile !== undefined) return new FilePersistence(fallbackFile);
  return new MemoryPersistence();
}
