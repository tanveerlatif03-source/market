/** Error codes agents see. Every refusal says what to do instead. */
export type MarketErrorCode =
  | 'UNAUTHORIZED'
  | 'AGENT_PAUSED'
  | 'PLAN_NOT_APPROVED'
  | 'NOT_FOUND'
  | 'TASK_OWNED'
  | 'NOT_OWNER'
  | 'OUT_OF_SCOPE'
  | 'BUDGET_EXHAUSTED'
  | 'INVALID'
  | 'NOT_LEAD';

export class MarketError extends Error {
  code: MarketErrorCode;
  /** What the agent should do instead. Carried back in the tool result. */
  remedy: string;
  details: Record<string, unknown>;

  constructor(
    code: MarketErrorCode,
    message: string,
    remedy: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }
}

export function isMarketError(err: unknown): err is MarketError {
  return err instanceof MarketError;
}
