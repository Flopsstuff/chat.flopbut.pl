import type { User } from 'firebase/auth';
import { createContext } from 'react';

// The pictures of the knowledge base sit behind the member's token (server/kbFiles.ts), so an
// <img> cannot load them by address: they are fetched with the token and shown from a blob.

/** The signed-in account, for components deep in a message that fetch with its token. */
export const SignedInUser = createContext<User | null>(null);

const loaded = new Map<string, Promise<string>>();

/** A picture's path inside the base, from what a note or the bot wrote; null for anything else. */
export function kbAssetPath(src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
  const path = src.replace(/^(\.\.?\/)+|^\/+/g, '').replace(/^kb\//, '');
  if (path.split('/').includes('..')) return null;
  return /\.(jpe?g|png|webp|gif)$/i.test(path) ? path : null;
}

/** A local address for the picture, fetched once per page. */
export function kbImageUrl(user: User, path: string): Promise<string> {
  let url = loaded.get(path);
  if (!url) {
    url = (async () => {
      const token = await user.getIdToken();
      const address = `/api/kb/${path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(address, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`${address}: ${res.status}`);
      return URL.createObjectURL(await res.blob());
    })();
    // A failure is not remembered: the next time the picture is shown, it is tried again.
    url.catch(() => loaded.delete(path));
    loaded.set(path, url);
  }
  return url;
}
