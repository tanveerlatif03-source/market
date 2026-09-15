import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgoraError, isAgoraError } from '../errors.ts';

const MAX_BODY_BYTES = 1_000_000;

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (isAgoraError(error)) {
    const status =
      error.code === 'UNAUTHORIZED' ? 401 : error.code === 'NOT_FOUND' ? 404 : 400;
    sendJson(res, status, {
      error: { code: error.code, message: error.message, remedy: error.remedy, details: error.details }
    });
    return;
  }
  sendJson(res, 500, {
    error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new AgoraError('INVALID', 'Request body too large.', 'Send less.');
    }
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AgoraError('INVALID', 'Request body is not valid JSON.', 'Send a JSON object.');
  }
}

export function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return '';
}

/** EventSource cannot set headers, so a browser stream may carry its token in the query. */
export function queryToken(url: URL): string {
  return url.searchParams.get('access_token') ?? '';
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgoraError('INVALID', `"${key}" is required.`, `Pass a non-empty "${key}".`);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function optionalStringArray(
  source: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}
