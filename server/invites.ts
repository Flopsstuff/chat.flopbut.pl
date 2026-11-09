import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { type AuthEnv, isOwner, requireAdmin, requireUser } from './auth.js';
import { db } from './firebase.js';
import { type MemberRecord, profileOf, recordGuest } from './members.js';

export type InviteRecord = {
  limit: number;
  used: number;
  createdAt: number;
  expiresAt?: number;
  revoked?: boolean;
  /** Accounts that joined through this invite: uid -> joinedAt. */
  users?: Record<string, number>;
};

/** What the admin sees for an invite that can still let someone in. */
export type ActiveInvite = {
  code: string;
  limit: number;
  used: number;
  left: number;
  createdAt: number;
  expiresAt: number | null;
};

// No look-alikes: 0/o, 1/l/i are left out, so a code read aloud or retyped survives.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 7;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function isValidCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_PATTERN.test(code);
}

/**
 * Answers `{ joined }` and nothing more. Why a link did not let someone in (unknown, full,
 * expired, withdrawn) is not told: everyone left outside sees the same waiting-list screen.
 */
export const redeem = new Hono<AuthEnv>().post('/', requireUser, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ code?: unknown }>().catch(() => ({}) as { code?: unknown });
  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : body.code;

  // Owners never need an invite, and an existing account never spends a second place.
  if (isOwner(user)) return c.json({ joined: true });
  const memberRef = db.ref(`members/${user.uid}`);
  const member = (await memberRef.get()).val() as MemberRecord | null;
  if (member) return c.json({ joined: member.disabled !== true });

  if (!isValidCode(code)) {
    await recordGuest(user);
    return c.json({ joined: false });
  }

  // The transaction is what makes the last place go to exactly one account. The handler can
  // run several times, the first time against a local null, so the outcome is whatever the
  // final run decided.
  const now = Date.now();
  // Assigned inside the transaction handler, which TypeScript cannot see through.
  let joined = false as boolean;
  let spent = false as boolean;
  const result = await db.ref(`invites/${code}`).transaction((invite: InviteRecord | null) => {
    joined = false;
    spent = false;
    if (invite === null) return null;
    // A place already taken here stays this account's, even once the link expired or was
    // withdrawn: that is how a lost member record is recovered.
    if (invite.users?.[user.uid] !== undefined) {
      joined = true;
      return;
    }
    if (invite.revoked || (invite.expiresAt !== undefined && invite.expiresAt <= now)) return;
    if (invite.used >= invite.limit) return;
    joined = true;
    spent = true;
    return { ...invite, used: invite.used + 1, users: { ...invite.users, [user.uid]: now } };
  });
  if (result.committed && !result.snapshot.exists()) joined = false;

  if (!joined) {
    await recordGuest(user, code);
    return c.json({ joined: false });
  }

  // If this write is lost, the place is already recorded under users/{uid}, so redeeming the
  // same link again recreates the member without spending another place.
  //
  // The member record is created only where none exists, so when one account opens two links
  // at once exactly one of them admits it. The other gives back the place it took.
  const record: MemberRecord = { ...profileOf(user), invite: code, joinedAt: now, lastSeenAt: now };
  const created = await memberRef.transaction((current: MemberRecord | null) =>
    current === null ? record : undefined,
  );
  if (!created.committed) {
    if (spent) await releasePlace(code, user.uid, now);
    const existing = created.snapshot.val() as MemberRecord | null;
    return c.json({ joined: existing !== null && existing.disabled !== true });
  }
  await db.ref(`guests/${user.uid}`).remove();
  return c.json({ joined: true });
});

/** Undoes a place this request took on `code`, recognised by the time it was taken. */
async function releasePlace(code: string, uid: string, takenAt: number): Promise<void> {
  await db.ref(`invites/${code}`).transaction((invite: InviteRecord | null) => {
    if (invite === null) return null;
    if (invite.users?.[uid] !== takenAt) return;
    const { [uid]: _, ...users } = invite.users;
    return { ...invite, used: invite.used - 1, users };
  });
}

export const MAX_LIMIT = 100;
export const PERIODS = ['day', 'week', 'month', 'year'] as const;
export type Period = (typeof PERIODS)[number];

/** `from` moved forward by one period. Months and years follow the calendar, clamped to the
 * end of a shorter month (31 January plus a month is 28 or 29 February). */
export function addPeriod(from: number, period: Period): number {
  const day = 24 * 60 * 60 * 1000;
  if (period === 'day') return from + day;
  if (period === 'week') return from + 7 * day;
  const date = new Date(from);
  const months = period === 'month' ? 1 : 12;
  const target = new Date(date);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target.getTime();
}

function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value);
}

export const adminInvites = new Hono<AuthEnv>()
  .use(requireUser, requireAdmin)
  .get('/', async (c) => {
    const all = ((await db.ref('invites').get()).val() ?? {}) as Record<string, InviteRecord>;
    const now = Date.now();
    const invites: ActiveInvite[] = Object.entries(all)
      .map(([code, invite]) => ({
        code,
        limit: invite.limit,
        used: invite.used,
        left: Math.max(0, invite.limit - invite.used),
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt ?? null,
        revoked: invite.revoked === true,
      }))
      .filter((i) => !i.revoked && i.left > 0 && (i.expiresAt === null || i.expiresAt > now))
      .map(({ revoked: _, ...invite }) => invite)
      .sort((a, b) => b.createdAt - a.createdAt);
    return c.json({ invites });
  })
  .post('/', async (c) => {
    const body = await c.req.json<{ limit?: unknown; period?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: 'invalid_body' }, 400);

    const { limit, period } = body;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json({ error: 'invalid_limit' }, 400);
    }
    if (!isPeriod(period)) return c.json({ error: 'invalid_period' }, 400);

    const now = Date.now();
    const invite: InviteRecord = {
      limit,
      used: 0,
      createdAt: now,
      expiresAt: addPeriod(now, period),
    };

    // 31^7 is about 27 billion codes, so a collision is unlikely; the transaction makes it
    // impossible to overwrite one anyway.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const result = await db
        .ref(`invites/${code}`)
        .transaction((current: InviteRecord | null) => (current === null ? invite : undefined));
      if (result.committed) return c.json({ code, expiresAt: invite.expiresAt }, 201);
    }
    return c.json({ error: 'code_collision' }, 500);
  });
