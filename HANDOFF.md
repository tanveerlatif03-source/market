# Agora — what it is, and where it stands

A handoff document. Read this first, then `docs/design.md`, which is the design of
record and wins wherever this file disagrees with it.

Written 2026-09-16. Everything below was checked against the tree at that point
rather than remembered: 380 tests / 99 suites passing, typecheck clean, deployed
and health-green on Vercel.

---

## 1. What we are building

**Agora is a shared room where AI agents from different providers work on one
project together, while humans supervise.**

Claude Code, Codex and Cursor all sit in the same room, see the same plan, hold
the same contracts, and merge through the same gate. The human rules on shape
and interfaces; the agents write the code.

### The founding architectural decision

**Agora does not connect to the agents. The agents connect to Agora.**

This is the load-bearing choice and everything else follows from it. Driving
Claude Code or Codex from Agora would mean holding API keys and paying for
tokens a second time on top of a subscription the user already has. So Agora is
**one remote MCP server**. An agent adds it the way it adds any MCP server, with
a room token, and joins on its own.

Consequence worth keeping in mind while working on this: Agora can never *make*
an agent do anything. It can only refuse. Every rule in this system is therefore
expressed as a refusal with a remedy attached — never as a command.

### The core loop

1. A room opens with a **goal**.
2. The **lead agent** drafts a plan: a split into lanes, the contracts between
   them, and the evidence each lane will produce.
3. A **human edits that plan in place** and approves it. (Not approve-or-reject —
   when a plan is 80% right, forcing a redraft teaches people to stop reading it.)
4. Agents **claim files** before editing them. One owner per file, room-wide.
5. Agents build against the **contract**, not against each other's half-written code.
6. When a lane submits, the agent **across the contract reviews it**. A
   configurable **risk list** pulls a human in on auth, payments, schema, public API.
7. The **merge gate** reads the actual `git diff` and refuses anything that left
   its lane, broke a contract, skipped a claim or has no evidence.
8. Lanes sharing a contract **land as a set, or not at all**.
9. The room **closes** when evidence is green and branches have landed, and its
   archive **seeds the next room's contracts**.

### The bet, stated plainly

That contract-level review catches most of what matters, and that a human ruling
on shape and interfaces is a better use of the scarcest resource in the system
than a human reading three thousand lines of generated code.

If that bet is false, Agora ships coordinated mistakes faster than anyone has
shipped them before. `test/phase1.test.ts` is the first place it can fail and it
should be run adversarially.

### What it is not

- Not an agent. It writes no code and reads no code context — the agent already
  has the repo.
- Not an orchestrator. It never tells an agent what to do next.
- Not a chat app. Supervision here is **episodic**, not a wall of live streams.
- Not a CI system. It gates merges; it does not run your build.

---

## 2. Where it stands right now

All four planned phases are built and passing. The design doc (`docs/design.md`)
carries per-phase checkboxes; four boxes remain open and all four are honest.

| Phase | What it proves | State |
|---|---|---|
| **1 — the spine** | Two agents build one feature across a real contract; the gate refuses a lane violation neither agent admitted to | Passing, `test/phase1.test.ts`, against real git |
| **2 — survives being left alone** | Nobody looks for two hours; nothing stalls silently, nothing merges silently | Passing, `test/phase2.test.ts` |
| **3 — a team product** | A second person picks up a room cold and rules *correctly* on the first thing needing them | Passing, `test/phase3.test.ts` |
| **4 — scale** | A front-end and a back-end repo ship one contract together, and the failure case is loud | Passing, `test/phase4.test.ts`, against two real git repos |
| **the grid** | Forty files, one check, three agents → one question, not forty | Passing, `test/room-grid.test.ts` |

```
380 tests, 99 suites, 0 failures  (npm test, ~13s)
typecheck clean                   (npm run typecheck — runs BOTH tsconfigs)
```

**Deployed:** `https://market-henna-three.vercel.app` — `/healthz` returns
`{"ok":true,"room":"room_..."}`, which means the function is live, Upstash/KV is
reachable from it, and the room seeded and read back. Storage is Upstash for
Redis via the Vercel integration (free plan).

### The four open boxes — all of them honest

None of these are design gaps. Three need credentials and a public endpoint;
one needs a Slack app.

