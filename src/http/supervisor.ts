import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgoraError } from '../errors.ts';
import type { RoomService } from '../room/service.ts';
import { mergeActions } from '../room/rights.ts';
import type { LedgerColumn } from '../room/ledger.ts';
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
  /** The person this token acts as. Every write below is attributed to them (Q16). */
  by: string,
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

  // The attention queue (Q8). Answering from here is the fallback for when the
  // notification the design wants — one that is answerable where it arrives —
  // is not wired up in this deployment.
  if (method === 'GET' && path === '/api/attention') {
    sendJson(res, 200, service.attentionFor(url.searchParams.get('human') ?? by));
    return true;
  }

  // Who is in the room, and what each of them may do (Q7, Q16).
  if (method === 'GET' && path === '/api/humans') {
    sendJson(res, 200, { you: by, humans: service.humans(), mergeActions: mergeActions() });
    return true;
  }

  // Every lane on one screen (Q19).
  if (method === 'GET' && path === '/api/ledger') {
    const column = url.searchParams.get('sort');
    sendJson(res, 200, {
      rows: service.ledger({
        column: (column ?? 'health') as LedgerColumn,
        direction: url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
      }),
      cost: service.costFor(null)
    });
    return true;
  }

  // Repetitive work as a grid (Q19).
  if (method === 'GET' && path === '/api/sweeps') {
    sendJson(res, 200, { sweeps: service.sweeps() });
    return true;
  }

  // Can this room close, and what is in the way (Q24)?
  if (method === 'GET' && path === '/api/close') {
    const landed = (url.searchParams.get('landed') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    sendJson(res, 200, service.closeReadiness(landed));
    return true;
  }

  if (method === 'GET' && path === '/api/archive') {
    sendJson(res, 200, service.archive());
    return true;
  }

  // Why is this the way it is (Q26).
  if (method === 'GET' && path === '/api/why') {
    const file = url.searchParams.get('file');
    const lane = url.searchParams.get('lane');
    const contract = url.searchParams.get('contract');
    if (file !== null) sendJson(res, 200, service.provenance({ kind: 'file', path: file }));
    else if (lane !== null) sendJson(res, 200, service.provenance({ kind: 'lane', laneId: lane }));
    else if (contract !== null) {
      sendJson(res, 200, service.provenance({ kind: 'contract', seamId: contract }));
    } else {
      throw new AgoraError(
        'INVALID',
        'Ask about one thing.',
        'Pass ?file=, ?lane= or ?contract=.'
      );
    }
    return true;
  }

  if (method === 'GET' && path === '/api/events') {
    streamEvents(service, req, res, Number(url.searchParams.get('since') ?? '0'));
    return true;
  }

  if (method !== 'POST') return false;

  const body = asRecord(await readJsonBody(req));

  if (path === '/api/goal') {
    sendJson(res, 200, await service.setGoal(by, requireString(body, 'goal')));
    return true;
  }

  if (path === '/api/plan/approve') {
    sendJson(res, 200, await service.approvePlan(by, optionalString(body, 'note') ?? null));
    return true;
  }

  if (path === '/api/plan/reject') {
    sendJson(res, 200, await service.rejectPlan(by, requireString(body, 'note')));
    return true;
  }

  const seamMatch = /^\/api\/seams\/([^/]+)\/amend$/.exec(path);
  if (seamMatch !== null) {
    sendJson(res, 200, await service.amendSeam(by, decodeURIComponent(seamMatch[1] as string), {
      body: requireString(body, 'body'),
      note: optionalString(body, 'note')
    }));
    return true;
  }

  const editMatch = /^\/api\/tasks\/([^/]+)\/edit$/.exec(path);
  if (editMatch !== null) {
    const edits: Parameters<RoomService['editPlannedLane']>[2] = {};
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
    sendJson(res, 200, await service.editPlannedLane(by, decodeURIComponent(editMatch[1] as string), edits));
    return true;
  }

  if (path === '/api/decisions') {
    sendJson(res, 200, await service.recordDecision(by, {
      title: requireString(body, 'title'),
      body: requireString(body, 'body')
    }));
    return true;
  }

  if (path === '/api/agents') {
    const role = optionalString(body, 'role') === 'lead' ? 'lead' : 'peer';
    const created = await service.addAgent(by, {
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
      sendJson(res, 200, await service.pauseAgent(by, agentId, optionalString(body, 'reason') ?? 'paused by the human'));
    } else if (action === 'resume') {
      sendJson(res, 200, await service.resumeAgent(by, agentId));
    } else {
      const scope: { readPaths?: string[]; writeTasks?: string[] } = {};
      const readPaths = optionalStringArray(body, 'readPaths');
      const writeTasks = optionalStringArray(body, 'writeTasks');
      if (readPaths !== undefined) scope.readPaths = readPaths;
      if (writeTasks !== undefined) scope.writeTasks = writeTasks;
      sendJson(res, 200, await service.setAgentScope(by, agentId, scope));
    }
    return true;
  }

  if (path === '/api/humans') {
    sendJson(res, 200, await service.addHuman(by, {
      id: requireString(body, 'id'),
      displayName: requireString(body, 'displayName'),
      canMerge: body.canMerge === true
    }));
    return true;
  }

  if (path === '/api/close') {
    sendJson(res, 200, await service.closeRoom(by, {
      landed: optionalStringArray(body, 'landed') ?? [],
      note: optionalString(body, 'note'),
      force: body.force === true
    }));
    return true;
  }

  if (path === '/api/risks') {
    const rules = Array.isArray(body.rules) ? body.rules : [];
    sendJson(res, 200, await service.setRiskList(by, 
      rules.map((raw) => {
        const rule = asRecord(raw);
        return {
          id: requireString(rule, 'id'),
          label: requireString(rule, 'label'),
          paths: optionalStringArray(rule, 'paths') ?? [],
          why: optionalString(rule, 'why') ?? ''
        };
      })
    ));
    return true;
  }

  const answerMatch = /^\/api\/attention\/([^/]+)\/answer$/.exec(path);
  if (answerMatch !== null) {
    sendJson(res, 200, await service.answerAttention(by, {
      itemId: decodeURIComponent(answerMatch[1] as string),
      optionId: requireString(body, 'option'),
      note: optionalString(body, 'note')
    }));
    return true;
  }

  const takeMatch = /^\/api\/attention\/([^/]+)\/take$/.exec(path);
  if (takeMatch !== null) {
    sendJson(res, 200, await service.takeAttention(by, {
      itemId: decodeURIComponent(takeMatch[1] as string),
      because: optionalString(body, 'because')
    }));
    return true;
  }

  const ownerMatch = /^\/api\/tasks\/([^/]+)\/owner$/.exec(path);
  if (ownerMatch !== null) {
    sendJson(res, 200, await service.assignLaneOwner(
      by,
      decodeURIComponent(ownerMatch[1] as string),
      optionalString(body, 'human') ?? null
    ));
    return true;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)\/(assign|accept|reopen|budget|message)$/.exec(path);
  if (taskMatch !== null) {
    const taskId = decodeURIComponent(taskMatch[1] as string);
    const action = taskMatch[2] as string;
    if (action === 'assign') {
      sendJson(res, 200, await service.assignTask(by, taskId, requireString(body, 'agentId')));
    } else if (action === 'accept') {
      sendJson(res, 200, await service.acceptTask(by, taskId));
    } else if (action === 'reopen') {
      sendJson(res, 200, await service.reopenTask(by, taskId, body.keepOwner === true));
    } else if (action === 'budget') {
      const budget = body.actionBudget;
      if (typeof budget !== 'number') {
        throw new AgoraError('INVALID', '"actionBudget" is required.', 'Pass a whole number.');
      }
      sendJson(res, 200, await service.setTaskBudget(by, taskId, budget));
    } else {
      const kind = optionalString(body, 'kind');
      sendJson(res, 200, await service.postAsHuman(by, {
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
