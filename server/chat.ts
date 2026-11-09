import { type Reference, ServerValue } from 'firebase-admin/database';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { type About, describeAbout } from './about.js';
import { type Allowance, type Limits, refreshAllowance } from './allowance.js';
import { type AuthEnv, isOwner, requireUser } from './auth.js';
import type { ChatBackend, Turn, Usage } from './bot/index.js';
import { config } from './config.js';
import { db } from './firebase.js';
import type { MemberRecord } from './members.js';

export type MessageRecord = {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** Assistant messages only. */
  status?: 'streaming' | 'done' | 'error';
  /** The opening note: the bot reads it, the member never sees it. */
  hidden?: boolean;
};

/** costs/{uid}/{answerId}: what one answer cost. Admin-only, like every dollar amount. */
export type CostRecord = Usage & { ts: number };

/**
 * archiveIndex/{uid}/{pushId}: a chat the member reset, kept for the admin. Its messages are at
 * archive/{uid}/{pushId}/messages, apart, so the admin's list of chats does not load them.
 */
export type ArchivedChat = {
  endedAt: number;
  /** When it ran out of budget or context, if it did before the reset. */
  usedUpAt?: number;
  /** The last question asked in it. */
  preview: string;
  questions: number;
  cost: number;
  context: number;
};

export const MAX_TEXT = 4000;
/** A lock older than this is from a request that died without releasing it. */
export const BUSY_STALE_MS = 3 * 60 * 1000;
/**
 * An answer is cut off after this long, well before its lock could go stale. It leaves room for
 * the bot to wait for Flop in Telegram (FLOP_WAIT_MS in flop.ts) and still finish its answer.
 */
export const REPLY_TIMEOUT_MS = 150 * 1000;
/** How long a delivery from outside the chat (Flop's answer) waits for the chat to be free. */
export const DELIVER_WAIT_MS = REPLY_TIMEOUT_MS + 10 * 1000;
const LOCK_RETRY_MS = 1000;
/** How often a streaming answer is saved to RTDB, so other tabs and reloads see it grow. */
const FLUSH_MS = 250;
/** Length of the last question kept in chatIndex for the admin's list. */
export const PREVIEW_LENGTH = 140;

/**
 * chatIndex/{uid}: a summary of the current chat, so the admin's list does not load every
 * message. `cost` is what the current chat has spent, `totalCost` what the account has spent
 * across every chat it has had, both in dollars; `context` is how many tokens the chat came to
 * in its last answer, question and answer included; `usedUpAt` is when it ran out of budget or
 * context, absent while it still has some.
 */
export type ChatSummary = {
  lastAt: number;
  preview: string;
  questions: number;
  cost?: number;
  totalCost?: number;
  context?: number;
  usedUpAt?: number;
};

export type ChatOptions = {
  budgetUsd: number;
  contextTokens: number;
  contextGapTokens: number;
  replyTimeoutMs: number;
};

/** How a delivery from outside the chat went: answered by the bot, or why not. */
export type Delivery = 'retold' | 'limit_reached' | 'failed' | 'busy';

/**
 * POST /api/chat { text }: saves the question, then streams the answer as server-sent events
 * (`start` with the answer's message id, `delta` pieces, then `done` or `error`) while writing
 * it to chats/{uid}/messages. One question at a time per account, and none once the chat is
 * used up: its budget spent or its context full (402 `limit_reached`; owners have no budget).
 *
 * POST /api/chat/open { lang }: in a chat with no messages yet, saves a hidden opening note and
 * streams the bot's greeting the same way, so the bot speaks first.
 *
 * POST /api/chat/reset: archives a used-up chat and starts a clean one, from the moment set in
 * chats/{uid}/allowance/resetAt (409 `not_yet` before then). Admins may do it at any time, as
 * long as there is something to put away (409 `empty`).
 *
 * Besides the routes, `deliver` answers a hidden note that comes from outside the chat (Flop's
 * answer from Telegram) the same way, writing to RTDB only, and `post` adds a finished message
 * from the bot without asking the model.
 */