1. **GitHub App** (Q1, Q16) — installation, webhooks, org permissions read from
   the GitHub API. The *rules* it would enforce are built and tested; what is
   missing is the deployment shell.
2. **Permissions mirrored from GitHub** (Q16) — the line is enforced on every
   action today, but which side of it a person is on is set when they are added
   rather than read from GitHub.
3. **Slack as the notification transport** (Q11) — the contract Q11 asks for is
   that a ruling be answerable *from the notification*. That is built, tested
   and reachable over HTTP at `/api/attention`. Slack is delivery plumbing that
   enforces no rule of its own.
4. **The merge gate on serverless** — not an open box so much as a permanent
   split. See §10.

---

## 3. Running it

Node **>= 22.18** required (the project uses native TypeScript type stripping).

### Locally, the shape the design assumes

```sh
npm install
npm run build

# zero-config day one: one room, one agent, one goal
node dist/cli.js start "Ship the checkout flow"

# or explicitly
node dist/cli.js init --name "Checkout" --goal "Ship the checkout flow"
node dist/cli.js agent add --name "Claude" --provider claude-code --role lead
node dist/cli.js token supervisor --label "my laptop"
node dist/cli.js serve          # http://127.0.0.1:8787
```

`npm run dev` runs the CLI straight from `src/` with no build step.

The room is written to `.agora/room.json` (override with `AGORA_DIR`).

### Against the deployment

The CLI reads the same two environment variables the deployment does, so it
operates on the same room without talking to the deployment at all:

```sh
export KV_REST_API_URL=...
export KV_REST_API_TOKEN=...
node dist/cli.js status
node dist/cli.js token supervisor --label "my laptop"
```

**Known papercut:** commands that print a URL (`token supervisor`, `agent add`)
print `http://127.0.0.1:8787/...` because they read the local config and do not
know they are pointed at a deployment. The tokens themselves are correct.
Substitute the deployment host by hand. Worth fixing — see §14.

---

## 4. Repository map

```
src/
  index.ts            Public exports
  cli.ts              Every CLI command (692 lines)
  config.ts           AGORA_DIR / AGORA_HOST / AGORA_PORT / AGORA_ALLOWED_HOSTS
  errors.ts           AgoraError: code + message + remedy + details
  events.ts           EventBus, in-process pub/sub for the SSE stream
  ids.ts              Id generation
  paths.ts            Glob matching for scopes and risk rules
  types.ts            The whole domain model (406 lines) — start here

  room/
    service.ts        THE RULES. 3,422 lines. Every mutation goes through it.
    seed.ts           A new room's starting state; OWNER_ID, PLAN_TASK_ID
    views.ts          What an agent sees vs. what a supervisor sees (Q21)
    claims.ts         Per-file claims: held / soft / dead (Q2–Q5)
    attention.ts      The queue: named owner, 15-minute timer (Q8, Q11)
    spin.ts           Spinning detector: rewrites + unchanged evidence (Q20)
    review.ts         Cross-review at the seam + the risk list (Q13)
    provenance.ts     "Why is this the way it is" (Q26)
    rights.ts         One line: reversible vs. changes-what-merges (Q16)
    cost.ts           metered / reported / quota — and NO total (Q15)
    ledger.ts         Every lane on one screen, worst first (Q19)
    close.ts          Close, archive, seed the next room (Q24)
    repos.ts          Multi-repo ordering and partial-landing state (Q17)
    grid.ts           Sweeps: allocate rows, collapse findings (Q19)

  gate/
    evaluate.ts       Pure decision: 14 GateCodes, no I/O
    gate.ts           MergeGate: branches, landing plan, land/resume/rollback

  git/repo.ts         Real git via execFile. No library.

  store/
    persistence.ts    The Persistence port: File | Memory | Redis
    store.ts          AgoraStore: apply(), refresh(), CAS retry loop

  mcp/server.ts       15 MCP tools + 1 resource — what agents see
  http/
    server.ts         Routing: /healthz /mcp /broker/* /api/* /
    supervisor.ts     The supervisor REST API
    dashboard.ts      The dashboard, one self-contained HTML file (1,188 lines)
    broker.ts         /broker/<provider> passthrough
    serverless.ts     The Vercel entry — stateless MCP, Redis room
    util.ts           sendJson, sendError, body parsing

  broker/broker.ts    Forward a call, read real usage off the response (Q15)

api/index.js          Two lines. What Vercel actually loads.
docs/design.md        THE DESIGN OF RECORD — 26 decisions + build order
docs/spec-v0.md       The original brief, kept as provenance
docs/deploy-vercel.md What changes on serverless and what cannot go there
docs/connecting.md    How an agent joins
test/                 26 test files, no framework — node:test + node:assert
```

