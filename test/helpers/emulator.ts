import { auth } from '../../server/firebase.js';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;

/** Signs `uid` in on the Auth emulator and returns a real ID token for it. */
export async function idTokenFor(uid: string): Promise<string> {
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

export async function createUser(uid: string, email: string, emailVerified = true) {
  await auth.createUser({ uid, email, emailVerified, displayName: uid });
}

export async function clearAuth() {
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/demo-chat/accounts`, { method: 'DELETE' });
}
