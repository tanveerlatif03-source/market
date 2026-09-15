import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isAgoraError } from '../errors.ts';
import { HUMAN_ID, PLAN_TASK_ID } from '../room/seed.ts';
import type { RoomService } from '../room/service.ts';
import type { RoomEvent } from '../types.ts';

const SERVER_NAME = 'agora';
const SERVER_VERSION = '0.1.0';
const ROOM_RESOURCE_URI = 'agora://room';

/**
 * What every agent is told the moment it joins, whichever tool it is running in.
 * Agora does not translate between agents; it gives them one room and one set
 * of rules.
 */
function instructionsFor(roomName: string, goal: string): string {
  return [
    `You are in the Agora room "${roomName}", working alongside agents from other tools.`,
    `The goal: ${goal}`,
    '',
    'How the room works:',
    `- One agent is lead. It proposes the task split on the "${PLAN_TASK_ID}" task; the human approves it.`,
    '- A task has exactly one owner. Claim, do not merge. Never edit files outside the lane of a task you own — ask the owner in a thread instead.',
    '- The seam — exactly where two pieces touch, what each side provides and expects — is agreed before work starts and stored as a room decision. Build toward it.',
    '- Every message attaches to a task and spends that task\'s message budget. When the budget runs out the task stops and the human is asked.',
    '- Send only the ask and the answer. Your reasoning and live status go to the human through status_note on any tool call, never to another agent.',
    '- Threads are visible to their participants and to the human. Decisions are visible to everyone, including agents that join later.',
    '',
    `Start with read_room. Address the human with the recipient "${HUMAN_ID}".`
  ].join('\n');
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown) {
  const payload = isAgoraError(error)
    ? { error: { code: error.code, message: error.message, remedy: error.remedy, details: error.details } }
    : { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error), remedy: 'Report this to the human.' } };
  return { ...ok(payload), isError: true };
}

async function guard<T>(run: () => Promise<T>) {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error);
  }
}

/** Should this event interrupt that agent's work? */
export function shouldWake(event: RoomEvent, agentId: string): boolean {
  if (event.actor === agentId) return false;
  if (event.type === 'agent.status') return false;
  if (event.audience.length > 0) return event.audience.includes(agentId);
  return (
    event.type === 'plan.approved' ||
    event.type === 'plan.rejected' ||
    event.type === 'plan.proposed' ||
    event.type === 'task.created' ||
    event.type === 'task.claimed' ||
    event.type === 'task.reopened' ||
    event.type === 'decision.recorded'
  );
}

const statusNote = z
  .string()
  .max(1000)
  .optional()
  .describe('Your live status and reasoning. The human reads this; no other agent ever sees it.');

const seamCheckSchema = z.object({
  decisionId: z.string().describe('Id of the seam decision you are confirming.'),
  satisfied: z.boolean().describe('True only if your side matches the agreed contract exactly.'),
  note: z.string().default('').describe('What you built on your side of the seam.')
});

const planSchema = z.object({
  summary: z.string().optional().describe('One paragraph the whole room can read.'),
  tasks: z
    .array(
      z.object({
        key: z.string().describe('A short key for this task, used by the seams below.'),
        title: z.string(),
        description: z.string().optional(),
        paths: z.array(z.string()).describe('The files this task owns. No two tasks may own the same file.'),
        suggestedOwner: z.string().optional().describe('Which agent should take this lane.'),
        messageBudget: z.number().int().positive().optional()
      })
    )
    .min(1),
  seams: z
    .array(
      z.object({
        title: z.string(),
        body: z.string().describe('The fixed point both sides build toward.'),
        between: z.tuple([z.string(), z.string()]).describe('The two task keys whose pieces touch.'),
        contract: z
          .array(
            z.object({
              task: z.string().describe('One of the two task keys.'),
              provides: z.string().describe('What this side hands over.'),
              expects: z.string().describe('What this side expects to receive.')
            })
          )
          .describe('What each side of the seam provides and expects.')
      })
    )
    .describe('Agree a seam for every pair of tasks that touch. Do this before work starts, not after.'),
  decisions: z
    .array(z.object({ title: z.string(), body: z.string() }))
    .optional()
    .describe('Any other room-wide decision the split depends on.')
});

export interface AgentMcpServer {
  server: McpServer;
  dispose: () => void;
}

/**
 * Builds the MCP server one connected agent talks to. Everything it can see or
 * do is already scoped to that agent by RoomService.
 */
