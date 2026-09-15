import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventBus } from '../src/events.ts';
import { AgoraStore } from '../src/store/store.ts';
import { RedisPersistence } from '../src/store/persistence.ts';
import { RoomService } from '../src/room/service.ts';
import { createAgoraData, OWNER_ID } from '../src/room/seed.ts';
import { createAgoraServer } from '../src/http/server.ts';
import { startRedisRest } from './redis-harness.ts';
import type { RedisRest } from './redis-harness.ts';

/**
 * Agora behind a serverless host.
 *
 * The thing under test is the shape the host forces: the room kept somewhere
 * shared rather than in this process, and MCP with no session between requests.
 * The handler here is the same one `src/http/serverless.ts` hands to the host —
 * built the same way, against a real Redis — so what passes here is what the
 * deployment runs.
 *
 * What this cannot prove is that Vercel itself is configured correctly. It
 * proves the code is right about the constraints; `docs/deploy-vercel.md` is
 * where the rest lives.
 */

let redis: RedisRest;
/** Every server started here, closed in `after` so a failed assertion reports
 * rather than leaving the runner waiting on an open socket. */
const running: (() => Promise<void>)[] = [];

before(async () => {
  redis = await startRedisRest();
});

after(async () => {
  for (const close of running) await close().catch(() => undefined);
  await redis?.stop();
});

let keys = 0;

interface Deployment {
  base: string;
  service: RoomService;
  /** Throws away the process and builds a new one, as a cold start would. */
  coldStart: () => Promise<Deployment>;
  close: () => Promise<void>;
}

/**
 * One instance of the deployment: a fresh process, a shared room, stateless
 * MCP. Built exactly as `src/http/serverless.ts` builds it.
 */
async function deploy(key: string): Promise<Deployment> {
  const home = new RedisPersistence({ url: redis.url, token: redis.token, key });
  const store = await AgoraStore.on(home, () =>
    createAgoraData({ name: 'Deployed', goal: 'Prove it survives a cold start.' })
  );
  const service = new RoomService(store, new EventBus());
  const agora = createAgoraServer(service, { host: '127.0.0.1', port: 0, statelessMcp: true });
  const address = await agora.listen();
  running.push(() => agora.close());

  return {
    base: `http://${address.host}:${address.port}`,
    service,
    coldStart: async () => {
      await agora.close();
      return deploy(key);
    },
    close: () => agora.close()
  };
}

function fresh(): Promise<Deployment> {
  keys += 1;
  return deploy(`agora:sls:${keys}`);
}

describe('the room survives the host forgetting', () => {
  it('answers a health check with the room it found', async () => {
    const one = await fresh();
    const response = await fetch(`${one.base}/healthz`);
    const payload = (await response.json()) as { ok: boolean; room: string };
    assert.equal(payload.ok, true);
    assert.match(payload.room, /^room_/);
  });

  it('serves the dashboard', async () => {
    const one = await fresh();
    const response = await fetch(`${one.base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /Agora/);
  });

  it('still has the room after the instance is thrown away', async () => {
    let one = await fresh();
    const token = await one.service.createSupervisorToken(OWNER_ID, 'dash');
    await fetch(`${one.base}/api/goal`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'Ship the auth page.' })
    });

    // The host decides this instance is done. Everything in memory is gone.
    one = await one.coldStart();

    const response = await fetch(`${one.base}/api/room`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const payload = (await response.json()) as { room: { goal: string } };
    assert.equal(payload.room.goal, 'Ship the auth page.', 'a room that forgets is not a room');
  });

  it('honours a token minted by an instance that no longer exists', async () => {
    let one = await fresh();
    const token = await one.service.createSupervisorToken(OWNER_ID, 'dash');
    one = await one.coldStart();

    const response = await fetch(`${one.base}/api/room`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
  });

  it('refuses an unknown token, cold or warm', async () => {
    const one = await fresh();
    const response = await fetch(`${one.base}/api/room`, {
      headers: { authorization: 'Bearer agr_not-a-real-token' }
    });
    assert.equal(response.status, 401);
  });
});

describe('two instances at once', () => {
  it('shows each what the other did', async () => {
    keys += 1;
    const key = `agora:sls:${keys}`;
    const one = await deploy(key);
    const two = await deploy(key);

    const token = await one.service.createSupervisorToken(OWNER_ID, 'dash');
    await fetch(`${one.base}/api/humans`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'priya', displayName: 'Priya', canMerge: true })
    });

    // The second instance never saw that request, and must still know.
    const response = await fetch(`${two.base}/api/humans`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const payload = (await response.json()) as { humans: { id: string }[] };
    assert.ok(payload.humans.some((human) => human.id === 'priya'));

  });
});

describe('an agent connecting, with no session to hold', () => {
  it('lists the room’s tools over stateless MCP', async () => {
    const one = await fresh();
    const { token } = await one.service.addAgent(OWNER_ID, {
      id: 'claude',
      displayName: 'Claude',
      provider: 'claude-code',
      role: 'lead'
    });

    const client = new Client({ name: 'probe', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${one.base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'read_room'));
    assert.ok(tools.some((tool) => tool.name === 'claim_file'));
    await client.close();
  });

  it('does what an agent asks, and the room keeps it', async () => {
    const one = await fresh();
    const { token } = await one.service.addAgent(OWNER_ID, {
      id: 'claude',
      displayName: 'Claude',
      provider: 'claude-code',
      role: 'lead'
    });

    const client = new Client({ name: 'probe', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${one.base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const result = await client.callTool({ name: 'claim_task', arguments: { task_id: 'plan' } });
    const content = result.content as { text: string }[];
    assert.equal(result.isError, undefined, content[0]?.text);
    await client.close();

    // Read it back from a process that was not there when it happened.
    const after = await one.coldStart();
    assert.equal(after.service.snapshot().tasks.find((task) => task.id === 'plan')?.owner, 'claude');
  });

  it('turns away an agent without a room token', async () => {
    const one = await fresh();
    const response = await fetch(`${one.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(response.status, 401);
  });
});
