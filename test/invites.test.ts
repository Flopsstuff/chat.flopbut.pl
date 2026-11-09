import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../server/app.js';
import { auth, db } from '../server/firebase.js';
import {
  type ActiveInvite,
  addPeriod,
  generateCode,
  type InviteRecord,
  isValidCode,
} from '../server/invites.js';
import { clearAuth, createUser, idTokenFor } from './helpers/emulator.js';

// OWNER_EMAILS in vitest.config.ts includes owner@example.com.

function post(path: string, token: string | null, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

async function seedInvite(code: string, invite: Partial<InviteRecord> = {}) {
  await db.ref(`invites/${code}`).set({ limit: 2, used: 0, createdAt: 1, ...invite });
}

const invite = async (code: string) =>
  (await db.ref(`invites/${code}`).get()).val() as InviteRecord;
const member = async (uid: string) => (await db.ref(`members/${uid}`).get()).val();
const guest = async (uid: string) => (await db.ref(`guests/${uid}`).get()).val();

async function joined(res: Response) {
  expect(res.status).toBe(200);
  return ((await res.json()) as { joined: boolean }).joined;
}

async function signedIn(uid: string, email = `${uid}@example.com`) {
  await createUser(uid, email);
  return idTokenFor(uid);
}

beforeEach(async () => {
  await clearAuth();
  await db.ref().set(null);
});

describe('invite codes', () => {
  it('are 7 characters without look-alikes', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[a-z2-9]{7}$/);
      expect(code).not.toMatch(/[01ilo]/);
      expect(isValidCode(code)).toBe(true);
    }
  });

  it('reject anything else', () => {
    for (const bad of ['', 'abc', 'abcdefgh', 'ABCDEFG', 'abcdef0', 'abcdefl', '../../x', 42]) {
      expect(isValidCode(bad)).toBe(false);
    }
  });
});

