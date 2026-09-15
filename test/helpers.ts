import { openRoom } from '../src/index.ts';
import type { RoomService } from '../src/room/service.ts';
import type { PlanProposal } from '../src/room/service.ts';
import { isAgoraError } from '../src/errors.ts';
import type { AgoraErrorCode } from '../src/errors.ts';
import { OWNER_ID } from '../src/room/seed.ts';

export const AUTH_PAGE_PLAN: PlanProposal = {
  summary: 'Two lanes that meet at one HTTP contract.',
  tasks: [
    {
      key: 'ui',
      title: 'Auth page UI',
      description: 'The sign-in form and its states.',
      paths: ['src/auth/AuthPage.tsx'],
      suggestedOwner: 'claude',
      evidence: 'Signing in with a good password reaches the dashboard; a bad one shows the 401 text.'
    },
    {
      key: 'api',
      title: 'Auth API route',
      description: 'The endpoint the form posts to.',
      paths: ['src/auth/api.ts'],
      suggestedOwner: 'cursor',
      evidence: 'POST /api/auth/login returns a token for a known user and 401 for a bad password.'
    }
  ],
  seams: [
    {
      title: 'POST /api/auth/login',
      body: 'Request {email, password}. Response 200 {ok:true, token} or 401 {ok:false, error}.',
      between: ['ui', 'api'],
      contract: [
        {
          task: 'ui',
          provides: 'A POST to /api/auth/login with a JSON body {email, password}.',
          expects: '200 {ok:true, token} on success, 401 {ok:false, error} on bad credentials.'
        },
        {
          task: 'api',
          provides: '200 {ok:true, token} or 401 {ok:false, error}.',
          expects: 'A JSON body {email, password} at POST /api/auth/login.'
        }
      ]
    }
  ]
};

/** A room with a lead and one peer, nothing claimed, no plan yet. */
export async function twoAgentRoom(): Promise<{
  service: RoomService;
  claude: string;
  cursor: string;
  claudeToken: string;
  cursorToken: string;
  supervisorToken: string;
}> {
  const service = await openRoom({
    file: null,
    name: 'Auth page',
    goal: 'Ship a working auth page.'
  });
  const lead = await service.addAgent(OWNER_ID, {
    id: 'claude',
    displayName: 'Claude',
    provider: 'claude-code',
    role: 'lead'
  });
  const peer = await service.addAgent(OWNER_ID, {
    id: 'cursor',
    displayName: 'Cursor',
    provider: 'cursor',
    role: 'peer'
  });
  const supervisorToken = await service.createSupervisorToken(OWNER_ID, 'test');
  return {
    service,
    claude: lead.agent.id,
    cursor: peer.agent.id,
    claudeToken: lead.token,
    cursorToken: peer.token,
    supervisorToken
  };
}

/** Gets the room to the point where both lanes are claimable. */
export async function roomWithApprovedPlan(): Promise<
  Awaited<ReturnType<typeof twoAgentRoom>> & { ui: string; api: string; seamId: string }
> {
  const room = await twoAgentRoom();
  await room.service.claimTask(room.claude, { taskId: 'plan' });
  await room.service.submitWork(room.claude, {
    taskId: 'plan',
    summary: 'Two lanes, one HTTP seam.',
    outcome: 'needs-review',
    plan: AUTH_PAGE_PLAN
  });
  await room.service.approvePlan(OWNER_ID, 'Looks right.');
  const snapshot = room.service.snapshot();
  const ui = snapshot.tasks.find((task) => task.title === 'Auth page UI');
  const api = snapshot.tasks.find((task) => task.title === 'Auth API route');
  const seam = snapshot.decisions.find((decision) => decision.kind === 'seam');
  if (ui === undefined || api === undefined || seam === undefined) {
    throw new Error('The approved plan did not materialize as expected.');
  }
  return { ...room, ui: ui.id, api: api.id, seamId: seam.id };
}

/** Asserts the call is refused with a specific code, and hands back the error. */
export async function refusal(
  run: () => Promise<unknown>,
  code: AgoraErrorCode
): Promise<{ code: AgoraErrorCode; message: string; remedy: string; details: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    if (!isAgoraError(error)) throw error;
    if (error.code !== code) {
      throw new Error(`Expected ${code}, got ${error.code}: ${error.message}`);
    }
    return { code: error.code, message: error.message, remedy: error.remedy, details: error.details };
  }
  throw new Error(`Expected the call to be refused with ${code}, but it succeeded.`);
}
