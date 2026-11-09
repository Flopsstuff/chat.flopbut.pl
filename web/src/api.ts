import type { User } from 'firebase/auth';

export type Me = {
  uid: string;
  email: string | null;
  name: string | null;
  photo: string | null;
  member: boolean;
  disabled: boolean;
  admin: boolean;
  refreshToken: boolean;
  /** A member who has not seen the short form about themselves yet. */
  askAbout: boolean;
};

/** The short form after the invite; every answer optional, or skipped as a whole. */
export type AboutAnswers =
  | {
      role: string | null;
      name: string;
      company: string;
      positions: string[];
      language: string | null;
    }
  | { skip: true };

export type Period = 'day' | 'week' | 'month' | 'year';

export type ActiveInvite = {
  code: string;
  limit: number;
  used: number;
  left: number;
  createdAt: number;
  expiresAt: number | null;
};

async function call(user: User, method: string, path: string, body?: unknown) {
  return fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${await user.getIdToken()}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function fetchMe(user: User): Promise<Me> {
  const res = await call(user, 'GET', '/api/me');
  if (!res.ok) throw new Error(`GET /api/me failed: ${res.status}`);
  const me = (await res.json()) as Me;
  // The server changed our custom claims (admin); pick them up for RTDB reads.
  if (me.refreshToken) await user.getIdToken(true);
  return me;
}

/** Spends a place on the invite if one is free. False means the account stays a guest. */
export async function redeemInvite(user: User, code: string): Promise<boolean> {
  const res = await call(user, 'POST', '/api/redeem', { code });
  if (!res.ok) throw new Error(`POST /api/redeem failed: ${res.status}`);
  return ((await res.json()) as { joined: boolean }).joined;
}

/** Saves the short form about the member (or that they skipped it). */
export async function saveAbout(user: User, answers: AboutAnswers): Promise<void> {
  const res = await call(user, 'POST', '/api/about', answers);
  if (!res.ok) throw new Error(`POST /api/about failed: ${res.status}`);
}

/** One file of the knowledge base, and what it is to the bot. */
export type KbFile = {
  path: string;
  size: number;
  updated: number;
  kind: 'prompt' | 'note' | 'photo' | 'other';
};

/** The knowledge base's folder as it is now: the bucket, or null where it is a folder on disk. */
export type KbState = { bucket: string | null; files: KbFile[] };

export async function getKb(user: User): Promise<KbState> {
  const res = await call(user, 'GET', '/api/admin/kb');
  if (!res.ok) throw new Error(`GET /api/admin/kb failed: ${res.status}`);
  return (await res.json()) as KbState;
}

export async function listInvites(user: User): Promise<ActiveInvite[]> {
  const res = await call(user, 'GET', '/api/admin/invites');
  if (!res.ok) throw new Error(`GET /api/admin/invites failed: ${res.status}`);
  return ((await res.json()) as { invites: ActiveInvite[] }).invites;
}

export async function createInvite(
  user: User,
  input: { limit: number; period: Period },
): Promise<string> {
  const res = await call(user, 'POST', '/api/admin/invites', input);
  const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  if (!res.ok || !body.code) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body.code;
}

/** Archives a used-up chat and starts a clean one. The server allows it from the reset time on. */
export async function resetChat(user: User): Promise<void> {
  const res = await call(user, 'POST', '/api/chat/reset');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  }
}

/**
 * Admin: deletes a member's current chat (they start a clean one) or, with `archiveId`, one they
 * reset earlier, along with what its answers cost.
 */
export async function deleteChat(user: User, uid: string, archiveId?: string): Promise<void> {
  const path = archiveId ? `${uid}/archive/${archiveId}` : uid;
  const res = await call(user, 'DELETE', `/api/admin/chats/${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Asks the bot. The question is saved on the server, then the answer streams back as
 * server-sent events while it is also written to RTDB. Resolves to how the stream ended:
 * `interrupted` means the question was accepted but the connection dropped, and the server
 * still finishes the answer in RTDB. Throws when the question was not accepted, so nothing
 * was saved: ApiError for a refusal, the fetch error when the request never got through.
 */
export function sendMessage(user: User, text: string, on: StreamHandlers) {
  return stream(user, '/api/chat', { text }, on);
}

/**
 * Opens an empty chat: the bot greets the member first, in their browser's language. Streams like
 * sendMessage; throws ApiError `not_empty` when the chat already has messages.
 */
export function openChat(user: User, on: StreamHandlers) {
  return stream(user, '/api/chat/open', { lang: navigator.language }, on);
}

type StreamHandlers = { start: (id: string) => void; delta: (text: string) => void };

async function stream(
  user: User,
  path: string,
  body: unknown,
  on: StreamHandlers,
): Promise<'done' | 'error' | 'interrupted'> {
  const res = await call(user, 'POST', path, body);
  if (!res.ok || !res.body) {
    const refusal = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, refusal.error ?? `http_${res.status}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<string>;
    try {
      chunk = await reader.read();
    } catch {
      return 'interrupted';
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += value;
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as {
        id?: string;
        text?: string;
      };
      if (event === 'start' && data.id) on.start(data.id);
      else if (event === 'delta' && data.text) on.delta(data.text);
      else if (event === 'done') return 'done';
      else if (event === 'error') return 'error';
    }
  }
  // The stream closed without a final event.
  return 'interrupted';
}
