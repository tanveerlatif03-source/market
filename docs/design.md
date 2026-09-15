# Agora — the settled design

Twenty-six decisions, taken one at a time. This is what the code is being built to do. The
original brief is kept as [spec-v0.md](spec-v0.md); where the two disagree, this wins.

Decision numbers are the order they were decided in, kept as provenance. Several are load-bearing
for others — where that happens, the later one says so.

## The one-paragraph version

Every file has one owner at a time, claimed before it is edited. Where two pieces of work touch,
the interface between them is written down and signed before either side starts — that contract is
what agents build against, what decides which lanes ship together, and what humans actually
review. Agora holds the branch, so a lane that left its lane or broke its contract simply does not
land. Humans rule on shape and contracts; agents handle code. Nobody watches anything
continuously.

## Territory

**Q1 — Agora holds the branch.** Agents write freely on their own machines; nothing merges except
through Agora, which checks the diff against the lane and the signed contracts. Real teeth without
controlling anyone's editor. Cost: Agora needs write access to the repo, so it is infrastructure
in the git flow, not just an MCP server.

**Q2 — Claim before edit, not find out at the gate.** An agent asks, Agora answers instantly, then
it writes. The merge gate stays as a backstop for anything that skipped the claim — but a refusal
should cost seconds, not forty minutes of binned work.

**Q3 — The file is the unit, not the folder.** Agents discover what they need to touch as they
work; the boundary cannot be drawn up front. So a lane is *intent* — "I'm on checkout" — and the
claim is *fact*: these six files, right now. Territory is a live ragged set, not a shape on a map.

**Q4 — A claim is held until released, with two ways to lose it.** A heartbeat drops claims from
dead sessions. A claim also goes *soft* the moment its holder writes to a different file — a
better signal than a timer, because an agent that has moved on is done in all but name.

**Q5 — Soft claims transfer automatically; agents never negotiate locks.** A requester takes a
soft claim instantly and the previous holder is told it lost it. Only a live collision — both
agents writing the same file this minute — reaches a human, surfaced as what it actually is: the
plan put two agents in the same code. Peer negotiation stays out, because it loops forever.

## Contracts

**Q6 — Agents build against the contract, not each other's code.** Reading a peer's half-written
branch is available when someone is genuinely stuck, but it is the escape hatch, not the rule.
Agents chasing each other's unfinished work recreates the garbage problem earlier rather than
solving it.

**Q12 — Lanes land independently, unless they share a contract.** Two lanes sharing a seam land
together, because that is what the contract means. A lane sharing no seam ships the moment it is
ready. The contract graph does double duty: what you build against, and what has to ship as a set.

**Q14 — Changing a contract invalidates every check signed against the old one.** This falls out
of Q12 rather than being a new rule: a lane cannot merge unless it holds its seams, so a version
bump makes old signatures worthless and those lanes go stale until re-confirmed. Precise — only
lanes touching that seam notice. Affected agents are woken immediately, and Agora states the cost
plainly rather than hiding it: *nine files were written against v3.*

## The plan

**Q9 — A plan gate, but only when more than one agent is involved.** Locks do not catch duplicated
work — two agents can write different files and do the same job twice. Only a split prevents that.
And the plan is where contracts get written, so dropping it leaves Q6 with no source.

**Q10 — The lead agent drafts it; a human edits in place and approves.** Reading a codebase and
enumerating interfaces is what agents are good at and humans hate; judgement is the human's half.
Approve-in-one-tap is out: when a plan is 80% right, forcing reject-and-redraft is how people
learn to stop reading it and just hit approve.

**Q18 — Every lane declares its evidence in the plan.** The gap this closes: every other check is
*local*. The room has a goal and nothing ever tested against it. So each lane states what would
demonstrate it worked — a recording of the flow under three minutes, the quote for a known cart
matching a known number — and the human approves the split *and* the proof. It also kills
tautological tests, which cannot produce that evidence.

## Humans

**Q7 — A team is in the room, not one supervisor.** Work that runs for days pulls in many people.
A single-supervisor cockpit is multiplayer agents with single-player humans, which is half the
thing.

