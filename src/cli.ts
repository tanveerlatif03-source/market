#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EventBus } from './events.ts';
import { AgoraStore } from './store/store.ts';
import { RoomService } from './room/service.ts';
import { createAgoraData, OWNER_ID, PLAN_TASK_ID } from './room/seed.ts';
import { seedContracts } from './room/close.ts';
import type { RoomArchive } from './room/close.ts';
import { summarizeCost } from './room/cost.ts';
import type { LedgerColumn } from './room/ledger.ts';
import { createAgoraServer } from './http/server.ts';
import { providersFromEnv } from './broker/broker.ts';
import { MergeGate } from './gate/gate.ts';
import { summarize } from './gate/evaluate.ts';
import { openRepo } from './git/repo.ts';
import { loadConfig } from './config.ts';
import { isAgoraError } from './errors.ts';

const USAGE = `Agora — a shared room where agents from different tools work on one project.

Usage:
  agora start "<goal>"                        One room, one agent, one goal. No setup.
  agora init --name <room> --goal <goal>      Create the room.
  agora agent add --name <name> [options]     Add an agent and mint its room token.
  agora people add --name <name> [--merge]    Add a person to the room.
  agora token supervisor [--label <label>]    Mint a token for someone's dashboard.
  agora serve [--host <host>] [--port <port>] Run the room.
  agora status                                Print the board.
  agora ledger [--sort <column>] [--desc]     Every lane on one screen, worst first.
  agora sweeps [<lane|id>] [--rows]           Repetitive work: one instruction, many files.
  agora why --file|--lane|--contract <x>      Why is this the way it is.
  agora repo add --id <id> --root <path>      Add a repository to the room.
  agora land <lane> [--dry-run]               Land a lane and everything it shares a contract with.
  agora close [--landed <a,b>] [--note <n>]   Close the room and write its archive.

Options for "land":
  --dry-run            Say what would happen, in order, and change nothing.
  --resume             Finish a landing that got half in.
  --rollback           Revert what landed, with a revert commit in each repository.

Options everywhere:
  --as <id>            Who is doing this. Defaults to "owner", who opened the room.

Options for "init":
  --from <archive>     Seed this room's contracts from a closed room's archive.

Options for "agent add":
  --name <name>        Display name, e.g. "Claude".
  --provider <id>      claude-code | codex | cursor | ...   (default: unknown)
  --role <role>        lead | peer                          (default: peer)
  --id <id>            Agent id. Defaults to a slug of the name.
  --tasks <a,b>        Tasks this agent may write. Default "*" (any).
  --paths <a,b>        Paths this agent may read. Default "**" (all).

Environment:
  AGORA_DIR           Where the room is stored (default ./.agora)
  AGORA_BROKER_<X>_URL, _KEY, _AUTH, _HEADERS, _PRICES
                      Broker calls to provider <X> so its spend is metered exactly.
                      Only for agents on an API key — a subscription would bill twice.
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
    options: {
      name: { type: 'string' },
      goal: { type: 'string' },
      from: { type: 'string' },
      you: { type: 'string' }
    },
    allowPositionals: false
  });
  const config = loadConfig();
  const name = values.name ?? 'Agora room';
  const goal = values.goal ?? 'No goal set yet.';
  const existed = await access(config.roomFile).then(() => true, () => false);

  // Contracts from a room that already closed. Carried as notes for the lead to
  // re-propose, never as signed seams (Q24).
  const carried =
    values.from === undefined
      ? []
      : seedContracts([JSON.parse(await readFile(values.from, 'utf8')) as RoomArchive]);

  const store = await AgoraStore.open(config.roomFile, () =>
    createAgoraData({
      name,
      goal,
      ...(values.you !== undefined ? { owner: { displayName: values.you } } : {}),
      seededContracts: carried,
      seededFrom: values.from ?? null
    })
  );
  const room = new RoomService(store, new EventBus()).snapshot();
  if (existed) {
    console.log(`A room already exists at ${config.roomFile}: "${room.name}".`);
    console.log('Delete that file to start over, or use it as is.');
    return;
  }
  console.log(`Room "${room.name}" created at ${config.roomFile}.`);
  if (carried.length > 0) {
    console.log(`Carried ${carried.length} contract(s) from earlier work; the lead re-proposes them.`);
  }
  console.log('Next: agora agent add --name "Claude" --provider claude-code --role lead');
}

/**
 * Day one (Q25): one repo, one agent, one goal — and a plan anyway. No
 * configuration at any step, because watching the work get decomposed and
 * contracted before a line is written is the thing worth seeing.
 */
async function cmdStart(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { agent: { type: 'string' }, provider: { type: 'string' }, name: { type: 'string' } },
    allowPositionals: true
  });
  const goal = positionals.join(' ').trim();
  if (goal === '') throw new Error('Say what you are trying to do: agora start "Ship the auth page".');

  const config = loadConfig();
  if (await access(config.roomFile).then(() => true, () => false)) {
    throw new Error(`A room already exists at ${config.roomFile}. Use "agora status", or delete it.`);
  }

  const store = await AgoraStore.open(config.roomFile, () =>
    createAgoraData({ name: values.name ?? goal.slice(0, 60), goal })
  );
  const service = new RoomService(store, new EventBus());
  const displayName = values.agent ?? 'Claude';
  const provider = values.provider ?? 'claude-code';
  const { agent, token } = await service.addAgent(OWNER_ID, {
    displayName,
    provider,
    role: 'lead'
  });
  const supervisor = await service.createSupervisorToken(OWNER_ID, 'you');
  const url = `http://${config.host}:${config.port}/mcp`;

  console.log(`Room open: ${goal}\n`);
  console.log(`${agent.displayName} is the lead. Paste this where it will see it:\n`);
  console.log(snippetFor(provider, url, token));
  console.log('\nThen, in two terminals:\n');
  console.log('  agora serve');
  console.log(`  open http://${config.host}:${config.port}/  (token: ${supervisor})\n`);
  console.log(
    `${agent.displayName} will claim "${PLAN_TASK_ID}" and propose how the work splits, with the\n` +
      'proof each piece owes, before it writes a line. You approve that, and it starts.\n' +
      'Add a second agent whenever you like — the first contract is the payoff.'
  );
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
      paths: { type: 'string' },
      as: { type: 'string' }
    }
  });
  if (values.name === undefined) throw new Error('--name is required.');
  const service = await openService();
  const list = (value: string | undefined, fallback: string[]): string[] =>
    value === undefined ? fallback : value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');

  const { agent, token } = await service.addAgent(values.as ?? OWNER_ID, {
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
  const { values } = parseArgs({
    args: argv,
    options: { label: { type: 'string' }, as: { type: 'string' }, for: { type: 'string' } }
  });
  const service = await openService();
  const who = values.for ?? values.as ?? OWNER_ID;
  const token = await service.createSupervisorToken(
    values.as ?? OWNER_ID,
    values.label ?? who,
    who
  );
  const config = loadConfig();
  console.log(`Token for ${who} — shown once:\n`);
  console.log(`  ${token}\n`);
  console.log(`Open http://${config.host}:${config.port}/ and paste it in.`);
  console.log('It carries exactly that person\u2019s rights, and no more.');
}

/** Several people in the room, which is what long work actually looks like (Q7). */
async function cmdPeopleAdd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      id: { type: 'string' },
      merge: { type: 'boolean' },
      as: { type: 'string' }
    }
  });
  if (values.name === undefined) throw new Error('--name is required.');
  const service = await openService();
  const human = await service.addHuman(values.as ?? OWNER_ID, {
    id: values.id ?? values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    displayName: values.name,
    canMerge: values.merge === true
  });
  console.log(`${human.displayName} is in the room (id: ${human.id}).`);
  console.log(
    human.canMerge
      ? 'They can merge, so they can approve plans, settle contracts and raise caps.'
      : 'They can do anything reversible: pause, redirect, answer, read. Pass --merge to mirror\n' +
        'merge rights on the repository.'
  );
  console.log(`Give them a dashboard: agora token supervisor --for ${human.id}`);
}

