import { resolve } from 'node:path';

export interface AgoraConfig {
  /** Where the room lives on disk. */
  dataDir: string;
  roomFile: string;
  host: string;
  port: number;
  allowedHosts: string[] | undefined;
}

export function loadConfig(overrides: Partial<AgoraConfig> = {}): AgoraConfig {
  const dataDir = overrides.dataDir ?? resolve(process.env.AGORA_DIR ?? '.agora');
  const allowedHosts = process.env.AGORA_ALLOWED_HOSTS?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return {
    dataDir,
    roomFile: overrides.roomFile ?? resolve(dataDir, 'room.json'),
    host: overrides.host ?? process.env.AGORA_HOST ?? '127.0.0.1',
    port: overrides.port ?? Number(process.env.AGORA_PORT ?? '8787'),
    allowedHosts:
      overrides.allowedHosts ?? (allowedHosts !== undefined && allowedHosts.length > 0 ? allowedHosts : undefined)
  };
}
