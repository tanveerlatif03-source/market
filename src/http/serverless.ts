/**
 * Agora on a serverless host.
 *
 * Every path goes through this one handler: the dashboard, the supervisor API,
 * the MCP endpoint agents connect to, and the broker. `vercel.json` rewrites
 * everything to it rather than splitting routes into separate functions,
 * because they all need the same room and building it twice per request would
 * be twice the work for no gain. `api/index.js` is the two-line file the host
 * actually loads.
 *
 * Two things are different from `agora serve`, and both are the host's doing
 * rather than a choice:
 *
 *   - The room lives in Redis, not a file. A serverless filesystem is
 *     per-instance and discarded; a room kept there would lose work silently.
 *     `KV_REST_API_URL` and `KV_REST_API_TOKEN` are what Vercel KV sets. If
 *     they are absent this function refuses to start rather than quietly
 *     running on a disk that forgets, which is the failure mode worth avoiding.
 *
 *   - MCP runs stateless: no session is kept between requests, because on this
 *     host the next request may be a different process. Agents ask rather than
 *     being told. `docs/deploy-vercel.md` says what that costs.
 *
 * What is *not* here: the merge gate. It shells out to real git against real
 * checkouts, and a serverless function has neither. Agora-on-Vercel is the room
 * — the place agents meet and people supervise. Landing runs with `agora land`
 * wherever the repositories actually are.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventBus } from '../events.ts';
import { AgoraStore } from '../store/store.ts';
import { persistenceFromEnv } from '../store/persistence.ts';
import { RoomService } from '../room/service.ts';
import { createAgoraData } from '../room/seed.ts';
import { createAgoraServer } from './server.ts';
import { providersFromEnv } from '../broker/broker.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Built once per warm instance and reused. The store still re-reads the room
 * before every mutation, so a warm instance is a saved connection rather than a
 * stale cache.
 */
let cached: Promise<Handler> | undefined;

async function build(): Promise<Handler> {
  const home = persistenceFromEnv(process.env);
  if (home.authoritative) {
    throw new Error(
      'Agora needs somewhere shared to keep the room. On Vercel, add a KV store and it will ' +
        'set KV_REST_API_URL and KV_REST_API_TOKEN for you. Without one, every request would ' +
        'get its own copy of the room and the work would be lost.'
    );
  }

  const store: AgoraStore = await AgoraStore.on(home, () =>
    createAgoraData({
      name: process.env.AGORA_ROOM_NAME ?? 'Agora',
      goal: process.env.AGORA_GOAL ?? 'No goal set yet. Set one from the dashboard.',
      ...(process.env.AGORA_OWNER !== undefined
        ? { owner: { displayName: process.env.AGORA_OWNER } }
        : {})
    })
  );

  const service = new RoomService(store, new EventBus());
  const { handler } = createAgoraServer(service, {
    statelessMcp: true,
    brokers: providersFromEnv(),
    ...(process.env.AGORA_ALLOWED_HOSTS !== undefined
      ? { allowedHosts: process.env.AGORA_ALLOWED_HOSTS.split(',').map((host) => host.trim()) }
      : {})
  });

  // The handler syncs the room itself on every request, because that is a
  // property of the room being shared rather than of this host.
  return handler;
}

export default async function agora(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    cached ??= build();
    (await cached)(req, res);
  } catch (error) {
    // A build failure is almost always a missing KV binding, and it will happen
    // on every request until somebody fixes it. Say which one, not "500".
    cached = undefined;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'INVALID',
          message: error instanceof Error ? error.message : String(error),
          remedy: 'See docs/deploy-vercel.md. This is configuration, not a bug in the room.'
        }
      })
    );
  }
}
