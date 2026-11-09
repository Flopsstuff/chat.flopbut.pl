import { Hono } from 'hono';
import { type AuthEnv, requireAdmin, requireUser } from './auth.js';
import { lock } from './chat.js';
import { db } from './firebase.js';

// Admins delete chats: a member's current one, or one they reset earlier. Meant for clearing
// out test chats. What the account has spent over all its chats (chatIndex/{uid}/totalCost)
// stays, since that money was spent.

/** An RTDB key as uids and push ids look: no path separators or other reserved characters. */
const KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** Removals of the cost records of these answers, for the same write as the chat itself. */
function costs(uid: string, messages: Record<string, unknown> | null) {
  return Object.fromEntries(Object.keys(messages ?? {}).map((id) => [`costs/${uid}/${id}`, null]));
}

export const adminChats = new Hono<AuthEnv>()
  .use(requireUser, requireAdmin)
  // The current chat: the member keeps their place and starts a clean chat, as after a reset.
  .delete('/:uid', async (c) => {
    const uid = c.req.param('uid');
    if (!KEY.test(uid)) return c.json({ error: 'not_found' }, 404);
    const chat = db.ref(`chats/${uid}`);
    // Not while an answer is being written into it.
    const unlock = await lock(chat, Date.now());
    if (!unlock) return c.json({ error: 'busy' }, 409);
    try {
      const messages = (await chat.child('messages').get()).val() as Record<string, unknown> | null;
      const index = await db.ref(`chatIndex/${uid}`).get();
      if (!messages && !index.exists()) return c.json({ error: 'not_found' }, 404);
      await db.ref().update({
        ...costs(uid, messages),
        [`chats/${uid}/messages`]: null,
        [`chats/${uid}/allowance`]: null,
        ...(index.exists() && {
          [`chatIndex/${uid}/cost`]: 0,
          [`chatIndex/${uid}/context`]: 0,
          [`chatIndex/${uid}/questions`]: 0,
          [`chatIndex/${uid}/preview`]: '',
          [`chatIndex/${uid}/usedUpAt`]: null,
        }),
      });
    } finally {
      await unlock().catch(() => {});
    }
    return c.json({ ok: true });
  })
  // A chat the member reset earlier.
  .delete('/:uid/archive/:id', async (c) => {
    const { uid, id } = c.req.param();
    if (!KEY.test(uid) || !KEY.test(id)) return c.json({ error: 'not_found' }, 404);
    const [messages, summary] = await Promise.all([
      db.ref(`archive/${uid}/${id}/messages`).get(),
      db.ref(`archiveIndex/${uid}/${id}`).get(),
    ]);
    if (!messages.exists() && !summary.exists()) return c.json({ error: 'not_found' }, 404);
    await db.ref().update({
      ...costs(uid, messages.val() as Record<string, unknown> | null),
      [`archive/${uid}/${id}`]: null,
      [`archiveIndex/${uid}/${id}`]: null,
    });
    return c.json({ ok: true });
  });