**Q8 — Each lane has one named human, with a fifteen-minute timer.** Named, because a question
posted to a room of six is a question nobody answers. Timered, because a named person asleep is a
dead lane — after fifteen minutes it opens to the room. First responder and decision-maker are
different roles, and that is correct.

**Q11 — Agora is its own place; Slack is the doorbell, GitHub is the exhaust.** The room state has
nowhere else to live, so it needs a home. But a blocked agent must reach a person in seconds, and
that is a notification. Hard rule: **a ruling must be answerable from the notification itself.** If
settling a border needs the app open, the timer expires every time.

**Q16 — Permissions mirror GitHub; there is no permissions screen.** The team made this decision
once already. The line: anything reversible is open to everyone in the room — pause, redirect,
answer, read. Anything that changes what merges — approve a plan, settle a border, raise a cap,
override the gate — needs merge rights.

**Q22 — An agent may dissent on the record without disobeying.** A wrong ruling is expensive
because it invalidates work downstream. If agents can only comply silently the human gets no
feedback; if agents can refuse, they hold a veto. So: comply, and register *I think this is wrong,
because X.* Reversing a ruling is another version bump, so Q14 handles the cleanup.

## Trust

**Q13 — Humans review the contract; agents cross-review the code.** Four agents write 3,000 lines
in an afternoon: review it all and the human is the bottleneck, review none and this is a machine
for shipping unread code. So the agent across a seam reviews your work — it has context and a real
stake in whether you held the contract — and a configurable risk list pulls a human onto auth,
payments, schema, public API. Default light. **This is a bet** that contract-level review catches
most of what matters. Teams who will not take it can set the risk list to everything.

**Q20 — Agora notices an agent spinning, because nobody is watching.** The detector is mechanical
and cheap: same file rewritten repeatedly, evidence unchanged. That triggers a concrete question —
*can you produce your evidence yet; if not, what is missing?* — and the same missing piece twice
means stuck. The named owner is woken with the specific fact. Admitting you are stuck must always
cost less than grinding, or agents will grind.

**Q15 — Meter what is real; cap in actions.** On a subscription there is no per-task dollar cost.
Money is real in three ways: *metered* where Agora brokers API calls and knows to the cent;
*reported* where a tool volunteers its token count; *quota*, which is what actually runs out for a
developer on a plan. Every figure carries which one it is, never blended into a total that hides
the difference. Action caps are the backstop, because actions are the one thing countable with
certainty and they are what stops a runaway loop.

## Shape

**Q17 — A room is a unit of work that ends, and it may span repos.** It opens with a goal, takes a
branch per repo it touches, and archives when the work lands. Cross-repo merges cannot be atomic
and Agora does not pretend otherwise: what is on offer is dependency order, a visible blast
radius, and a room that stays open and red until both halves are in. Build single-repo first;
model it repo-agnostic from day one.

**Q19 — The Ledger is a table; formulas are parked.** A formula language for delegating work
invents a small language, forever, to do what a button already does. Parked, not killed:
repetitive work — the same check across forty files, one row each — is genuinely grid-shaped.

**Q21 — A joining agent gets the decisions, never the history.** On arrival: the goal, the plan,
every contract at its current version, its own lane and evidence and budget, and what it may
claim. Not thread history, not another agent's reasoning, not past rulings — because the contracts
*are* the compressed history. If a ruling mattered, it is in a contract; if it is not in a
contract, it did not matter. A reconnecting agent gets a diff, not a replay. Agora never ships code
context: the agent already has the repo.

**Q23 — Lead is a job, not a rank.** It exists only while a plan needs drafting. Once approved,
everyone is a peer executing. Any agent can be asked to draft a revision — the human picks, and can
pick a different one. No elections, no rotation schedule.

**Q24 — A room closes itself when its evidence is green and its branches have landed.** The same
gate as everything else, with a human confirming. The archive then has two jobs: answer *why is
the code like this*, and seed the next room's contracts. The second one compounds.

**Q25 — Day one is one repo, one agent, one goal — and a plan anyway.** Q9 says solo work is not
gated on a plan, but day one should still *offer* one, because watching the work get decomposed
and contracted before a line is written is the moment that sells the product. The second agent is
the upgrade; the first seam is the payoff. No configuration at any step.

