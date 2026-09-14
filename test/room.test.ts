import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTH_PAGE_PLAN, refusal, roomWithApprovedPlan, twoAgentRoom } from './helpers.ts';

describe('the plan', () => {
  it('only the lead proposes it', async () => {
    const room = await twoAgentRoom();
    const error = await refusal(() => room.service.claimTask(room.cursor, { taskId: 'plan' }), 'NOT_LEAD');
    assert.equal(error.details.lead, room.claude);
    assert.match(error.remedy, new RegExp(room.claude));
  });

  it('holds every task closed until the human approves', async () => {
    const room = await twoAgentRoom();
    await room.service.claimTask(room.claude, { taskId: 'plan' });
    await room.service.submitWork(room.claude, {
      taskId: 'plan',
      summary: 'Two lanes, one HTTP seam.',
      outcome: 'needs-review',
      plan: AUTH_PAGE_PLAN
    });

    const proposed = room.service.snapshot();
    assert.equal(proposed.plan.status, 'proposed');
    assert.equal(proposed.tasks.filter((task) => task.status === 'draft').length, 2);

    const ui = proposed.tasks.find((task) => task.title === 'Auth page UI');
    assert.ok(ui);
    await refusal(() => room.service.claimTask(room.cursor, { taskId: ui.id }), 'PLAN_NOT_APPROVED');

    await room.service.approvePlan();
    const approved = room.service.snapshot();
    assert.equal(approved.plan.status, 'approved');
    assert.equal(approved.tasks.filter((task) => task.status === 'open').length, 2);
  });

  it('records the seam as a room-wide decision both sides can read', async () => {
    const room = await roomWithApprovedPlan();
    const view = await room.service.readRoom(room.cursor, {});
    const seam = view.decisions.find((decision) => decision.id === room.seamId);

    assert.ok(seam?.seam);
    assert.deepEqual([...seam.seam.betweenTasks].sort(), [room.api, room.ui].sort());
    assert.equal(seam.seam.contract.length, 2);
    // The lane that did not propose it still sees what it must build toward.
    assert.match(seam.body, /POST \/api\/auth\/login|\{email, password\}/);
  });

  it('refuses a seam that names a task outside the proposal', async () => {
    const room = await twoAgentRoom();
    await room.service.claimTask(room.claude, { taskId: 'plan' });
    await refusal(
      () =>
        room.service.submitWork(room.claude, {
          taskId: 'plan',
          summary: 'Bad seam.',
          outcome: 'needs-review',
          plan: {
            ...AUTH_PAGE_PLAN,
            seams: [{ ...AUTH_PAGE_PLAN.seams[0]!, between: ['ui', 'nope'] }]
          }
        }),
      'INVALID'
    );
  });

  it('replaces the previous split when the human rejects and the lead re-proposes', async () => {
    const room = await twoAgentRoom();
    await room.service.claimTask(room.claude, { taskId: 'plan' });
    await room.service.submitWork(room.claude, {
      taskId: 'plan',
      summary: 'First attempt.',
      outcome: 'needs-review',
      plan: AUTH_PAGE_PLAN
    });
    await room.service.rejectPlan('Split the session store out too.');

    await room.service.submitWork(room.claude, {
      taskId: 'plan',
      summary: 'Second attempt.',
      outcome: 'needs-review',
      plan: {
        ...AUTH_PAGE_PLAN,
        tasks: [...AUTH_PAGE_PLAN.tasks, { key: 'store', title: 'Session store', paths: ['src/auth/store.ts'] }]
      }
    });

    const snapshot = room.service.snapshot();
    assert.equal(snapshot.plan.revision, 2);
    assert.equal(snapshot.tasks.filter((task) => task.id !== 'plan').length, 3);
    assert.equal(snapshot.decisions.filter((decision) => decision.kind === 'seam').length, 1);
  });

  it('will not let the lead rewrite a split others have already built on', async () => {
    const room = await roomWithApprovedPlan();
    await refusal(
      () =>
        room.service.submitWork(room.claude, {
          taskId: 'plan',
          summary: 'Rethinking this.',
          outcome: 'needs-review',
          plan: AUTH_PAGE_PLAN
        }),
      'INVALID'
    );
  });
});