/** Every lane on one screen, worst first (Q19). */
async function cmdLedger(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { sort: { type: 'string' }, desc: { type: 'boolean' } }
  });
  const service = await openService();
  const rows = service.ledger({
    column: (values.sort ?? 'health') as LedgerColumn,
    direction: values.desc === true ? 'desc' : 'asc'
  });
  if (rows.length === 0) {
    console.log('No lanes yet. The lead proposes the split first.');
    return;
  }
  const head = ['lane', 'health', 'agent', 'person', 'evidence', 'review', 'cost'];
  console.log(
    `${head[0]?.padEnd(16)}${head[1]?.padEnd(16)}${head[2]?.padEnd(10)}${head[3]?.padEnd(10)}` +
      `${head[4]?.padEnd(14)}${head[5]?.padEnd(16)}${head[6]}`
  );
  for (const row of rows) {
    console.log(
      `${row.laneId.padEnd(16)}${row.health.padEnd(16)}${(row.agent ?? '—').padEnd(10)}` +
        `${(row.human ?? 'room').padEnd(10)}${row.evidence.padEnd(14)}${row.review.padEnd(16)}` +
        `${summarizeCost(row.cost)}`
    );
    console.log(`  ${row.blockedOn}`);
  }
}

/** Why is this the way it is (Q26). */
async function cmdWhy(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: 'string' }, lane: { type: 'string' }, contract: { type: 'string' } }
  });
  const service = await openService();
  const answer =
    values.file !== undefined
      ? service.provenance({ kind: 'file', path: values.file })
      : values.lane !== undefined
        ? service.provenance({ kind: 'lane', laneId: values.lane })
        : values.contract !== undefined
          ? service.provenance({ kind: 'contract', seamId: values.contract })
          : null;
  if (answer === null) throw new Error('Ask about one thing: --file, --lane or --contract.');

  console.log(`${answer.headline}\n`);
  for (const entry of answer.entries) {
    console.log(`  ${entry.at}  ${entry.kind.padEnd(11)} ${entry.by}`);
    console.log(`    ${entry.what}`);
    console.log(`    — ${entry.because}`);
  }
  if (answer.openQuestions.length > 0) {
    console.log('\nStill unsettled:');
    for (const question of answer.openQuestions) console.log(`  - ${question}`);
  }
}

