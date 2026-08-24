import { DurableObject } from 'cloudflare:workers';
import {
  Hocuspocus,
  type WebSocketLike
} from '@hocuspocus/server';
import * as Y from 'yjs';

interface Env {
  PAIRING_ROOMS: DurableObjectNamespace<PairingRoom>;
  ALLOWED_ORIGINS: string;
  ROOM_TTL_SECONDS: string;
}

interface RoomMetadata {
  code: string;
  createdAt: number;
  expiresAt: number;
}

interface ConnectionContext {
  roomCode: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const MAX_CREATE_ATTEMPTS = 5;
const DOCUMENT_KEY = 'document';
const METADATA_KEY = 'metadata';

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...headers
    }
  });
}

function createCode(): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    for (const byte of bytes) {
      // 248 is the largest multiple of 31 below 256. Rejecting the remainder
      // keeps every symbol equally likely while preserving the readable alphabet.
      if (byte < 248) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
      if (code.length === CODE_LENGTH) {
        break;
      }
    }
  }
  return code;
}

function normalizeCode(value: string): string | null {
  const code = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return code.length === CODE_LENGTH && [...code].every(char => CODE_ALPHABET.includes(char))
    ? code
    : null;
}

function formatCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  if (!origin) {
    return null;
  }

  const allowed = env.ALLOWED_ORIGINS.split(',').map(value => value.trim());
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null): HeadersInit {
  return origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        vary: 'Origin'
      }
    : {};
}

function roomStub(env: Env, code: string): DurableObjectStub<PairingRoom> {
  return env.PAIRING_ROOMS.get(env.PAIRING_ROOMS.idFromName(code));
}

export class PairingRoom extends DurableObject<Env> {
  private readonly hocuspocus: Hocuspocus<ConnectionContext>;
  private readonly sockets = new Set<WebSocket>();
  private expired = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.hocuspocus = new Hocuspocus<ConnectionContext>({
      async onAuthenticate({ context, documentName }) {
        if (documentName !== context.roomCode) {
          throw new Error('The document name does not match this pairing room.');
        }
        return context;
      },
      onLoadDocument: async () => {
        const stored = await this.ctx.storage.get<ArrayBuffer>(DOCUMENT_KEY);
        return stored ? new Uint8Array(stored) : undefined;
      },
      onStoreDocument: async ({ document }) => {
        if (this.expired) {
          return;
        }
        const update = Y.encodeStateAsUpdate(document);
        const stored = update.buffer.slice(
          update.byteOffset,
          update.byteOffset + update.byteLength
        );
        await this.ctx.storage.put(DOCUMENT_KEY, stored);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/internal/create') {
      return this.createRoom(request);
    }

    const metadata = await this.activeMetadata();
    if (!metadata) {
      return json({ error: 'Pairing room not found or expired.' }, 404);
    }

    if (request.method === 'POST' && url.pathname === '/internal/join') {
      return json({ code: formatCode(metadata.code), expiresAt: metadata.expiresAt });
    }

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.connectWebSocket(request, metadata);
    }

    return json({ error: 'Not found.' }, 404);
  }

  async alarm(): Promise<void> {
    await this.expireRoom();
  }

  private async expireRoom(): Promise<void> {
    this.expired = true;
    for (const socket of this.sockets) {
      socket.close(4001, 'Pairing room expired.');
    }
    this.sockets.clear();
    this.hocuspocus.closeConnections();
    await this.ctx.storage.deleteAll();
  }

  private async createRoom(request: Request): Promise<Response> {
    if (await this.ctx.storage.get(METADATA_KEY)) {
      return json({ error: 'Pairing code collision.' }, 409);
    }

    const payload = (await request.json()) as Partial<RoomMetadata>;
    if (!payload.code || !payload.createdAt || !payload.expiresAt) {
      return json({ error: 'Invalid room metadata.' }, 400);
    }

    const metadata: RoomMetadata = {
      code: payload.code,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt
    };
    await this.ctx.storage.put(METADATA_KEY, metadata);
    await this.ctx.storage.setAlarm(metadata.expiresAt);

    return json({ code: formatCode(metadata.code), expiresAt: metadata.expiresAt }, 201);
  }

  private async activeMetadata(): Promise<RoomMetadata | null> {
    const metadata = await this.ctx.storage.get<RoomMetadata>(METADATA_KEY);
    if (!metadata || metadata.expiresAt <= Date.now()) {
      if (metadata) {
        await this.expireRoom();
      }
      return null;
    }
    return metadata;
  }

  private connectWebSocket(request: Request, metadata: RoomMetadata): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);

    const connection = this.hocuspocus.handleConnection(
      server as unknown as WebSocketLike,
      request,
      { roomCode: metadata.code }
    );

    server.addEventListener('message', event => {
      const message: unknown = event.data;
      if (typeof message === 'string') {
        connection.handleMessage(new TextEncoder().encode(message));
      } else if (message instanceof ArrayBuffer) {
        connection.handleMessage(new Uint8Array(message));
      } else if (ArrayBuffer.isView(message)) {
        connection.handleMessage(
          new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
        );
      } else if (message instanceof Blob) {
        void message.arrayBuffer().then(buffer => {
          connection.handleMessage(new Uint8Array(buffer));
        });
      } else {
        server.close(1003, 'Unsupported WebSocket message type.');
      }
    });

    server.addEventListener('close', event => {
      this.sockets.delete(server);
      connection.handleClose({ code: event.code, reason: event.reason });
    });

    server.addEventListener('error', () => {
      this.sockets.delete(server);
      connection.handleClose({ code: 1011, reason: 'WebSocket error.' });
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    const headers = corsHeaders(origin);

    if (request.headers.has('origin') && !origin) {
      return json({ error: 'Origin not allowed.' }, 403);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const ttlSeconds = Number.parseInt(env.ROOM_TTL_SECONDS, 10) || 86400;

      for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
        const code = createCode();
        const now = Date.now();
        const response = await roomStub(env, code).fetch(
          new Request('https://room/internal/create', {
            method: 'POST',
            body: JSON.stringify({
              code,
              createdAt: now,
              expiresAt: now + ttlSeconds * 1000
            })
          })
        );

        if (response.status !== 409) {
          return new Response(response.body, {
            status: response.status,
            headers: { ...headers, 'content-type': 'application/json' }
          });
        }
      }

      return json({ error: 'Unable to allocate a pairing room.' }, 503, headers);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|ws)$/);
    if (!match) {
      return json({ error: 'Not found.' }, 404, headers);
    }

    const code = normalizeCode(match[1]);
    if (!code) {
      return json({ error: 'Invalid pairing code.' }, 400, headers);
    }

    const action = match[2];
    if (action === 'join' && request.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405, headers);
    }
    if (action === 'ws' && request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required.' }, 426, headers);
    }

    const internalUrl = action === 'join'
      ? 'https://room/internal/join'
      : 'https://room/internal/ws';
    const response = await roomStub(env, code).fetch(
      new Request(internalUrl, request)
    );

    if (response.status === 101) {
      return response;
    }

    return new Response(response.body, {
      status: response.status,
      headers: { ...headers, 'content-type': 'application/json' }
    });
  }
} satisfies ExportedHandler<Env>;

