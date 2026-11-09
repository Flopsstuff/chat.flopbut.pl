import type { KbEntry, KbFolder } from './bot/kb.js';

// The knowledge base's folder in a private Cloud Storage bucket: the objects under base/, which
// the owner fills (scripts/kb-push.sh mirrors a local folder there). To the bot it is a folder like
// any other (server/bot/kb.ts): every list and read goes to the bucket as it is at that moment.

/** Where the knowledge base's files are in the bucket. */
export const BASE_PREFIX = 'base/';

/** One object in the bucket. */
export type StoredObject = { name: string; size: number; generation: string; updated: number };

/** The few bucket operations the server needs, so tests can stand in for Cloud Storage. */
export interface ObjectStore {
  list(prefix: string): Promise<StoredObject[]>;
  stat(name: string): Promise<StoredObject | null>;
  read(name: string): Promise<Uint8Array | null>;
}

/** An object as a file of the folder; its generation changes whenever it is written. */
function entry(object: StoredObject): KbEntry {
  return {
    path: object.name.slice(BASE_PREFIX.length),
    size: object.size,
    updated: object.updated,
    stamp: object.generation,
  };
}

/** The objects under base/ as a folder; hidden files aside, as on disk. */
export function bucketFolder(store: ObjectStore): KbFolder {
  return {
    async list() {
      return (await store.list(BASE_PREFIX))
        .map(entry)
        .filter((e) => e.path && !e.path.split('/').some((part) => part.startsWith('.')));
    },
    async stat(path) {
      const object = await store.stat(BASE_PREFIX + path);
      return object && entry(object);
    },
    read: (path) => store.read(BASE_PREFIX + path),
  };
}
