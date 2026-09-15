import { EventBus } from './events.ts';
import { AgoraStore } from './store/store.ts';
import { RoomService } from './room/service.ts';
import { createAgoraData } from './room/seed.ts';
import { createAgoraServer } from './http/server.ts';
import type { AgoraServer, AgoraServerOptions } from './http/server.ts';
import type { CreateRoomOptions } from './room/seed.ts';

export { EventBus } from './events.ts';
export { AgoraStore } from './store/store.ts';
export { RoomService } from './room/service.ts';
export { createAgoraServer } from './http/server.ts';
export { MergeGate, seamMatesOf } from './gate/gate.ts';
export { evaluateMerge, summarize } from './gate/evaluate.ts';
export type { GateDecision, GateReason, MergeVerdict } from './gate/evaluate.ts';
export * as gitRepo from './git/repo.ts';
export { createAgoraData, createRoom, DEFAULT_MESSAGE_BUDGET, HUMAN_ID, OWNER_ID, PLAN_TASK_ID } from './room/seed.ts';
export { canDo, describeAction, mergeActions, needsMergeRights } from './room/rights.ts';
export { costReport, summarizeCost, quotaWarnings } from './room/cost.ts';
export { DEFAULT_SORT, ledgerRows, sortRows } from './room/ledger.ts';
export { archiveOf, closeReadiness, seedBriefing, seedContracts } from './room/close.ts';
export { provenanceOf } from './room/provenance.ts';
export { AgoraError, isAgoraError } from './errors.ts';
export { loadConfig } from './config.ts';
export type * from './types.ts';

export interface OpenRoomOptions extends CreateRoomOptions {
  /** Path to the room file, or null to keep the room in memory only. */
  file: string | null;
}

/** Opens (or creates) a room and wires it to a service. */
export async function openRoom(options: OpenRoomOptions): Promise<RoomService> {
  const { file: _file, ...room } = options;
  const store = await AgoraStore.open(options.file, () => createAgoraData(room));
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
