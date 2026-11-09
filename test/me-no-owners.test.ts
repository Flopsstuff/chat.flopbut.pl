import { beforeAll, describe, expect, it } from 'vitest';
import type { Me } from '../server/me.js';

// A list that is present but has no addresses in it, as a stray comma or space in the
// OWNER_EMAILS variable would produce. Each test file gets its own module registry, so the
// config below is read with this value.
process.env.OWNER_EMAILS = ' , ';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
let app: typeof import('../server/app.js').app;
let auth: typeof import('../server/firebase.js').auth;

beforeAll(async () => {
  ({ app } = await import('../server/app.js'));
  ({ auth } = await import('../server/firebase.js'));
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/demo-chat/accounts`, { method: 'DELETE' });
});

async function idTokenFor(uid: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await auth.createCustomToken(uid), returnSecureToken: true }),
    },
  );
  return ((await res.json()) as { idToken: string }).idToken;
}

describe('GET /api/me with an empty owner list', () => {
  it('keeps an existing admin claim instead of revoking it', async () => {
    await auth.createUser({ uid: 'admin', email: 'admin@example.com', emailVerified: true });
    await auth.setCustomUserClaims('admin', { admin: true });

    const res = await app.request('/api/me', {
      headers: { authorization: `Bearer ${await idTokenFor('admin')}` },
    });
    const body = (await res.json()) as Me;

    expect(body.refreshToken).toBe(false);
    expect((await auth.getUser('admin')).customClaims).toEqual({ admin: true });
  });
});
