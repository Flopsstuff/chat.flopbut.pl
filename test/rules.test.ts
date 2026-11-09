import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rules',
    database: { rules: readFileSync('database.rules.json', 'utf8') },
  });
});

afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .database()
      .ref()
      .set({
        members: {
          alice: { email: 'alice@example.com', invite: 'abc1234' },
          bob: { email: 'bob@example.com', invite: 'abc1234', disabled: true },
          dave: { email: 'dave@example.com', invite: 'abc1234' },
        },
        chats: {
          alice: { messages: { m1: { role: 'user', text: 'hi', ts: 1 } } },
          bob: { messages: { m1: { role: 'user', text: 'hi', ts: 1 } } },
          carol: { messages: { m1: { role: 'user', text: 'hi', ts: 1 } } },
          dave: { messages: { m1: { role: 'user', text: 'hi', ts: 1 } } },
        },
        invites: { abc1234: { limit: 5, used: 2 } },
      });
  });
});

const db = (uid: string | null, claims: Record<string, unknown> = {}) =>
  uid === null
    ? env.unauthenticatedContext().database()
    : env.authenticatedContext(uid, claims).database();

describe('chats', () => {
  it('a member reads their own chat', async () => {
    await assertSucceeds(db('alice').ref('chats/alice').get());
  });

  it('a member cannot read someone else’s chat', async () => {
    await assertFails(db('alice').ref('chats/dave').get());
  });

  it('a disabled member cannot read their chat', async () => {
    await assertFails(db('bob').ref('chats/bob').get());
  });

  it('a signed-in non-member cannot read a chat at their uid', async () => {
    await assertFails(db('carol').ref('chats/carol').get());
  });

  it('anonymous visitors read nothing', async () => {
    await assertFails(db(null).ref('chats/alice').get());
  });
});

describe('admin', () => {
  it('reads everything', async () => {
    const admin = db('owner', { admin: true });
    await assertSucceeds(admin.ref('chats').get());
    await assertSucceeds(admin.ref('members').get());
    await assertSucceeds(admin.ref('invites').get());
    await assertSucceeds(admin.ref('guests').get());
    await assertSucceeds(admin.ref('chatIndex').get());
    await assertSucceeds(admin.ref('costs').get());
    await assertSucceeds(admin.ref('archive').get());
    await assertSucceeds(admin.ref('archiveIndex').get());
  });

  it('a non-admin cannot list members or invites', async () => {
    await assertFails(db('alice').ref('members').get());
    await assertFails(db('alice').ref('invites').get());
    await assertFails(db('alice').ref('guests').get());
    await assertFails(db('alice').ref('guests/alice').get());
    await assertFails(db('alice').ref('chatIndex').get());
    await assertFails(db('alice').ref('chatIndex/alice').get());
  });

  it('a member sees the share of their allowance, never what it cost or their old chats', async () => {
    await assertSucceeds(db('alice').ref('chats/alice/allowance').get());
    await assertFails(db('alice').ref('costs/alice').get());
    await assertFails(db('alice').ref('archive/alice').get());
    await assertFails(db('alice').ref('archiveIndex/alice').get());
  });
});

describe('writes', () => {
  it('nobody writes from the client, admins included', async () => {
    await assertFails(db('alice').ref('chats/alice/messages/x').set({ text: 'x' }));
    await assertFails(db('alice').ref('members/alice/disabled').set(false));
    await assertFails(db('owner', { admin: true }).ref('invites/new').set({ limit: 1 }));
  });
});
