import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openRoom } from '../src/index.ts';
import { MergeGate } from '../src/gate/gate.ts';
import { checkout, git, openRepo } from '../src/git/repo.ts';
import type { Repo } from '../src/git/repo.ts';
import { hasOpenedToRoom, longestWait, queueFor, unanswered } from '../src/room/attention.ts';
import { REWRITE_THRESHOLD } from '../src/room/spin.ts';
import { refusal } from './helpers.ts';
import type { RoomService } from '../src/room/service.ts';

/**
 * Phase 2's acceptance test.
 *
 * "Nobody looks at the room for two hours, and nothing stalls silently, nothing
 * merges silently, and the log explains every minute of it."
 *
 * Two agents, one contract, one person who is asleep. Everything that can go
 * wrong in two unattended hours goes wrong here: two agents in the same file, a
 * lane going in circles, a contract one side says the other broke, and a risky
 * surface nobody has looked at. None of it may pass quietly in either
 * direction.
 *
 * On the clock: the room reads the wall clock, so the two hours are not slept
 * through. Everything that turns on time — whose queue an item sits in, how
 * long it has waited — is asked of the pure layer with `twoHoursOn` passed in,
 * which is the same arithmetic the service does with `Date.now()`.
 */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

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
  const dir = await mkdtemp(join(tmpdir(), 'agora-phase2-'));
  scratch.push(dir);
  const repo = openRepo(dir);
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@agora.invalid']);
  await git(repo, ['config', 'user.name', 'Agora Test']);
  await write(repo, 'README.md', 'login\n');
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
  startedAt: number;
}

/** A room nobody is watching: two lanes, one contract, one sleeping person. */
async function unattendedRoom(): Promise<Stage> {
  const repo = await project();
  const service = await openRoom({
    file: null,
    name: 'Login rebuild',
    goal: 'Replace the login flow and the session store behind it.'
  });
  await service.addAgent({ id: 'claude', displayName: 'Claude', provider: 'claude-code', role: 'lead' });
  await service.addAgent({ id: 'cursor', displayName: 'Cursor', provider: 'cursor', role: 'peer' });

  await service.claimTask('claude', { taskId: 'plan' });
  await service.submitWork('claude', {
    taskId: 'plan',
    summary: 'The page and the store, meeting at the session contract.',
    outcome: 'needs-review',
    plan: {
      summary: 'Claude takes the login page, Cursor the session store.',
      tasks: [
        {
          key: 'login',
          title: 'Login page',
          paths: ['src/auth/**'],
          suggestedOwner: 'claude',
          evidence: 'A good password reaches the dashboard; a bad one shows the 401 text.',
          actionBudget: 60
        },
        {
          key: 'sessions',
          title: 'Session store',
          paths: ['src/session/**'],
          suggestedOwner: 'cursor',
          evidence: 'A session issued now is still valid in an hour and gone in a day.',
          actionBudget: 60
        }
      ],
      seams: [
        {
          title: 'The session token',
          body: 'createSession(userId) returns {token, expiresIn} where expiresIn is seconds.',
          between: ['login', 'sessions'],
          contract: [
            { task: 'login', provides: 'A verified userId.', expects: '{token, expiresIn} in seconds.' },
            { task: 'sessions', provides: '{token, expiresIn} in seconds.', expects: 'A verified userId.' }
          ]
        }
      ]
    }
  });
  await service.approvePlan('Good split.');

  // Two people, one of whom cannot merge. Both go to sleep immediately.
  await service.addHuman({ id: 'priya', displayName: 'Priya', canMerge: true });
  await service.addHuman({ id: 'jun', displayName: 'Jun', canMerge: false });

  const room = service.snapshot();
  const login = room.tasks.find((task) => task.title === 'Login page')?.id as string;
  const sessions = room.tasks.find((task) => task.title === 'Session store')?.id as string;
  const seamId = room.decisions.find((decision) => decision.kind === 'seam')?.id as string;

  await service.assignLaneOwner(login, 'priya');
  await service.assignLaneOwner(sessions, 'priya');
  await service.claimTask('claude', { taskId: login });
  await service.claimTask('cursor', { taskId: sessions });

  const gate = new MergeGate(service, { repo, baseBranch: 'main' });
  await gate.openLane(login);
  await gate.openLane(sessions);

  return { repo, service, gate, login, sessions, seamId, startedAt: Date.now() };
}