**Q26 — The Console is demoted; the Trace is reframed.** A standing wall of live reasoning streams
is a *continuous* surface, and supervision is episodic — so it becomes a per-agent view opened
while investigating. The Trace survives and matters more, since Q14, Q22 and Q24 lean on it, but
its job is provenance — *why is this the way it is* — not time travel.

## Two of them clashed

Consolidating twenty-six decisions taken one at a time turned up exactly two conflicts. Both
resolutions are part of the design.

**Q9 × Q18 — no plan for solo work, but evidence lives in the plan.** Together they left solo work
with nothing to prove. **Resolved:** solo work still declares evidence. Its plan is goal plus
proof, without the split or the contracts — which is also exactly what Q25 wants to show a new user
on day one.

**Q10 × Q11 — edit the plan in place, from a notification?** You cannot edit a four-lane plan in a
Slack message. **Resolved:** they are different acts. A *ruling* is one decision under time
pressure and must be answerable in place. *Plan approval* is considered work that happens in
Agora. Do not stretch one affordance over both.

## Build order

Each phase ends at a test that can fail. Nothing moves on until it passes, because every later
phase assumes the one before it works.

### Phase 1 — the spine

- [x] Per-file claims: claim, release, heartbeat, soft lapse, automatic transfer (Q2–Q5)
- [x] The merge gate: reads the diff, compares it to what the agent declared (Q1)
- [x] Plan: agent drafts, human edits in place, every lane declares evidence (Q10, Q18)
- [x] Contracts: signed against a version, checked at merge, stale on bump (Q6, Q12, Q14)
- [x] Lanes sharing a contract land as a set, or not at all (Q12)
- [x] Action budgets (Q15)
- [ ] GitHub App: installation, webhooks, mirrored permissions (Q1, Q16)

**Passes when** two agents build one feature across a real contract, and the gate refuses a lane
violation neither agent admitted to. — **passing**, in `test/phase1.test.ts`, against real git.

**What the open box means.** The gate is built and enforced against a real repository: it cuts
lane branches, reads `git diff` for what actually changed, refuses on unclaimed or foreign files,
stale or unsigned contracts and missing evidence, and merges a contract's lanes together or not at
all. What is not built is the deployment shell — installing as a GitHub App, receiving webhooks,
and reading org permissions from the GitHub API (Q16). That needs credentials and a public
endpoint rather than more design, and the rules it would enforce are already written and tested.

### Phase 2 — survives being left alone

- [x] Named lane owner, fifteen-minute timer, room fallback (Q8)
- [x] Every item answerable from the notification: options with stated effects (Q11)
- [ ] Slack as the place that notification arrives (Q11)
- [x] Spinning detector and the evidence question (Q20)
- [x] Cross-review at the seam, and the risk list that overrides it (Q13)
- [x] Dissent on the record (Q22)
- [x] Provenance view (Q26)

**Passes when** nobody looks at the room for two hours and nothing stalls silently, nothing merges
silently, and the log explains every minute of it. — **passing**, in `test/phase2.test.ts`, against
real git.

**What the test actually does.** Two agents, one contract, two people asleep. In the two hours: two
agents reach for the same file, a lane rewrites one file past the threshold and names the same
missing thing twice, both lanes submit, and the agent across the contract says the other side broke
it. Nothing merges — the repository is checked, not the room's word for it — and nothing goes quiet:
every stall is an item with a name on it, a deadline on that name, and answers that carry their own
effects. Two hours on, every one of them has opened to the room. Then one person clears the queue
from the notifications and only then does the set land, together. Removing cross-review, the risk
list or the timer each fails it.

**What the open box means.** The contract Q11 actually asks for is that a ruling can be settled
without opening the app: an item carries its own answers, each with the effect stated, and answering
one is a single call. That is built, tested, and reachable over HTTP at `/api/attention`. What is
not built is Slack as the transport — an app manifest, an OAuth install, Block Kit for the buttons.
That is delivery plumbing for a surface that does not exist in this sandbox, and it enforces no rule
of its own.

