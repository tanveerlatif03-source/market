/** Error codes agents see. Every refusal says what to do instead. */
export type AgoraErrorCode =
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

export class AgoraError extends Error {
  code: AgoraErrorCode;
  /** What the agent should do instead. Carried back in the tool result. */
  remedy: string;
  details: Record<string, unknown>;

  constructor(
    code: AgoraErrorCode,
    message: string,
    remedy: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AgoraError';
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }
}

export function isAgoraError(err: unknown): err is AgoraError {
  return err instanceof AgoraError;
}