export function createAgentMcpServer(service: RoomService, agentId: string): AgentMcpServer {
  const room = service.snapshot();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {}, tools: {}, resources: { subscribe: true } },
      instructions: instructionsFor(room.name, room.goal)
    }
  );

  server.registerTool(
    'read_room',
    {
      title: 'Read the room',
      description:
        'The goal, the decisions, the task board, and the threads you are in. Call this first, and again whenever you are woken.',
      inputSchema: {
        since_seq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only return events newer than this sequence number.'),
        status_note: statusNote
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (args) =>
      guard(() =>
        service.readRoom(agentId, {
          sinceSeq: args.since_seq ?? 0,
          statusNote: args.status_note
        })
      )
  );

  server.registerTool(
    'claim_task',
    {
      title: 'Claim a task',
      description:
        'Take ownership of exactly one task. A task has one owner at a time; if someone already owns it, ask them in a thread instead.',
      inputSchema: {
        task_id: z.string().describe('Task id from the board.'),
        status_note: statusNote
      },
      annotations: { idempotentHint: true, openWorldHint: false }
    },
    async (args) => guard(() => service.claimTask(agentId, { taskId: args.task_id, statusNote: args.status_note }))
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post a message',
      description:
        `Send an ask or an answer to another agent, or to "${HUMAN_ID}". Every message attaches to a task and spends that task's message budget. Send the ask, not the reasoning behind it.`,
      inputSchema: {
        task_id: z.string().describe('The task this message is about.'),
        to: z
          .array(z.string())
          .optional()
          .describe(`Agent ids, or "${HUMAN_ID}". Omit when replying inside an existing thread_id.`),
        thread_id: z.string().optional().describe('Reply inside a thread you are already in.'),
        subject: z.string().optional().describe('Subject for a new thread.'),
        kind: z
          .enum(['ask', 'answer', 'handoff', 'fyi'])
          .describe('Declare what this message is. Only declared messages travel between agents.'),
        body: z.string().min(1).max(2000),
        status_note: statusNote
      },
      annotations: { openWorldHint: false }
    },
    async (args) =>
      guard(() =>
        service.postMessage(agentId, {
          taskId: args.task_id,
          to: args.to,
          threadId: args.thread_id,
          subject: args.subject,
          kind: args.kind,
          body: args.body,
          statusNote: args.status_note
        })
      )
  );

  server.registerTool(
    'submit_work',
    {
      title: 'Submit work',
      description:
        `Hand a task you own back to the room. On "${PLAN_TASK_ID}", pass "plan" to propose the task split and the seams for the human to approve. On any other task, list the files you changed — they must fall inside that task's lane — and confirm every seam it touches.`,
      inputSchema: {
        task_id: z.string(),
        summary: z.string().min(1).describe('What you did, in a few sentences the whole room can read.'),
        outcome: z
          .enum(['complete', 'blocked', 'needs-review'])
          .describe('"complete" requires every seam on this task to be confirmed satisfied.'),
        files_changed: z
          .array(z.string())
          .optional()
          .describe('Repository-relative paths you changed. Anything outside your lane is refused.'),
        seam_checks: z.array(seamCheckSchema).optional().describe('One entry per seam this task touches.'),
        plan: planSchema.optional().describe(`Only on "${PLAN_TASK_ID}": the proposed split and its seams.`),
        status_note: statusNote
      },
      annotations: { openWorldHint: false }
    },
    async (args) =>
      guard(() =>
        service.submitWork(agentId, {
          taskId: args.task_id,
          summary: args.summary,
          outcome: args.outcome,
          filesChanged: args.files_changed,
          seamChecks: args.seam_checks,
          plan: args.plan,
          statusNote: args.status_note
        })
      )
  );

  server.registerResource(
    'room',
    ROOM_RESOURCE_URI,
    {
      title: 'The room',
      description: 'The room as this agent sees it. Subscribe to be woken when it changes.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const view = await service.readRoom(agentId, {});
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }]
      };
    }
  );

  // Live-ness: push into the session instead of making the agent poll.
  const unsubscribe = service.events().subscribe((event) => {
    if (!shouldWake(event, agentId)) return;
    void server.server
      .sendLoggingMessage({
        level: 'info',
        logger: SERVER_NAME,
        data: {
          seq: event.seq,
          type: event.type,
          taskId: event.taskId,
          summary: event.summary,
          hint: 'Call read_room with since_seq to pick this up.'
        }
      })
      .catch(() => undefined);
    void server.server.sendResourceUpdated({ uri: ROOM_RESOURCE_URI }).catch(() => undefined);
  });

  return { server, dispose: unsubscribe };
}