---

## 5. The domain model

Everything lives under one `AgoraData`:

```ts
interface AgoraData {
  version: 1;
  room: Room;
  tokens: TokenRecord[];   // secrets, kept outside the room proper
}
```

`Room` carries: `id name goal status closedAt seededFrom repos partialLanding
lead plan agents decisions tasks claims humans attention probes dissents reviews
riskList signOffs costs batches threads events eventSeq`.

Key vocabulary — **use these words, the code does**:

| Word | Means |
|---|---|
| **Lane** | A unit of work. Modelled as a `Task`. "I'm on checkout." |
| **Seam** | A contract between two lanes. Versioned. |
| **Claim** | One agent holding one file path, right now. |
| **Evidence** | What a lane declared would prove it worked. |
| **Attention item** | Something waiting on a named person. |
| **Sweep / batch** | Repetitive work: one instruction, many rows. |
| **Row** | One subject inside a sweep — usually one file. |
| **Dissent** | An agent's on-record objection *while complying*. |

`RoomStatus` is `open | red | closed`. **Red** means a landing got half in
across two repositories; the room cannot close while red.

There are 54 `RoomEventType` values (and 23 `RoomAction` values — 13 needing merge rights, 10 open to everyone). The event log is append-only with a
monotonic `seq`, and it is what provenance and the dashboard stream read.

---

## 6. The rules, module by module

### Claims — `room/claims.ts` (Q2–Q5)

A claim is **held**, **soft**, or its session is **dead**. Nothing sweeps on a
timer; state is *derived* from timestamps every time it is read.

```ts
SOFT_AFTER_MS         = 10 * 60 * 1000   // quiet this long → soft
SESSION_DEAD_AFTER_MS =  2 * 60 * 1000   // no heartbeat → session gone
```

A claim also goes soft the moment its holder writes to a *different* file — a
better signal than a clock, because an agent that moved on is done in all but
name. **Soft claims transfer instantly and silently.** Agents never negotiate
locks with each other; only a live collision (both writing the same file this
minute) reaches a human, described as what it actually is: *the plan put two
agents in the same code.*

**Territory belongs to the lane, not to the agent.** This changed in Phase 4 for
the grid, where several agents work inside one lane on purpose. The gate's
foreign-file check compares `laneId`, and `requireLaneAccess` refuses a claim for
a lane you neither own nor hold a row of.

### The merge gate — `gate/evaluate.ts` + `gate/gate.ts` (Q1, Q12)

`evaluate.ts` is pure and does no I/O. `gate.ts` shells out to real `git` via
`execFile`.

**The diff is truth; `filesChanged` is a claim.** The gate reads what actually
changed and compares it to what the agent said.

14 refusal codes:

```
not-submitted  unclaimed-files  foreign-files
seam-unsigned  seam-stale  seam-unsatisfied  seam-mate-not-ready
cross-review-missing  cross-review-stale  cross-review-breaks
risk-unsigned  sweep-unfinished  evidence-missing  conflicts
```

Landing: `where()` resolves repos, `landingPlan()` orders the steps,
`land()` walks them with an `onStep` hook, `resume()` finishes a half-landing,
`rollback(by)` reverts with a **revert commit in each repo — never a force-push**,
because somebody has that history checked out.

### Contracts — versioned (Q6, Q12, Q14)

`SeamCheck.signedVersion` records which version of a contract a lane signed
against. Bumping the contract makes every old signature worthless, and only the
lanes touching that seam go stale. Agora states the cost plainly rather than
hiding it: *nine files were written against v3.*

### Cross-review and the risk list — `room/review.ts` (Q13)

```ts
type ReviewState = 'missing' | 'stale' | 'breaks' | 'holds' | 'unreviewable';
```

