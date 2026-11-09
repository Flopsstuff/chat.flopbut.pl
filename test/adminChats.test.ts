import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../server/app.js';
import { auth, db } from '../server/firebase.js';
import { clearAuth, createUser, idTokenFor } from './helpers/emulator.js';

beforeEach(async () => {
  await clearAuth();
  await db.ref().set(null);
});

async function adminToken() {
  await createUser('owner', 'owner@example.com');
  await auth.setCustomUserClaims('owner', { admin: true });
  return idTokenFor('owner');
}

function remove(path: string, token: string | null) {
  return app.request(`/api/admin/chats/${path}`, {
    method: 'DELETE',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const message = (role: 'user' | 'assistant', text: string) => ({ role, text, ts: 1 });

/** Alice with a current chat of one question and answer, and one chat she reset before. */
async function seed() {
  await db.ref().update({
    'members/alice': { invite: 'abcdefg', joinedAt: 1, lastSeenAt: 1 },
    'chats/alice/messages': { q1: message('user', 'Hi'), a1: message('assistant', 'Hello') },
    'chats/alice/allowance': { left: 0, resetAt: 5 },
    'chatIndex/alice': {
      lastAt: 3,
      preview: 'Hi',
      questions: 1,
      cost: 0.02,
      totalCost: 0.05,
      context: 900,
      usedUpAt: 4,
    },
    'costs/alice': { a1: { cost: 0.02 }, old1: { cost: 0.03 } },
    'archive/alice/arc1/messages': {
      oldq: message('user', 'Old'),
      old1: message('assistant', 'X'),
    },
    'archiveIndex/alice/arc1': {
      endedAt: 2,
      preview: 'Old',
      questions: 1,
      cost: 0.03,
      context: 500,
    },
  });
}

describe('DELETE /api/admin/chats', () => {
  it('is closed to non-admins', async () => {
    await seed();
    expect((await remove('alice', null)).status).toBe(401);
    await createUser('alice', 'alice@example.com');
    expect((await remove('alice', await idTokenFor('alice'))).status).toBe(403);
    expect((await remove('alice/archive/arc1', await idTokenFor('alice'))).status).toBe(403);
    expect((await db.ref('chats/alice/messages').get()).exists()).toBe(true);
  });

  it('clears the current chat and its costs, keeping the member and what they spent', async () => {
    await seed();
    const res = await remove('alice', await adminToken());
    expect(res.status).toBe(200);
    expect((await db.ref('chats/alice').get()).val()).toBeNull();
    expect((await db.ref('chatIndex/alice').get()).val()).toEqual({
      lastAt: 3,
      preview: '',
      questions: 0,
      cost: 0,
      totalCost: 0.05,
      context: 0,
    });
    expect((await db.ref('costs/alice').get()).val()).toEqual({ old1: { cost: 0.03 } });
    expect((await db.ref('members/alice').get()).exists()).toBe(true);
    expect((await db.ref('archiveIndex/alice/arc1').get()).exists()).toBe(true);
  });

  it('does not clear a chat while an answer is being written', async () => {
    await seed();
    await db.ref('chats/alice/pending').set(Date.now());
    expect((await remove('alice', await adminToken())).status).toBe(409);
    expect((await db.ref('chats/alice/messages').get()).exists()).toBe(true);
  });

  it('deletes an earlier chat, its summary and its costs', async () => {
    await seed();
    const res = await remove('alice/archive/arc1', await adminToken());
    expect(res.status).toBe(200);
    expect((await db.ref('archive/alice').get()).val()).toBeNull();
    expect((await db.ref('archiveIndex/alice').get()).val()).toBeNull();
    expect((await db.ref('costs/alice').get()).val()).toEqual({ a1: { cost: 0.02 } });
    expect((await db.ref('chats/alice/messages').get()).exists()).toBe(true);
  });

  it('answers 404 for a chat that is not there or a malformed key', async () => {
    const token = await adminToken();
    expect((await remove('nobody', token)).status).toBe(404);
    expect((await remove('alice/archive/none', token)).status).toBe(404);
    expect((await remove('a.b', token)).status).toBe(404);
  });
});