export function chatService(backend: ChatBackend, options: Partial<ChatOptions> = {}) {
  const { budgetUsd, contextTokens, contextGapTokens, replyTimeoutMs }: ChatOptions = {
    budgetUsd: config.chatBudgetUsd,
    contextTokens: config.chatContextTokens,
    contextGapTokens: config.chatContextGapTokens,
    replyTimeoutMs: REPLY_TIMEOUT_MS,
    ...options,
  };
  const limitsFor = (owner: boolean): Limits => ({
    budgetUsd: owner ? Number.POSITIVE_INFINITY : budgetUsd,
    contextTokens,
    contextGapTokens,
  });

  /**
   * With the chat's lock held: saves the question (or a hidden note, which does not count as a
   * question) and an empty answer to stream into, and returns the chat so far.
   */
  async function begin(uid: string, question: { text: string; hidden?: boolean }) {
    const { text, hidden = false } = question;
    const chat = db.ref(`chats/${uid}`);
    const now = Date.now();
    const history = await finishedTurns(chat);
    history.push({ role: 'user', text });
    const messages = chat.child('messages');
    const asked = messages.push();
    await db.ref().update({
      [`chats/${uid}/messages/${asked.key}`]: {
        role: 'user',
        text,
        ts: now,
        ...(hidden && { hidden: true }),
      } satisfies MessageRecord,
      [`chatIndex/${uid}/lastAt`]: now,
      // A hidden note is no question: the admin's list starts a chat at the first real one.
      ...(!hidden && {
        [`chatIndex/${uid}/preview`]: text.slice(0, PREVIEW_LENGTH),
        [`chatIndex/${uid}/questions`]: ServerValue.increment(1),
      }),
    });
    const answer = messages.push();
    await answer.set({
      role: 'assistant',
      text: '',
      ts: Date.now(),
      status: 'streaming',
    } satisfies MessageRecord);
    return { history, answer };
  }

  /**
   * Streams the bot's answer into the message `begin` made, and `send`s each piece on. The final
   * text, the status, what the answer cost and how large the chat has grown go in one write; a
   * failed answer may have cost something too. The allowance follows.
   */
  async function run(
    uid: string,
    limits: Limits,
    history: Turn[],
    answer: Reference,
    send: (event: string, data: unknown) => Promise<void>,
  ): Promise<'done' | 'error'> {
    let reply = '';
    let usage: Usage | undefined;
    const finish = async (status: 'done' | 'error') => {
      const key = answer.key as string;
      const updates: Record<string, unknown> = {
        [`chats/${uid}/messages/${key}/text`]: reply,
        [`chats/${uid}/messages/${key}/status`]: status,
      };
      if (usage) {
        updates[`costs/${uid}/${key}`] = { ...usage, ts: Date.now() } satisfies CostRecord;
        updates[`chatIndex/${uid}/context`] = usage.context ?? usage.input + usage.output;
        if (usage.cost !== undefined) {
          updates[`chatIndex/${uid}/cost`] = ServerValue.increment(usage.cost);
          updates[`chatIndex/${uid}/totalCost`] = ServerValue.increment(usage.cost);
        }
      }
      await db.ref().update(updates);
      await refreshAllowance(uid, limits);
    };

    try {
      await send('start', { id: answer.key });
      let flushed = Date.now();
      const signal = AbortSignal.timeout(replyTimeoutMs);
      const input = { chatId: uid, answerId: answer.key as string, history, signal };
      for await (const event of backend.reply(input)) {
        if (event.type === 'usage') {
          usage = event.usage;
          continue;
        }
        reply += event.text;
        await send('delta', { text: event.text });
        if (Date.now() - flushed >= FLUSH_MS) {
          flushed = Date.now();
          // Not awaited: RTDB applies writes from one client in order, the final one wins.
          answer.update({ text: reply }).catch(() => {});
        }
      }
      await finish('done');
      await send('done', {});
      return 'done';
    } catch (err) {
      console.error('chat backend failed', err);
      await finish('error').catch((e) => console.error('could not save the failed answer', e));
      await send('error', { error: 'bot_failed' });
      return 'error';
    }
  }

  /** Saves the question and streams the answer to it, over HTTP. */
  async function ask(c: Context<AuthEnv>, question: { text: string; hidden?: boolean }) {
    const user = c.get('user');
    const limits = limitsFor(isOwner(user));
    if ((await refreshAllowance(user.uid, limits)) === 0) {
      return c.json({ error: 'limit_reached' }, 402);
    }

    const chat = db.ref(`chats/${user.uid}`);
    const unlock = await lock(chat, Date.now());
    if (!unlock) return c.json({ error: 'busy' }, 409);

    let begun: Awaited<ReturnType<typeof begin>>;
    try {
      if (question.hidden && (await chat.child('messages').limitToFirst(1).get()).exists()) {
        await unlock();
        return c.json({ error: 'not_empty' }, 409);
      }
      begun = await begin(user.uid, question);
    } catch (err) {
      await unlock();
      throw err;
    }

    return streamSSE(c, async (stream) => {
      // The answer is finished and saved even if the client goes away: it reads RTDB anyway.
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      const send = async (event: string, data: unknown) => {
        if (!open) return;
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        } catch {
          open = false;
        }
      };
      try {
        await run(user.uid, limits, begun.history, begun.answer, send);
      } finally {
        await unlock().catch(() => {});
      }
    });
  }

  /**
   * Answers a hidden note from outside the chat, as the bot answers a question, once the chat is
   * free (waiting up to `waitMs` for a question in progress). `limit_reached` when the chat is
   * used up and `failed` when the bot broke off: the caller then says it some other way.
   */
  async function deliver(uid: string, note: string, waitMs = DELIVER_WAIT_MS): Promise<Delivery> {
    const member = (await db.ref(`members/${uid}`).get()).val() as MemberRecord | null;
    const limits = limitsFor(member?.invite === 'owner');
    const chat = db.ref(`chats/${uid}`);
    const deadline = Date.now() + waitMs;
    let unlock = await lock(chat, Date.now());
    while (!unlock) {
      if (Date.now() >= deadline) return 'busy';
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      unlock = await lock(chat, Date.now());
    }
    try {
      if ((await refreshAllowance(uid, limits)) === 0) return 'limit_reached';
      const { history, answer } = await begin(uid, { text: note, hidden: true });
      const status = await run(uid, limits, history, answer, async () => {});
      return status === 'done' ? 'retold' : 'failed';
    } finally {
      await unlock().catch(() => {});
    }
  }

  /** Adds a finished message from the bot, written as it is, without the model. */
  async function post(uid: string, text: string) {
    const now = Date.now();
    const message = db.ref(`chats/${uid}/messages`).push();
    await db.ref().update({
      [`chats/${uid}/messages/${message.key}`]: {
        role: 'assistant',
        text,
        ts: now,
        status: 'done',
      } satisfies MessageRecord,
      [`chatIndex/${uid}/lastAt`]: now,
    });
  }

  const route = new Hono<AuthEnv>()
    .post('/', requireUser, async (c) => {
      const user = c.get('user');
      if (!(await isActiveMember(user.uid))) return c.json({ error: 'forbidden' }, 403);

      const body = await c.req.json<{ text?: unknown }>().catch(() => null);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TEXT) return c.json({ error: 'invalid_text' }, 400);
      return ask(c, { text });
    })
    .post('/open', requireUser, async (c) => {
      const user = c.get('user');
      if (!(await isActiveMember(user.uid))) return c.json({ error: 'forbidden' }, 403);
      const body = await c.req.json<{ lang?: unknown }>().catch(() => null);
      const about = (await db.ref(`members/${user.uid}/about`).get()).val() as About | null;
      return ask(c, { text: openingNote(body?.lang, user.name, about), hidden: true });
    })
    .post('/reset', requireUser, async (c) => {
      const user = c.get('user');
      if (!(await isActiveMember(user.uid))) return c.json({ error: 'forbidden' }, 403);

      const chat = db.ref(`chats/${user.uid}`);
      const now = Date.now();
      const allowance = (await chat.child('allowance').get()).val() as Allowance | null;
      // Admins start a new chat whenever they like; members once theirs is used up and the
      // reset time has come.
      const admin = user.admin === true;
      if (!admin && (!allowance?.resetAt || now < allowance.resetAt)) {
        return c.json({ error: 'not_yet' }, 409);
      }

      const unlock = await lock(chat, now);
      if (!unlock) return c.json({ error: 'busy' }, 409);
      try {
        const [messages, summary] = await Promise.all([
          chat.child('messages').get(),
          db.ref(`chatIndex/${user.uid}`).get(),
        ]);
        if (!messages.exists()) return c.json({ error: 'empty' }, 409);
        const index = (summary.val() as ChatSummary | null) ?? null;
        const archived = db.ref(`archive/${user.uid}`).push();
        const record: ArchivedChat = {
          endedAt: now,
          ...(index?.usedUpAt !== undefined && { usedUpAt: index.usedUpAt }),
          preview: index?.preview ?? '',
          questions: index?.questions ?? 0,
          cost: index?.cost ?? 0,
          context: index?.context ?? 0,
        };
        // One write: the old chat lands in the archive in the same moment it leaves the member.
        await db.ref().update({
          [`archive/${user.uid}/${archived.key}/messages`]: messages.val(),
          [`archiveIndex/${user.uid}/${archived.key}`]: record,
          [`chats/${user.uid}/messages`]: null,
          [`chats/${user.uid}/allowance`]: null,
          [`chatIndex/${user.uid}/cost`]: 0,
          [`chatIndex/${user.uid}/context`]: 0,
          [`chatIndex/${user.uid}/questions`]: 0,
          [`chatIndex/${user.uid}/preview`]: '',
          [`chatIndex/${user.uid}/usedUpAt`]: null,
        });
      } finally {
        await unlock().catch(() => {});
      }
      return c.json({ ok: true });
    });

  return { route, deliver, post };
}

