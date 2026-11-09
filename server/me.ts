import { Hono } from 'hono';
import { refreshAllowance } from './allowance.js';
import { type AuthEnv, isOwner, requireUser } from './auth.js';
import { config } from './config.js';
import { auth, db } from './firebase.js';
import { type MemberRecord, profileOf, recordGuest } from './members.js';

export type Me = {
  uid: string;
  email: string | null;
  name: string | null;
  photo: string | null;
  member: boolean;
  disabled: boolean;
  admin: boolean;
  /** Custom claims changed: the client must refresh its ID token. */
  refreshToken: boolean;
  /** A member who has not seen the short form about themselves yet (owners never do). */
  askAbout: boolean;
};

export const me = new Hono<AuthEnv>().get('/', requireUser, async (c) => {
  const user = c.get('user');
  const owner = isOwner(user);
  const profile = profileOf(user);
  const now = Date.now();

  // The admin claim mirrors OWNER_EMAILS both ways, so removing an address revokes admin.
  // An empty list is treated as a misconfiguration, not as "nobody is an owner": admin claims
  // are then neither granted nor revoked, so a bad deploy cannot lock the owners out.
  let refreshToken = false;
  if ((user.admin === true) !== owner && config.ownerEmails.size > 0) {
    const record = await auth.getUser(user.uid);
    await auth.setCustomUserClaims(user.uid, { ...record.customClaims, admin: owner });
    refreshToken = true;
  }

  const ref = db.ref(`members/${user.uid}`);
  const existing = (await ref.get()).val() as MemberRecord | null;

  if (existing) {
    // A refused redeem racing a successful one can write the guest record back after the
    // join removed it; every visit of a member clears it again.
    await Promise.all([
      ref.update({ ...profile, lastSeenAt: now }),
      db.ref(`guests/${user.uid}`).remove(),
      // Changed limits reach the member's allowance on their next visit. Owners have no budget,
      // but their chat still has a context limit.
      existing.disabled === true && !owner
        ? undefined
        : refreshAllowance(
            user.uid,
            {
              budgetUsd: owner ? Number.POSITIVE_INFINITY : config.chatBudgetUsd,
              contextTokens: config.chatContextTokens,
              contextGapTokens: config.chatContextGapTokens,
            },
            now,
          ),
    ]);
  } else if (owner) {
    // An address added to OWNER_EMAILS after its first visit was recorded as a guest then.
    const record: MemberRecord = { ...profile, invite: 'owner', joinedAt: now, lastSeenAt: now };
    await db.ref().update({ [`members/${user.uid}`]: record, [`guests/${user.uid}`]: null });
  } else {
    // Anyone who signs in is remembered, so they can be sent an invite later.
    await recordGuest(user);
  }

  const disabled = !owner && existing?.disabled === true;
  const body: Me = {
    uid: user.uid,
    ...profile,
    member: owner || (existing !== null && !disabled),
    disabled,
    admin: owner,
    refreshToken,
    askAbout: !owner && existing !== null && !disabled && existing.about === undefined,
  };
  return c.json(body);
});
