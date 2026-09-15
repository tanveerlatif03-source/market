/**
 * The broker (Q15).
 *
 * "Metered" has a precise meaning in this design: Agora made the call and
 * counted it. Everywhere else in Agora, a cost figure is somebody else's word —
 * a tool volunteering its token count, a quota reading. Those are useful and
 * they are labelled as what they are. This is the only path that produces a
 * figure Agora can stand behind, and it exists because the alternative was to
 * leave the word "metered" in the design meaning nothing.
 *
 * It is deliberately narrow:
 *
 *   - It is for agents running on an API key. An agent on a subscription
 *     already has its own billing relationship and routing it through here
 *     would bill the work twice — which is the founding reason Agora is a place
 *     agents connect *to* rather than something that drives them.
 *   - It forwards, it does not interpret. Agora is not in the business of
 *     rewriting anyone's prompts.
 *   - It counts tokens, which it can see. It converts to money only where a
 *     price has been configured, and otherwise says tokens and stops. A
 *     plausible dollar figure with no price behind it is worse than no figure.
 *   - It spends an action per call, because a runaway loop through a paid API
 *     is exactly what the action cap exists to stop.
 */

export interface ProviderConfig {
  id: string;
  /** Where calls go. No path: the caller's path is appended. */
  baseUrl: string;
  /** The key Agora presents. Never the agent's, never logged, never stored in the room. */
  apiKey: string;
  /** How the key is sent. Providers disagree about this and always will. */
  auth: { kind: 'bearer' } | { kind: 'header'; name: string };
  /** Headers every call needs, such as an API version. */
  headers?: Record<string, string>;
  /**
   * Cost per million tokens, in whole cents, per model. Absent means this
   * broker reports tokens and no money, which is the honest default.
   */
  prices?: Record<string, { inPerMillion: number; outPerMillion: number }>;
}

export interface BrokerUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Null unless a price was configured for this exact model. */
  cents: number | null;
}

/** Providers report usage under different names. Read all of them, guess none. */
export function readUsage(
  body: unknown,
  provider: ProviderConfig
): BrokerUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const usage = record.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const counts = usage as Record<string, unknown>;

  const number = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = counts[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };

  // Anthropic: input_tokens / output_tokens. OpenAI: prompt_tokens /
  // completion_tokens. Nothing is inferred from a total — a total cannot be
  // priced, because input and output do not cost the same.
  const input = number('input_tokens', 'prompt_tokens');
  const output = number('output_tokens', 'completion_tokens');
  if (input === null && output === null) return null;

  const model = typeof record.model === 'string' ? record.model : null;
  const price = model === null ? undefined : provider.prices?.[model];
  const cents =
    price === undefined
      ? null
      : ((input ?? 0) * price.inPerMillion + (output ?? 0) * price.outPerMillion) / 1_000_000;

  return { model, inputTokens: input ?? 0, outputTokens: output ?? 0, cents };
}

export interface BrokerRequest {
  provider: ProviderConfig;
  /** The path after the provider name, e.g. "v1/messages". */
  path: string;
  method: string;
  body: Buffer | string;
  /** Headers from the agent. The authorization header is dropped, never forwarded. */
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface BrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  usage: BrokerUsage | null;
}

/** Headers that belong to the hop, or to a key that is not ours to pass on. */
const STRIPPED = new Set([
  'authorization',
  'x-api-key',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding'
]);

export async function forward(
  request: BrokerRequest,
  fetchImpl: typeof fetch = fetch
): Promise<BrokerResponse> {
  const { provider } = request;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (STRIPPED.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  for (const [name, value] of Object.entries(provider.headers ?? {})) headers[name] = value;

  // Agora's own key, put on here and nowhere else. It never reaches the room,
  // the log, or the agent.
  if (provider.auth.kind === 'bearer') headers.authorization = `Bearer ${provider.apiKey}`;
  else headers[provider.auth.name] = provider.apiKey;

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/${request.path.replace(/^\/+/, '')}`;
  const response = await fetchImpl(url, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    ...(request.signal !== undefined ? { signal: request.signal } : {})
  });

  const text = await response.text();
  let usage: BrokerUsage | null = null;
  try {
    usage = readUsage(JSON.parse(text), provider);
  } catch {
    // A streamed or non-JSON response cannot be counted here. That is a gap,
    // and it is reported as "not counted" rather than estimated.
    usage = null;
  }

  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (STRIPPED.has(name.toLowerCase())) return;
    out[name] = value;
  });

  return { status: response.status, headers: out, body: text, usage };
}

/**
 * Reads providers out of the environment. Keys live here and not in the room,
 * because the room is a JSON file that people read and copy around.
 *
 *   AGORA_BROKER_ANTHROPIC_URL     https://api.anthropic.com
 *   AGORA_BROKER_ANTHROPIC_KEY     sk-...
 *   AGORA_BROKER_ANTHROPIC_AUTH    x-api-key            (default: bearer)
 *   AGORA_BROKER_ANTHROPIC_HEADERS anthropic-version=2023-06-01
 *   AGORA_BROKER_ANTHROPIC_PRICES  claude-x=300/1500    (cents per million, in/out)
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  for (const [name, value] of Object.entries(env)) {
    const match = /^AGORA_BROKER_([A-Z0-9_]+)_KEY$/.exec(name);
    if (match === null || value === undefined || value === '') continue;
    const prefix = `AGORA_BROKER_${match[1] as string}`;
    const baseUrl = env[`${prefix}_URL`];
    if (baseUrl === undefined || baseUrl === '') continue;

    const authHeader = env[`${prefix}_AUTH`];
    providers.push({
      id: (match[1] as string).toLowerCase().replace(/_/g, '-'),
      baseUrl,
      apiKey: value,
      auth:
        authHeader === undefined || authHeader === '' || authHeader.toLowerCase() === 'bearer'
          ? { kind: 'bearer' }
          : { kind: 'header', name: authHeader },
      headers: parsePairs(env[`${prefix}_HEADERS`]),
      prices: parsePrices(env[`${prefix}_PRICES`])
    });
  }
  return providers.sort((a, b) => a.id.localeCompare(b.id));
}

function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    out[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return out;
}

function parsePrices(
  raw: string | undefined
): Record<string, { inPerMillion: number; outPerMillion: number }> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const out: Record<string, { inPerMillion: number; outPerMillion: number }> = {};
  for (const [model, pair] of Object.entries(parsePairs(raw))) {
    const [input, output] = pair.split('/').map((part) => Number(part.trim()));
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    out[model] = { inPerMillion: input as number, outPerMillion: output as number };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
