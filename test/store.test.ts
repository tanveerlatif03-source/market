import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EventBus } from '../src/events.ts';
import { AgoraStore } from '../src/store/store.ts';
import { RoomService } from '../src/room/service.ts';
import { createAgoraData, OWNER_ID } from '../src/room/seed.ts';
import { AUTH_PAGE_PLAN } from './helpers.ts';

const temporary: string[] = [];

async function scratchFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-'));
  temporary.push(dir);
  return join(dir, 'room.json');
}

after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

describe('the room on disk', () => {
  it('survives a restart with the plan, the seams and the board intact', async () => {
    const file = await scratchFile();
    const open = async (): Promise<RoomService> =>
      new RoomService(
        await AgoraStore.open(file, () => createAgoraData({ name: 'Auth page', goal: 'Ship a working auth page.' })),
        new EventBus()
      );

    const first = await open();
    const lead = await first.addAgent(OWNER_ID, {
      id: 'claude',
      displayName: 'Claude',
      provider: 'claude-code',
      role: 'lead'
    });
    await first.claimTask('claude', { taskId: 'plan' });
    await first.submitWork('claude', {
      taskId: 'plan',
      summary: 'Two lanes, one seam.',
      outcome: 'needs-review',
      plan: AUTH_PAGE_PLAN
    });
    await first.approvePlan(OWNER_ID);

    const second = await open();
    const room = second.snapshot();
    assert.equal(room.plan.status, 'approved');
    assert.equal(room.tasks.filter((task) => task.status === 'open').length, 2);
    assert.equal(room.decisions.filter((decision) => decision.kind === 'seam').length, 1);
    // Tokens outlive the process too, or every agent would have to be re-added.
    assert.equal(second.authenticate(lead.token)?.agentId, 'claude');
  });

  it('never writes a token in the clear', async () => {
    const file = await scratchFile();
    const service = new RoomService(
      await AgoraStore.open(file, () => createAgoraData({ name: 'Room', goal: 'Goal.' })),
      new EventBus()
    );
    const { token } = await service.addAgent(OWNER_ID, { displayName: 'Claude', provider: 'claude-code', role: 'lead' });
    const supervisorToken = await service.createSupervisorToken(OWNER_ID, 'human');

    const written = await readFile(file, 'utf8');
    assert.ok(!written.includes(token));
    assert.ok(!written.includes(supervisorToken));
  });

  it('leaves the room untouched when a mutation is refused', async () => {
    const store = await AgoraStore.open(null, () => createAgoraData({ name: 'Room', goal: 'Goal.' }));
    await assert.rejects(
      store.mutate((data) => {
        data.room.goal = 'half-applied';
        throw new Error('nope');
      })
    );
    assert.equal(store.read((data) => data.room.goal), 'Goal.');
  });

  it('serializes concurrent mutations instead of interleaving them', async () => {
    const store = await AgoraStore.open(null, () => createAgoraData({ name: 'Room', goal: 'Goal.' }));
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.mutate((data) => {
          data.room.eventSeq += 1;
          data.room.events.push({
            seq: data.room.eventSeq,
            at: new Date().toISOString(),
            type: 'agent.status',
            actor: `agent-${index}`,
            taskId: null,
            threadId: null,
            summary: `write ${index}`,
            audience: []
          });
        })
      )
    );
    const seqs = store.read((data) => data.room.events.map((event) => event.seq));
    assert.equal(new Set(seqs).size, seqs.length, 'every write should get its own sequence number');
    assert.equal(store.read((data) => data.room.eventSeq), 26);
  });
});
