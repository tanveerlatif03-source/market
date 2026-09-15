import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgoraError } from '../errors.ts';
import type { RoomService } from '../room/service.ts';
import type { MessageKind } from '../types.ts';
import {
  asRecord,
  optionalString,
  optionalStringArray,
  readJsonBody,
  requireString,
  sendJson
} from './util.ts';

const MESSAGE_KINDS = new Set<MessageKind>(['ask', 'answer', 'handoff', 'fyi']);

/**
 * The human's side of the room: watch it, approve the plan, pause an agent,
 * move a task, raise a budget, answer an ask.
 */
export async function handleSupervisorRequest(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/room') {
    sendJson(res, 200, service.supervisorView());
    return true;
  }

  if (method === 'GET' && path === '/api/events') {
    streamEvents(service, req, res, Number(url.searchParams.get('since') ?? '0'));
    return true;
  }

  if (method !== 'POST') return false;

  const body = asRecord(await readJsonBody(req));

  if (path === '/api/goal') {
    sendJson(res, 200, await service.setGoal(requireString(body, 'goal')));
    return true;
  }

  if (path === '/api/plan/approve') {
    sendJson(res, 200, await service.approvePlan(optionalString(body, 'note') ?? null));
    return true;
  }

  if (path === '/api/plan/reject') {
    sendJson(res, 200, await service.rejectPlan(requireString(body, 'note')));
    return true;
  }

  const seamMatch = /^\/api\/seams\/([^/]+)\/amend$/.exec(path);
  if (seamMatch !== null) {
    sendJson(res, 200, await service.amendSeam(decodeURIComponent(seamMatch[1] as string), {
      body: requireString(body, 'body'),
      note: optionalString(body, 'note')
    }));
    return true;
  }

  const editMatch = /^\/api\/tasks\/([^/]+)\/edit$/.exec(path);
  if (editMatch !== null) {
    const edits: Parameters<RoomService['editPlannedLane']>[1] = {};
    const title = optionalString(body, 'title');
    const description = optionalString(body, 'description');
    const paths = optionalStringArray(body, 'paths');
    const evidence = optionalString(body, 'evidence');
    if (title !== undefined) edits.title = title;
    if (description !== undefined) edits.description = description;
    if (paths !== undefined) edits.paths = paths;
    if (evidence !== undefined) edits.evidence = evidence;
    if (typeof body.actionBudget === 'number') edits.actionBudget = body.actionBudget;
    if ('suggestedOwner' in body) edits.suggestedOwner = optionalString(body, 'suggestedOwner') ?? null;
    sendJson(res, 200, await service.editPlannedLane(decodeURIComponent(editMatch[1] as string), edits));
    return true;
  }

  if (path === '/api/decisions') {
    sendJson(res, 200, await service.recordDecision({
      title: requireString(body, 'title'),
      body: requireString(body, 'body')
    }));
    return true;
  }

  if (path === '/api/agents') {
    const role = optionalString(body, 'role') === 'lead' ? 'lead' : 'peer';
    const created = await service.addAgent({
      id: optionalString(body, 'id'),
      displayName: requireString(body, 'displayName'),
      provider: optionalString(body, 'provider') ?? 'unknown',
      role,
      scope: {
        readPaths: optionalStringArray(body, 'readPaths') ?? ['**'],
        writeTasks: optionalStringArray(body, 'writeTasks') ?? ['*']
      }
    });
    // The token is shown once, here, and never stored in the clear.
    sendJson(res, 200, created);
    return true;
  }

  const agentMatch = /^\/api\/agents\/([^/]+)\/(pause|resume|scope)$/.exec(path);
  if (agentMatch !== null) {
    const agentId = decodeURIComponent(agentMatch[1] as string);
    const action = agentMatch[2] as string;
    if (action === 'pause') {
      sendJson(res, 200, await service.pauseAgent(agentId, optionalString(body, 'reason') ?? 'paused by the human'));
    } else if (action === 'resume') {
      sendJson(res, 200, await service.resumeAgent(agentId));
    } else {
      const scope: { readPaths?: string[]; writeTasks?: string[] } = {};
      const readPaths = optionalStringArray(body, 'readPaths');
      const writeTasks = optionalStringArray(body, 'writeTasks');
      if (readPaths !== undefined) scope.readPaths = readPaths;
      if (writeTasks !== undefined) scope.writeTasks = writeTasks;
      sendJson(res, 200, await service.setAgentScope(agentId, scope));
    }
    return true;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)\/(assign|accept|reopen|budget|message)$/.exec(path);
  if (taskMatch !== null) {
    const taskId = decodeURIComponent(taskMatch[1] as string);
    const action = taskMatch[2] as string;
    if (action === 'assign') {
      sendJson(res, 200, await service.assignTask(taskId, requireString(body, 'agentId')));
    } else if (action === 'accept') {
      sendJson(res, 200, await service.acceptTask(taskId));
    } else if (action === 'reopen') {
      sendJson(res, 200, await service.reopenTask(taskId, body.keepOwner === true));
    } else if (action === 'budget') {
      const budget = body.actionBudget;
      if (typeof budget !== 'number') {
        throw new AgoraError('INVALID', '"actionBudget" is required.', 'Pass a whole number.');
      }
      sendJson(res, 200, await service.setTaskBudget(taskId, budget));
    } else {
      const kind = optionalString(body, 'kind');
      sendJson(res, 200, await service.postAsHuman({
        taskId,
        to: optionalStringArray(body, 'to'),
        threadId: optionalString(body, 'threadId'),
        subject: optionalString(body, 'subject'),
        body: requireString(body, 'body'),
        kind: kind !== undefined && MESSAGE_KINDS.has(kind as MessageKind) ? (kind as MessageKind) : 'answer'
      }));
    }
    return true;
  }

  return false;
}

/** Live status for the human, as a plain SSE stream. */
function streamEvents(
  service: RoomService,
  req: IncomingMessage,
  res: ServerResponse,
  since: number
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const backlog = service.snapshot().events.filter((event) => event.seq > (Number.isFinite(since) ? since : 0));
  for (const event of backlog) {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = service.events().subscribe((event) => {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  const stop = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', stop);
  res.on('close', stop);
}