/** Everything two unattended hours can throw at the room. */
async function twoUnattendedHours(s: Stage): Promise<void> {
  // 1. Both lanes start honestly.
  await s.service.claimFile('claude', { path: 'src/auth/LoginPage.tsx', laneId: s.login });
  await s.service.claimFile('cursor', { path: 'src/session/store.ts', laneId: s.sessions });

  // 2. Cursor reaches for a file Claude is writing right now.
  await refusal(
    () => s.service.claimFile('cursor', { path: 'src/auth/LoginPage.tsx', laneId: s.sessions }),
    'LIVE_COLLISION'
  );

  // 3. Claude goes in circles on its own file, and says the same thing twice.
  for (let i = 0; i < REWRITE_THRESHOLD; i += 1) {
    await s.service.claimFile('claude', { path: 'src/auth/LoginPage.tsx', laneId: s.login });
  }
  await s.service.answerProbe('claude', { laneId: s.login, missing: 'the 401 copy' });
  await s.service.checkForSpin(s.login);
  await s.service.answerProbe('claude', { laneId: s.login, missing: 'the 401 copy' });
  await s.service.checkForSpin(s.login);

  // 4. Both lanes finish and submit. Both touch authentication.
  await workOn(
    s.repo,
    `agora/${s.sessions}`,
    { 'src/session/store.ts': 'export const createSession = () => ({ token: "t", expiresIn: 3600 });\n' },
    'session store'
  );
  await s.service.submitWork('cursor', {
    taskId: s.sessions,
    summary: 'Returns {token, expiresIn} in seconds.',
    outcome: 'complete',
    filesChanged: ['src/session/store.ts'],
    seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Seconds, as agreed.' }]
  });
  await s.service.produceEvidence('cursor', {
    taskId: s.sessions,
    note: 'Valid at +1h, gone at +24h.'
  });

  await workOn(
    s.repo,
    `agora/${s.login}`,
    { 'src/auth/LoginPage.tsx': 'export const LoginPage = () => null; // expiresIn read as ms\n' },
    'login page'
  );
  await s.service.submitWork('claude', {
    taskId: s.login,
    summary: 'Posts the credentials and stores what comes back.',
    outcome: 'complete',
    filesChanged: ['src/auth/LoginPage.tsx'],
    seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Reads {token, expiresIn}.' }]
  });
  await s.service.produceEvidence('claude', {
    taskId: s.login,
    note: 'Good password reaches the dashboard; bad one shows the 401 text.'
  });

  // 5. Each side reads the other. Cursor finds the contract broken.
  await s.service.reviewLane('claude', {
    laneId: s.sessions,
    verdict: 'holds',
    note: 'expiresIn is seconds, as the contract says.'
  });
  await s.service.reviewLane('cursor', {
    laneId: s.login,
    verdict: 'breaks',
    note: 'It treats expiresIn as milliseconds. Sessions will look expired the moment they are issued.'
  });
}

