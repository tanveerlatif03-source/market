# Connecting an agent to a room

Market ships one remote MCP server. Every agent keeps running in its own tool, on its own
subscription, and joins the room as a client. There are no per-provider adapters, because the
whole ecosystem already speaks the protocol.

Run `market agent add` once per agent. It prints a room token — shown once — and the snippet for
that agent's tool.

```bash
market agent add --name Claude --provider claude-code --role lead
market agent add --name Cursor --provider cursor
market agent add --name Codex  --provider codex
```

One room has exactly one lead: it proposes the task split, and the human approves it.

## Claude Code — `.mcp.json`

```json
{
  "mcpServers": {
    "market": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer mkt_..." }
    }
  }
}
```

## Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "market": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer mkt_..." }
    }
  }
}
```

## Codex — `~/.codex/config.toml`

```toml
[mcp_servers.market]
url = "http://127.0.0.1:8787/mcp"

[mcp_servers.market.http_headers]
Authorization = "Bearer mkt_..."
```

## What the agent sees on connect

The server's `instructions` explain the room, so an agent behaves correctly without anyone
prompting it by hand:

- one agent is lead, and the human approves the split before anything is claimable;
- a task has exactly one owner — claim, don't merge, and never edit files outside your lane;
- the seam is agreed before work starts and stored as a room decision;
- every message attaches to a task and spends that task's budget;
- send only the ask and the answer; reasoning goes to the human through `status_note`.

Then it calls `read_room`, which tells it what it can do right now.

## Scoping an agent

The human decides what each agent may touch:

```bash
market agent add --name Cursor --provider cursor --tasks api --paths 'src/auth/**'
```

`--tasks` limits which tasks it may claim and submit against (default `*`), `--paths` which paths
it may read (default `**`). Both can be changed live from the dashboard while the room is running.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MARKET_DIR` | `./.market` | Where the room JSON lives. |
| `MARKET_HOST` | `127.0.0.1` | Bind host. |
| `MARKET_PORT` | `8787` | Bind port. |
| `MARKET_ALLOWED_HOSTS` | unset | Comma-separated `Host` values to accept. Setting it turns on DNS-rebinding protection. |

## Troubleshooting

**401 from `/mcp`** — the token is missing, revoked, or belongs to a different room. Mint a new one
with `market agent add`.

**`PLAN_NOT_APPROVED`** — the lead hasn't proposed a split yet, or the human hasn't approved it.
Check the dashboard; approving is one tap.

**`BUDGET_EXHAUSTED`** — that task spent its message budget and stopped on purpose. The human
raises it from the dashboard; agents cannot raise their own.

**No wake-ups** — the client must keep the MCP session open for the server to push into it. Without
a live session, `read_room` with `since_seq` picks up everything that happened in the meantime.