describe('ownership', () => {
  it('gives a task exactly one owner and tells the loser who to ask', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });

    const error = await refusal(() => room.service.claimTask(room.cursor, { taskId: room.ui }), 'TASK_OWNED');
    assert.equal(error.details.owner, room.claude);
    assert.match(error.remedy, /post_message/);
  });

  it('is idempotent for the agent that already owns it', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const again = await room.service.claimTask(room.claude, { taskId: room.ui });
    assert.match(again.message, /already own/);
  });

  it('refuses work on files another task owns, and names that task', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });

    const error = await refusal(
      () =>
        room.service.submitWork(room.claude, {
          taskId: room.ui,
          summary: 'Built the form and, while I was there, the endpoint.',
          outcome: 'complete',
          filesChanged: ['src/auth/AuthPage.tsx', 'src/auth/api.ts']
        }),
      'OUT_OF_SCOPE'
    );
    assert.deepEqual(error.details.outside, ['src/auth/api.ts']);
    assert.match(error.remedy, /cursor/);
  });

  it('lets the human move a task from one agent to another', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const moved = await room.service.assignTask(room.ui, room.cursor);

    assert.equal(moved.owner, room.cursor);
    assert.equal(moved.status, 'claimed');
    const view = await room.service.readRoom(room.claude, {});
    assert.ok(!view.you.ownedTasks.includes(room.ui));
  });

  it('honours a narrowed permission scope', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.setAgentScope(room.cursor, { writeTasks: [room.api] });

    await refusal(() => room.service.claimTask(room.cursor, { taskId: room.ui }), 'OUT_OF_SCOPE');
    const claimed = await room.service.claimTask(room.cursor, { taskId: room.api });
    assert.equal(claimed.task.owner, room.cursor);
  });
});

describe('the seam', () => {
  it('will not accept "complete" while a seam is unconfirmed', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });

    const error = await refusal(
      () =>
        room.service.submitWork(room.claude, {
          taskId: room.ui,
          summary: 'Form done.',
          outcome: 'complete',
          filesChanged: ['src/auth/AuthPage.tsx']
        }),
      'INVALID'
    );
    assert.deepEqual(error.details.missing, [room.seamId]);
  });

  it('will not accept "complete" when a seam is confirmed unsatisfied', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });

    const error = await refusal(
      () =>
        room.service.submitWork(room.claude, {
          taskId: room.ui,
          summary: 'Form done, but I changed the response shape.',
          outcome: 'complete',
          filesChanged: ['src/auth/AuthPage.tsx'],
          seamChecks: [{ decisionId: room.seamId, satisfied: false, note: 'I return {user} now.' }]
        }),
      'INVALID'
    );
    assert.match(error.remedy, /needs-review|blocked/);
  });

  it('accepts the work when both sides hold the contract', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const result = await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Form posts email and password and handles 401.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Posts {email, password}.' }]
    });

    assert.equal(result.task.status, 'submitted');
    const accepted = await room.service.acceptTask(room.ui);
    assert.equal(accepted.status, 'accepted');
  });

  it('wakes the agent on the other side of the seam when work lands', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.claimTask(room.cursor, { taskId: room.api });

    const woken: string[][] = [];
    room.service.events().subscribe((event) => {
      if (event.type === 'task.submitted') woken.push(event.audience);
    });

    await room.service.submitWork(room.claude, {
      taskId: room.ui,
      summary: 'Form done.',
      outcome: 'complete',
      filesChanged: ['src/auth/AuthPage.tsx'],
      seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Contract held.' }]
    });

    assert.equal(woken.length, 1);
    assert.ok(woken[0]?.includes(room.cursor), 'the other side of the seam should be woken');
  });
});

