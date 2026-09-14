import { EventBus } from './events.ts';
import { MarketStore } from './store/store.ts';
import { RoomService } from './room/service.ts';
import { createMarketData } from './room/seed.ts';
import { createMarketServer } from './http/server.ts';
import type { MarketServer, MarketServerOptions } from './http/server.ts';

export { EventBus } from './events.ts';
export { MarketStore } from './store/store.ts';
export { RoomService } from './room/service.ts';
export { createMarketServer } from './http/server.ts';
export { createMarketData, createRoom, DEFAULT_MESSAGE_BUDGET, HUMAN_ID, PLAN_TASK_ID } from './room/seed.ts';
export { MarketError, isMarketError } from './errors.ts';
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
  const store = await MarketStore.open(options.file, () =>
    createMarketData({ name: options.name, goal: options.goal })
  );
  return new RoomService(store, new EventBus());
}

export async function startMarket(
  options: OpenRoomOptions & MarketServerOptions
): Promise<{ service: RoomService; server: MarketServer; host: string; port: number }> {
  const service = await openRoom(options);
  const server = createMarketServer(service, options);
  const address = await server.listen();
  return { service, server, ...address };
}
