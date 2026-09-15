import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createAgentMcpServer } from '../mcp/server.ts';
import type { AgentMcpServer } from '../mcp/server.ts';
import type { RoomService } from '../room/service.ts';
import { OWNER_ID } from '../room/seed.ts';
import type { ProviderConfig } from '../broker/broker.ts';
import { handleBrokerRequest } from './broker.ts';
import { dashboardHtml } from './dashboard.ts';
import { handleSupervisorRequest } from './supervisor.ts';
import { bearerToken, queryToken, readJsonBody, sendError, sendJson } from './util.ts';

export interface AgoraServerOptions {
  host?: string;
  port?: number;
  /** Host header values accepted when DNS rebinding protection is on. */
  allowedHosts?: string[];
  /**
   * Providers this room will broker calls to (Q15). Empty is the normal case:
   * an agent on a subscription has its own billing and routing it through here
   * would bill the work twice.
   */
  brokers?: readonly ProviderConfig[];
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /**
   * No MCP session is kept between requests (Q1, but forced by the host).
   *
   * A serverless host may answer every request from a different process, so a
   * session map in memory is a map most requests cannot see. In stateless mode
   * each MCP call stands alone: correct, at the cost of the server being able
   * to push — agents find out by asking rather than by being told.
   */
  statelessMcp?: boolean;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  mcp: AgentMcpServer;
  agentId: string;
}

export interface AgoraServer {
  server: Server;
  /** The router on its own, for a host that owns the listening socket. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  listen: () => Promise<{ host: string; port: number }>;
  close: () => Promise<void>;
}

/**
 * One endpoint each: agents speak MCP at /mcp with their room token, the human
 * watches and steers at /api and /.
 */
export function createAgoraServer(service: RoomService, options: AgoraServerOptions = {}): AgoraServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const sessions = new Map<string, McpSession>();

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = service.authenticate(bearerToken(req));
    if (principal === null || principal.kind !== 'agent' || principal.agentId === null) {
      res.setHeader('www-authenticate', 'Bearer realm="agora"');
      sendJson(res, 401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'This endpoint needs a Agora room token.',
          remedy: 'Ask the human for the token for this agent and set it as a Bearer header.'
        }
      });
      return;
    }
    const agentId = principal.agentId;

    if (options.statelessMcp === true) {
      // One transport, one request, thrown away after — because on this host
      // the next request may be a different process, so there is nowhere for a
      // session to live. This has to come before anything looks for a session
      // id: in stateless mode there never is one, on any request.
      const once = createAgentMcpServer(service, agentId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        once.dispose();
      });
      await once.server.connect(transport);
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (existing !== undefined) {
      if (existing.agentId !== agentId) {
        sendJson(res, 403, {
          error: {
            code: 'UNAUTHORIZED',
            message: 'That session belongs to another agent.',
            remedy: 'Start your own session; one token, one agent.'
          }
        });
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 400, {
        error: {
          code: 'INVALID',
          message: 'Missing or unknown mcp-session-id.',
          remedy: 'Initialize first with a POST.'
        }
      });
      return;
    }

    const body = await readJsonBody(req);
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, {
        error: {
          code: 'INVALID',
          message: 'Missing or unknown mcp-session-id.',
          remedy: 'Send an initialize request first.'
        }
      });
      return;
    }

    const mcp = createAgentMcpServer(service, agentId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      ...(options.allowedHosts !== undefined
        ? { allowedHosts: options.allowedHosts, enableDnsRebindingProtection: true }
        : {}),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, mcp, agentId });
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
        mcp.dispose();
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
      mcp.dispose();
    };

    await mcp.server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleSupervisor(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const token = bearerToken(req) !== '' ? bearerToken(req) : queryToken(url);
    const principal = service.authenticate(token);
    if (principal === null || principal.kind !== 'supervisor') {
      sendJson(res, 401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'This endpoint needs the supervisor token.',
          remedy: 'Run `agora token supervisor` to mint one.'
        }
      });
      return;
    }
    const handled = await handleSupervisorRequest(
      service,
      principal.humanId ?? OWNER_ID,
      req,
      res,
      url
    );
    if (!handled) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}.` } });
    }
  }

  /** Agents call this with their own room token; Agora supplies the provider key. */
  async function handleBroker(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const principal = service.authenticate(bearerToken(req));
    if (principal === null || principal.kind !== 'agent' || principal.agentId === null) {
      res.setHeader('www-authenticate', 'Bearer realm="agora"');
      sendJson(res, 401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'The broker needs your Agora room token, not a provider key.',
          remedy: 'Send the same Bearer token you use for /mcp.'
        }
      });
      return;
    }
    const handled = await handleBrokerRequest(
      service,
      principal.agentId,
      { providers: options.brokers ?? [], ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
      req,
      res,
      url
    );
    if (!handled) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}.` } });
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

    const run = async (): Promise<void> => {
      // When the room lives somewhere shared, this process is not the
      // authority — so every request starts from what is stored. A token
      // minted a second ago by another instance has to work here too.
      await service.sync();

      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true, room: service.snapshot().id });
        return;
      }
      if (url.pathname === '/mcp') {
        await handleMcp(req, res);
        return;
      }
      if (url.pathname.startsWith('/broker/')) {
        await handleBroker(req, res, url);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleSupervisor(req, res, url);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = dashboardHtml();
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html)
        });
        res.end(html);
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}.` } });
    };

    run().catch((error: unknown) => {
      if (!res.headersSent) sendError(res, error);
      else res.end();
    });
  };

  const server = createServer(handler);

  return {
    server,
    handler,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const actual = typeof address === 'object' && address !== null ? address.port : port;
          resolve({ host, port: actual });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        for (const session of sessions.values()) {
          session.mcp.dispose();
          void session.transport.close();
        }
        sessions.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      })
  };
}
