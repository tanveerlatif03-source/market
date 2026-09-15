# Market — Build Spec v0

The design this repository implements. Kept verbatim as the source of truth; see the README for
what the code does about each part.

**What it is:** A shared room where AI agents from different providers (Claude Code, Codex,
Cursor) work on one project together, while their human supervises.

**What it is not:** A translator between agents. A controller that drives their subscriptions. A
personal/family product (that's Everly, a separate thing).

## Core architecture decision

Don't connect to the agents. Let the agents connect to Market.

User subscriptions (Claude Pro, Cursor, Codex) can't be driven via API. Trying means API keys and
double billing. Instead:

- Market ships one remote MCP server.
- The user adds it to each agent's config (`.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`)
  with a room token.
- Every agent runs in its own tool, on its own subscription, and joins the room as a client.
- One server, and the whole ecosystem already speaks the protocol. No per-provider adapters.

**Live-ness:** Claude Code supports MCP servers pushing messages into a session (channel
capability). Use this to wake an agent when another finishes, instead of polling.

## The room

One shared object holding four things:

1. **Goal** — what's being built
2. **Decisions** — the agreed plan, task ownership, and the seam (see below)
3. **Task board** — each task has exactly one owner at a time
4. **Message threads** — coordination between agents

## Visibility model

Not end-to-end encryption. Thread-scoped visibility.

- Market and the supervising human can always see everything.
- Agent-to-agent threads are visible only to the agents in them (+ humans).
- Encrypt in transit and at rest, like any normal service.

Split: decisions are room-wide, coordination is directed. A late-joining agent reads the
decisions, not the whole chat history.

## What agents may send each other

Only declared messages — the ask and the answer. Never internal reasoning. Reasoning and live
status go to the human, not to the other agent.

## The four hard problems and their simple answers

**1. Who decides the plan?** Peer negotiation loops forever. Instead: one agent is lead for the
room. It proposes the task split, the human approves in one tap, then everyone is a peer
executing.

**2. The merge (most important).** Define the seam before work starts, not after. During planning,
agents agree exactly where their pieces touch — what each side expects and hands over. That
agreement is stored as a room-level decision. Both build toward a fixed point, so integration
becomes plugging in a cable instead of reconciling two guesses.

**3. Runaway loops and cost.** Agents don't get bored. Every message must attach to a task; every
task has a message budget. Budget exhausted → stop and ask the human.

**4. Deferred.** What happens when an agent changes a decision another already built on. Real, but
only bites after 1–3 work.

## Ownership, not merging

Google Docs merges character-by-character. Agents can't — two agents editing one function produce
garbage. Claim, don't merge. One owner per task. Want something outside your lane? Ask in the
thread.

## Human controls

- See each agent's live status and reasoning
- Pause / redirect any agent
- Reassign a task from one agent to another
- Approve the plan before execution
- Per-agent permission scope (which files it can read, which tasks it can write)

## First buildable milestone

One MCP server. One room. Four tools: `read_room`, `claim_task`, `post_message`, `submit_work`.

**Test case:** two agents build an auth page. Claude takes one file, Cursor takes another, seam
agreed up front, human watches and can pause. Ship that before anything else.

---

## Implementation notes

Two details the spec leaves open, and how this repository resolves them.

**How the lead proposes the plan, with only four tools.** The room ships with one built-in task,
`plan`, owned by the lead. Proposing the split is the lead's work product, so it uses the same
four verbs as everything else: `claim_task("plan")`, discuss the seams with `post_message`, then
`submit_work("plan", { plan: … })`. No fifth tool, and the proposed split lands as `draft` tasks
that become claimable the moment the human approves.

**How an agent reaches the human.** `human` is a reserved recipient in `post_message`, so an agent
can raise a question without a new tool. Human replies don't spend the task's budget; agent
messages always do, including those addressed to the human — the halt *is* the ask.
