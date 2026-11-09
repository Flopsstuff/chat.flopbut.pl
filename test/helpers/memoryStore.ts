import type { ObjectStore, StoredObject } from '../../server/kbBucket.js';

/**
 * A bucket in memory, standing in for Cloud Storage; `reads` records the downloads, and `failing`
 * makes every call throw, as an unreachable bucket would.
 */
export class MemoryStore implements ObjectStore {
  objects = new Map<string, { bytes: Uint8Array; meta: StoredObject }>();
  reads: string[] = [];
  failing = false;
  #generation = 1;

  put(name: string, content: string | Uint8Array, updated = Date.now()) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const generation = String(this.#generation++);
    this.objects.set(name, { bytes, meta: { name, size: bytes.byteLength, generation, updated } });
  }

  /** Puts every file under a prefix, by path. */
  putAll(prefix: string, files: Record<string, string | Uint8Array>) {
    for (const [path, content] of Object.entries(files)) this.put(prefix + path, content);
  }

  async list(prefix: string) {
    if (this.failing) throw new Error('bucket unreachable');
    return [...this.objects.values()].map((o) => o.meta).filter((m) => m.name.startsWith(prefix));
  }

  async stat(name: string) {
    return this.objects.get(name)?.meta ?? null;
  }

  async read(name: string) {
    if (this.failing) throw new Error('bucket unreachable');
    this.reads.push(name);
    return this.objects.get(name)?.bytes ?? null;
  }
}
