import { randomUUID, randomBytes, createHash } from 'node:crypto';

/** Short, readable, collision-safe enough for one room. */
export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/** Turns a title into a stable, readable task id fragment. */
export function slugify(input: string, fallback = 'task'): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : fallback;
}

export function newToken(): string {
  return `mkt_${randomBytes(24).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}
