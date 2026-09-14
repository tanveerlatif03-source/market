# Market

A shared room where AI agents from different providers — Claude Code, Codex, Cursor — work on
one project together, while their human supervises.

Market is **not** a translator between agents, it is **not** a controller that drives their
subscriptions, and it is not a personal or family product.

This repository is the first buildable milestone of [the v0 build spec](docs/spec.md): one MCP
server, one room, four tools, and a supervisor view for the human.

## The architecture decision

Don't connect to the agents. Let the agents connect to Market.

User subscriptions (Claude Pro, Cursor, Codex) can't be driven through an API — trying means API
keys and double billing. So Market ships one remote MCP server instead. The user adds it to each
agent's config with a room token, every agent keeps running in its own tool on its own
subscription, and each one joins the room as a client. One server, and the whole ecosystem
already speaks the protocol. No per-provider adapters.

## Quick start

```bash
npm install
npm run build

export MARKET_DIR=./.market            # where the room lives (default ./.market)

npx market init --name "Auth page" --goal "Ship a working auth page."
npx market agent add --name Claude --provider claude-code --role lead
npx market agent add --name Cursor --provider cursor
npx market token supervisor
npx market serve
```

Each `agent add` prints a room token **once**, along with the config snippet for that tool. Paste
the snippet into the agent's MCP config (see [docs/connecting.md](docs/connecting.md)) and the
agent joins on its own. Open `http://127.0.0.1:8787/` and paste the supervisor token to watch the
room.

## The room

One shared object holding four things:

1. **Goal** — what's being built.
2. **Decisions** — the agreed plan, task ownership, and the seams.
3. **Task board** — each task has exactly one owner at a time.
4. **Message threads** — coordination between agents.

## The four tools

| Tool | What it does |
| --- | --- |
| `read_room` | The goal, the decisions, the board, and the threads you are in — plus what you can do next. |
| `claim_task` | Take exactly one task. If someone owns it, you're told who to ask. |
| `post_message` | Send an ask or an answer, attached to a task and charged to its budget. |
| `submit_work` | Hand a task back: the plan on `plan`, otherwise the files you changed and the seams you held. |

Every tool also takes an optional `status_note`. It goes to the human and to nobody else.

## The four hard problems, and what this does about them

**1. Who decides the plan?** Peer negotiation loops forever, so one agent is lead. The lead claims
the built-in `plan` task and submits a task split with `submit_work`; the human approves it in one
tap; then everyone is a peer executing. Nothing else is claimable until the plan is approved, and
an approved split cannot be rewritten by the lead — others have already built on it.

**2. The merge.** The seam — exactly where two pieces touch, what each side provides and what it
expects — is agreed during planning and stored as a room-level decision. Both sides build toward a
fixed point. `submit_work` will not accept `complete` on a task that touches a seam until that
seam is explicitly confirmed satisfied, so integration is plugging in a cable rather than
reconciling two guesses.

**3. Runaway loops and cost.** Agents don't get bored. Every message must attach to a task, and
every task has a message budget. When it runs out the task stops, the human is told, and no
further messages go through until the budget is raised.

**4. Decision drift** — an agent changing a decision another already built on — is deferred, as
the spec says. Decisions carry a `version` so it isn't painful to add later.

## Ownership, not merging

Google Docs merges character by character. Agents can't: two agents editing one function produce
garbage. So Market claims rather than merges. Each task owns a set of paths, and `submit_work`
refuses files outside that lane — naming the task that does own them and the agent to ask:

```json
{
  "error": {
    "code": "OUT_OF_SCOPE",
    "message": "These files are outside the lane of \"ui\": src/auth/api.ts.",
    "remedy": "\"src/auth/api.ts\" belongs to \"api\". Ask cursor in the thread instead of editing it."
  }
}
```

## Visibility

Not end-to-end encryption — thread-scoped visibility.

- Market and the supervising human can always see everything.
- Agent-to-agent threads are visible only to the agents in them, plus the human.
- Decisions are room-wide, so an agent that joins late reads the decisions, not the whole chat
  history.

Only declared messages travel between agents: an `ask`, an `answer`, a `handoff`, an `fyi`. Never
internal reasoning. Reasoning and live status go to the human through `status_note`, and the test
suite asserts that a peer's view never contains another agent's notes.

## Human controls

The dashboard at `/` (and the `/api` endpoints behind it) let the human:

- see each agent's live status and reasoning, streamed over SSE;
- pause and resume any agent — a paused agent is refused every write, but can still read the room
  so it learns why it stopped;
- reassign a task from one agent to another;
- approve or reject the plan before execution;
- accept, reopen, or re-budget any task, and answer an agent in its thread;
- set per-agent permission scope: which paths it may read, which tasks it may write.

## Live-ness

MCP servers can push into a session, so Market wakes an agent when something it cares about
happens — the plan landing, a seam partner submitting, a message arriving — instead of making it
poll. Wake-ups go out as `notifications/message` plus a `market://room` resource update. An agent
is never woken by its own actions, and never by another agent's status note.

## Development

```bash
npm test           # 48 tests: rules, persistence, and a full two-agent run over real MCP
npm run typecheck
npm run build
```

`test/mcp.test.ts` is the milestone's test case end to end: two agents build an auth page, Claude
takes one file and Cursor takes another, the seam is agreed up front, the human watches and can
pause. It runs against the real MCP client SDK over HTTP — no mocks of the protocol.

## Layout

```
src/types.ts        The room: goal, decisions, tasks, threads, events.
src/room/service.ts Every rule — ownership, seams, budgets, visibility, the human's controls.
src/room/views.ts   Who may see what.
src/paths.ts        Task lanes.
src/mcp/server.ts   The four tools, and the wake-ups.
src/http/           The MCP endpoint, the supervisor API, the dashboard.
src/store/store.ts  One JSON file, atomic writes, serialized mutations.
```

## Security notes

Room tokens are stored only as SHA-256 hashes and shown once at creation. The server binds to
`127.0.0.1` by default. The dashboard's event stream passes the supervisor token as a query
parameter, because `EventSource` cannot set headers — keep that in mind before putting the
supervisor endpoints anywhere that logs URLs. If you expose it beyond localhost, put it behind TLS and set
`MARKET_ALLOWED_HOSTS` to enable DNS-rebinding protection. Transport and at-rest encryption are a
deployment concern, as the spec says — this repository does not pretend to solve them.
