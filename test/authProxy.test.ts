import { describe, expect, it } from 'vitest';
import { authProxy, FIREBASE_AUTH_ORIGIN } from '../server/authProxy.js';

describe('the sign-in proxy at /__', () => {
  function upstream() {
    const seen: Request[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      return new Response('<html>handler</html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'x-upstream': 'yes' },
      });
    };
    return { seen, fetch: fetch as typeof globalThis.fetch };
  }

  it('passes requests through to the same path on firebaseapp.com', async () => {
    const { seen, fetch } = upstream();
    const proxied = authProxy('https://example.firebaseapp.com', fetch);
    const res = await proxied.request('/__/auth/handler?apiKey=k&authType=signInViaPopup', {
      headers: { host: 'chat.flopbut.pl', 'user-agent': 'Safari' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>handler</html>');
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(seen[0]?.url).toBe(
      'https://example.firebaseapp.com/__/auth/handler?apiKey=k&authType=signInViaPopup',
    );
    expect(seen[0]?.headers.get('user-agent')).toBe('Safari');
    expect(seen[0]?.headers.get('host')).toBeNull();
  });

  it('passes a POST with its body', async () => {
    const { seen, fetch } = upstream();
    const proxied = authProxy('https://example.firebaseapp.com', fetch);
    await proxied.request('/__/auth/handler', { method: 'POST', body: 'state=abc' });
    expect(seen[0]?.method).toBe('POST');
    expect(await seen[0]?.text()).toBe('state=abc');
  });

  it('points at the project on firebaseapp.com', () => {
    expect(FIREBASE_AUTH_ORIGIN).toBe('https://demo-chat.firebaseapp.com');
  });
});