describe('Phase 2 — two hours with nobody watching', () => {
  it('lands nothing while a person is still owed an answer', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);

    for (const laneId of [s.login, s.sessions]) {
      const landing = await s.gate.land(laneId);
      assert.notEqual(landing.verdict, 'merge', `"${laneId}" must not land unattended`);
      assert.deepEqual(landing.landed, []);
    }

    // And the repository proves it, rather than the room claiming it.
    await checkout(s.repo, 'main');
    const { stdout } = await git(s.repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
    const onMain = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(onMain, ['README.md'], 'nothing reached main while nobody was looking');
  });

  it('refuses for the reasons a person could act on, not a generic one', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);

    const decision = await s.gate.evaluate(s.login);
    assert.equal(decision.verdict, 'refuse');
    const codes = decision.reasons.map((reason) => reason.code);

    assert.ok(codes.includes('cross-review-breaks'), 'the agent across the contract said no');
    assert.ok(codes.includes('risk-unsigned'), 'authentication is on the risk list');
    const broke = decision.reasons.find((reason) => reason.code === 'cross-review-breaks');
    assert.match(broke?.detail ?? '', /milliseconds/, 'and it says what is actually wrong');

    // The other lane is clean on its own merits and still does not land, because
    // it shares a contract with one that is not.
    const partner = await s.gate.evaluate(s.sessions);
    assert.equal(partner.verdict, 'refuse');
    assert.ok(
      partner.reasons.every((reason) => reason.code === 'risk-unsigned'),
      'its only outstanding item is the one a person owes it'
    );
  });

  it('leaves nothing stalled without a person named on it', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);

    const open = unanswered(s.service.snapshot().attention);
    const kinds = new Set(open.map((item) => item.kind));
    assert.ok(kinds.has('collision'), 'two agents in one file is a planning problem, not a retry');
    assert.ok(kinds.has('stuck'), 'a lane rewriting one file forever has to reach a person');
    assert.ok(kinds.has('ruling'), 'two agents cannot settle a contract between themselves');
    assert.ok(kinds.has('review'), 'a risky surface pulls a person in');

    for (const item of open) {
      assert.ok(item.detail.trim().length > 0, `${item.id} must say what happened`);
      assert.ok(item.options.length > 0, `${item.id} must be answerable from the notification`);
      assert.ok(
        item.options.every((option) => option.effect.trim().length > 0),
        `${item.id} must say what each answer does`
      );
      assert.ok(item.assignedTo !== null, `${item.id} must have a name on it`);
      assert.ok(item.opensToRoomAt !== null, `${item.id} must have a deadline on that name`);
    }
  });

  it('has opened every one of them to the room by the time anyone wakes up', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);
    const twoHoursOn = s.startedAt + TWO_HOURS_MS;

    const open = unanswered(s.service.snapshot().attention);
    assert.ok(
      open.every((item) => hasOpenedToRoom(item, twoHoursOn)),
      'a named person asleep for two hours is a dead lane; the fifteen minutes expire'
    );

    // Anyone can now pick them up, subject only to merge rights (Q16).
    const jun = queueFor(s.service.snapshot().attention, { id: 'jun', canMerge: false }, twoHoursOn);
    const priya = queueFor(
      s.service.snapshot().attention,
      { id: 'priya', canMerge: true },
      twoHoursOn
    );
    assert.deepEqual(jun.waiting, [], 'nothing is still being held for someone else');
    assert.ok(priya.yours.length > 0, 'the named person still sees them as hers');
    assert.ok(
      jun.room.length < priya.yours.length + priya.room.length,
      'and the things that change what merges stay off the queue of someone who cannot'
    );
    assert.ok(longestWait(s.service.snapshot().attention, twoHoursOn) >= TWO_HOURS_MS * 0.9);
  });

  it('can account for the whole two hours afterwards', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);

    const answer = s.service.provenance({ kind: 'file', path: 'src/auth/LoginPage.tsx' });
    assert.match(answer.headline, new RegExp(s.login));

    const kinds = new Set(answer.entries.map((entry) => entry.kind));
    for (const expected of ['plan', 'contract', 'claim', 'submission', 'review', 'evidence']) {
      assert.ok(kinds.has(expected as never), `the chain has to include ${expected}`);
    }
    assert.ok(
      answer.entries.every((entry) => entry.because.trim().length > 0),
      'every entry says why it is part of the answer'
    );
    assert.ok(
      answer.openQuestions.length > 0,
      'and it is just as clear about what is still unsettled'
    );

    // Every open question has an event behind it. Nothing appeared without the
    // log saying so.
    const raised = s.service
      .snapshot()
      .events.filter((event) => event.type === 'attention.raised');
    assert.equal(raised.length, unanswered(s.service.snapshot().attention).length);
    assert.ok(raised.every((event) => event.summary.trim().length > 0));
  });
});

