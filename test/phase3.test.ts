import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openRoom } from '../src/index.ts';
import { MergeGate } from '../src/gate/gate.ts';
import { checkout, git, openRepo } from '../src/git/repo.ts';
import type { Repo } from '../src/git/repo.ts';
import { OPENS_TO_ROOM_AFTER_MS, queueFor, unanswered } from '../src/room/attention.ts';
import { seedContracts } from '../src/room/close.ts';
import { OWNER_ID } from '../src/room/seed.ts';
import { refusal } from './helpers.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * Phase 3's acceptance test.
 *
 * "A second person picks up a room cold and rules correctly on the first thing
 * that needs them."
 *
 * The word doing the work is *correctly*. Anyone can answer a question with
 * three buttons on it; the test is whether the room told them enough to pick
 * the right one. So the question is built to have a wrong answer that looks
 * right:
 *
 *   The contract says expiresIn is in seconds. The login lane treats it as
 *   milliseconds, and the agent across the contract says — correctly — that
 *   this breaks it. Siding with the reviewer is the obvious call, and it is
 *   wrong: the lane built milliseconds because a person in this room ruled
 *   that it should, and the agent said at the time that it disagreed. The
 *   contract and the ruling contradict each other. Nobody who reads only the
 *   notification can know that.
 *
 * Everything the second person needs is in the room already: the ledger says
 * which lane and why, provenance says how it got that way, and Q22's dissent is
 * the thing that makes the earlier ruling visible as a ruling rather than as a
 * fact. If any of those is missing, they side with the reviewer and make an
 * agent redo work a person told it to do.
 */

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function write(repo: Repo, path: string, body: string): Promise<void> {
  const full = join(repo.root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

async function workOn(
  repo: Repo,
  branch: string,
  files: Record<string, string>,
  message: string
): Promise<void> {
  await checkout(repo, branch);
  for (const [path, body] of Object.entries(files)) await write(repo, path, body);
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', message]);
}

async function project(): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-phase3-'));
  scratch.push(dir);
  const repo = openRepo(dir);
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@agora.invalid']);
  await git(repo, ['config', 'user.name', 'Agora Test']);
  await write(repo, 'README.md', 'sessions\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'base']);
  return repo;
}

interface Stage {
  repo: Repo;
  service: RoomService;
  gate: MergeGate;
  login: string;
  sessions: string;
  seamId: string;
  openedAt: number;
}

/**
 * A room Priya ran for a while and then walked away from, leaving one question
 * that cannot be answered from the question alone.
 */
async function roomPriyaLeftBehind(): Promise<Stage> {
  const repo = await project();
  const service = await openRoom({
    file: null,
    name: 'Session rework',
    goal: 'Move sessions onto short-lived tokens.',
    owner: { id: 'priya', displayName: 'Priya' }
  });
  await service.setRiskList('priya', []);
  await service.addAgent('priya', { id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' });
  await service.addAgent('priya', { id: 'cursor', displayName: 'Cursor', provider: 'cursor', role: 'peer' });

  await service.claimTask('claude', { taskId: 'plan' });
  await service.submitWork('claude', {
    taskId: 'plan',
    summary: 'The login page and the session store, meeting at the token.',
    outcome: 'needs-review',
    plan: {
      summary: 'Claude takes login, Cursor the store.',
      tasks: [
        {
          key: 'login',
          title: 'Login page',
          paths: ['src/login/**'],
          suggestedOwner: 'claude',
          evidence: 'A signed-in session is still good after a refresh.',
          actionBudget: 60
        },
        {
          key: 'sessions',
          title: 'Session store',
          paths: ['src/store/**'],
          suggestedOwner: 'cursor',
          evidence: 'A session issued now expires when the contract says it does.',
          actionBudget: 60
        }
      ],
      seams: [
        {
          title: 'The session token',
          body: 'createSession(userId) returns {token, expiresIn}. expiresIn is in SECONDS.',
          between: ['login', 'sessions'],
          contract: [
            { task: 'login', provides: 'A verified userId.', expects: '{token, expiresIn} in seconds.' },
            { task: 'sessions', provides: '{token, expiresIn} in seconds.', expects: 'A verified userId.' }
          ]
        }
      ]
    }
  });
  await service.approvePlan('priya', 'Good split.');

  const room = service.snapshot();
  const login = room.tasks.find((task) => task.title === 'Login page')?.id as string;
  const sessions = room.tasks.find((task) => task.title === 'Session store')?.id as string;
  const seamId = room.decisions.find((decision) => decision.kind === 'seam')?.id as string;

  await service.assignLaneOwner('priya', login, 'priya');
  await service.assignLaneOwner('priya', sessions, 'priya');
  await service.claimTask('claude', { taskId: login });
  await service.claimTask('cursor', { taskId: sessions });

  const gate = new MergeGate(service, { repo, baseBranch: 'main' });
  await gate.openLane(login);
  await gate.openLane(sessions);

  // Claude stops to ask which unit expiresIn is in. Priya rules: milliseconds.
  // She is wrong — the contract she approved says seconds — and this is the
  // fact the whole test turns on.
  await service.submitWork('claude', {
    taskId: login,
    summary: 'Is expiresIn seconds or milliseconds? The store and the contract read differently to me.',
    outcome: 'blocked',
    filesChanged: []
  });
  const question = service.attentionFor('priya').yours.find((item) => item.kind === 'blocked');
  assert.ok(question);
  await service.answerAttention('priya', {
    itemId: question.id,
    optionId: 'answer',
    note: 'expiresIn is milliseconds. Build it that way.'
  });

  // Claude complies and says on the record that it thinks this is wrong (Q22).
  await service.recordDissent('claude', {
    about: 'Ruling: expiresIn is milliseconds.',
    because: 'The contract for the session token says seconds, in capitals. One of them has to move.',
    laneId: login
  });

  // Both lanes do the work. Claude builds what it was told to build.
  await service.reopenTask('priya', login, true);
  await service.claimFile('claude', { path: 'src/login/LoginPage.tsx', laneId: login });
  await workOn(
    repo,
    `agora/${login}`,
    { 'src/login/LoginPage.tsx': 'export const expiresInMs = (s: number) => s; // ms, as ruled\n' },
    'login page'
  );
  await service.submitWork('claude', {
    taskId: login,
    summary: 'Treats expiresIn as milliseconds, as ruled.',
    outcome: 'complete',
    filesChanged: ['src/login/LoginPage.tsx'],
    seamChecks: [{ decisionId: seamId, satisfied: true, note: 'Reads {token, expiresIn}.' }]
  });
  await service.produceEvidence('claude', {
    taskId: login,
    note: 'Session survives a refresh.'
  });

  await service.claimFile('cursor', { path: 'src/store/session.ts', laneId: sessions });
  await workOn(
    repo,
    `agora/${sessions}`,
    { 'src/store/session.ts': 'export const createSession = () => ({ token: "t", expiresIn: 3600 });\n' },
    'session store'
  );
  await service.submitWork('cursor', {
    taskId: sessions,
    summary: 'Returns expiresIn in seconds, per the contract.',
    outcome: 'complete',
    filesChanged: ['src/store/session.ts'],
    seamChecks: [{ decisionId: seamId, satisfied: true, note: 'Seconds.' }]
  });
  await service.produceEvidence('cursor', {
    taskId: sessions,
    note: 'Issued session expires at exactly 3600s.'
  });

  // Each side reads the other. Cursor is right about the contract.
  await service.reviewLane('claude', {
    laneId: sessions,
    verdict: 'holds',
    note: 'It returns what the contract says it returns.'
  });
  await service.reviewLane('cursor', {
    laneId: login,
    verdict: 'breaks',
    note: 'It reads expiresIn as milliseconds. The contract says seconds, so every session is 1000x short.'
  });

  // And Priya goes dark.
  return { repo, service, gate, login, sessions, seamId, openedAt: Date.now() };
}

/** Sam has never seen this room. Somebody adds him; that is all he gets. */
async function samArrives(s: Stage, canMerge = true): Promise<void> {
  await s.service.addHuman('priya', { id: 'sam', displayName: 'Sam', canMerge });
}

describe('Phase 3 — a second person picks the room up cold', () => {
  it('shows him which lane needs him, at the top, without being asked', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s);

    const rows = s.service.ledger();
    assert.equal(rows[0]?.laneId, s.login, 'the problem leads the table');
    assert.equal(rows[0]?.health, 'needs-a-person');
    assert.match(rows[0]?.blockedOn ?? '', /across the contract says it breaks/);

    // And the lane that is merely waiting is not competing for his attention.
    const other = rows.find((row) => row.laneId === s.sessions);
    assert.notEqual(other?.health, 'needs-a-person');
  });

  it('puts the question in his hands once the named person has gone quiet', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s);
    const later = s.openedAt + OPENS_TO_ROOM_AFTER_MS + 1000;

    const queue = queueFor(s.service.snapshot().attention, { id: 'sam', canMerge: true }, later);
    const ruling = [...queue.yours, ...queue.room].find((item) => item.kind === 'ruling');
    assert.ok(ruling, 'a question nobody can reach is a dead lane');
    assert.deepEqual(ruling.options.map((option) => option.id), [
      'side-with-reviewer',
      'side-with-lane',
      'amend'
    ]);
  });

  it('gives him everything he needs to know the obvious answer is wrong', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s);

    const lane = s.service.provenance({ kind: 'lane', laneId: s.login });

    // The earlier ruling, which is why the lane is the way it is.
    const ruling = lane.entries.find((entry) => entry.kind === 'ruling');
    assert.ok(ruling, 'a lane that did what it was told must say who told it');
    assert.match(ruling.what, /milliseconds/);
    assert.equal(ruling.by, 'priya');

    // The objection filed at the time, which is what makes that ruling visible
    // as a ruling rather than as a fact about the world (Q22).
    const dissent = lane.entries.find((entry) => entry.kind === 'dissent');
    assert.ok(dissent, 'without this, the second person cannot tell a ruling from a fact');
    assert.match(dissent.what, /contract for the session token says seconds/);

    // And the contract itself, which still says the opposite.
    const contract = s.service.provenance({ kind: 'contract', seamId: s.seamId });
    assert.match(contract.entries[0]?.what ?? '', /SECONDS/);

    // The two are in the same story, in the order they happened.
    const times = lane.entries.map((entry) => Date.parse(entry.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it('refuses the ruling to someone without merge rights, and says what they can do', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s, false);
    const ruling = unanswered(s.service.snapshot().attention).find((item) => item.kind === 'ruling');
    assert.ok(ruling);

    const error = await refusal(
      () => s.service.answerAttention('sam', { itemId: ruling.id, optionId: 'side-with-reviewer' }),
      'UNAUTHORIZED'
    );
    assert.match(error.message, /merge rights/);
    assert.match(error.message, /pausing, redirecting, answering/);
  });

  it('lets him rule correctly, and the room carries it out', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s);

    const ruling = unanswered(s.service.snapshot().attention).find((item) => item.kind === 'ruling');
    assert.ok(ruling);

    // It is named to Priya, who is not here. He says he has it rather than
    // waiting out a timer built for someone who is asleep.
    const taken = await s.service.takeAttention('sam', {
      itemId: ruling.id,
      because: 'Priya is out; I can read this now.'
    });
    assert.equal(taken.item.assignedTo, 'sam');
    assert.match(taken.message, /Priya has been told/);

    // Neither agent is wrong. The contract and an earlier ruling contradict
    // each other, and only a person can settle that.
    await s.service.answerAttention('sam', {
      itemId: ruling.id,
      optionId: 'amend',
      note: 'Priya ruled milliseconds; the contract says seconds. The contract is what everyone builds against, so it wins — and Claude was right to say so.'
    });

    await s.service.amendSeam('sam', s.seamId, {
      body:
        'createSession(userId) returns {token, expiresIn}. expiresIn is in SECONDS. ' +
        'Callers convert; the store never returns milliseconds.'
    });

    // Amending it takes both sides stale, which is the point of Q14.
    const decision = await s.gate.evaluate(s.login);
    assert.equal(decision.verdict, 'refuse');
    assert.ok(decision.reasons.some((reason) => reason.code === 'seam-stale'));

    // Claude redoes its side against the contract as it now stands.
    await s.service.reopenTask('sam', s.login, true);
    await workOn(
      s.repo,
      `agora/${s.login}`,
      { 'src/login/LoginPage.tsx': 'export const expiresInMs = (s: number) => s * 1000;\n' },
      'seconds, converted at the edge'
    );
    await s.service.submitWork('claude', {
      taskId: s.login,
      summary: 'Reads seconds and converts at the edge.',
      outcome: 'complete',
      filesChanged: ['src/login/LoginPage.tsx'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Seconds in, ms at the edge.' }]
    });
    await s.service.reopenTask('sam', s.sessions, true);
    await s.service.submitWork('cursor', {
      taskId: s.sessions,
      summary: 'Unchanged; re-signed against v2.',
      outcome: 'complete',
      filesChanged: ['src/store/session.ts'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Still seconds.' }]
    });
    await s.service.reviewLane('cursor', {
      laneId: s.login,
      verdict: 'holds',
      note: 'Seconds now. It matches.'
    });
    await s.service.reviewLane('claude', {
      laneId: s.sessions,
      verdict: 'holds',
      note: 'Unchanged and still right.'
    });

    const landing = await s.gate.land(s.login);
    assert.equal(landing.verdict, 'merge', landing.summary);
    assert.deepEqual(landing.landed.sort(), [s.login, s.sessions].sort());

    await checkout(s.repo, 'main');
    const { stdout } = await git(s.repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
    assert.ok(stdout.includes('src/login/LoginPage.tsx'));
    assert.ok(stdout.includes('src/store/session.ts'));
  });
});

describe('Phase 3 — and the room ends', () => {
  it('will not close until the work is actually done, then closes on his word', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s);

    // Nothing is settled yet, so nothing closes.
    const early = s.service.closeReadiness([s.login, s.sessions]);
    assert.equal(early.ready, false);
    assert.ok(early.blockers.some((blocker) => blocker.kind === 'question-open'));

    const ruling = unanswered(s.service.snapshot().attention).find((item) => item.kind === 'ruling');
    assert.ok(ruling);
    await s.service.takeAttention('sam', { itemId: ruling.id });
    await s.service.answerAttention('sam', {
      itemId: ruling.id,
      optionId: 'amend',
      note: 'The contract wins.'
    });
    await s.service.acceptTask('sam', s.login);
    await s.service.acceptTask('sam', s.sessions);

    const ready = s.service.closeReadiness([s.login, s.sessions]);
    assert.equal(ready.ready, true, ready.summary);

    const { room, archive } = await s.service.closeRoom('sam', {
      landed: [s.login, s.sessions],
      note: 'Shipped. The unit question is settled in the contract now.'
    });
    assert.equal(room.status, 'closed');
    assert.equal(room.closedBy, 'sam');
    assert.equal(archive.rulings.length, 2, 'both decisions are on the record');
  });

  it('hands the next room the contract, the version it took, and the objection', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s);

    const ruling = unanswered(s.service.snapshot().attention).find((item) => item.kind === 'ruling');
    assert.ok(ruling);
    await s.service.takeAttention('sam', { itemId: ruling.id });
    await s.service.answerAttention('sam', { itemId: ruling.id, optionId: 'amend', note: 'Contract wins.' });
    await s.service.amendSeam('sam', s.seamId, {
      body: 'createSession(userId) returns {token, expiresIn}. expiresIn is in SECONDS.'
    });
    await s.service.reopenTask('sam', s.login, true);
    await s.service.submitWork('claude', {
      taskId: s.login,
      summary: 'Converts at the edge.',
      outcome: 'complete',
      filesChanged: ['src/login/LoginPage.tsx'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Seconds.' }]
    });
    await s.service.reopenTask('sam', s.sessions, true);
    await s.service.submitWork('cursor', {
      taskId: s.sessions,
      summary: 'Re-signed.',
      outcome: 'complete',
      filesChanged: ['src/store/session.ts'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Seconds.' }]
    });
    await s.service.reviewLane('cursor', { laneId: s.login, verdict: 'holds', note: 'Matches.' });
    await s.service.reviewLane('claude', { laneId: s.sessions, verdict: 'holds', note: 'Matches.' });
    await s.service.acceptTask('sam', s.login);
    await s.service.acceptTask('sam', s.sessions);

    const { archive } = await s.service.closeRoom('sam', { landed: [s.login, s.sessions] });
    const carried = seedContracts([archive]);
    assert.equal(carried.length, 1);
    assert.equal(carried[0]?.versionsItTook, 2, 'it took an amendment to settle, and that is worth knowing');
    assert.match(carried[0]?.body ?? '', /SECONDS/);

    const next = await openRoom({
      file: null,
      name: 'Refresh tokens',
      goal: 'Add refresh tokens on top of sessions.',
      seededContracts: carried,
      seededFrom: archive.roomId
    });
    const plan = next.snapshot().tasks.find((task) => task.id === 'plan');
    assert.match(plan?.description ?? '', /SECONDS/, 'the next lead starts from what this room learned');
    assert.match(plan?.description ?? '', /starting point, not a/);
  });
});

