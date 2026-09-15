import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { roomWithApprovedPlan } from './helpers.ts';

/**
 * Provenance (Q26): "why is this the way it is".
 *
 * Not time travel and not a transcript. One question about one thing, answered
 * from what the room already stores — the plan that made the lane, the contract
 * it was built toward, every amendment, who ruled on what, and every objection
 * that was filed anyway.
 */

/** A room where a contract moved, a person ruled, and an agent objected. */
async function history(): Promise<
  Awaited<ReturnType<typeof roomWithApprovedPlan>> & { path: string }
> {
  const room = await roomWithApprovedPlan();
  await room.service.setRiskList([]);
  await room.service.addHuman({ id: 'priya', displayName: 'Priya', canMerge: true });
  await room.service.assignLaneOwner(room.ui, 'priya');
  await room.service.claimTask(room.claude, { taskId: room.ui });
  await room.service.claimTask(room.cursor, { taskId: room.api });
  await room.service.claimFile(room.claude, { path: 'src/auth/AuthPage.tsx', laneId: room.ui });

  await room.service.submitWork(room.claude, {
    taskId: room.ui,
    summary: 'Form posts and renders both states.',
    outcome: 'complete',
    filesChanged: ['src/auth/AuthPage.tsx'],
    seamChecks: [{ decisionId: room.seamId, satisfied: true, note: 'Posts {email, password}.' }]
  });

  await room.service.recordDissent(room.claude, {
    about: `Ruling on ${room.seamId}: the token lives for 24 hours.`,
    because: 'A provisioning token over an hour cannot pass our security review.',
    laneId: room.ui
  });

  await room.service.amendSeam(room.seamId, {
    body: 'Request {email, password}. Response 200 {ok:true, token, expiresIn} or 401 {ok:false, error}.'
  });

  await room.service.produceEvidence(room.claude, {
    taskId: room.ui,
    note: 'Signed in as a known user and reached the dashboard.'
  });

  return { ...room, path: 'src/auth/AuthPage.tsx' };
}

describe('why is this file the way it is', () => {
  it('names the lane that owns it and who has been writing it', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'file', path: room.path });

    assert.match(answer.headline, new RegExp(room.ui));
    const claim = answer.entries.find((entry) => entry.kind === 'claim');
    assert.ok(claim, 'a file is written by whoever holds it');
    assert.equal(claim.by, room.claude);
  });

  it('carries the contract, the amendment, the objection and the evidence', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'file', path: room.path });
    const kinds = new Set(answer.entries.map((entry) => entry.kind));

    assert.ok(kinds.has('plan'), 'every lane starts as a line in an approved plan');
    assert.ok(kinds.has('contract'));
    assert.ok(kinds.has('amendment'), 'moving a contract moves what the lane had to build');
    assert.ok(kinds.has('dissent'), 'an objection is part of why this looks the way it does');
    assert.ok(kinds.has('evidence'));
  });

  it('tells the story oldest first', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'file', path: room.path });
    const times = answer.entries.map((entry) => Date.parse(entry.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it('says every entry is here for a reason', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'file', path: room.path });
    assert.ok(answer.entries.length > 0);
    assert.ok(
      answer.entries.every((entry) => entry.because.trim().length > 0),
      'an entry that cannot say why it is in the answer is noise'
    );
  });

  it('is honest about a file no lane owns', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'file', path: 'src/util/format.ts' });
    assert.match(answer.headline, /No lane owns/);
    assert.deepEqual(answer.entries, []);
  });
});

describe('why is this contract the way it is', () => {
  it('shows the version it started at and every move since', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'contract', seamId: room.seamId });

    assert.match(answer.headline, /v2/);
    const first = answer.entries[0];
    assert.equal(first?.kind, 'contract', 'the contract as first written comes first');
    assert.ok(answer.entries.some((entry) => entry.kind === 'amendment'));
  });

  it('shows which side signed which version', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'contract', seamId: room.seamId });
    const signature = answer.entries.find((entry) => entry.kind === 'submission');
    assert.ok(signature);
    assert.match(signature.what, /signed v1/);
    assert.match(signature.because, /one version of the contract/);
  });

  it('keeps the objection next to the contract it was about', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'contract', seamId: room.seamId });
    const dissent = answer.entries.find((entry) => entry.kind === 'dissent');
    assert.ok(dissent, 'someone built to this while saying it was wrong');
    assert.match(dissent.what, /security review/);
  });

  it('says so when there is no such contract', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'contract', seamId: 'dec_nope' });
    assert.match(answer.headline, /no contract/);
  });
});

describe('why is this lane the way it is', () => {
  it('leads with where the lane stands and who answers for it', async () => {
    const room = await history();
    const answer = room.service.provenance({ kind: 'lane', laneId: room.ui });
    assert.match(answer.headline, /submitted/);
    assert.match(answer.headline, /priya/);
  });

  it('lists what is still unsettled, rather than only what was', async () => {
    const room = await history();
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'No session secret in the environment.',
      outcome: 'blocked',
      filesChanged: []
    });
    const answer = room.service.provenance({ kind: 'lane', laneId: room.api });
    assert.equal(answer.openQuestions.length, 1);
    assert.match(answer.openQuestions[0] ?? '', /stopped itself/);
  });

  it('records the ruling once a person has settled it', async () => {
    const room = await history();
    await room.service.assignLaneOwner(room.api, 'priya');
    await room.service.submitWork(room.cursor, {
      taskId: room.api,
      summary: 'Needs a decision on rounding.',
      outcome: 'blocked',
      filesChanged: []
    });
    const item = room.service.attentionFor('priya').yours.find((entry) => entry.kind === 'blocked');
    assert.ok(item);
    await room.service.answerAttention('priya', {
      itemId: item.id,
      optionId: 'answer',
      note: 'Round the line, then sum.'
    });

    const answer = room.service.provenance({ kind: 'lane', laneId: room.api });
    const ruling = answer.entries.find((entry) => entry.kind === 'ruling');
    assert.ok(ruling, 'the lane carried on from here, so this is part of why');
    assert.match(ruling.what, /Round the line/);
    assert.equal(ruling.by, 'priya');
    assert.deepEqual(answer.openQuestions, []);
  });
});
