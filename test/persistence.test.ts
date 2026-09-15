import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AgoraStore } from '../src/store/store.ts';
import {
  FilePersistence,
  MemoryPersistence,
  RedisPersistence,
  persistenceFromEnv
} from '../src/store/persistence.ts';
import { createAgoraData, OWNER_ID } from '../src/room/seed.ts';
import { RoomService } from '../src/room/service.ts';
import { EventBus } from '../src/events.ts';
import { startRedisRest } from './redis-harness.ts';
import type { RedisRest } from './redis-harness.ts';

/**
 * Where a room is kept, when the host will not let it be a file.
 *
 * These run against a **real Redis**, started for the test, with a small shim
 * in front speaking Upstash's REST protocol — because that is what Vercel KV
 * gives you and what the adapter is written against. The compare-and-set is a
 * Lua script, so testing it against anything other than a real Redis would be
 * testing the double instead of the script.
 */

const scratch: string[] = [];
let redis: RedisRest;

before(async () => {
  redis = await startRedisRest();
});

after(async () => {
  await redis?.stop();
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

let keyCounter = 0;
function freshRedis(): RedisPersistence {
  keyCounter += 1;
  return new RedisPersistence({ url: redis.url, token: redis.token, key: `agora:test:${keyCounter}` });
}

const seed = (): ReturnType<typeof createAgoraData> =>
  createAgoraData({ name: 'Deployed', goal: 'Run somewhere that forgets.' });

describe('choosing where the room lives', () => {
  it('takes Redis when Vercel KV has set its variables', () => {
    const home = persistenceFromEnv({
      KV_REST_API_URL: 'https://kv.example.invalid',
      KV_REST_API_TOKEN: 'tok'
    });
    assert.equal(home.authoritative, false);
    assert.match(home.kind, /Redis at https:\/\/kv\.example\.invalid/);
  });

  it('takes Upstash’s variables too, since they are the same thing', () => {
    const home = persistenceFromEnv({
      UPSTASH_REDIS_REST_URL: 'https://up.example.invalid',
      UPSTASH_REDIS_REST_TOKEN: 'tok'
    });
    assert.equal(home.authoritative, false);
  });

  it('falls back to a file when nothing shared is configured', () => {
    const home = persistenceFromEnv({}, '/tmp/room.json');
    assert.equal(home.authoritative, true);
    assert.match(home.kind, /the file at \/tmp\/room\.json/);
  });

  it('will not treat half a configuration as configured', () => {
    assert.equal(persistenceFromEnv({ KV_REST_API_URL: 'https://x.invalid' }).authoritative, true);
    assert.equal(persistenceFromEnv({ KV_REST_API_TOKEN: 'tok' }).authoritative, true);
  });
});

describe('a room in Redis', () => {
  it('is empty before anything is written', async () => {
    assert.equal(await freshRedis().load(), null);
  });

  it('comes back exactly as it went in', async () => {
    const home = freshRedis();
    const data = seed();
    const written = await home.save(data, 0);
    assert.equal(written.ok, true);
    assert.equal(written.rev, 1);

    const loaded = await home.load();
    assert.equal(loaded?.rev, 1);
    assert.equal(loaded?.data.room.name, 'Deployed');
    assert.deepEqual(loaded?.data, data);
  });

  it('refuses a write that did not see the last one', async () => {
    const home = freshRedis();
    await home.save(seed(), 0);
    // Somebody else got there first, so this write is working from rev 0.
    const stale = await home.save(seed(), 0);
    assert.equal(stale.ok, false, 'the second writer must be told, not merged blindly');
  });

  it('accepts the retry once it has caught up', async () => {
    const home = freshRedis();
    await home.save(seed(), 0);
    const caught = await home.save(seed(), 1);
    assert.equal(caught.ok, true);
    assert.equal(caught.rev, 2);
  });

  it('says where it was looking when the token is wrong', async () => {
    const home = new RedisPersistence({ url: redis.url, token: 'nope', key: 'agora:test:auth' });
    await assert.rejects(() => home.load(), /Redis at http/);
  });
});

describe('two instances of one room', () => {
  /** What a serverless host does: a fresh process per request, same room. */
  async function instance(home: RedisPersistence): Promise<RoomService> {
    const store = await AgoraStore.on(home, seed);
    return new RoomService(store, new EventBus());
  }

  it('lets the second instance see what the first wrote', async () => {
    const home = freshRedis();
    const first = await instance(home);
    await first.setGoal(OWNER_ID, 'Ship the auth page.');

    const second = await instance(home);
    assert.equal(second.snapshot().goal, 'Ship the auth page.');
  });

  it('does not lose a write when two instances act at once', async () => {
    const home = freshRedis();
    const first = await instance(home);
    const second = await instance(home);

    // Both are holding the same starting room. Without the retry, whichever
    // wrote second would erase the other's agent and nobody would be told.
    await Promise.all([
      first.addAgent(OWNER_ID, { id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' }),
      second.addAgent(OWNER_ID, { id: 'cursor', displayName: 'Cursor', provider: 'cursor', role: 'peer' })
    ]);

    const third = await instance(home);
    assert.deepEqual(
      third.snapshot().agents.map((agent) => agent.id).sort(),
      ['claude', 'cursor'],
      'both agents are in the room; neither write was silently dropped'
    );
  });

  it('keeps the event log of both, in one sequence', async () => {
    const home = freshRedis();
    const first = await instance(home);
    const second = await instance(home);

    await first.addHuman(OWNER_ID, { id: 'priya', displayName: 'Priya', canMerge: true });
    await second.addHuman(OWNER_ID, { id: 'sam', displayName: 'Sam', canMerge: false });

    const room = (await instance(home)).snapshot();
    const joins = room.events.filter((event) => event.type === 'human.joined');
    assert.equal(joins.length, 2);
    assert.equal(new Set(room.events.map((event) => event.seq)).size, room.events.length,
      'no two events share a sequence number');
  });

  it('survives a dozen writes from four instances', async () => {
    const home = freshRedis();
    const instances = await Promise.all([instance(home), instance(home), instance(home), instance(home)]);

    await Promise.all(
      instances.flatMap((service, group) =>
        [0, 1, 2].map((index) =>
          service.addHuman(OWNER_ID, {
            id: `p${group}-${index}`,
            displayName: `Person ${group}-${index}`,
            canMerge: false
          })
        )
      )
    );

    const room = (await instance(home)).snapshot();
    // Twelve added, plus the owner the room opens with.
    assert.equal(room.humans.length, 13);
  });
});

describe('a room in a file, unchanged', () => {
  it('still behaves exactly as it did', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agora-file-'));
    scratch.push(dir);
    const file = join(dir, 'room.json');

    const store = await AgoraStore.on(new FilePersistence(file), seed);
    const service = new RoomService(store, new EventBus());
    await service.setGoal(OWNER_ID, 'Ship it.');

    const reopened = await AgoraStore.on(new FilePersistence(file), seed);
    assert.equal(new RoomService(reopened, new EventBus()).snapshot().goal, 'Ship it.');
  });

  it('keeps a memory room in memory', async () => {
    const store = await AgoraStore.on(new MemoryPersistence(), seed);
    const service = new RoomService(store, new EventBus());
    await service.setGoal(OWNER_ID, 'Nowhere to write.');
    assert.equal(service.snapshot().goal, 'Nowhere to write.');
  });
});