/** A room is a unit of work, and work does not stop at a repo boundary (Q17). */
async function cmdRepoAdd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      id: { type: 'string' },
      name: { type: 'string' },
      root: { type: 'string' },
      base: { type: 'string' },
      as: { type: 'string' }
    }
  });
  if (values.id === undefined) throw new Error('--id is required, e.g. --id web');
  const service = await openService();
  const repo = await service.addRepo(values.as ?? OWNER_ID, {
    id: values.id,
    ...(values.name !== undefined ? { name: values.name } : {}),
    root: resolve(values.root ?? process.cwd()),
    ...(values.base !== undefined ? { baseBranch: values.base } : {})
  });
  console.log(`"${repo.name}" is in the room: ${repo.root} on ${repo.baseBranch}.`);
  if (service.repos().length > 1) {
    console.log(
      '\nThis room now spans repositories. Two merges cannot be atomic, so every contract\n' +
        'crossing them has to say which side lands first — the plan will be refused without it.'
    );
  }
}

/**
 * Landing, from the command line (Q1, Q17). `--dry-run` is the interesting one:
 * it prints the blast radius before anything moves.
 */
async function cmdLand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      resume: { type: 'boolean' },
      rollback: { type: 'boolean' },
      as: { type: 'string' }
    },
    allowPositionals: true
  });
  const service = await openService();
  const room = service.snapshot();
  const gate = new MergeGate(service, {
    ...(room.repos.length === 0 ? { repo: openRepo(process.cwd()) } : {}),
    onStep: (step, index, total) => {
      console.log(`  [${index + 1}/${total}] merging ${step.laneId} into ${step.repoName}/${step.baseBranch}...`);
    }
  });

  if (values.rollback === true) {
    const outcome = await gate.rollback(values.as ?? OWNER_ID);
    if (outcome.reverted.length === 0 && outcome.failed.length === 0) {
      console.log('Nothing to roll back — this room is not red.');
      return;
    }
    console.log(`Reverted in ${outcome.reverted.join(', ') || 'nothing'}.`);
    if (outcome.failed.length > 0) {
      console.log(`Could not revert in ${outcome.failed.join(', ')}. The room stays red.`);
      process.exitCode = 1;
    } else {
      console.log('Nothing shipped half. The room is open again.');
    }
    return;
  }

  if (values.resume === true) {
    const outcome = await gate.resume();
    if (outcome === null) {
      console.log('Nothing to resume — this room is not red.');
      return;
    }
    console.log(outcome.summary);
    if (outcome.verdict !== 'merge') process.exitCode = 1;
    else await service.clearPartialLanding(values.as ?? OWNER_ID, { how: 'finished' });
    return;
  }

  const laneId = positionals[0];
  if (laneId === undefined) throw new Error('Which lane? agora land <lane> [--dry-run]');

  const plan = gate.landingPlan(laneId);
  console.log(plan.summary);
  for (const step of plan.steps) {
    console.log(`  ${step.order}. ${step.laneId} -> ${step.repoName}/${step.baseBranch}`);
    console.log(`     ${step.because}`);
  }
  if (plan.windows.length > 0) {
    console.log('\nWhile this happens:');
    for (const window of plan.windows) console.log(`  - ${window}`);
  }

  if (values['dry-run'] === true) {
    const decision = await gate.evaluate(laneId);
    console.log(`\nThe gate says: ${summarize(decision, laneId)}`);
    for (const reason of decision.reasons) console.log(`  - ${reason.detail}`);
    return;
  }

  const outcome = await gate.land(laneId);
  console.log(`\n${outcome.summary}`);
  for (const reason of outcome.decision.reasons) console.log(`  - ${reason.detail}`);
  if (outcome.partial) {
    console.log('\nTHE ROOM IS RED. Finish it with "agora land --resume", or put it back with');
    console.log('"agora land --rollback". Leaving it is the one thing that is not an option.');
  }
  if (outcome.verdict !== 'merge') process.exitCode = 1;
}

