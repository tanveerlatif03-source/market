import { EventBus } from './events.ts';
import { AgoraStore } from './store/store.ts';
import { RoomService } from './room/service.ts';
import { createAgoraData } from './room/seed.ts';
import { createAgoraServer } from './http/server.ts';
import type { AgoraServer, AgoraServerOptions } from './http/server.ts';

export { EventBus } from './events.ts';
export { AgoraStore } from './store/store.ts';
export { RoomService } from './room/service.ts';
export { createAgoraServer } from './http/server.ts';
export { MergeGate, seamMatesOf } from './gate/gate.ts';
export { evaluateMerge, summarize } from './gate/evaluate.ts';
export type { GateDecision, GateReason, MergeVerdict } from './gate/evaluate.ts';
export * as gitRepo from './git/repo.ts';
export { createAgoraData, createRoom, DEFAULT_MESSAGE_BUDGET, HUMAN_ID, PLAN_TASK_ID } from './room/seed.ts';
export { AgoraError, isAgoraError } from './errors.ts';
export { loadConfig } from './config.ts';
export type * from './types.ts';

export interface OpenRoomOptions {
  /** Path to the room file, or null to keep the room in memory only. */
  file: string | null;
  name: string;
  goal: string;
}

/** Opens (or creates) a room and wires it to a service. */
export async function openRoom(options: OpenRoomOptions): Promise<RoomService> {
  const store = await AgoraStore.open(options.file, () =>
    createAgoraData({ name: options.name, goal: options.goal })
  );
  return new RoomService(store, new EventBus());
}

export async function startAgora(
  options: OpenRoomOptions & AgoraServerOptions
): Promise<{ service: RoomService; server: AgoraServer; host: string; port: number }> {
  const service = await openRoom(options);
  const server = createAgoraServer(service, options);
  const address = await server.listen();
  return { service, server, ...address };
}
