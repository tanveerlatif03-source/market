import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgoraServer } from '../src/http/server.ts';
import { openRoom } from '../src/index.ts';
import type { AgoraServer } from '../src/http/server.ts';
import type { RoomService } from '../src/room/service.ts';
import { AUTH_PAGE_PLAN } from './helpers.ts';

interface ToolError {
  error: { code: string; message: string; remedy: string; details?: Record<string, unknown> };
}

let service: RoomService;
let server: AgoraServer;
let base: string;
let supervisorToken = '';
const tokens: Record<string, string> = {};
const clients: Client[] = [];

/** Connects as one agent, exactly the way a real tool would. */
async function connect(name: string, token: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  clients.push(client);
  return client;
}

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const payload = JSON.parse(content[0]?.text ?? '{}');
  if (result.isError === true) {
    throw new Error(`${name} was refused: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

/** Expects the tool to refuse, and returns the structured refusal. */
async function refused(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolError['error']> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const payload = JSON.parse(content[0]?.text ?? '{}') as ToolError;
  assert.equal(result.isError, true, `${name} should have been refused, got ${content[0]?.text}`);
  return payload.error;
}

async function supervisor(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${supervisorToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

before(async () => {
  service = await openRoom({ file: null, name: 'Auth page', goal: 'Ship a working auth page.' });
  const lead = await service.addAgent({
    id: 'claude',
    displayName: 'Claude',
    provider: 'claude-code',
    role: 'lead'
  });
  const peer = await service.addAgent({
    id: 'cursor',
    displayName: 'Cursor',
    provider: 'cursor',
    role: 'peer'
  });
  tokens.claude = lead.token;
  tokens.cursor = peer.token;
  supervisorToken = await service.createSupervisorToken('test');

  server = createAgoraServer(service, { host: '127.0.0.1', port: 0 });
  const address = await server.listen();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await server.close();
});

describe('the MCP surface', () => {
  it('refuses a connection without a room token', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(response.status, 401);
    const payload = (await response.json()) as ToolError;
    assert.equal(payload.error.code, 'UNAUTHORIZED');
  });

  it('offers the room verbs, including per-file claims', async () => {
    const client = await connect('probe', tokens.claude as string);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'claim_file',
        'claim_task',
        'dissent',
        'post_message',
        'read_room',
        'release_file',
        'report_missing',
        'review_lane',
        'show_evidence',
        'submit_work',
        'why_is_this'
      ]
    );
    await client.close();
  });

  it('tells a joining agent to claim files before writing them', async () => {
    const client = await connect('probe-claims', tokens.claude as string);
    assert.match(client.getInstructions() ?? '', /claim_file before you write/);
    await client.close();
  });

  it('tells a joining agent how the room works', async () => {
    const client = await connect('probe-2', tokens.cursor as string);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /one owner/i);
    assert.match(instructions, /seam/i);
    await client.close();
  });
});

describe('two agents build an auth page', () => {
  it('runs the whole milestone through MCP, with the human watching', async () => {
    const claude = await connect('claude-code', tokens.claude as string);
    const cursor = await connect('cursor', tokens.cursor as string);

    // Cursor is woken when work it depends on moves, instead of polling.
    const wakeups: { type: string; summary: string }[] = [];
    cursor.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      wakeups.push(notification.params.data as { type: string; summary: string });
    });

    // 1. The lead reads the room and proposes the split.
    const opening = await call<{ guidance: string[] }>(claude, 'read_room', {
      status_note: 'Reading the goal before I split anything.'
    });
    assert.match(opening.guidance.join(' '), /Claim "plan"/);

    await call(claude, 'claim_task', { task_id: 'plan' });
    const proposed = await call<{ message: string }>(claude, 'submit_work', {
      task_id: 'plan',
      summary: 'Two lanes that meet at one HTTP contract.',
      outcome: 'needs-review',
      plan: AUTH_PAGE_PLAN
    });
    assert.match(proposed.message, /2 task\(s\) and 1 seam\(s\)/);

    // 2. Nothing is claimable until the human approves.
    const board = service.snapshot();
    const ui = board.tasks.find((task) => task.title === 'Auth page UI')?.id as string;
    const api = board.tasks.find((task) => task.title === 'Auth API route')?.id as string;
    const seamId = board.decisions.find((decision) => decision.kind === 'seam')?.id as string;

    const tooEarly = await refused(cursor, 'claim_task', { task_id: api });
    assert.equal(tooEarly.code, 'PLAN_NOT_APPROVED');

    const attention = (await supervisor('/api/room')) as { attention: string[] };
    assert.ok(attention.attention.some((item) => item.includes('Approve')));
    await supervisor('/api/plan/approve', { note: 'Ship it.' });

    // 3. One owner per task.
    await call(claude, 'claim_task', { task_id: ui, status_note: 'Taking the form.' });
    await call(cursor, 'claim_task', { task_id: api, status_note: 'Taking the endpoint.' });
    const taken = await refused(cursor, 'claim_task', { task_id: ui });
    assert.equal(taken.code, 'TASK_OWNED');
    assert.equal(taken.details?.owner, 'claude');

    // 4. Claim, do not merge: work outside the lane is refused, with a name to ask.
    const strayed = await refused(claude, 'submit_work', {
      task_id: ui,
      summary: 'Form plus the endpoint while I was in there.',
      outcome: 'complete',
      files_changed: ['src/auth/AuthPage.tsx', 'src/auth/api.ts']
    });
    assert.equal(strayed.code, 'OUT_OF_SCOPE');
    assert.match(strayed.remedy, /cursor/);

    // 5. So it asks, and gets an answer.
    const asked = await call<{ threadId: string; delivered: string[] }>(claude, 'post_message', {
      task_id: ui,
      to: ['cursor'],
      kind: 'ask',
      subject: 'Error body on a bad password',
      body: 'On 401, is the body {ok:false, error} exactly? The form renders error verbatim.',
      status_note: 'Blocked on the error shape; not touching their file.'
    });
    assert.deepEqual(asked.delivered, ['cursor']);

    await call(cursor, 'post_message', {
      task_id: ui,
      thread_id: asked.threadId,
      kind: 'answer',
      body: 'Yes: 401 {ok:false, error:"Invalid email or password"}.'
    });

    // 6. Both sides confirm the seam they agreed up front.
    await call(claude, 'submit_work', {
      task_id: ui,
      summary: 'Sign-in form posts email and password, renders the 401 error.',
      outcome: 'complete',
      files_changed: ['src/auth/AuthPage.tsx'],
      seam_checks: [{ decisionId: seamId, satisfied: true, note: 'Posts {email, password} to /api/auth/login.' }]
    });
    await call(cursor, 'submit_work', {
      task_id: api,
      summary: 'POST /api/auth/login returns a token or a 401.',
      outcome: 'complete',
      files_changed: ['src/auth/api.ts'],
      seam_checks: [{ decisionId: seamId, satisfied: true, note: 'Returns {ok:true, token} or {ok:false, error}.' }]
    });

    // 7. The human accepts both lanes.
    await supervisor(`/api/tasks/${ui}/accept`, {});
    await supervisor(`/api/tasks/${api}/accept`, {});
    const finished = service.snapshot();
    assert.equal(finished.tasks.find((task) => task.id === ui)?.status, 'accepted');
    assert.equal(finished.tasks.find((task) => task.id === api)?.status, 'accepted');

    // Cursor was pushed the events it needed, without asking for them.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(
      wakeups.some((wake) => wake.type === 'plan.approved'),
      `expected a plan.approved wake-up, got ${JSON.stringify(wakeups.map((wake) => wake.type))}`
    );
    assert.ok(wakeups.some((wake) => wake.type === 'message.posted'));
    assert.ok(
      !wakeups.some((wake) => wake.summary.includes('not touching their file')),
      "another agent's reasoning must never be pushed to a peer"
    );
  });
});

describe('the human can stop an agent mid-flight', () => {
  it('refuses every write from a paused agent until it is resumed', async () => {
    const service2 = await openRoom({ file: null, name: 'Pause', goal: 'Test the pause button.' });
    const lead = await service2.addAgent({
      id: 'claude',
      displayName: 'Claude',
      provider: 'claude-code',
      role: 'lead'
    });
    const token = await service2.createSupervisorToken('test');
    const paused = createAgoraServer(service2, { host: '127.0.0.1', port: 0 });
    const address = await paused.listen();
    const pausedBase = `http://127.0.0.1:${address.port}`;

    const client = new Client({ name: 'claude-code', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${pausedBase}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${lead.token}` } }
      })
    );

    await fetch(`${pausedBase}/api/agents/claude/pause`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Hold on.' })
    });

    const stopped = await refused(client, 'claim_task', { task_id: 'plan' });
    assert.equal(stopped.code, 'AGENT_PAUSED');

    // It can still read the room, so it learns why it was stopped.
    const view = await call<{ you: { paused: boolean }; guidance: string[] }>(client, 'read_room');
    assert.equal(view.you.paused, true);
    assert.match(view.guidance.join(' '), /paused/i);

    await fetch(`${pausedBase}/api/agents/claude/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const resumed = await call<{ message: string }>(client, 'claim_task', { task_id: 'plan' });
    assert.match(resumed.message, /You own "plan"/);

    await client.close();
    await paused.close();
  });
});

describe('the supervisor endpoints', () => {
  it('need the supervisor token, not an agent token', async () => {
    const withAgentToken = await fetch(`${base}/api/room`, {
      headers: { authorization: `Bearer ${tokens.claude}` }
    });
    assert.equal(withAgentToken.status, 401);

    const anonymous = await fetch(`${base}/api/room`);
    assert.equal(anonymous.status, 401);

    const authorized = await fetch(`${base}/api/room`, {
      headers: { authorization: `Bearer ${supervisorToken}` }
    });
    assert.equal(authorized.status, 200);
  });

  it('serve the dashboard and a health check', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agora/);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
  });
});