describe('POST /api/redeem', () => {
  it('requires a signed-in user', async () => {
    expect((await post('/api/redeem', null, { code: 'abcdefg' })).status).toBe(401);
  });

  it('turns a guest into a member and spends one place', async () => {
    await seedInvite('abcdefg');
    await db.ref('guests/alice').set({ firstSeenAt: 1, lastSeenAt: 1 });
    expect(
      await joined(await post('/api/redeem', await signedIn('alice'), { code: 'abcdefg' })),
    ).toBe(true);
    expect(await member('alice')).toMatchObject({ invite: 'abcdefg', email: 'alice@example.com' });
    expect(await guest('alice')).toBeNull();
    const after = await invite('abcdefg');
    expect(after.used).toBe(1);
    expect(after.users).toHaveProperty('alice');
  });

  it('accepts a code typed in capitals or with spaces around it', async () => {
    await seedInvite('abcdefg');
    const res = await post('/api/redeem', await signedIn('alice'), { code: ' ABCDEFG ' });
    expect(await joined(res)).toBe(true);
  });

  it('does not spend a place when the same account redeems again', async () => {
    await seedInvite('abcdefg');
    const token = await signedIn('alice');
    await post('/api/redeem', token, { code: 'abcdefg' });
    expect(await joined(await post('/api/redeem', token, { code: 'abcdefg' }))).toBe(true);
    expect((await invite('abcdefg')).used).toBe(1);
  });

  it('a member opening another invite spends nothing there', async () => {
    await seedInvite('abcdefg');
    await seedInvite('hjkmnpq');
    const token = await signedIn('alice');
    await post('/api/redeem', token, { code: 'abcdefg' });
    expect(await joined(await post('/api/redeem', token, { code: 'hjkmnpq' }))).toBe(true);
    expect((await invite('hjkmnpq')).used).toBe(0);
    expect((await member('alice')).invite).toBe('abcdefg');
  });

  it('recreates a lost member record without spending a second place', async () => {
    await seedInvite('abcdefg', { used: 1, users: { alice: 5 } });
    const res = await post('/api/redeem', await signedIn('alice'), { code: 'abcdefg' });
    expect(await joined(res)).toBe(true);
    expect(await member('alice')).toMatchObject({ invite: 'abcdefg' });
    expect((await invite('abcdefg')).used).toBe(1);
  });

  it.each([
    ['has expired', { expiresAt: Date.now() - 1000 }],
    ['was revoked', { revoked: true }],
  ])('recreates a lost member record even after the invite %s', async (_label, seed) => {
    await seedInvite('abcdefg', { used: 1, users: { alice: 5 }, ...seed });
    const res = await post('/api/redeem', await signedIn('alice'), { code: 'abcdefg' });
    expect(await joined(res)).toBe(true);
    expect(await member('alice')).toMatchObject({ invite: 'abcdefg' });
    expect((await invite('abcdefg')).used).toBe(1);
  });

  it('owners never spend a place', async () => {
    await seedInvite('abcdefg');
    const token = await signedIn('owner', 'owner@example.com');
    expect(await joined(await post('/api/redeem', token, { code: 'abcdefg' }))).toBe(true);
    expect((await invite('abcdefg')).used).toBe(0);
  });

  it.each([
    ['an unknown code', 'zzzzzzz', {}],
    ['a full invite', 'abcdefg', { limit: 1, used: 1, users: { x: 1 } }],
    ['an expired invite', 'abcdefg', { expiresAt: Date.now() - 1000 }],
    ['a revoked invite', 'abcdefg', { revoked: true }],
  ])('leaves the account a guest on %s, noting the link', async (_label, code, seed) => {
    await seedInvite('abcdefg', seed as Partial<InviteRecord>);
    const before = await invite('abcdefg');
    const res = await post('/api/redeem', await signedIn('alice'), { code });
    expect(await res.json()).toEqual({ joined: false });
    expect(await member('alice')).toBeNull();
    expect(await guest('alice')).toMatchObject({ email: 'alice@example.com', invite: code });
    expect(await invite('abcdefg')).toEqual(before);
  });

  it('a malformed code leaves a guest without a link noted', async () => {
    const res = await post('/api/redeem', await signedIn('alice'), { code: '../../x' });
    expect(await joined(res)).toBe(false);
    const record = await guest('alice');
    expect(record).toMatchObject({ email: 'alice@example.com' });
    expect(record).not.toHaveProperty('invite');
  });

  it('keeps when a guest was first seen', async () => {
    await db.ref('guests/alice').set({ firstSeenAt: 5, lastSeenAt: 5 });
    await post('/api/redeem', await signedIn('alice'), { code: 'zzzzzzz' });
    const record = await guest('alice');
    expect(record.firstSeenAt).toBe(5);
    expect(record.lastSeenAt).toBeGreaterThan(5);
  });

  it('a disabled member is not let back in by a fresh invite', async () => {
    await seedInvite('abcdefg');
    await db
      .ref('members/bob')
      .set({ invite: 'old1234', joinedAt: 1, lastSeenAt: 1, disabled: true });
    const res = await post('/api/redeem', await signedIn('bob'), { code: 'abcdefg' });
    expect(await joined(res)).toBe(false);
    expect((await invite('abcdefg')).used).toBe(0);
    expect((await member('bob')).disabled).toBe(true);
    expect(await guest('bob')).toBeNull();
  });

  it('gives the last place to exactly one of many concurrent accounts', async () => {
    await seedInvite('abcdefg', { limit: 1 });
    const uids = Array.from({ length: 8 }, (_, i) => `racer${i}`);
    const tokens = await Promise.all(uids.map((uid) => signedIn(uid)));
    const results = await Promise.all(
      tokens.map((token) => post('/api/redeem', token, { code: 'abcdefg' })),
    );
    const outcomes = await Promise.all(results.map(joined));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const after = await invite('abcdefg');
    expect(after.used).toBe(1);
    expect(Object.keys(after.users ?? {})).toHaveLength(1);
    const members = (await db.ref('members').get()).val() ?? {};
    expect(Object.keys(members)).toEqual(Object.keys(after.users ?? {}));
    const guests = (await db.ref('guests').get()).val() ?? {};
    expect(Object.keys(guests)).toHaveLength(7);
  });

  it('one account opening two links at once spends a place in only one of them', async () => {
    for (let round = 0; round < 5; round++) {
      await db.ref().set(null);
      await seedInvite('abcdefg');
      await seedInvite('hjkmnpq');
      const token = await signedIn(`twin${round}`);
      const results = await Promise.all([
        post('/api/redeem', token, { code: 'abcdefg' }),
        post('/api/redeem', token, { code: 'hjkmnpq' }),
      ]);
      expect(await Promise.all(results.map(joined))).toEqual([true, true]);
      const used = (await invite('abcdefg')).used + (await invite('hjkmnpq')).used;
      expect(used).toBe(1);
      const record = await member(`twin${round}`);
      const holder = record.invite === 'abcdefg' ? 'abcdefg' : 'hjkmnpq';
      expect((await invite(holder)).users).toHaveProperty(`twin${round}`);
    }
  });
});