The reviewer is chosen **by the contract** — the agent on the other side of the
seam has context and a real stake. A review is signed against a specific
submission *and* a specific seam version, so it goes stale the same way.

`DEFAULT_RISK_LIST` covers auth, payments, schema, public-api. A sign-off covers
**one submission only** — resubmit and you need a fresh one.

> **Landmine:** every risk rule lists both `**/x` and `x` forms, because `**/x`
> does **not** match a root-level `x`. If you add a rule, add both.

### Rights — `room/rights.ts` (Q16)

One line, drawn once: **reversible = everyone in the room; changes-what-merges =
merge rights.** `ACTIONS` is an exhaustive `Record<RoomAction, …>` so a new
action cannot compile without someone deciding which side it falls on.

A supervisor token carries exactly one person's rights — nobody can mint their
way upward. **A refused attempt is on the record and survives the rollback it
caused** (see the Repair carrier, §13).

### Attention — `room/attention.ts` (Q8, Q11)

One named human per lane, `OPENS_TO_ROOM_AFTER_MS = 15 * 60 * 1000`. After that
it opens to the room. Every item carries its own answer options **with the
effect of each stated**, and answering is a single call — because if settling a
border needs the app open, the timer expires every time.

### Spin detection — `room/spin.ts` (Q20)

Mechanical and cheap: `REWRITE_THRESHOLD = 4` rewrites of the same file with
evidence unchanged triggers a concrete question — *can you produce your evidence
yet; if not, what is missing?* The **same missing piece named twice** means
stuck, and the named owner is woken with that specific fact.

Design principle: admitting you are stuck must always cost less than grinding,
or agents will grind.

### Cost — `room/cost.ts` (Q15)

Three provenances, never blended:

- **metered** — Agora brokered the call and counted it itself
- **reported** — a tool volunteered its token count
- **quota** — what actually runs out for a developer on a plan

> **`CostReport` has no `total` field and must never grow one.** Adding one
> requires deciding to lie about units. This is deliberate and tested.

Quota is a **level** (latest reading wins), not a running total. A quota nearly
gone raises attention *before* it runs out mid-lane.

### The Ledger — `room/ledger.ts` (Q19)

`ledgerRows(room, now)` → sortable; `DEFAULT_SORT = { column: 'health',
direction: 'asc' }` puts the worst lane on top. `whatIsBlocking` names the
**cause** ahead of the count — "the agent across the contract says it breaks",
not "3 problems".

### Close and archive — `room/close.ts` (Q24)

`closeReadiness` → `archiveOf` → `seedContracts` + `seedBriefing`. Only contracts
**both sides held** are carried into the next room, as `kind: 'general'` notes.
The archive has two jobs: answer *why is the code like this*, and seed the next
room. The second one compounds.

### Multi-repo — `room/repos.ts` (Q17)

`orderLanes` is a topological sort of the contract graph — a cycle **says so**
rather than picking arbitrarily. `contractsMissingOrder` refuses to approve a
plan with a cross-repo contract that does not state its order, because approving
it would promise "they land together" when that cannot be kept.

**Agora refuses to promise atomicity across repos.** What it offers instead:
*order*, *blast radius* (`agora land --dry-run` prints the window: *after step 1,
api is on the new POST /quote and web is not*), and *a loud failure* — the room
goes red and stays red.

### The grid — `room/grid.ts` (Q19)

Q19 parked a **formula language**; it did not park the **shape**. The distance
between those two is the whole decision.

**Nothing in it evaluates anything.** A sweep has an instruction in prose which
Agora stores and hands on untouched, a list of real paths, and one row per path.
No expressions, no cell references, no dependency graph.

Two enforced properties:

- **Rows are handed out, never negotiated** — `allocate()`. Q5's rule at a
  different grain.
- **Forty findings are not forty questions** — `collapseFindings()` normalizes
  whitespace and case; a sweep raises **one** item for the whole batch, refreshed
  rather than duplicated, and answering it once carries onto every row it covers.

`assessSweep` → `working | needs-a-person | changed-nothing | finished`. That
third one was not asked for and is worth keeping: forty files finding nothing is
usually an instruction that did not ask for what you meant.

### The broker — `broker/broker.ts` (Q15)

An agent on an API key points its provider base URL at `/broker/<provider>`.
Agora forwards with its own key, reads token counts off the response, records
them as **metered**.

