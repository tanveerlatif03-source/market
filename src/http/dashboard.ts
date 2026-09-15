/**
 * The human's window on the room: live status, the plan waiting for one tap,
 * and the pause button. Served as one self-contained page — no build step, no
 * CDN, nothing to install.
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Market</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1016; --panel: #151a23; --line: #242c39; --ink: #e6ebf2;
    --muted: #8b97a8; --accent: #7cc4ff; --warn: #ffcf6b; --bad: #ff8b7a; --good: #7fe0a8;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 20px 16px 64px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .09em;
       color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  a { color: var(--accent); }
  .panel { background: var(--panel); border: 1px solid var(--line);
           border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
  @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .between { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .muted { color: var(--muted); }
  .mono { font-family: var(--mono); font-size: 12.5px; }
  .pill { font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 999px;
          border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .pill.open { color: var(--accent); border-color: #2b4b66; }
  .pill.claimed { color: var(--warn); border-color: #5a4820; }
  .pill.submitted, .pill.proposed { color: var(--warn); border-color: #5a4820; }
  .pill.accepted, .pill.approved { color: var(--good); border-color: #23503a; }
  .pill.blocked, .pill.rejected, .pill.paused { color: var(--bad); border-color: #5e2f2a; }
  button { font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 7px;
           border: 1px solid var(--line); background: #1d2431; color: var(--ink); cursor: pointer; }
  button:hover { border-color: #38445a; }
  button.primary { background: #1d4e73; border-color: #2f6d99; }
  button.danger { background: #52302c; border-color: #7b463f; }
  input, textarea { font: inherit; background: #10151d; color: var(--ink);
                    border: 1px solid var(--line); border-radius: 7px; padding: 6px 9px; width: 100%; }
  .item { border-top: 1px solid var(--line); padding: 11px 0; }
  .item:first-of-type { border-top: 0; }
  .bar { height: 4px; background: #10151d; border-radius: 3px; overflow: hidden; max-width: 190px; flex: 1; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .bar.full > i { background: var(--bad); }
  .feed { max-height: 340px; overflow: auto; font-family: var(--mono); font-size: 12.5px; }
  .feed div { padding: 3px 0; border-bottom: 1px solid #1a212c; }
  .seam { border-left: 2px solid var(--accent); padding-left: 10px; }
  .note { background: #10151d; border-radius: 6px; padding: 6px 9px; margin-top: 6px;
          font-family: var(--mono); font-size: 12px; color: var(--warn); }
  .attention { border-color: #5a4820; }
  .attention li { margin: 3px 0; }
  .gate { max-width: 420px; margin: 15vh auto; }
  .hide { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <div id="gate" class="gate panel">
    <h2>Market</h2>
    <p class="muted">Paste the supervisor token to watch the room.</p>
    <input id="token" type="password" placeholder="mkt_..." autocomplete="off" />
    <p><button class="primary" id="enter">Watch</button> <span id="gate-err" class="muted"></span></p>
  </div>

  <main id="app" class="hide">
    <div class="between" style="margin-bottom:14px">
      <div>
        <h1 id="room-name"></h1>
        <div class="muted" id="room-goal"></div>
      </div>
      <div class="row">
        <span id="plan-pill" class="pill"></span>
        <button id="sign-out">Sign out</button>
      </div>
    </div>

    <div id="attention" class="panel attention hide">
      <h2>Needs you</h2>
      <ul id="attention-list" style="margin:0;padding-left:18px"></ul>
      <div id="plan-actions" class="row hide" style="margin-top:10px">
        <button class="primary" id="approve">Approve the plan</button>
        <button class="danger" id="reject">Reject</button>
      </div>
    </div>

    <div class="grid">
      <section class="panel">
        <h2>Agents</h2>
        <div id="agents"></div>
      </section>
      <section class="panel">
        <h2>Live</h2>
        <div class="feed" id="feed"></div>
      </section>
    </div>

    <section class="panel">
      <h2>Task board</h2>
      <div id="tasks"></div>
    </section>

    <section class="panel">
      <h2>Decisions and seams</h2>
      <div id="decisions"></div>
    </section>

    <section class="panel">
      <h2>Threads</h2>
      <div id="threads"></div>
    </section>
  </main>
</div>

<script>
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (id) => document.getElementById(id);
let token = sessionStorage.getItem('market-token') || '';
let stream = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || res.statusText);
  return data;
}

function bar(used, budget) {
  const pct = budget === 0 ? 100 : Math.min(100, Math.round((used / budget) * 100));
  return '<span class="bar' + (used >= budget ? ' full' : '') + '"><i style="width:' + pct + '%"></i></span>' +
         '<span class="muted mono">' + used + '/' + budget + '</span>';
}

function renderAgents(room) {
  el('agents').innerHTML = room.agents.map((agent) => {
    const status = agent.status || {};
    return '<div class="item">' +
      '<div class="between"><div><b>' + esc(agent.displayName) + '</b> ' +
      '<span class="muted mono">' + esc(agent.id) + ' · ' + esc(agent.provider) + ' · ' + esc(agent.role) + '</span></div>' +
      '<div class="row">' +
      '<span class="pill ' + (agent.paused ? 'paused' : '') + '">' + (agent.paused ? 'paused' : esc(status.state || 'idle')) + '</span>' +
      (agent.paused
        ? '<button data-resume="' + esc(agent.id) + '">Resume</button>'
        : '<button class="danger" data-pause="' + esc(agent.id) + '">Pause</button>') +
      '</div></div>' +
      (status.note ? '<div class="note">' + esc(status.note) + '</div>' : '') +
      (agent.pausedReason ? '<div class="muted mono">' + esc(agent.pausedReason) + '</div>' : '') +
      '<div class="muted mono">scope: ' + esc((agent.scope?.writeTasks || []).join(', ')) + '</div>' +
    '</div>';
  }).join('') || '<div class="muted">No agents yet. Mint a token with <code>market agent add</code>.</div>';
}

function renderTasks(room) {
  const agentOptions = room.agents.map((a) => '<option value="' + esc(a.id) + '">' + esc(a.displayName) + '</option>').join('');
  el('tasks').innerHTML = room.tasks.map((task) => {
    const seams = task.seams.length ? '<span class="muted mono"> · ' + task.seams.length + ' seam(s)</span>' : '';
    return '<div class="item">' +
      '<div class="between">' +
      '<div><b class="mono">' + esc(task.id) + '</b> — ' + esc(task.title) + seams +
      '<div class="muted mono">' + esc(task.paths.join(', ') || 'no declared paths') + '</div>' +
      '<div class="muted">owner: ' + esc(task.owner || (task.suggestedOwner ? task.suggestedOwner + ' (suggested)' : 'unclaimed')) + '</div>' +
      (task.blockedReason ? '<div class="note">' + esc(task.blockedReason) + '</div>' : '') +
      '</div>' +
      '<div class="row"><span class="pill ' + esc(task.status) + '">' + esc(task.status) + '</span></div>' +
      '</div>' +
      '<div class="row" style="margin-top:8px">' + bar(task.messagesUsed, task.messageBudget) +
      '<button data-budget="' + esc(task.id) + '">Raise budget</button>' +
      (task.status === 'submitted' ? '<button class="primary" data-accept="' + esc(task.id) + '">Accept</button>' : '') +
      '<button data-reopen="' + esc(task.id) + '">Reopen</button>' +
      '<select data-assign="' + esc(task.id) + '"><option value="">Reassign to…</option>' + agentOptions + '</select>' +
      '</div>' +
      (task.submissions.length
        ? '<div class="muted mono" style="margin-top:6px">last: ' +
          esc(task.submissions[task.submissions.length - 1].summary) + '</div>'
        : '') +
    '</div>';
  }).join('');
}

function renderDecisions(room) {
  el('decisions').innerHTML = room.decisions.map((decision) => {
    const seam = decision.seam
      ? '<div class="seam mono" style="margin-top:6px">' +
        esc(decision.seam.betweenTasks.join('  ↔  ')) + '<br/>' +
        decision.seam.contract.map((side) =>
          esc(side.taskId) + ' provides: ' + esc(side.provides) + '<br/>' +
          esc(side.taskId) + ' expects: ' + esc(side.expects)).join('<br/>') +
        '</div>'
      : '';
    return '<div class="item"><div class="between"><b>' + esc(decision.title) + '</b>' +
      '<span class="pill">' + esc(decision.kind) + '</span></div>' +
      '<div class="muted" style="white-space:pre-wrap">' + esc(decision.body) + '</div>' + seam +
      '<div class="muted mono">' + esc(decision.id) + '</div></div>';
  }).join('') || '<div class="muted">No decisions yet.</div>';
}

function renderThreads(room) {
  el('threads').innerHTML = room.threads.map((thread) =>
    '<div class="item"><div class="between"><b>' + esc(thread.subject) + '</b>' +
    '<span class="muted mono">' + esc(thread.taskId) + ' · ' + esc(thread.participants.join(', ')) + '</span></div>' +
    thread.messages.map((message) =>
      '<div class="mono" style="margin-top:5px"><span class="muted">' + esc(message.from) +
      ' [' + esc(message.kind) + ']</span> ' + esc(message.body) + '</div>').join('') +
    '<div class="row" style="margin-top:8px"><input data-reply="' + esc(thread.id) +
    '" data-task="' + esc(thread.taskId) + '" placeholder="Answer or redirect…" /></div></div>'
  ).join('') || '<div class="muted">No threads yet.</div>';
}

function pushEvent(event) {
  const feed = el('feed');
  const line = document.createElement('div');
  line.innerHTML = '<span class="muted">' + esc(new Date(event.at).toLocaleTimeString()) + '</span> ' + esc(event.summary);
  feed.prepend(line);
  while (feed.childNodes.length > 200) feed.lastChild.remove();
}

async function refresh() {
  const { room, attention } = await api('/api/room');
  el('room-name').textContent = room.name;
  el('room-goal').textContent = room.goal;
  const pill = el('plan-pill');
  pill.textContent = 'plan: ' + room.plan.status;
  pill.className = 'pill ' + room.plan.status;
  el('attention').classList.toggle('hide', attention.length === 0);
  el('attention-list').innerHTML = attention.map((item) => '<li>' + esc(item) + '</li>').join('');
  el('plan-actions').classList.toggle('hide', room.plan.status !== 'proposed');
  renderAgents(room);
  renderTasks(room);
  renderDecisions(room);
  renderThreads(room);
}

function connect() {
  if (stream) stream.close();
  stream = new EventSource('/api/events?access_token=' + encodeURIComponent(token) + '&since=0');
  stream.onmessage = (message) => { pushEvent(JSON.parse(message.data)); refresh().catch(() => {}); };
}

document.addEventListener('click', async (domEvent) => {
  const target = domEvent.target;
  if (!(target instanceof HTMLElement)) return;
  try {
    if (target.dataset.pause) {
      const reason = prompt('Why pause this agent?', 'holding while I look at this') ?? '';
      await api('/api/agents/' + encodeURIComponent(target.dataset.pause) + '/pause', { reason });
    } else if (target.dataset.resume) {
      await api('/api/agents/' + encodeURIComponent(target.dataset.resume) + '/resume', {});
    } else if (target.dataset.accept) {
      await api('/api/tasks/' + encodeURIComponent(target.dataset.accept) + '/accept', {});
    } else if (target.dataset.reopen) {
      await api('/api/tasks/' + encodeURIComponent(target.dataset.reopen) + '/reopen', {});
    } else if (target.dataset.budget) {
      const value = Number(prompt('New message budget for this task?', '40'));
      if (Number.isFinite(value)) {
        await api('/api/tasks/' + encodeURIComponent(target.dataset.budget) + '/budget', { messageBudget: value });
      }
    } else if (target.id === 'approve') {
      await api('/api/plan/approve', { note: prompt('Note for the room (optional)?', '') || null });
    } else if (target.id === 'reject') {
      const note = prompt('What needs to change?');
      if (note) await api('/api/plan/reject', { note });
    } else {
      return;
    }
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

document.addEventListener('change', async (domEvent) => {
  const target = domEvent.target;
  if (!(target instanceof HTMLSelectElement) || !target.dataset.assign || target.value === '') return;
  try {
    await api('/api/tasks/' + encodeURIComponent(target.dataset.assign) + '/assign', { agentId: target.value });
    await refresh();
  } catch (error) { alert(error.message); }
});

document.addEventListener('keydown', async (domEvent) => {
  const target = domEvent.target;
  if (domEvent.key !== 'Enter' || !(target instanceof HTMLInputElement) || !target.dataset.reply) return;
  const body = target.value.trim();
  if (body === '') return;
  try {
    await api('/api/tasks/' + encodeURIComponent(target.dataset.task) + '/message',
      { threadId: target.dataset.reply, body, kind: 'answer' });
    target.value = '';
    await refresh();
  } catch (error) { alert(error.message); }
});

async function start() {
  try {
    await refresh();
    el('gate').classList.add('hide');
    el('app').classList.remove('hide');
    sessionStorage.setItem('market-token', token);
    connect();
  } catch (error) {
    el('gate-err').textContent = error.message;
    throw error;
  }
}

el('enter').addEventListener('click', () => { token = el('token').value.trim(); start().catch(() => {}); });
el('token').addEventListener('keydown', (event) => { if (event.key === 'Enter') el('enter').click(); });
el('sign-out').addEventListener('click', () => { sessionStorage.removeItem('market-token'); location.reload(); });
if (token) start().catch(() => {});
</script>
</body>
</html>
`;
}