describe('Phase 2 — and then somebody wakes up', () => {
  it('lets one person clear it all from the notifications, and only then lands it', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);

    const answer = async (kind: string, optionId: string, note: string): Promise<void> => {
      const item = unanswered(s.service.snapshot().attention).find(
        (candidate) => candidate.kind === kind
      );
      assert.ok(item, `expected something of kind "${kind}" to still be waiting`);
      await s.service.answerAttention('priya', { itemId: item.id, optionId, note });
    };

    await answer('collision', 'wait', 'Claude finishes the page first.');
    await answer('stuck', 'unblock', 'The 401 copy is "That password is not right."');
    await answer('ruling', 'side-with-reviewer', 'Cursor is right: expiresIn is seconds.');

    // Siding with the reviewer means the lane does the work again.
    await s.service.reopenTask(s.login, true);
    await workOn(
      s.repo,
      `agora/${s.login}`,
      { 'src/auth/LoginPage.tsx': 'export const LoginPage = () => null; // expiresIn is seconds\n' },
      'read expiresIn as seconds'
    );
    await s.service.submitWork('claude', {
      taskId: s.login,
      summary: 'expiresIn is read as seconds now.',
      outcome: 'complete',
      filesChanged: ['src/auth/LoginPage.tsx'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Seconds.' }]
    });

    // The old review was of code that no longer exists, so it does not count.
    const stale = await s.gate.evaluate(s.login);
    assert.ok(
      stale.reasons.some((reason) => reason.code === 'cross-review-stale'),
      'a review survives only as long as the code it read'
    );

    await s.service.reviewLane('cursor', {
      laneId: s.login,
      verdict: 'holds',
      note: 'Seconds now. It matches.'
    });

    // Both lanes still touch authentication, and nobody has looked at either.
    const beforeSignOff = await s.gate.land(s.login);
    assert.notEqual(beforeSignOff.verdict, 'merge');
    assert.ok(
      beforeSignOff.decision.reasons.some((reason) => reason.code === 'risk-unsigned'),
      'the risk list does not care that the agents agree with each other'
    );

    for (const item of unanswered(s.service.snapshot().attention)) {
      if (item.kind !== 'review') continue;
      await s.service.answerAttention('priya', {
        itemId: item.id,
        optionId: 'approve',
        note: 'Read both sides of the token handling.'
      });
    }

    const landing = await s.gate.land(s.login);
    assert.equal(landing.verdict, 'merge');
    assert.deepEqual(
      landing.landed.sort(),
      [s.login, s.sessions].sort(),
      'lanes sharing a contract land as a set'
    );

    await checkout(s.repo, 'main');
    const { stdout } = await git(s.repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
    const onMain = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.ok(onMain.includes('src/auth/LoginPage.tsx'));
    assert.ok(onMain.includes('src/session/store.ts'));
    assert.deepEqual(unanswered(s.service.snapshot().attention), [], 'and the queue is empty');
  });

  it('does not carry a sign-off over to code the person never saw', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);

    const risk = unanswered(s.service.snapshot().attention).find(
      (item) => item.kind === 'review' && item.laneId === s.sessions
    );
    assert.ok(risk);
    await s.service.answerAttention('priya', {
      itemId: risk.id,
      optionId: 'approve',
      note: 'Looked at the store.'
    });
    assert.ok(
      (await s.gate.evaluate(s.sessions)).reasons.every(
        (reason) => reason.code !== 'risk-unsigned'
      ),
      'what she signed is cleared'
    );

    // The lane then changes the very code she signed off on.
    await s.service.reopenTask(s.sessions, true);
    await workOn(
      s.repo,
      `agora/${s.sessions}`,
      { 'src/session/store.ts': 'export const createSession = () => ({ token: "t", expiresIn: 86400 });\n' },
      'longer sessions'
    );
    await s.service.submitWork('cursor', {
      taskId: s.sessions,
      summary: 'Sessions now last a day.',
      outcome: 'complete',
      filesChanged: ['src/session/store.ts'],
      seamChecks: [{ decisionId: s.seamId, satisfied: true, note: 'Still seconds.' }]
    });

    assert.ok(
      (await s.gate.evaluate(s.sessions)).reasons.some((reason) => reason.code === 'risk-unsigned'),
      'a sign-off covers one submission, not a lane forever'
    );
  });

  it('refuses to let someone without merge rights settle what merges', async () => {
    const s = await unattendedRoom();
    await twoUnattendedHours(s);

    const ruling = unanswered(s.service.snapshot().attention).find(
      (item) => item.kind === 'ruling'
    );
    assert.ok(ruling);
    const error = await refusal(
      () =>
        s.service.answerAttention('jun', {
          itemId: ruling.id,
          optionId: 'side-with-reviewer',
          note: 'Seems right.'
        }),
      'UNAUTHORIZED'
    );
    assert.match(error.message, /merge rights/);
  });
});
