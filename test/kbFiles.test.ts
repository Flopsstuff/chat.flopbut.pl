import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { localFolder } from '../server/bot/kb.js';
import { auth, db } from '../server/firebase.js';
import { BASE_PREFIX, bucketFolder } from '../server/kbBucket.js';
import { assetPath, kbFiles } from '../server/kbFiles.js';
import { clearAuth, createUser, idTokenFor } from './helpers/emulator.js';
import { MemoryStore } from './helpers/memoryStore.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('picture paths', () => {
  it('reads a picture path as a note or the bot writes it, and nothing outside', () => {
    expect(assetPath('photos/keryx/on-speaker.jpg')).toBe('photos/keryx/on-speaker.jpg');
    expect(assetPath('../../photos/keryx/on-speaker.jpg')).toBe('photos/keryx/on-speaker.jpg');
    expect(assetPath('kb/photos/a%20b.png')).toBe('photos/a b.png');
    expect(assetPath('photos/../../etc/passwd.jpg')).toBeNull();
    expect(assetPath('INDEX.md')).toBeNull();
    expect(assetPath('%E0%A4%A')).toBeNull();
  });
});

describe('GET /api/kb', () => {
  beforeEach(async () => {
    await clearAuth();
    await db.ref().set(null);
  });

  function setup() {
    const objects = new MemoryStore();
    objects.putAll(BASE_PREFIX, {
      'INDEX.md': '# Map',
      'photos/keryx/on-speaker.jpg': JPEG,
      'private/secret.jpg': JPEG,
      '.github/logo.png': JPEG,
      'photos/huge.jpg': new Uint8Array(5 * 1024 * 1024 + 1),
    });
    const app = new Hono().route('/api/kb', kbFiles(bucketFolder(objects)));
    const get = (path: string, token: string | null, headers: Record<string, string> = {}) =>
      app.request(`/api/kb/${path}`, {
        headers: { ...headers, ...(token && { authorization: `Bearer ${token}` }) },
      });
    return { objects, get };
  }

  async function member(uid: string, extra: Record<string, unknown> = {}) {
    await createUser(uid, `${uid}@example.com`);
    await db.ref(`members/${uid}`).set({ invite: 'abcdefg', joinedAt: 1, lastSeenAt: 1, ...extra });
    return idTokenFor(uid);
  }

  it('gives a member the photo from the bucket, read once and tagged by its generation', async () => {
    const { objects, get } = setup();
    const token = await member('alice');
    const res = await get('photos/keryx/on-speaker.jpg', token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    const etag = res.headers.get('etag') ?? '';
    expect(
      (await get('photos/keryx/on-speaker.jpg', token, { 'if-none-match': etag })).status,
    ).toBe(304);
    expect(objects.reads).toEqual([`${BASE_PREFIX}photos/keryx/on-speaker.jpg`]);

    objects.put(`${BASE_PREFIX}photos/keryx/on-speaker.jpg`, new Uint8Array([9]));
    const replaced = await get('photos/keryx/on-speaker.jpg', token, { 'if-none-match': etag });
    expect(replaced.status).toBe(200);
    expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(new Uint8Array([9]));
  });

  it('gives nothing to a stranger, a disabled member or anyone signed out', async () => {
    const { get } = setup();
    expect((await get('photos/keryx/on-speaker.jpg', null)).status).toBe(401);
    await createUser('stranger', 'stranger@example.com');
    expect((await get('photos/keryx/on-speaker.jpg', await idTokenFor('stranger'))).status).toBe(
      403,
    );
    const disabled = await member('bob', { disabled: true });
    expect((await get('photos/keryx/on-speaker.jpg', disabled)).status).toBe(403);
  });

  it('lets an admin in without a member record', async () => {
    const { get } = setup();
    await createUser('owner', 'owner@example.com');
    await auth.setCustomUserClaims('owner', { admin: true });
    expect((await get('photos/keryx/on-speaker.jpg', await idTokenFor('owner'))).status).toBe(200);
  });

  it('answers 404 for anything that is not a picture of the base, or is too large', async () => {
    const { get } = setup();
    const token = await member('alice');
    for (const path of [
      'private/secret.jpg',
      '.github/logo.png',
      'INDEX.md',
      'photos/none.jpg',
      'photos/huge.jpg',
    ]) {
      expect((await get(path, token)).status).toBe(404);
    }
  });

  it('serves from a local folder the same way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-'));
    mkdirSync(join(dir, 'photos'));
    writeFileSync(join(dir, 'photos/a.png'), JPEG);
    const app = new Hono().route('/api/kb', kbFiles(localFolder(dir)));
    const res = await app.request('/api/kb/photos/a.png', {
      headers: { authorization: `Bearer ${await member('carol')}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
