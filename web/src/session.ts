import { onAuthStateChanged, type User } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMe, type Me } from './api';
import { auth } from './firebase';

export type Session =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string }
  | { state: 'signed-in'; user: User; me: Me };

/** The signed-in account and its /api/me answer, plus a way to fetch that answer again. */
export function useSession(): [Session, () => void] {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  // Each auth change or refresh starts a generation. A /api/me answer that arrives after a
  // newer one started (sign-out in another tab, account switch) is dropped.
  const generation = useRef(0);

  const load = useCallback((user: User | null) => {
    const current = ++generation.current;
    if (!user) {
      setSession({ state: 'signed-out' });
      return;
    }
    setSession({ state: 'loading' });
    fetchMe(user).then(
      (me) => {
        if (current === generation.current) setSession({ state: 'signed-in', user, me });
      },
      (err: unknown) => {
        if (current !== generation.current) return;
        setSession({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, load);
    return () => {
      generation.current++;
      unsubscribe();
    };
  }, [load]);

  const refresh = useCallback(() => load(auth.currentUser), [load]);
  return [session, refresh];
}
