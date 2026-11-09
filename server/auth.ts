import type { DecodedIdToken } from 'firebase-admin/auth';
import { createMiddleware } from 'hono/factory';
import { config } from './config.js';
import { auth } from './firebase.js';

export type AuthEnv = { Variables: { user: DecodedIdToken } };

/** Verifies the Firebase ID token from `Authorization: Bearer`. Anyone with a Google account
 * passes this; whether they get in is decided by `members/{uid}`. */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match?.[1]) return c.json({ error: 'unauthenticated' }, 401);
  try {
    c.set('user', await auth.verifyIdToken(match[1]));
  } catch {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  await next();
});

/** Owners skip invites and are admins. Only a verified email counts. */
export function isOwner(user: DecodedIdToken): boolean {
  return (
    user.email_verified === true &&
    typeof user.email === 'string' &&
    config.ownerEmails.has(user.email.toLowerCase())
  );
}

/** For /api/admin/*: a valid token carrying the `admin` claim, which /api/me keeps in sync with
 * OWNER_EMAILS. Must run after requireUser. */
export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.get('user').admin !== true) return c.json({ error: 'forbidden' }, 403);
  await next();
});