/** Repetitive work, as a grid (Q19). */
async function cmdSweeps(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { rows: { type: 'boolean' } },
    allowPositionals: true
  });
  const service = await openService();
  const wanted = positionals[0];
  const sweeps = service
    .sweeps()
    .filter((entry) => wanted === undefined || entry.batch.id === wanted || entry.batch.laneId === wanted);

  if (sweeps.length === 0) {
    console.log(
      wanted === undefined
        ? 'No sweeps. An agent opens one when the same change applies to many files.'
        : `No sweep matching "${wanted}".`
    );
    return;
  }

  for (const { batch, progress, verdict } of sweeps) {
    console.log(`${batch.title}  (${batch.id}, lane ${batch.laneId})`);
    console.log(`  ${batch.instruction}`);
    console.log(`  ${progress.summary}`);
    if (verdict.kind !== 'working' && verdict.kind !== 'finished') {
      console.log(`  ${verdict.detail}`);
    }
    // The collapsed view is the point: one line per distinct answer, not one
    // per row, unless you ask.
    for (const finding of verdict.findings) {
      console.log(`    ${String(finding.subjects.length).padStart(3)} × [${finding.state}] ${finding.finding}`);
    }
    if (values.rows === true) {
      console.log('');
      for (const row of batch.rows) {
        console.log(
          `    ${row.state.padEnd(8)} ${(row.agent ?? '—').padEnd(8)} ${row.subject}` +
            (row.finding === '' ? '' : `\n             ${row.finding}`)
        );
      }
    }
    console.log('');
  }
}

