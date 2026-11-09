import type { DecodedIdToken } from 'firebase-admin/auth';
import type { About } from './about.js';
import { db } from './firebase.js';

export type MemberRecord = {
  email: string | null;
  name: string | null;
  photo: string | null;
  /** Invite code the account joined through, or "owner". */
  invite: string;
  joinedAt: number;
  lastSeenAt: number;
  disabled?: boolean;
  /** The short form after the invite: who they are, for the bot. Absent until asked. */
  about?: About;
};

export function profileOf(user: DecodedIdToken) {
  return {
    email: user.email ?? null,
    name: typeof user.name === 'string' ? user.name : null,
    photo: user.picture ?? null,
  };
}

/** Someone who signed in without access yet: kept so they can be invited later. */
export type GuestRecord = {
  email: string | null;
  name: string | null;
  photo: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** The last invite link they opened, when it could not let them in. */
  invite?: string;
};

/** Creates or refreshes `guests/{uid}`, keeping when they were first seen. */
export async function recordGuest(user: DecodedIdToken, invite?: string): Promise<void> {
  const now = Date.now();
  const profile = profileOf(user);
  await db.ref(`guests/${user.uid}`).transaction((guest: GuestRecord | null) => {
    const lastInvite = invite ?? guest?.invite;
    return {
      ...profile,
      firstSeenAt: guest?.firstSeenAt ?? now,
      lastSeenAt: now,
      ...(lastInvite !== undefined && { invite: lastInvite }),
    } satisfies GuestRecord;
  });
}
