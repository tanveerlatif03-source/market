/**
 * The broker endpoint (Q15).
 *
 * An agent on an API key points its provider base URL here instead of at the
 * provider. Agora forwards the call with its own key, reads the token counts
 * off the response, and records them as *metered* — the one provenance in this
 * system that means "we counted this ourselves".
 *
 * Two rules the endpoint enforces on the way through:
 *
 *   - A lane that has spent its cap does not get to keep spending money. The
 *     call is refused before it leaves the building.
 *   - Every call costs an action. A runaway loop through a paid API is exactly
 *     what the cap is for, and a broker that did not charge would be a hole in
 *     the one backstop the design actually relies on.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { forward } from '../broker/broker.ts';
import type { ProviderConfig } from '../broker/broker.ts';
import { isAgoraError } from '../errors.ts';
import type { RoomService } from '../room/service.ts';
import { readRawBody, sendJson } from './util.ts';

export interface BrokerOptions {
  providers: readonly ProviderConfig[];
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export async function handleBrokerRequest(
  service: RoomService,
  agentId: string,
  options: BrokerOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/broker\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (match === null) return false;

  const providerId = decodeURIComponent(match[1] as string);
  const provider = options.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    sendJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: `This room brokers no provider called "${providerId}".`,
        remedy:
          options.providers.length === 0
            ? 'No provider is configured. Set AGORA_BROKER_<NAME>_URL and _KEY where Agora runs.'
            : `Configured: ${options.providers.map((entry) => entry.id).join(', ')}.`
      }
    });
    return true;
  }

  // Which lane is this work for? The agent's own claimed lane — it does not get
  // to say, because then a spent lane could bill a fresh one.
  const room = service.snapshot();
  const lane = room.tasks.find(
    (task) => task.owner === agentId && (task.status === 'claimed' || task.status === 'submitted')
  );

  if (lane !== undefined && lane.budgetHaltedAt !== null) {
    sendJson(res, 402, {
      error: {
        code: 'BUDGET_EXHAUSTED',
        message: `"${lane.id}" has spent its cap, so Agora will not spend money on its behalf.`,
        remedy: 'Stop and wait. A person has been asked to raise it or redirect the work.'
      }
    });
    return true;
  }

  let outcome;
  try {
    outcome = await forward(
      {
        provider,
        path: match[2] as string,
        method: req.method ?? 'POST',
        body: await readRawBody(req),
        headers: headersOf(req)
      },
      options.fetchImpl
    );
  } catch (error) {
    sendJson(res, 502, {
      error: {
        code: 'INVALID',
        message: `The provider could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        remedy: 'Retry, or call the provider directly and report your usage with report_usage.'
      }
    });
    return true;
  }

  // Counted on the way back, whatever the provider said. A failed call still
  // costs an action, because a loop of failures is still a loop.
  try {
    await service.recordBrokeredCall(agentId, {
      laneId: lane?.id ?? null,
      provider: provider.id,
      usage: outcome.usage,
      status: outcome.status
    });
  } catch (error) {
    if (isAgoraError(error) && error.code === 'BUDGET_EXHAUSTED') {
      // The response is already paid for, so it is handed back rather than
      // thrown away — but this was the last one.
      res.setHeader('x-agora-cap', 'spent');
    }
  }

  res.writeHead(outcome.status, outcome.headers);
  res.end(outcome.body);
  return true;
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