- Strips `authorization` / `x-api-key` from the incoming request before forwarding.
- Reads Anthropic-shaped and OpenAI-shaped usage.
- **Refuses to infer from `total_tokens`** — input and output do not cost the same.
- Converts to money **only where a price is configured**; otherwise reports tokens
  and stops, because a plausible dollar figure with no price behind it is exactly
  what Q15 refuses to print.
- Every brokered call spends an action.

**Narrow on purpose:** an agent on a subscription must not use it — that would
bill the work twice, which is the founding reason Agora is a place agents connect
*to*.

---

## 7. The surfaces

### MCP — 15 tools (`src/mcp/server.ts`)

What every agent sees:

```
read_room       claim_task      post_message    submit_work
claim_file      release_file    show_evidence   dissent
report_missing  review_lane     why_is_this     report_usage
open_sweep      take_rows       finish_row
```

Plus one resource: `room`.

Transport is `StreamableHTTPServerTransport`. **Two modes:**

- **Stateful** (`agora serve`) — a transport per session keyed by `mcp-session-id`,
  with server→client push via `sendLoggingMessage` + `sendResourceUpdated`.
- **Stateless** (`sessionIdGenerator: undefined`, used on Vercel) — no session
  between requests. Agents ask rather than being told.

> **Landmine:** the stateless branch must sit at the **top** of `handleMcp`,
> before any session lookup. It was behind the `isInitializeRequest` check
> originally, so only the first request ever reached it.

**Q21 — what a joining agent gets:** the goal, the plan, every contract at its
current version, its own lane and evidence and budget, and what it may claim.
**Not** thread history, not another agent's reasoning, not past rulings — the
contracts *are* the compressed history. A reconnecting agent gets a diff, not a
replay. Agora never ships code context.

### CLI (`src/cli.ts`)

```
agora start "<goal>"                      One room, one agent, one goal. No setup.
agora init --name <room> --goal <goal>
agora agent add --name <name> [--provider|--role|--id|--tasks|--paths]
agora people add --name <name> [--merge]
agora token supervisor [--label <label>] [--for <humanId>]
agora serve [--host <host>] [--port <port>]
agora status
agora ledger [--sort <column>] [--desc]
agora sweeps [<lane|id>] [--rows]
agora why --file|--lane|--contract <x>
agora repo add --id <id> --root <path>
agora land <lane> [--dry-run|--resume|--rollback]
agora close [--landed <a,b>] [--note <n>]
```

`--as <id>` everywhere sets who is acting. Defaults to `owner`.

`agent add` prints a ready-made MCP config block tailored to the provider
(`.mcp.json`, `.cursor/mcp.json`, or `~/.codex/config.toml`).

### HTTP (`src/http/server.ts`)

```
GET  /healthz                     { ok, room }
ALL  /mcp                         agents
ALL  /broker/<provider>/*         metered passthrough
GET  /                            the dashboard
     /api/*                       supervisor API
```

`/api` — GET: `room attention humans ledger sweeps close archive why events`
(`events` is SSE). POST: `goal plan/approve plan/reject decisions agents humans
close risks`, `agents/:id/(pause|resume|scope)`, `attention/:id/answer`.

> **Every request calls `await service.sync()` first.** When the room lives
> somewhere shared this process is not the authority, and a token minted a second
> ago by another instance has to work here too.

### Dashboard (`src/http/dashboard.ts`)

One self-contained HTML file, no build step, no framework. Opens the SSE stream
and **falls back to polling every 5s** when the host cuts it off, saying which
mode it is in via its status dot — rather than looking live while being stale.

---

## 8. Storage

A port with three implementations (`src/store/persistence.ts`):

| | `authoritative` | Used by |
|---|---|---|
| `FilePersistence` | `true` | `agora serve` — temp file + rename |
| `MemoryPersistence` | `true` | tests, `--file null` |
| `RedisPersistence` | `false` | Vercel — Upstash REST |

`persistenceFromEnv()` picks Redis when configured, reading, in order:
`KV_REST_API_*`, `UPSTASH_REDIS_REST_*`, `AGORA_REDIS_*`. **Half a configuration
is not a configuration** — both URL and token, or it falls through.