describe('messages and budgets', () => {
  it('charges every message to its task and stops when the budget is gone', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(room.ui, 2);

    const first = await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: [room.cursor],
      kind: 'ask',
      body: 'Does the endpoint return a token or a cookie?'
    });
    assert.equal(first.budgetRemaining, 1);

    await room.service.postMessage(room.cursor, {
      taskId: room.ui,
      threadId: first.threadId,
      kind: 'answer',
      body: 'A token in the JSON body.'
    });

    const error = await refusal(
      () =>
        room.service.postMessage(room.claude, {
          taskId: room.ui,
          threadId: first.threadId,
          kind: 'ask',
          body: 'And the expiry?'
        }),
      'BUDGET_EXHAUSTED'
    );
    assert.match(error.remedy, /human/);

    const halted = room.service.snapshot().tasks.find((task) => task.id === room.ui);
    assert.notEqual(halted?.budgetHaltedAt, null);
    assert.ok(room.service.supervisorView().attention.some((item) => item.includes('budget')));
  });

  it('lets the human raise the budget and the work continue', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    await room.service.setTaskBudget(room.ui, 1);
    await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: [room.cursor],
      kind: 'ask',
      body: 'Token or cookie?'
    });
    await refusal(
      () => room.service.postMessage(room.claude, { taskId: room.ui, to: [room.cursor], kind: 'ask', body: 'Ping?' }),
      'BUDGET_EXHAUSTED'
    );

    await room.service.setTaskBudget(room.ui, 5);
    const resumed = await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: [room.cursor],
      kind: 'ask',
      body: 'Expiry?'
    });
    assert.equal(resumed.budgetRemaining, 3);
    assert.equal(room.service.snapshot().tasks.find((task) => task.id === room.ui)?.budgetHaltedAt, null);
  });

  it('refuses a message with no task to attach to', async () => {
    const room = await roomWithApprovedPlan();
    await refusal(
      () => room.service.postMessage(room.claude, { taskId: 'nope', to: [room.cursor], kind: 'ask', body: 'Hi.' }),
      'NOT_FOUND'
    );
  });

  it('refuses a wall of reasoning and points at the human-only channel', async () => {
    const room = await roomWithApprovedPlan();
    const error = await refusal(
      () =>
        room.service.postMessage(room.claude, {
          taskId: room.ui,
          to: [room.cursor],
          kind: 'fyi',
          body: 'x'.repeat(2500)
        }),
      'INVALID'
    );
    assert.match(error.remedy, /status_note/);
  });

  it('reuses one thread per task and participant set', async () => {
    const room = await roomWithApprovedPlan();
    const first = await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: [room.cursor],
      kind: 'ask',
      body: 'Shape of the error body?'
    });
    const second = await room.service.postMessage(room.cursor, {
      taskId: room.ui,
      to: [room.claude],
      kind: 'answer',
      body: '{ok:false, error}.'
    });
    assert.equal(first.threadId, second.threadId);
  });

  it('lets an agent address the human, and the human answer without spending budget', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, { taskId: room.ui });
    const asked = await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: ['human'],
      kind: 'ask',
      body: 'Should the form remember the email?'
    });
    assert.deepEqual(asked.delivered, ['human']);
    assert.ok(room.service.supervisorView().attention.some((item) => item.includes('asked you')));

    const before = room.service.snapshot().tasks.find((task) => task.id === room.ui)?.messagesUsed;
    await room.service.postAsHuman({ taskId: room.ui, threadId: asked.threadId, body: 'Yes, remember it.' });
    const after = room.service.snapshot().tasks.find((task) => task.id === room.ui)?.messagesUsed;
    assert.equal(before, after);
  });
});

describe('visibility', () => {
  it('keeps a thread to the agents in it', async () => {
    const room = await roomWithApprovedPlan();
    const third = await room.service.addAgent({ id: 'codex', displayName: 'Codex', provider: 'codex', role: 'peer' });
    await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: [room.cursor],
      kind: 'ask',
      body: 'Token or cookie?'
    });

    const outsider = await room.service.readRoom(third.agent.id, {});
    assert.deepEqual(outsider.threads, []);

    const participant = await room.service.readRoom(room.cursor, {});
    assert.equal(participant.threads.length, 1);
    assert.equal(participant.threads[0]?.messages[0]?.body, 'Token or cookie?');

    // The whole room still sees the decisions, so a late joiner can catch up.
    assert.equal(outsider.decisions.length, room.service.snapshot().decisions.length);
  });

  it('never shows one agent another agent\'s reasoning', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.claude, {
      taskId: room.ui,
      statusNote: 'Weighing a controlled input against a form action.'
    });

    const peerView = await room.service.readRoom(room.cursor, {});
    const serialized = JSON.stringify(peerView);
    assert.ok(!serialized.includes('Weighing a controlled input'), 'reasoning leaked to another agent');
    assert.ok(!peerView.agents.some((agent) => 'status' in agent));

    // The human sees it.
    const supervisor = room.service.supervisorView();
    const claude = supervisor.room.agents.find((agent) => agent.id === room.claude);
    assert.equal(claude?.status.note, 'Weighing a controlled input against a form action.');
  });

  it('gives a late joiner the decisions without the chat history', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.postMessage(room.claude, {
      taskId: room.ui,
      to: [room.cursor],
      kind: 'ask',
      body: 'Chatter the newcomer does not need.'
    });
    const late = await room.service.addAgent({ id: 'codex', displayName: 'Codex', provider: 'codex', role: 'peer' });

    const view = await room.service.readRoom(late.agent.id, {});
    assert.equal(view.threads.length, 0);
    assert.ok(view.decisions.some((decision) => decision.kind === 'seam'));
    assert.equal(view.room.goal, 'Ship a working auth page.');
  });
});

