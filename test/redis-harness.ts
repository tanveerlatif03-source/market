import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A real Redis, behind Upstash's REST protocol.
 *
 * Vercel KV speaks Upstash REST, and the adapter's compare-and-set is a Lua
 * script — so testing it against a hand-written double would be testing the
 * double. This starts an actual `redis-server` and puts a thin shim in front
 * that speaks the REST shape. The shim is the only stand-in; the Redis, and
 * therefore the Lua, is real.
 */

export interface RedisRest {
  /** What `RedisPersistence` is pointed at. */
  url: string;
  token: string;
  stop: () => Promise<void>;
}

/** Replies are read fully before being parsed: TCP splits wherever it likes. */
function parseReply(buffer: Buffer): { value: unknown; length: number } | null {
  const text = buffer.toString('utf8');
  const end = text.indexOf('\r\n');
  if (end === -1) return null;
  const head = text.slice(1, end);

  switch (text[0]) {
    case '+':
      return { value: head, length: end + 2 };
    case '-':
      return { value: new Error(head), length: end + 2 };
    case ':':
      return { value: Number(head), length: end + 2 };
    case '$': {
      const size = Number(head);
      if (size === -1) return { value: null, length: end + 2 };
      const start = end + 2;
      if (buffer.length < start + size + 2) return null;
      return { value: buffer.subarray(start, start + size).toString('utf8'), length: start + size + 2 };
    }
    case '*': {
      const count = Number(head);
      if (count === -1) return { value: null, length: end + 2 };
      const items: unknown[] = [];
      let offset = end + 2;
      for (let index = 0; index < count; index += 1) {
        const item = parseReply(buffer.subarray(offset));
        if (item === null) return null;
        items.push(item.value);
        offset += item.length;
      }
      return { value: items, length: offset };
    }
    default:
      return null;
  }
}

function command(port: number, parts: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const chunks: Buffer[] = [];
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        `*${parts.length}\r\n` +
          parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')
      );
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const reply = parseReply(Buffer.concat(chunks));
      if (reply === null) return; // Not all of it has arrived yet.
      socket.end();
      if (reply.value instanceof Error) reject(reply.value);
      else resolve(reply.value);
    });
  });
}

export async function startRedisRest(token = 'test-token'): Promise<RedisRest> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-redis-'));
  let redis: ChildProcess | undefined;
  let port = 0;

  // Ports are picked at random and retried, so parallel test files do not
  // fight over one.
  for (let attempt = 0; attempt < 10 && redis === undefined; attempt += 1) {
    const candidate = 6400 + Math.floor(Math.random() * 1000);
    const child = spawn(
      'redis-server',
      ['--port', String(candidate), '--save', '', '--appendonly', 'no', '--dir', dir],
      { stdio: 'ignore' }
    );
    for (let ping = 0; ping < 40; ping += 1) {
      try {
        if ((await command(candidate, ['PING'])) === 'PONG') {
          redis = child;
          port = candidate;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (redis === undefined) child.kill('SIGKILL');
  }
  if (redis === undefined) throw new Error('Could not start redis-server for the test.');

  const live = port;
  const shim: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        try {
          const parts = JSON.parse(Buffer.concat(chunks).toString('utf8')) as string[];
          const result = await command(live, parts);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => shim.listen(0, '127.0.0.1', resolve));
  const address = shim.address();
  const restPort = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${restPort}`,
    token,
    stop: async () => {
      await new Promise<void>((resolve) => shim.close(() => resolve()));
      redis?.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  };
}
