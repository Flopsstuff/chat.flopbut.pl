import { Hono } from 'hono';
import { proxy } from 'hono/proxy';
import { config } from './config.js';

// Google sign-in runs its handler pages from the auth domain. On flopbut.firebaseapp.com that is
// another site than chat.flopbut.pl, and browsers that block third-party storage (Safari, the
// in-app browsers of iOS) never hand the result back to the chat: the page stays on "Sign in".
// So the chat serves /__/* itself, passed through to firebaseapp.com unchanged, and the client
// uses chat.flopbut.pl as its auth domain. See
// https://firebase.google.com/docs/auth/web/redirect-best-practices (option 3).

export const FIREBASE_AUTH_ORIGIN = `https://${config.projectId}.firebaseapp.com`;

/** Mounted at /__: every method and path, the query kept, to the same path on firebaseapp.com. */
export function authProxy(origin = FIREBASE_AUTH_ORIGIN, customFetch?: typeof fetch) {
  return new Hono().all('/*', (c) => {
    const url = new URL(c.req.url);
    return proxy(`${origin}${url.pathname}${url.search}`, {
      raw: c.req.raw,
      // The upstream answers for its own host, not ours.
      headers: { ...c.req.header(), host: undefined },
      customFetch,
    });
  });
}
