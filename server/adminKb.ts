import { Hono } from 'hono';
import { type AuthEnv, requireAdmin, requireUser } from './auth.js';
import { fileKind, type KbFolder } from './bot/kb.js';

/**
 * GET /api/admin/kb: the knowledge base's folder as it is now, which is what the bot reads: every
 * file with its size, when it last changed and what it is to the bot, for the map on /admin/kb.
 * `bucket` names the bucket, or is null where the folder is on disk.
 */
export function adminKb(folder: KbFolder, bucket: string | null) {
  return new Hono<AuthEnv>().use(requireUser, requireAdmin).get('/', async (c) => {
    const files = (await folder.list())
      .map(({ path, size, updated }) => ({ path, size, updated, kind: fileKind(path) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return c.json({ bucket, files });
  });
}
