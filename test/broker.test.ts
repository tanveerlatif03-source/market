import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forward, providersFromEnv, readUsage } from '../src/broker/broker.ts';
import type { ProviderConfig } from '../src/broker/broker.ts';
import { createAgoraServer } from '../src/http/server.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal, roomWithApprovedPlan } from './helpers.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * The broker (Q15).
 *
 * "Metered" means Agora made the call and counted it. This is the only path in
 * the system that produces such a figure, and the tests are mostly about what
 * it refuses to do: invent a price, guess a token count, or let a lane that has
 * spent its cap keep spending money.
 */

const PROVIDER: ProviderConfig = {
  id: 'stub',
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'sk-agora-secret',
  auth: { kind: 'header', name: 'x-api-key' },
  headers: { 'provider-version': '2026-01-01' }
};

/** A provider that records what it was handed and answers with fixed usage. */
function upstream(
  body: unknown,
  status = 200
): { fetchImpl: typeof fetch; seen: { url: string; headers: Record<string, string>; body: string }[] } {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? '')
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe('reading what a call cost', () => {
  it('reads Anthropic-shaped usage', () => {
    const usage = readUsage(
      { model: 'some-model', usage: { input_tokens: 1200, output_tokens: 340 } },
      PROVIDER
    );
    assert.equal(usage?.inputTokens, 1200);
    assert.equal(usage?.outputTokens, 340);
    assert.equal(usage?.model, 'some-model');
  });

  it('reads OpenAI-shaped usage', () => {
    const usage = readUsage(
      { model: 'other-model', usage: { prompt_tokens: 50, completion_tokens: 7 } },
      PROVIDER
    );
    assert.equal(usage?.inputTokens, 50);
    assert.equal(usage?.outputTokens, 7);
  });

  it('gives no money figure when no price is configured', () => {
    const usage = readUsage(
      { model: 'some-model', usage: { input_tokens: 1000, output_tokens: 1000 } },
      PROVIDER
    );
    assert.equal(usage?.cents, null, 'a plausible number with nothing behind it is worse than none');
  });

  it('prices input and output separately, because they do not cost the same', () => {
    const priced: ProviderConfig = {
      ...PROVIDER,
      prices: { 'some-model': { inPerMillion: 300, outPerMillion: 1500 } }
    };
    const usage = readUsage(
      { model: 'some-model', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
      priced
    );
    assert.equal(usage?.cents, 1800);
  });

  it('will not price a model it was not given a price for', () => {
    const priced: ProviderConfig = {
      ...PROVIDER,
      prices: { 'some-model': { inPerMillion: 300, outPerMillion: 1500 } }
    };
    const usage = readUsage(
      { model: 'a-different-model', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      priced
    );
    assert.equal(usage?.cents, null);
  });

  it('refuses to infer anything from a total', () => {
    assert.equal(readUsage({ model: 'm', usage: { total_tokens: 4000 } }, PROVIDER), null);
  });

  it('says nothing rather than guessing when there is no usage at all', () => {
    assert.equal(readUsage({ content: 'hello' }, PROVIDER), null);
    assert.equal(readUsage('not json at all', PROVIDER), null);
  });
});

describe('forwarding', () => {
  it('puts Agora’s key on and takes the agent’s off', async () => {
    const { fetchImpl, seen } = upstream({ usage: { input_tokens: 1, output_tokens: 1 } });
    await forward(
      {
        provider: PROVIDER,
        path: 'messages',
        method: 'POST',
        body: '{"model":"m"}',
        headers: { authorization: 'Bearer the-agents-room-token', 'content-type': 'application/json' }
      },
      fetchImpl
    );

    const call = seen[0];
    assert.equal(call?.url, 'https://provider.invalid/v1/messages');
    assert.equal(call?.headers['x-api-key'], 'sk-agora-secret');
    assert.equal(
      call?.headers.authorization,
      undefined,
      'the agent’s room token is not the provider’s business'
    );
    assert.equal(call?.headers['provider-version'], '2026-01-01');
    assert.equal(call?.headers['content-type'], 'application/json');
  });

  it('forwards the body it was given, byte for byte', async () => {
    const { fetchImpl, seen } = upstream({ usage: { input_tokens: 1, output_tokens: 1 } });
    const body = '{"messages":[{"role":"user","content":"unchanged"}]}';
    await forward(
      { provider: PROVIDER, path: 'messages', method: 'POST', body, headers: {} },
      fetchImpl
    );
    assert.equal(seen[0]?.body, body, 'Agora is not in the business of rewriting prompts');
  });

  it('hands back what the provider said, including a failure', async () => {
    const { fetchImpl } = upstream({ error: { message: 'overloaded' } }, 529);
    const outcome = await forward(
      { provider: PROVIDER, path: 'messages', method: 'POST', body: '{}', headers: {} },
      fetchImpl
    );
    assert.equal(outcome.status, 529);
    assert.match(outcome.body, /overloaded/);
    assert.equal(outcome.usage, null);
  });
});

describe('providers from the environment', () => {
  it('reads a provider out of four variables', () => {
    const providers = providersFromEnv({
      AGORA_BROKER_ANTHROPIC_URL: 'https://api.anthropic.invalid',
      AGORA_BROKER_ANTHROPIC_KEY: 'sk-test',
      AGORA_BROKER_ANTHROPIC_AUTH: 'x-api-key',
      AGORA_BROKER_ANTHROPIC_HEADERS: 'anthropic-version=2023-06-01',
      AGORA_BROKER_ANTHROPIC_PRICES: 'some-model=300/1500'
    });
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.id, 'anthropic');
    assert.deepEqual(providers[0]?.auth, { kind: 'header', name: 'x-api-key' });
    assert.equal(providers[0]?.headers?.['anthropic-version'], '2023-06-01');
    assert.deepEqual(providers[0]?.prices?.['some-model'], { inPerMillion: 300, outPerMillion: 1500 });
  });

  it('defaults to a bearer token and no prices', () => {
    const providers = providersFromEnv({
      AGORA_BROKER_X_URL: 'https://x.invalid',
      AGORA_BROKER_X_KEY: 'k'
    });
    assert.deepEqual(providers[0]?.auth, { kind: 'bearer' });
    assert.equal(providers[0]?.prices, undefined);
  });

  it('ignores a key with nowhere to send it', () => {
    assert.deepEqual(providersFromEnv({ AGORA_BROKER_X_KEY: 'k' }), []);
  });

  it('brokers nothing by default, which is the right default', () => {
    assert.deepEqual(providersFromEnv({}), []);
  });
});

describe('a brokered call, in a room', () => {
  it('records it as metered, which is the only place that word is earned', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.recordBrokeredCall(room.claude, {
      laneId: room.ui,
      provider: 'stub',
      usage: { model: 'some-model', inputTokens: 1200, outputTokens: 340, cents: null },
      status: 200
    });

    const report = room.service.costFor(room.ui);
    assert.equal(report.lines.length, 1);
    assert.equal(report.lines[0]?.provenance, 'metered');
    assert.equal(report.lines[0]?.amount, 1540);
    assert.match(report.lines[0]?.confidence ?? '', /counted them\. Exact/);
  });

  it('keeps money and tokens on separate lines when both are known', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.recordBrokeredCall(room.claude, {
      laneId: room.ui,
      provider: 'stub',
      usage: { model: 'some-model', inputTokens: 1000, outputTokens: 500, cents: 42 },
      status: 200
    });
    const report = room.service.costFor(room.ui);
    assert.deepEqual(
      report.lines.map((line) => line.unit).sort(),
      ['tokens', 'usd-cents']
    );
    assert.equal('total' in report, false);
  });

  it('says plainly when nothing countable came back', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.recordBrokeredCall(room.claude, {
      laneId: room.ui,
      provider: 'stub',
      usage: null,
      status: 529
    });
    assert.deepEqual(room.service.costFor(room.ui).lines, [], 'nothing invented');
    const event = room.service.snapshot().events.find((entry) => entry.type === 'cost.metered');
    assert.match(event?.summary ?? '', /nothing countable came back/);
  });

  it('charges an action, because a loop through a paid API is what the cap is for', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const before = room.service.snapshot().tasks.find((task) => task.id === room.ui)?.actionsUsed ?? 0;
    await room.service.recordBrokeredCall(room.claude, {
      laneId: room.ui,
      provider: 'stub',
      usage: { model: 'm', inputTokens: 10, outputTokens: 10, cents: null },
      status: 200
    });
    const after = room.service.snapshot().tasks.find((task) => task.id === room.ui)?.actionsUsed ?? 0;
    assert.equal(after, before + 1);
  });

  it('charges a failed call too, because a loop of failures is still a loop', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const before = room.service.snapshot().tasks.find((task) => task.id === room.ui)?.actionsUsed ?? 0;
    await room.service.recordBrokeredCall(room.claude, {
      laneId: room.ui,
      provider: 'stub',
      usage: null,
      status: 500
    });
    const after = room.service.snapshot().tasks.find((task) => task.id === room.ui)?.actionsUsed ?? 0;
    assert.equal(after, before + 1);
  });

  it('stops a lane that has run out, and records the call it already paid for', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(OWNER_ID, room.ui, 1);

    // The one it has left.
    await room.service.recordBrokeredCall(room.claude, {
      laneId: room.ui,
      provider: 'stub',
      usage: { model: 'm', inputTokens: 10, outputTokens: 10, cents: null },
      status: 200
    });
    // The next one is refused — but the money already spent is still on record.
    await refusal(
      () =>
        room.service.recordBrokeredCall(room.claude, {
          laneId: room.ui,
          provider: 'stub',
          usage: { model: 'm', inputTokens: 999, outputTokens: 999, cents: null },
          status: 200
        }),
      'BUDGET_EXHAUSTED'
    );

    assert.equal(
      room.service.costFor(room.ui).lines[0]?.amount,
      20,
      'the refused call did not happen, so it did not cost anything'
    );
    const halted = room.service.snapshot().tasks.find((task) => task.id === room.ui);
    assert.ok(halted?.budgetHaltedAt !== null, 'and the lane stopping reached a person');
  });
});