describe('Phase 3 — several people, and the line between them', () => {
  it('lets the person who cannot merge do everything reversible, cold', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s, false);

    await s.service.pauseAgent('sam', 'claude', 'Reading this before it does anything else.');
    assert.equal(s.service.snapshot().agents.find((a) => a.id === 'claude')?.paused, true);
    await s.service.assignLaneOwner('sam', s.login, 'sam');
    assert.equal(s.service.snapshot().tasks.find((t) => t.id === s.login)?.laneOwner, 'sam');
    await s.service.resumeAgent('sam', 'claude');
  });

  it('shows him the room without showing him what he cannot act on', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s, false);
    const later = s.openedAt + OPENS_TO_ROOM_AFTER_MS + 1000;

    const queue = queueFor(s.service.snapshot().attention, { id: 'sam', canMerge: false }, later);
    assert.ok(
      [...queue.yours, ...queue.room, ...queue.waiting].every((item) => !item.needsMergeRights),
      'a queue full of things you cannot do is a queue you stop reading'
    );
  });

  it('attributes what each of them did, so the next person can tell them apart', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s);
    const ruling = unanswered(s.service.snapshot().attention).find((item) => item.kind === 'ruling');
    assert.ok(ruling);
    await s.service.takeAttention('sam', { itemId: ruling.id });
    await s.service.answerAttention('sam', { itemId: ruling.id, optionId: 'amend', note: 'Contract wins.' });

    const lane = s.service.provenance({ kind: 'lane', laneId: s.login });
    const rulings = lane.entries.filter((entry) => entry.kind === 'ruling');
    assert.deepEqual(rulings.map((entry) => entry.by), ['priya', 'sam']);
  });

  it('never let anyone widen their own rights along the way', async () => {
    const s = await roomPriyaLeftBehind();
    await samArrives(s, false);
    await refusal(
      () => s.service.createSupervisorToken('sam', 'a merge token for me', 'priya'),
      'UNAUTHORIZED'
    );
    assert.equal(s.service.humans().find((human) => human.id === 'sam')?.canMerge, false);
  });
});
