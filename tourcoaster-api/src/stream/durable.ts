/**
 * LiveTourRoom — Durable Object for one live stream.
 *
 * Responsibilities:
 *   - Accept WebSocket connections from authorized viewers (gated upstream
 *     by /v1/streams/:id/socket).
 *   - Broadcast viewer-count updates as connections open/close.
 *   - Fan out chat messages and stream-status pushes (called by webhook
 *     handler via fetch('/broadcast')).
 *
 * Uses hibernating WebSockets (`state.acceptWebSocket`) so an idle room
 * costs nothing while still tracking viewers.
 *
 * Internal endpoints (called only from this Worker):
 *   GET  /ws        — WebSocket upgrade
 *   POST /broadcast — { type, ... } message broadcast to all sockets
 *   GET  /state     — { viewer_count, last_status }
 */
import type { Bindings } from '../types';

type Attachment = { userId: string; role: string };
type StatusSnapshot = { status: string; updatedAt: number } | null;

const MAX_CHAT_BYTES = 1024;

export class LiveTourRoom implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Bindings;
  private lastStatus: StatusSnapshot = null;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.lastStatus = (await this.state.storage.get<StatusSnapshot>('last_status')) ?? null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.openWs(req, url);
    if (url.pathname === '/broadcast') return this.handleBroadcast(req);
    if (url.pathname === '/state') return this.handleState();
    return new Response('not_found', { status: 404 });
  }

  // -------------------------------------------------------------------------
  // WebSocket entry.
  // -------------------------------------------------------------------------

  private openWs(req: Request, url: URL): Response {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected_upgrade', { status: 426 });
    }
    const userId = url.searchParams.get('userId') ?? 'anon';
    const role = url.searchParams.get('role') ?? 'traveler';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, role } satisfies Attachment);
    // Greet with a snapshot so the new viewer doesn't have to wait for a
    // tick. Then announce the new viewer count to everyone.
    server.send(
      JSON.stringify({
        type: 'hello',
        viewer_count: this.viewerCount(),
        status: this.lastStatus?.status ?? 'idle',
      })
    );
    this.broadcast({ type: 'viewer_count', viewer_count: this.viewerCount() });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation hooks. These are called by the runtime even when no JS
  // handler is currently in memory, so we keep them stateless.

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    let parsed: { type?: string; text?: string };
    try {
      const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
      if (raw.length > MAX_CHAT_BYTES) return;
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.type === 'chat' && typeof parsed.text === 'string') {
      const text = parsed.text.trim().slice(0, 500);
      if (!text) return;
      const attach = ws.deserializeAttachment() as Attachment | null;
      this.broadcast({
        type: 'chat',
        from: attach?.userId ?? 'anon',
        role: attach?.role ?? 'traveler',
        text,
        at: Date.now(),
      });
    }
  }

  webSocketClose(_ws: WebSocket): void {
    this.broadcast({ type: 'viewer_count', viewer_count: this.viewerCount() });
  }
  webSocketError(_ws: WebSocket): void {
    this.broadcast({ type: 'viewer_count', viewer_count: this.viewerCount() });
  }

  // -------------------------------------------------------------------------
  // Internal HTTP endpoints.
  // -------------------------------------------------------------------------

  private async handleBroadcast(req: Request): Promise<Response> {
    let body: { type: string; [k: string]: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response('invalid_json', { status: 400 });
    }
    if (!body || typeof body.type !== 'string') {
      return new Response('invalid_payload', { status: 400 });
    }
    if (body.type === 'status') {
      this.lastStatus = { status: String(body.status ?? 'idle'), updatedAt: Date.now() };
      await this.state.storage.put('last_status', this.lastStatus);
    }
    this.broadcast(body);
    return Response.json({ ok: true, viewer_count: this.viewerCount() });
  }

  private handleState(): Response {
    return Response.json({
      viewer_count: this.viewerCount(),
      last_status: this.lastStatus,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  private viewerCount(): number {
    return this.state.getWebSockets().length;
  }

  private broadcast(payload: Record<string, unknown>): void {
    const wire = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(wire);
      } catch {
        // Socket gone; the runtime will clean it up.
      }
    }
  }
}