**One thing Phase 2 changed under Phase 1.** A lane with a contract now needs the agent across it to
have read the work before it can land, and a lane touching the risk list needs a person. Phase 1's
test was written before either existed, so it now does the cross-review step explicitly and turns
the risk list off — its subject is the territory rule, and Phase 2's test is where the risk list is
exercised.

### Phase 3 — a team product

- [x] Several humans, and one line enforced everywhere (Q7, Q16)
- [ ] That line *read from GitHub* rather than set by hand (Q16)
- [x] Editing the risk list from the dashboard (Q13) — the list itself landed in Phase 2
- [x] Cost with its provenance attached, and never a total (Q15)
- [ ] Metered cost proper, which needs Agora to broker the calls (Q15)
- [x] Sortable table across lanes (Q19)
- [x] Room close and archive; contracts seed the next room (Q24)
- [x] Day-one flow with zero configuration (Q25)

**Passes when** a second person picks up a room cold and rules correctly on the first thing that
needs them. — **passing**, in `test/phase3.test.ts`, against real git.

**The word doing the work is *correctly*.** Anyone can answer a question with three buttons on it,
so the test builds a question whose obvious answer is wrong. The contract says `expiresIn` is in
seconds; the login lane treats it as milliseconds; the agent across the contract says — correctly —
that this breaks it. Siding with the reviewer is the natural call and it is the wrong one: the lane
built milliseconds because a person in this room ruled that it should, and said at the time that it
disagreed. The contract and the ruling contradict each other, and only a person can settle that.

Everything the second person needs is already in the room. The Ledger puts the lane at the top and
says what is in its way. Provenance carries the earlier ruling and, next to it, Q22's dissent —
which is the thing that makes that ruling legible as a *ruling* rather than as a fact about the
world. Take either away and the test fails: they were removed one at a time to check. Without them
the second person sides with the reviewer and makes an agent redo work a person told it to do.

**One line, drawn once (Q16).** Every act that changes what merges now takes an actor and checks
it: approving a plan, amending a contract, raising a cap, accepting or reopening a lane, setting
the risk list, closing the room. Everything reversible — pausing, redirecting, answering, naming
who answers for a lane, taking a question off someone who has gone quiet — is open to everyone in
the room. A supervisor token carries one person's rights and no more, so nobody can mint their way
upward. A refused attempt is on the record, and it survives the rollback it caused.

**What "in anger" turned up.** Two escalations were being discarded by the refusals that raised
them: a lane that stopped on a spent cap, and a person refused an action. Both wrote their event
inside a mutation that then threw, so the room rolled back and the escalation went with it — a lane
stopping silently, which is the one thing Phase 2 rules out. Work that has to outlive its own
refusal now travels on the error and is applied afterwards, against state that still exists.

**Cost, said honestly (Q15).** `CostReport` has no `total` field and cannot grow one without
somebody deciding to lie. Reported token counts, quota levels and metered spend sit on separate
lines with separate units, each carrying how much it is worth in words. A quota nearly gone reaches
a person before it runs out mid-lane, because that is the one that actually stops work.

**What the open boxes mean.** *Permissions mirrored from GitHub*: the line is built and enforced on
every action; which side of it a person is on is set when they are added rather than read from the
GitHub API. That is the same unbuilt shell as Phase 1 — credentials and a public endpoint, not more
design. *Metered cost*: the shape is there and the tool reports through it, but "metered" means
Agora brokered the call and counted it, and Agora does not broker anyone's calls. It is left
labelled and empty rather than filled with a plausible number.

### Phase 4 — scale

- Multi-repo rooms with ordered landing (Q17)
- Repetitive work, if the need shows up (Q19)
- Agora brokering calls, which is the only thing that makes "metered" real (Q15)

**Passes when** a front-end and a back-end repo ship one contract together, and the failure case is
loud rather than half-landed and quiet.

## The bet, stated plainly

That contract-level review catches most of what matters, and a human ruling on shape and
interfaces is a better use of the scarcest resource in the system than a human reading three
thousand lines. If that is false, Agora ships coordinated mistakes faster than anyone has shipped
them before. Phase 1's test is the first place it can fail, and it should be run adversarially.
