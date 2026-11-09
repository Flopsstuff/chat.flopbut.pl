import { posix } from 'node:path';
import { Hono } from 'hono';
import { type AuthEnv, requireUser } from './auth.js';
import { assetType, type KbFolder, MAX_ASSET_BYTES } from './bot/kb.js';
import { db } from './firebase.js';
import type { MemberRecord } from './members.js';

// The pictures of the knowledge base, for the photos the bot puts in its answers, read from its
// folder (the bucket in production) when shown: a replaced photo shows at once. Only members and
// admins may see them: the chat fetches them with the member's token, so they never sit at a
// public address. The last few are kept in memory while their stamp stays the same.

/** How much of the photos one instance keeps in memory. */
export const PHOTO_CACHE_BYTES = 32 * 1024 * 1024;

/** A picture's path as a note or the bot may write it: `../../photos/x.jpg`, `kb/photos/x.jpg`. */
export function assetPath(raw: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  path = posix.normalize(path.replace(/^(\.\.?\/)+|^\/+/g, '').replace(/^kb\//, ''));
  if (path.startsWith('..') || path.startsWith('/') || path.split('/').includes('..')) return null;
  return assetType(path) ? path : null;
}

/** A photo with the stamp of the file it was read from. */
type Photo = { bytes: Uint8Array; stamp: string };

/** The photos read last, by path, up to a total size; the oldest go first. */
class PhotoCache {
  #photos = new Map<string, Photo>();
  #bytes = 0;

  constructor(private readonly limit: number) {}

  get(path: string): Photo | undefined {
    return this.#photos.get(path);
  }

  set(path: string, photo: Photo) {
    this.delete(path);
    if (photo.bytes.byteLength > this.limit) return;
    this.#photos.set(path, photo);
    this.#bytes += photo.bytes.byteLength;
    for (const [oldest] of this.#photos) {
      if (this.#bytes <= this.limit) break;
      this.delete(oldest);
    }
  }

  delete(path: string) {
    const photo = this.#photos.get(path);
    if (!photo) return;
    this.#photos.delete(path);
    this.#bytes -= photo.bytes.byteLength;
  }
}

/** GET /api/kb/{path}: one picture of the base, to members and admins. */
export function kbFiles(folder: KbFolder) {
  const cache = new PhotoCache(PHOTO_CACHE_BYTES);

  /** The picture as the folder has it now, or null when there is none or it is too large. */
  async function find(path: string): Promise<Photo | null> {
    const entry = await folder.stat(path);
    if (!entry || entry.size > MAX_ASSET_BYTES) {
      cache.delete(path);
      return null;
    }
    const cached = cache.get(path);
    if (cached?.stamp === entry.stamp) return cached;
    const bytes = await folder.read(path);
    if (!bytes) return null;
    const photo = { bytes, stamp: entry.stamp };
    cache.set(path, photo);
    return photo;
  }

  return new Hono<AuthEnv>().get('/*', requireUser, async (c) => {
    const user = c.get('user');
    if (user.admin !== true) {
      const member = (await db.ref(`members/${user.uid}`).get()).val() as MemberRecord | null;
      if (!member || member.disabled === true) return c.json({ error: 'forbidden' }, 403);
    }
    const path = assetPath(c.req.path.replace(/^.*?\/api\/kb\//, ''));
    const type = path ? assetType(path) : null;
    const found = path && type ? await find(path) : null;
    if (!found || !type) return c.json({ error: 'not_found' }, 404);

    const etag = `"${found.stamp}:${path}"`;
    const headers = {
      'content-type': type,
      // The address stays the same when the photo is replaced, so the browser asks every time and
      // gets 304 while the stamp holds.
      'cache-control': 'private, no-cache',
      etag,
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(found.bytes, { headers });
  });
}