/** A room is a unit of work that ends (Q24). */
async function cmdClose(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      landed: { type: 'string' },
      note: { type: 'string' },
      force: { type: 'boolean' },
      out: { type: 'string' },
      as: { type: 'string' }
    }
  });
  const service = await openService();
  const room = service.snapshot();
  // The gate is the authority on what landed. Absent it, the accepted lanes are
  // the closest thing the room knows, and the flag overrides.
  const landed =
    values.landed !== undefined
      ? values.landed.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
      : room.tasks.filter((task) => task.status === 'accepted').map((task) => task.id);

  const readiness = service.closeReadiness(landed);
  if (!readiness.ready && values.force !== true) {
    console.log(readiness.summary);
    for (const blocker of readiness.blockers) console.log(`  - ${blocker.detail}`);
    console.log('\nFinish those, or close it anyway with --force. That is on the record.');
    process.exitCode = 1;
    return;
  }

  const { archive } = await service.closeRoom(values.as ?? OWNER_ID, {
    landed,
    note: values.note ?? '',
    force: values.force === true
  });
  const out = values.out ?? `${room.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-archive.json`;
  await writeFile(out, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');

  console.log(`Closed. ${readiness.summary}`);
  console.log(`\nArchive written to ${out}. It has two jobs:`);
  console.log('  - answering why the code is like this, long after everyone has forgotten;');
  console.log(
    `  - seeding the next room: agora init --from ${out} carries ` +
      `${archive.contracts.length} contract(s) forward as a starting point.`
  );
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
  const brokers = providersFromEnv();
  const server = createAgoraServer(service, {
    host: config.host,
    port: config.port,
    allowedHosts: config.allowedHosts,
    brokers
  });
  const address = await server.listen();
  const room = service.snapshot();

  console.log(`Agora room "${room.name}" is open.`);
  console.log(`  agents      http://${address.host}:${address.port}/mcp`);
  console.log(`  supervisor  http://${address.host}:${address.port}/`);
  if (brokers.length > 0) {
    console.log(
      `  broker      http://${address.host}:${address.port}/broker/<provider>  ` +
        `(${brokers.map((broker) => broker.id).join(', ')})`
    );
    console.log(
      '              Point an API-key agent here and its spend is metered exactly.\n' +
        '              An agent on a subscription should not use this: it would bill twice.'
    );
  }
  console.log(`  agents in the room: ${room.agents.map((agent) => agent.id).join(', ') || 'none yet'}`);
  if (room.repos.length > 1) {
    console.log(`  repositories: ${room.repos.map((repo) => `${repo.id} (${repo.baseBranch})`).join(', ')}`);
  }
  if (room.status === 'red') {
    console.log('\n  THE ROOM IS RED. A change landed in one repository and not another.');
    console.log('  Run "agora land --resume" or "agora land --rollback".');
  }

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
    case 'start':
      await cmdStart([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'init':
      await cmdInit([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'agent':
      if (subcommand !== 'add') throw new Error('Unknown command. Try "agora agent add".');
      await cmdAgentAdd(rest);
      return;
    case 'people':
      if (subcommand !== 'add') throw new Error('Unknown command. Try "agora people add".');
      await cmdPeopleAdd(rest);
      return;
    case 'repo':
      if (subcommand !== 'add') throw new Error('Unknown command. Try "agora repo add".');
      await cmdRepoAdd(rest);
      return;
    case 'land':
      await cmdLand([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'sweep':
    case 'sweeps':
      await cmdSweeps([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'ledger':
      await cmdLedger([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'why':
      await cmdWhy([subcommand, ...rest].filter((value): value is string => value !== undefined));
      return;
    case 'close':
      await cmdClose([subcommand, ...rest].filter((value): value is string => value !== undefined));
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
