import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../server/app.js';
import { auth, db } from '../server/firebase.js';
import type { Me } from '../server/me.js';
import { clearAuth, createUser, idTokenFor } from './helpers/emulator.js';

// Set in vitest.config.ts: OWNER_EMAILS=owner@example.com, project demo-chat.

async function getMe(token?: string) {
  const res = await app.request('/api/me', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Me };
}

beforeEach(async () => {
  await clearAuth();
  await db.ref().set(null);
});

describe('GET /api/me', () => {
  it('rejects a request without a token', async () => {
    expect((await getMe()).status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    expect((await getMe('not-a-token')).status).toBe(401);
  });

  it('a signed-in stranger is not a member but is remembered as a guest', async () => {
    await createUser('stranger', 'stranger@example.com');
    const { status, body } = await getMe(await idTokenFor('stranger'));
    expect(status).toBe(200);
    expect(body).toMatchObject({ member: false, admin: false, refreshToken: false });
    expect((await db.ref('members/stranger').get()).exists()).toBe(false);
    const guest = (await db.ref('guests/stranger').get()).val();
    expect(guest).toMatchObject({ email: 'stranger@example.com', name: 'stranger' });
    expect(guest.firstSeenAt).toBe(guest.lastSeenAt);

    await getMe(await idTokenFor('stranger'));
    const again = (await db.ref('guests/stranger').get()).val();
    expect(again.firstSeenAt).toBe(guest.firstSeenAt);
    expect(again.lastSeenAt).toBeGreaterThanOrEqual(guest.lastSeenAt);
  });

  it('owners and members are not recorded as guests', async () => {
    await createUser('owner', 'owner@example.com');
    await createUser('alice', 'alice@example.com');
    await db.ref('members/alice').set({ invite: 'abc1234', joinedAt: 1, lastSeenAt: 1 });
    await getMe(await idTokenFor('owner'));
    await getMe(await idTokenFor('alice'));
    expect((await db.ref('guests').get()).exists()).toBe(false);
  });

  it('an owner joins without an invite and becomes admin', async () => {
    await createUser('owner', 'Owner@Example.com');
    const first = await getMe(await idTokenFor('owner'));
    expect(first.body).toMatchObject({ member: true, admin: true, refreshToken: true });

    const member = (await db.ref('members/owner').get()).val();
    expect(member).toMatchObject({ invite: 'owner', email: 'owner@example.com' });
    expect((await auth.getUser('owner')).customClaims).toEqual({ admin: true });

    // With the refreshed token the claim is already there, so nothing changes.
    const second = await getMe(await idTokenFor('owner'));
    expect(second.body).toMatchObject({ member: true, admin: true, refreshToken: false });
  });

  it('a guest whose address becomes an owner leaves the guest list', async () => {
    await createUser('owner', 'owner@example.com');
    await db.ref('guests/owner').set({ firstSeenAt: 1, lastSeenAt: 1 });
    const { body } = await getMe(await idTokenFor('owner'));
    expect(body).toMatchObject({ member: true, admin: true });
    expect((await db.ref('members/owner').get()).val()).toMatchObject({ invite: 'owner' });
    expect((await db.ref('guests/owner').get()).exists()).toBe(false);
  });

  it('an unverified owner address does not count', async () => {
    await createUser('fake-owner', 'owner@example.com', false);
    const { body } = await getMe(await idTokenFor('fake-owner'));
    expect(body).toMatchObject({ member: false, admin: false });
  });

  it('an admin claim without a matching owner address is revoked', async () => {
    await createUser('former', 'former@example.com');
    await auth.setCustomUserClaims('former', { admin: true });
    const { body } = await getMe(await idTokenFor('former'));
    expect(body).toMatchObject({ admin: false, refreshToken: true });
    expect((await auth.getUser('former')).customClaims).toEqual({ admin: false });
  });

  it('an existing member is let in and their visit is recorded', async () => {
    await createUser('alice', 'alice@example.com');
    await db.ref('members/alice').set({ invite: 'abc1234', joinedAt: 1, lastSeenAt: 1 });
    const { body } = await getMe(await idTokenFor('alice'));
    expect(body).toMatchObject({ member: true, admin: false, disabled: false });
    const member = (await db.ref('members/alice').get()).val();
    expect(member.lastSeenAt).toBeGreaterThan(1);
    expect(member.invite).toBe('abc1234');
  });

  it('a member left on the guest list by a racing request is taken off it', async () => {
    await createUser('alice', 'alice@example.com');
    await db.ref('members/alice').set({ invite: 'abc1234', joinedAt: 1, lastSeenAt: 1 });
    await db.ref('guests/alice').set({ firstSeenAt: 1, lastSeenAt: 2, invite: 'zzzzzzz' });
    await getMe(await idTokenFor('alice'));
    expect((await db.ref('guests/alice').get()).exists()).toBe(false);
  });

  it('a disabled member is not let in', async () => {
    await createUser('bob', 'bob@example.com');
    await db
      .ref('members/bob')
      .set({ invite: 'abc1234', joinedAt: 1, lastSeenAt: 1, disabled: true });
    const { body } = await getMe(await idTokenFor('bob'));
    expect(body).toMatchObject({ member: false, disabled: true });
  });
});