describe('the broker endpoint, end to end', () => {
  /** A room, a real HTTP server, and a provider that is not really there. */
  async function served(status = 200): Promise<{
    base: string;
    token: string;
    service: RoomService;
    lane: string;
    close: () => Promise<void>;
  }> {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });

    const { fetchImpl } = upstream(
      { model: 'some-model', usage: { input_tokens: 800, output_tokens: 200 } },
      status
    );
    const server = createAgoraServer(room.service, {
      host: '127.0.0.1',
      port: 0,
      brokers: [{ ...PROVIDER, prices: { 'some-model': { inPerMillion: 300, outPerMillion: 1500 } } }],
      fetchImpl
    });
    const address = await server.listen();
    return {
      base: `http://${address.host}:${address.port}`,
      token: room.claudeToken,
      service: room.service,
      lane: room.ui,
      close: () => server.close()
    };
  }

  it('takes the agent’s room token, not a provider key', async () => {
    const s = await served();
    const response = await fetch(`${s.base}/broker/stub/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"some-model"}'
    });
    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { remedy: string } };
    assert.match(payload.error.remedy, /same Bearer token you use for \/mcp/);
    await s.close();
  });

  it('forwards the call and meters what it cost', async () => {
    const s = await served();
    const response = await fetch(`${s.base}/broker/stub/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: '{"model":"some-model"}'
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /some-model/);

    const report = s.service.costFor(s.lane);
    assert.deepEqual(report.lines.map((line) => line.unit).sort(), ['tokens', 'usd-cents']);
    assert.equal(report.lines.find((line) => line.unit === 'tokens')?.amount, 1000);
    assert.equal(report.lines.every((line) => line.provenance === 'metered'), true);
    await s.close();
  });

  it('says so plainly when the room brokers no such provider', async () => {
    const s = await served();
    const response = await fetch(`${s.base}/broker/nobody/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}` },
      body: '{}'
    });
    assert.equal(response.status, 404);
    const payload = (await response.json()) as { error: { remedy: string } };
    assert.match(payload.error.remedy, /Configured: stub/);
    await s.close();
  });

  it('refuses to spend money for a lane that has spent its cap', async () => {
    const s = await served();
    await s.service.setTaskBudget(OWNER_ID, s.lane, 0);
    // The lane hits its cap and stops.
    await refusal(
      () => s.service.recordCost('claude', { laneId: s.lane, provenance: 'reported', amount: 1, unit: 'tokens' }),
      'BUDGET_EXHAUSTED'
    ).catch(() => undefined);
    await s.service
      .recordBrokeredCall('claude', { laneId: s.lane, provider: 'stub', usage: null, status: 200 })
      .catch(() => undefined);

    const response = await fetch(`${s.base}/broker/stub/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: '{"model":"some-model"}'
    });
    assert.equal(response.status, 402);
    const payload = (await response.json()) as { error: { message: string } };
    assert.match(payload.error.message, /will not spend money on its behalf/);
    await s.close();
  });
});