describe('addPeriod', () => {
  const at = (iso: string) => Date.parse(iso);

  it.each([
    ['day', '2026-11-03T10:00:00Z', '2026-11-04T10:00:00Z'],
    ['week', '2026-11-03T10:00:00Z', '2026-11-10T10:00:00Z'],
    ['month', '2026-11-03T10:00:00Z', '2026-12-03T10:00:00Z'],
    ['month', '2026-01-31T10:00:00Z', '2026-02-28T10:00:00Z'],
    ['month', '2028-01-31T10:00:00Z', '2028-02-29T10:00:00Z'],
    ['month', '2026-12-15T10:00:00Z', '2027-01-15T10:00:00Z'],
    ['year', '2026-11-03T10:00:00Z', '2027-11-03T10:00:00Z'],
    ['year', '2028-02-29T10:00:00Z', '2029-02-28T10:00:00Z'],
  ] as const)('a %s from %s is %s', (period, from, to) => {
    expect(addPeriod(at(from), period)).toBe(at(to));
  });
});

describe('/api/admin/invites', () => {
  async function adminToken() {
    await createUser('owner', 'owner@example.com');
    await auth.setCustomUserClaims('owner', { admin: true });
    return idTokenFor('owner');
  }

  async function list(token: string) {
    const res = await app.request('/api/admin/invites', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { invites: ActiveInvite[] }).invites;
  }

  it('is closed to non-admins', async () => {
    const body = { limit: 1, period: 'day' };
    expect((await post('/api/admin/invites', null, body)).status).toBe(401);
    const alice = await signedIn('alice');
    expect((await post('/api/admin/invites', alice, body)).status).toBe(403);
    const res = await app.request('/api/admin/invites', {
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(res.status).toBe(403);
  });

  it('creates an invite that expires one period from now and can be redeemed', async () => {
    const before = Date.now();
    const res = await post('/api/admin/invites', await adminToken(), { limit: 3, period: 'week' });
    expect(res.status).toBe(201);
    const { code } = (await res.json()) as { code: string };
    expect(isValidCode(code)).toBe(true);
    const created = await invite(code);
    expect(created).toMatchObject({ limit: 3, used: 0 });
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(created.expiresAt).toBeGreaterThanOrEqual(before + week);
    expect(created.expiresAt).toBeLessThanOrEqual(Date.now() + week);

    const res2 = await post('/api/redeem', await signedIn('alice'), { code });
    expect(await joined(res2)).toBe(true);
  });

  it('lists only links that can still let someone in, newest first', async () => {
    const future = Date.now() + 60_000;
    await seedInvite('aaaaaaa', { limit: 5, used: 2, createdAt: 10, expiresAt: future });
    await seedInvite('bbbbbbb', { limit: 1, used: 0, createdAt: 20 });
    await seedInvite('ccccccc', { limit: 1, used: 1, createdAt: 30, expiresAt: future });
    await seedInvite('ddddddd', { createdAt: 40, expiresAt: Date.now() - 1 });
    await seedInvite('eeeeeee', { createdAt: 50, revoked: true });

    expect(await list(await adminToken())).toEqual([
      { code: 'bbbbbbb', limit: 1, used: 0, left: 1, createdAt: 20, expiresAt: null },
      { code: 'aaaaaaa', limit: 5, used: 2, left: 3, createdAt: 10, expiresAt: future },
    ]);
  });

  it('lists nothing when there are no invites', async () => {
    expect(await list(await adminToken())).toEqual([]);
  });

  it.each([
    [{ period: 'day' }, 'invalid_limit'],
    [{ limit: 0, period: 'day' }, 'invalid_limit'],
    [{ limit: 1.5, period: 'day' }, 'invalid_limit'],
    [{ limit: 101, period: 'day' }, 'invalid_limit'],
    [{ limit: '3', period: 'day' }, 'invalid_limit'],
    [{ limit: 1 }, 'invalid_period'],
    [{ limit: 1, period: 'decade' }, 'invalid_period'],
    [{ limit: 1, period: 86400000 }, 'invalid_period'],
  ])('rejects %j', async (body, error) => {
    const res = await post('/api/admin/invites', await adminToken(), body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it('accepts the 100-place maximum', async () => {
    const res = await post('/api/admin/invites', await adminToken(), {
      limit: 100,
      period: 'year',
    });
    expect(res.status).toBe(201);
  });
});