describe('human controls', () => {
  it('stops a paused agent doing anything', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.pauseAgent(room.claude, 'Hold on, I want to look at this.');

    const error = await refusal(() => room.service.claimTask(room.claude, { taskId: room.ui }), 'AGENT_PAUSED');
    assert.match(error.message, /Hold on/);
    await refusal(
      () => room.service.postMessage(room.claude, { taskId: room.ui, to: [room.cursor], kind: 'ask', body: 'Hi.' }),
      'AGENT_PAUSED'
    );

    // Reading the room still works, so the agent can see it has been paused.
    const view = await room.service.readRoom(room.claude, {});
    assert.equal(view.you.paused, true);
    assert.match(view.guidance.join(' '), /paused/);

    await room.service.resumeAgent(room.claude);
    const claimed = await room.service.claimTask(room.claude, { taskId: room.ui });
    assert.equal(claimed.task.owner, room.claude);
  });

  it('surfaces a blocked task to the human', async () => {
    const room = await roomWithApprovedPlan();
    await room.service.claimTask(room.cursor, { taskId: room.api });
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'No session secret in the environment.',
      outcome: 'blocked',
      filesChanged: ['src/auth/api.ts']
    });

    const supervisor = room.service.supervisorView();
    assert.ok(supervisor.attention.some((item) => item.includes('blocked')));
    assert.equal(supervisor.room.tasks.find((task) => task.id === room.api)?.status, 'blocked');
  });

  it('mints one token per agent and authenticates it', async () => {
    const room = await twoAgentRoom();
    assert.equal(room.service.authenticate(room.claudeToken)?.agentId, room.claude);
    assert.equal(room.service.authenticate(room.cursorToken)?.agentId, room.cursor);
    assert.equal(room.service.authenticate(room.supervisorToken)?.kind, 'supervisor');
    assert.equal(room.service.authenticate('mkt_not-a-token'), null);
    assert.equal(room.service.authenticate(''), null);
  });

  it('keeps a room to one lead', async () => {
    const room = await twoAgentRoom();
    await refusal(
      () => room.service.addAgent({ displayName: 'Codex', provider: 'codex', role: 'lead' }),
      'INVALID'
    );
  });
});

describe('the room as an agent sees it', () => {
  it('tells a new agent exactly what it can do next', async () => {
    const room = await twoAgentRoom();
    const lead = await room.service.readRoom(room.claude, {});
    assert.match(lead.guidance.join(' '), /Claim "plan"/);

    const approved = await roomWithApprovedPlan();
    const peer = await approved.service.readRoom(approved.cursor, {});
    assert.deepEqual(peer.you.claimableTasks.sort(), [approved.api, approved.ui].sort());
    assert.match(peer.guidance.join(' '), /Claimable now/);
  });

  it('returns only events newer than the cursor the agent holds', async () => {
    const room = await roomWithApprovedPlan();
    const first = await room.service.readRoom(room.cursor, {});
    const cursorSeq = first.room.eventSeq;

    await room.service.claimTask(room.claude, { taskId: room.ui });
    const second = await room.service.readRoom(room.cursor, { sinceSeq: cursorSeq });

    assert.ok(second.events.length > 0);
    assert.ok(second.events.every((event) => event.seq > cursorSeq));
    assert.ok(second.events.some((event) => event.type === 'task.claimed'));
  });
});
