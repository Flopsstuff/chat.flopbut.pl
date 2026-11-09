import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminKb } from '../server/adminKb.js';
import { Knowledge } from '../server/bot/kb.js';
import { auth, db } from '../server/firebase.js';
import { BASE_PREFIX, bucketFolder } from '../server/kbBucket.js';
import { clearAuth, createUser, idTokenFor } from './helpers/emulator.js';
import { MemoryStore } from './helpers/memoryStore.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const BASE = {
  'CARD.md': '# Card\nHead of Mobile.\n',
  'INDEX.md': '# Map\n- `career/skills.md`\n',
  'SKILLS.md': '# Skills\n',
  'README.md': 'For maintainers.',
  'career/skills.md': 'Swift, Kotlin.',
  'career/other.md': 'Other.',
  'scripts/build.md': 'tooling',
  'private/rates.md': 'Never.',
  'photos/keryx/on-speaker.jpg': JPEG,
};

function bucket(files: Record<string, string | Uint8Array> = BASE) {
  const objects = new MemoryStore();
  objects.putAll(BASE_PREFIX, files);
  return { objects, folder: bucketFolder(objects) };
}

describe('the bucket as a folder', () => {
  it('lists the files under base/ by their path in it, hidden ones aside', async () => {
    const { objects, folder } = bucket({ 'CARD.md': 'card', '.github/ci.yml': 'ci' });
    objects.put('elsewhere/x.md', 'not the base');
    expect((await folder.list()).map((e) => e.path)).toEqual(['CARD.md']);
    expect(await folder.stat('CARD.md')).toMatchObject({ path: 'CARD.md', size: 4 });
    expect(await folder.stat('none.md')).toBeNull();
    expect(new TextDecoder().decode((await folder.read('CARD.md')) ?? undefined)).toBe('card');
  });

  it('gives the bot the notes, without photos, tooling or anything private', async () => {
    const { objects, folder } = bucket();
    const kb = new Knowledge(folder);
    expect(await kb.preloaded()).toBe(
      '# Card\nHead of Mobile.\n\n# Map\n- `career/skills.md`\n\n# Skills',
    );
    expect(await kb.listFiles()).toBe('career/other.md\ncareer/skills.md');
    expect(await kb.grep('kotlin')).toBe('career/skills.md:1: Swift, Kotlin.');
    expect(objects.reads.some((name) => /private|scripts|README|\.jpg/.test(name))).toBe(false);
  });

  it('sees every change at once, and downloads only the files that changed', async () => {
    const { objects, folder } = bucket();
    const kb = new Knowledge(folder);
    await kb.grep('x');
    objects.reads = [];
    expect(await kb.grep('Swift')).toBe('career/skills.md:1: Swift, Kotlin.');
    expect(objects.reads).toEqual([]);

    objects.put(`${BASE_PREFIX}career/skills.md`, 'Swift, Kotlin, Rust.');
    objects.objects.delete(`${BASE_PREFIX}career/other.md`);
    objects.put(`${BASE_PREFIX}career/new.md`, 'New.');
    expect(await kb.grep('Rust|New|Other')).toBe(
      'career/new.md:1: New.\ncareer/skills.md:1: Swift, Kotlin, Rust.',
    );
    expect(objects.reads.sort()).toEqual([
      `${BASE_PREFIX}career/new.md`,
      `${BASE_PREFIX}career/skills.md`,
    ]);
    expect(await kb.readNote('career/other.md')).toMatch(/^No note at/);
  });

  it('fails a tool call while the bucket cannot be read, and works again after', async () => {
    const { objects, folder } = bucket();
    const kb = new Knowledge(folder);
    objects.failing = true;
    await expect(kb.readNote('career/skills.md')).rejects.toThrow('bucket unreachable');
    objects.failing = false;
    expect(await kb.readNote('career/skills.md')).toBe('Swift, Kotlin.');
  });
});

describe('/api/admin/kb', () => {
  beforeEach(async () => {
    await clearAuth();
    await db.ref().set(null);
  });

  async function token(admin: boolean) {
    await createUser('someone', 'someone@example.com');
    if (admin) await auth.setCustomUserClaims('someone', { admin: true });
    return idTokenFor('someone');
  }

  function get(app: Hono, bearer: string) {
    return app.request('/api/admin/kb', { headers: { authorization: `Bearer ${bearer}` } });
  }

  it('shows the folder as it is now: every file, what it is to the bot, when it changed', async () => {
    const objects = new MemoryStore();
    objects.put(`${BASE_PREFIX}INDEX.md`, 'map', 3000);
    objects.put(`${BASE_PREFIX}career/a.md`, 'note', 2000);
    objects.put(`${BASE_PREFIX}photos/a.jpg`, JPEG, 2000);
    objects.put(`${BASE_PREFIX}photos/README.md`, 'how to', 1000);
    const app = new Hono().route('/api/admin/kb', adminKb(bucketFolder(objects), 'flopbut-kb'));

    const body = await (await get(app, await token(true))).json();
    expect(body).toEqual({
      bucket: 'flopbut-kb',
      files: [
        { path: 'INDEX.md', size: 3, updated: 3000, kind: 'prompt' },
        { path: 'career/a.md', size: 4, updated: 2000, kind: 'note' },
        { path: 'photos/README.md', size: 6, updated: 1000, kind: 'other' },
        { path: 'photos/a.jpg', size: 7, updated: 2000, kind: 'photo' },
      ],
    });
  });

  it('is closed to non-admins', async () => {
    const app = new Hono().route('/api/admin/kb', adminKb(bucket().folder, 'b'));
    expect((await get(app, await token(false))).status).toBe(403);
  });
});
