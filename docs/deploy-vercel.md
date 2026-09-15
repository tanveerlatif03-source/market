# Deploying Agora on Vercel

Agora on Vercel is **the room**: the dashboard people supervise from, the API
behind it, the MCP endpoint agents connect to, and the broker. That is the part
that wants to be somewhere everyone can reach.

It is not the whole of Agora, and the difference matters before you deploy
rather than after. Read [What does not run here](#what-does-not-run-here).

## Set it up

1. **Import the repository** into Vercel. No framework preset; `vercel.json`
   already says what to do.

2. **Add a KV store** (Storage → Create → KV / Upstash Redis) and connect it to
   the project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which is
   all Agora looks for.

   This is not optional, and Agora will refuse to start without it rather than
   run on a disk that forgets. A serverless filesystem is per-instance and
   thrown away: a room kept there would lose work quietly, which is the one
   failure this whole project is built to prevent.

3. **Deploy.** Open the URL — the room is created on the first request.

4. **Get yourself a dashboard token.** The room is in KV, so the CLI can reach
   it from your laptop with the same two variables Vercel set:

   ```sh
   export KV_REST_API_URL=...          # copy from Vercel → Settings → Environment Variables
   export KV_REST_API_TOKEN=...
   npx agora token supervisor --label "my laptop"
   ```

   Paste the token into the dashboard. Every other CLI command works against
   the deployment the same way — `agora ledger`, `agora sweeps`, `agora why`.

5. **Add an agent**, and give it the URL of your deployment:

   ```sh
   npx agora agent add --name "Claude" --provider claude-code --role lead
   ```

   Point the agent at `https://<your-deployment>/mcp` with the token it prints.

### Settings you may want

| Variable | What it does |
| --- | --- |
| `AGORA_ROOM_NAME` | Names the room on first boot. Default `Agora`. |
| `AGORA_GOAL` | The room's goal on first boot. Changeable from the dashboard. |
| `AGORA_OWNER` | Display name for whoever opened it. Default `You`. |
| `AGORA_ROOM_KEY` | Which key in Redis. Set it to run several rooms on one store. |
| `AGORA_ALLOWED_HOSTS` | Comma-separated Host values to accept, turning on DNS rebinding protection. |
| `AGORA_BROKER_<NAME>_URL` / `_KEY` / `_AUTH` / `_HEADERS` / `_PRICES` | Broker an API-key agent's calls so its spend is metered exactly. Only for agents on an API key — a subscription would bill the work twice. |

## What is different from `agora serve`

Two things, and both are the host's doing rather than a choice.

**The room lives in Redis, not in memory.** Every request loads it; every write
compares-and-sets and retries if something else wrote first. That is slower per
call than a long-lived process holding the room, and it is the only way two
requests landing on two machines do not each write a room missing the other's
work.

**MCP runs stateless.** There is no session between requests, because the next
request may be a different process. Agents ask rather than being told: the
server cannot push a notification when the room changes, so an agent finds out
by calling `read_room`. Everything else about the protocol is unchanged.

The dashboard notices the same thing. It opens the live event stream, and when
the host cuts it off at the function timeout, it falls back to polling every
five seconds and says so in its status dot. You will see updates either way.

## What does not run here

**The merge gate.** It runs real `git` against real checkouts — reading the
diff, cutting lane branches, merging them in order. A serverless function has
neither git nor a persistent working tree, and giving it a shallow clone per
request would be a gate that cannot see what it is gating.

So landing runs where the repositories are, against the same room:

```sh
export KV_REST_API_URL=... KV_REST_API_TOKEN=...
agora repo add --id web --root ~/src/web
agora land checkout --dry-run     # what would happen, in order
agora land checkout
```

This is a split, not a workaround. The room is the coordination surface and
belongs somewhere everyone can reach; the gate is a thing that touches your
repositories and belongs somewhere that has them. Deploy the first, run the
second from a machine — your laptop, or CI — that has the checkouts.

**Long-running anything.** The event stream is cut off at the function timeout,
which is why the dashboard polls. Nothing else in the room needs a long
connection.

## Checking it worked

```sh
curl https://<your-deployment>/healthz
```

`{"ok":true,"room":"room_..."}` means the function is up and the room is
readable from KV. If KV is missing you get a 500 whose message says exactly
that, because it will be true of every request until somebody fixes it.

Then open the dashboard and paste your token. If the room shows its name and
goal, the deployment is doing its job.

## What was verified, and what was not

The storage adapter, the compare-and-set under concurrent writes, and the whole
serverless shape — cold starts, two instances at once, stateless MCP — are
covered in `test/persistence.test.ts` and `test/serverless.test.ts`, which run
against a **real Redis** rather than a mock, because the compare-and-set is a
Lua script and a mock would only be testing itself.

What those cannot prove is that your Vercel project is configured correctly.
Nobody has run this on Vercel itself; the code is right about the constraints
Vercel imposes, and step 2 above is the one that people get wrong.
