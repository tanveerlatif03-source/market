#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { EventBus } from './events.ts';
import { AgoraStore } from './store/store.ts';
import { RoomService } from './room/service.ts';
import { createAgoraData, PLAN_TASK_ID } from './room/seed.ts';
import { createAgoraServer } from './http/server.ts';
import { loadConfig } from './config.ts';
import { isAgoraError } from './errors.ts';

const USAGE = `Agora — a shared room where agents from different tools work on one project.

Usage:
  agora init --name <room> --goal <goal>      Create the room.
  agora agent add --name <name> [options]     Add an agent and mint its room token.
  agora token supervisor [--label <label>]    Mint a token for the human's dashboard.
  agora serve [--host <host>] [--port <port>] Run the room.
  agora status                                Print the board.

Options for "agent add":
  --name <name>        Display name, e.g. "Claude".
  --provider <id>      claude-code | codex | cursor | ...   (default: unknown)
  --role <role>        lead | peer                          (default: peer)
  --id <id>            Agent id. Defaults to a slug of the name.
  --tasks <a,b>        Tasks this agent may write. Default "*" (any).
  --paths <a,b>        Paths this agent may read. Default "**" (all).

Environment:
  AGORA_DIR           Where the room is stored (default ./.agora)
  AGORA_HOST          Bind host (default 127.0.0.1)
  AGORA_PORT          Bind port (default 8787)
  AGORA_ALLOWED_HOSTS Comma-separated Host values to accept, enabling DNS rebinding protection.
`;

async function openService(): Promise<RoomService> {
  const config = loadConfig();
  const store = await AgoraStore.open(config.roomFile, () => {
    throw new Error(`No room at ${config.roomFile}. Run "agora init" first.`);
  });
  return new RoomService(store, new EventBus());
}

async function cmdInit(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: 'string' }, goal: { type: 'string' } },
    allowPositionals: false
  });
  const config = loadConfig();
  const name = values.name ?? 'Agora room';
  const goal = values.goal ?? 'No goal set yet.';
  const existed = await access(config.roomFile).then(() => true, () => false);
  const store = await AgoraStore.open(config.roomFile, () => createAgoraData({ name, goal }));
  const room = new RoomService(store, new EventBus()).snapshot();
  if (existed) {
    console.log(`A room already exists at ${config.roomFile}: "${room.name}".`);
    console.log('Delete that file to start over, or use it as is.');
    return;
  }
  console.log(`Room "${room.name}" created at ${config.roomFile}.`);
  console.log('Next: agora agent add --name "Claude" --provider claude-code --role lead');
}

async function cmdAgentAdd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      provider: { type: 'string' },
      role: { type: 'string' },
      id: { type: 'string' },
      tasks: { type: 'string' },
      paths: { type: 'string' }
    }
  });
  if (values.name === undefined) throw new Error('--name is required.');
  const service = await openService();
  const list = (value: string | undefined, fallback: string[]): string[] =>
    value === undefined ? fallback : value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');

  const { agent, token } = await service.addAgent({
    id: values.id,
    displayName: values.name,
    provider: values.provider ?? 'unknown',
    role: values.role === 'lead' ? 'lead' : 'peer',
    scope: { writeTasks: list(values.tasks, ['*']), readPaths: list(values.paths, ['**']) }
  });

  const config = loadConfig();
  const url = `http://${config.host}:${config.port}/mcp`;
  console.log(`Added ${agent.displayName} as ${agent.role} (id: ${agent.id}).`);
  console.log('\nRoom token — shown once, store it now:\n');
  console.log(`  ${token}\n`);
  console.log('Add the room to that agent, then it joins on its own:\n');
  console.log(snippetFor(agent.provider, url, token));
}

function snippetFor(provider: string, url: string, token: string): string {
  if (provider.includes('codex')) {
    return [
      '  # ~/.codex/config.toml',
      '  [mcp_servers.agora]',
      `  url = "${url}"`,
      '  [mcp_servers.agora.http_headers]',
      `  Authorization = "Bearer ${token}"`
    ].join('\n');
  }
  const file = provider.includes('cursor') ? '.cursor/mcp.json' : '.mcp.json';
  return [
    `  # ${file}`,
    '  {',
    '    "mcpServers": {',
    '      "agora": {',
    '        "type": "http",',
    `        "url": "${url}",`,
    `        "headers": { "Authorization": "Bearer ${token}" }`,
    '      }',
    '    }',
    '  }'
  ].join('\n');
}

async function cmdTokenSupervisor(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { label: { type: 'string' } } });
  const service = await openService();
  const token = await service.createSupervisorToken(values.label ?? 'supervisor');
  const config = loadConfig();
  console.log('Supervisor token — shown once:\n');
  console.log(`  ${token}\n`);
  console.log(`Open http://${config.host}:${config.port}/ and paste it in.`);
}

async function cmdServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { host: { type: 'string' }, port: { type: 'string' } }
  });
  const config = loadConfig({
    ...(values.host !== undefined ? { host: values.host } : {}),
    ...(values.port !== undefined ? { port: Number(values.port) } : {})
  });
  const service = await openService();
  const server = createAgoraServer(service, {
    host: config.host,
    port: config.port,
    allowedHosts: config.allowedHosts
  });
  const address = await server.listen();
  const room = service.snapshot();

  console.log(`Agora room "${room.name}" is open.`);
  console.log(`  agents      http://${address.host}:${address.port}/mcp`);
  console.log(`  supervisor  http://${address.host}:${address.port}/`);
  console.log(`  agents in the room: ${room.agents.map((agent) => agent.id).join(', ') || 'none yet'}`);

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStatus(): Promise<void> {
  const service = await openService();
  const { room, attention } = service.supervisorView();
  console.log(`${room.name} — ${room.goal}`);
  console.log(`plan: ${room.plan.status}${room.plan.note !== null ? ` (${room.plan.note})` : ''}\n`);
  for (const task of room.tasks) {
    const owner = task.owner ?? (task.suggestedOwner !== null ? `${task.suggestedOwner}?` : '—');
    console.log(
      `  ${task.id.padEnd(20)} ${task.status.padEnd(10)} ${owner.padEnd(12)} ` +
        `${task.actionsUsed}/${task.actionBudget} msgs  ${task.paths.join(' ')}`
    );
  }
  if (attention.length > 0) {
    console.log('\nNeeds you:');
    for (const item of attention) console.log(`  - ${item}`);
  }
  if (room.plan.status === 'none') {
    console.log(`\nThe lead has not claimed "${PLAN_TASK_ID}" and proposed a split yet.`);
  }
}

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'init':
      await cmdInit([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'agent':
      if (subcommand !== 'add') throw new Error('Unknown command. Try "agora agent add".');
      await cmdAgentAdd(rest);
      return;
    case 'token':
      if (subcommand !== 'supervisor') throw new Error('Unknown command. Try "agora token supervisor".');
      await cmdTokenSupervisor(rest);
      return;
    case 'serve':
      await cmdServe([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'status':
      await cmdStatus();
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (isAgoraError(error)) {
    console.error(`${error.message}\n${error.remedy}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