The compare-and-set is a **Lua script**, so it is atomic inside Redis:

```lua
local rev = redis.call('HGET', KEYS[1], 'rev')
if rev == false then rev = '0' end
if rev ~= ARGV[1] then return -1 end
local next = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rev', next, 'data', ARGV[2])
return next
```

`AgoraStore.apply()` in shared mode: refresh → clone → apply → CAS → retry on
`-1`. Without that retry, two requests on two machines each write a room missing
the other's work **and nobody is told** — the exact failure this whole project
exists to prevent.

---

## 9. Testing

**No framework.** `node:test` + `node:assert/strict`, run through Node's
type-stripping loader.

```sh
npm test                 # 380 tests / 99 suites, ~13s
npm run typecheck        # tsc --noEmit && tsc -p tsconfig.test.json
```

> **`npx tsc --noEmit` alone is not enough — it misses every type error in
> `test/`.** Always use `npm run typecheck`, which runs both configs.

Test files: `paths room store mcp claims room-claims git gate phase1 attention
room-attention review provenance phase2 rights cost ledger close phase3 repos
broker phase4 grid room-grid persistence serverless`, plus `helpers.ts` and
`redis-harness.ts`.

### Two conventions that matter

**1. Acceptance tests are mutation-checked.** Every phase test has had its rules
removed one at a time to confirm it actually fails. A test that passes with the
feature deleted is not a test. Examples recorded in `docs/design.md`: removing
cross-review, the risk list or the timer each fails Phase 2; breaking the
finding-collapse or handing a row out twice each fails the grid test.

> If you add an acceptance test, **break it on purpose before you trust it.**
> One weak assertion was caught this way: `[endpoint, page]` passed
> alphabetically as well as topologically, so the lanes were renamed
> `checkout`/`quote` to make the two orders disagree — mutation then produced 13
> failures instead of 0.

**2. Storage is tested against a real Redis, not a mock.** `test/redis-harness.ts`
starts an actual `redis-server` and fronts it with a shim speaking Upstash's REST
protocol. The CAS is a Lua script; testing it against a double would be testing
the double. Requires `redis-server` on PATH.

Servers started in tests are closed in `after()`, so a failed assertion reports
instead of leaving the runner hanging on an open socket.

---

## 10. Deployment

See `docs/deploy-vercel.md` for the full version. In short:

**What runs on Vercel:** the dashboard, the supervisor API, the MCP endpoint,
the broker. The room lives in Redis; MCP is stateless.

**What cannot:** the **merge gate**. It runs real `git` against real checkouts —
cutting lane branches, reading diffs, merging in order. A serverless function has
neither git nor a persistent working tree, and a shallow clone per request would
be a gate that cannot see what it is gating.

This is a split, not a workaround. The room is a coordination surface and belongs
where everyone can reach it; the gate touches your repositories and belongs where
they are. `agora land` runs from a laptop or CI against the same room.

**Setup that is easy to get wrong:** the KV store must be connected to the project
*and you must redeploy afterwards* — env vars reach a build, not a deployment that
already happened. Without KV the function refuses to start, with a message saying
exactly that, rather than quietly running on a disk that forgets.

```json
// vercel.json
{
  "buildCommand": "npm run build && mkdir -p public",
  "outputDirectory": "public",
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]
}
```

`api/index.js` is two lines: `export { default } from '../dist/http/serverless.js';`

---

## 11. Engineering conventions

### TypeScript

Node 22 **native type stripping** — no ts-node, no bundler, no transpile step in
dev. This constrains the code:

```jsonc
"erasableSyntaxOnly": true          // NO enums, NO parameter properties,
                                    // NO namespaces, NO decorators
"allowImportingTsExtensions": true  // imports are written './foo.ts'
"rewriteRelativeImportExtensions": true
"verbatimModuleSyntax": true        // `import type` is mandatory for types
"noUncheckedIndexedAccess": true    // arr[0] is T | undefined
"strict": true
```

**Write `./foo.ts` in imports, not `./foo.js`.** The compiler rewrites them.

`exactOptionalPropertyTypes` is off, but optional properties are still passed
conditionally in places (`...(x !== undefined ? { k: x } : {})`) — follow the
surrounding style.

### Code style

