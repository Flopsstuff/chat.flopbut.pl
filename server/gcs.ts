import { getStorage } from 'firebase-admin/storage';
import { app } from './firebase.js';
import type { ObjectStore, StoredObject } from './kbBucket.js';

// The knowledge base's bucket through the Cloud Storage client that comes with the Admin SDK, as
// the runtime service account, which may only read it.

type Metadata = {
  name?: string;
  size?: string | number;
  generation?: string | number;
  updated?: string;
};

function stored(meta: Metadata): StoredObject {
  return {
    name: meta.name ?? '',
    size: Number(meta.size ?? 0),
    generation: String(meta.generation ?? ''),
    updated: meta.updated ? Date.parse(meta.updated) : 0,
  };
}

function code(err: unknown): number | undefined {
  return (err as { code?: number }).code;
}

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;

/** The bucket by name, as the runtime service account (or local application credentials). */
export function gcsBucket(name: string): Bucket {
  return getStorage(app).bucket(name);
}

export function gcsStore(bucket: Bucket): ObjectStore {
  return {
    async list(prefix) {
      const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
      return files.map((file) => stored(file.metadata));
    },
    async stat(name) {
      try {
        const [meta] = await bucket.file(name).getMetadata();
        return stored(meta);
      } catch (err) {
        if (code(err) === 404) return null;
        throw err;
      }
    },
    async read(name) {
      try {
        const [bytes] = await bucket.file(name).download();
        return new Uint8Array(bytes);
      } catch (err) {
        if (code(err) === 404) return null;
        throw err;
      }
    },
  };
}