/** The chat's routes alone. */
export function chatRoute(backend: ChatBackend, options: Partial<ChatOptions> = {}) {
  return chatService(backend, options).route;
}

async function isActiveMember(uid: string): Promise<boolean> {
  const member = (await db.ref(`members/${uid}`).get()).val() as MemberRecord | null;
  return member !== null && member.disabled !== true;
}

/**
 * Takes chats/{uid}/pending, the one-at-a-time lock, and returns the function that releases it,
 * or null when another request holds it. It lives in RTDB rather than in memory because Cloud
 * Run may run several instances.
 */
export async function lock(chat: Reference, now: number): Promise<(() => Promise<unknown>) | null> {
  const pending = chat.child('pending');
  const taken = await pending.transaction((since: number | null) =>
    since !== null && now - since < BUSY_STALE_MS ? undefined : now,
  );
  if (!taken.committed) return null;
  // Released only while it is still ours: past BUSY_STALE_MS another request may have taken
  // it over, and removing that one would let a third run alongside.
  // The handler first runs against a local null; returning null there (a no-op write) lets
  // the transaction reach the server and run again on the real value.
  return () =>
    pending.transaction((since: number | null) =>
      since === null || since === now ? null : undefined,
    );
}

/**
 * The note that opens a chat, so the bot speaks first: who is there, as far as the browser and
 * the Google account tell. What to do with it is in the system prompt. The name is cut down to
 * letters and a few marks, so it cannot carry instructions of its own.
 */
export function openingNote(lang: unknown, name: unknown, about?: About | null): string {
  const language =
    typeof lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(lang) ? lang : null;
  const person =
    typeof name === 'string'
      ? name
          .replace(/[^\p{L}\p{M}\s.'-]/gu, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
      : '';
  return [
    '[Not from the person: they have just opened the chat and have not written anything yet.',
    language ? ` Their browser's language is ${language}.` : '',
    person ? ` The name on their Google account is ${person}.` : '',
    about && describeAbout(about) ? ` ${describeAbout(about)}` : '',
    ' Open the conversation.]',
  ].join('');
}

/**
 * The whole chat as the bot sees it: every finished message, oldest first. Nothing is cut or
 * summarised; the chat stops growing at its context limit instead.
 */
async function finishedTurns(chat: Reference): Promise<Turn[]> {
  const snapshot = await chat.child('messages').orderByKey().get();
  const turns: Turn[] = [];
  snapshot.forEach((child) => {
    const message = child.val() as MessageRecord;
    const finished = message.role === 'user' || message.status === 'done';
    if (finished && message.text) turns.push({ role: message.role, text: message.text });
  });
  return turns;
}