- **Comments explain *why*, never *what*.** Read a few files before writing any —
  the voice is consistent and deliberate: plain, specific, and honest about
  costs. Comments frequently cite the decision number (`(Q13)`) that forced the
  rule.
- Every refusal carries a **remedy**. `AgoraError(code, message, remedy, details)`.
  A refusal that does not say what to do instead is a bug.
- **Say what is not true.** The codebase repeatedly documents what it does *not*
  promise — atomic cross-repo merges, a cost total, a verified deployment. Keep
  doing this; it is the project's distinguishing habit.

### Git

Commits in this repo are titled like the work, not like a changelog:
`Phase 3: several people, cost with provenance, the Ledger, and rooms that end`.

---

## 12. Landmines

Things that have already bitten, kept so they do not bite twice.

1. **`**/x` does not match root-level `x`.** Every risk rule lists both forms.
2. **`npx tsc --noEmit` misses test-file errors.** Use `npm run typecheck`.
3. **The stateless MCP branch must be first** in `handleMcp`, before any session
   lookup — there is never a session id in stateless mode, on any request.
4. **`service.sync()` belongs in the server, not the serverless wrapper.** A
   token minted by one instance is invisible to another otherwise.
5. **Territory compares lanes, not holders.** `claim.holder !== lane.owner` marks
   every grid-worked file foreign. `requireLaneAccess` closes the hole — and it
   must only refuse a lane *someone else owns*, not require the lane be claimed
   (the stricter version broke 9 tests).
6. **`prepare: tsc`, never `tsc || true`.** Swallowing a build failure is exactly
   the quiet failure this project refuses.
7. **Don't `pkill -f`/`pgrep -f` on the serve process** in a sandbox — it matches
   the shell wrapper and kills the session. Scan `/proc/*/exe` for `*/node` and
   match argv instead.
8. **Provenance matches dissents by decision title *or* id** — agents refer to
   contracts by id, humans by title.

### The Repair carrier — read this before touching `service.ts`

Some work must **outlive its own refusal**. A lane that halts because its budget
is spent, and a person refused an action, both need their event to survive —
otherwise the mutation throws, the room rolls back, and the escalation goes with
it. That is *a lane stopping silently*, the one thing Phase 2 rules out.

```ts
type Repair = (data: AgoraData, emit: EmitFn) => void;
const REPAIR = Symbol('agora.repair');
function attachRepair(error: AgoraError, repair: Repair): void
function repairOf(error: unknown): Repair | undefined
```

The repair travels **on the error** and `apply()`'s catch block applies it against
state that still exists. Both bugs this fixed were found by tests being written
for something else — which is the argument for writing them.

---

## 13. Honest limits

State these rather than papering over them:

- **Nobody has run a full agent session end to end on the deployment.** `/healthz`
  is green, which proves the function is up and KV is readable. The dashboard
  token round-trip and an agent MCP handshake against the deployed URL have not
  been confirmed by a human.
- **The merge gate has never run against a repository anyone cares about.** It is
  tested against real git, in temporary repositories created by the tests.
- **No GitHub App, no Slack app.** See §2.
- **The bet in §1 is untested in the wild.** No real team has used this.

---

## 14. Sensible next steps

Roughly in order of value per unit of work.

1. **Fix the URL papercut.** `token supervisor` and `agent add` should print the
   deployment host when `KV_REST_API_URL` is set, or accept `--url`. Small, and
   it is the first thing every new user hits.
2. **Drive the deployment end to end** — mint a token, open the dashboard, connect
   a real agent over MCP at `/mcp`, set a goal from the browser, read it back
   from `agora status`. That round trip is the real proof the room is shared
   rather than three copies that agree.
3. **The GitHub App** (Q1, Q16). The largest remaining box, and it closes two at
   once: installation/webhooks *and* permissions read from the API rather than set
   by hand. Needs a public endpoint — which now exists.
4. **Slack transport** (Q11). The rule is built; this is Block Kit plus an OAuth
   install. The hard constraint to honour: **a ruling must be answerable from the
   notification itself.**
5. **Use it on a real project.** Everything above is less informative than one
   room with two real agents and a real goal.

### Before you commit anything

```sh
npm run typecheck && npm test
```

Both must be clean. If you add a rule, add the test that fails without it — and
break it on purpose to prove it fails.
