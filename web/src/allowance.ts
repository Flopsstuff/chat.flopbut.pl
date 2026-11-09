import { onValue, ref } from 'firebase/database';
import { useEffect, useState } from 'react';
import { database } from './firebase';

/** chats/{uid}/allowance, written by the server. Absent means the chat has all of it left. */
export type Allowance = { left: number; resetAt?: number };

/** The member's allowance, live. Undefined while loading. */
export function useAllowance(uid: string): Allowance | undefined {
  const [allowance, setAllowance] = useState<Allowance | undefined>(undefined);

  useEffect(() => {
    setAllowance(undefined);
    return onValue(
      ref(database, `chats/${uid}/allowance`),
      (snapshot) => setAllowance((snapshot.val() as Allowance | null) ?? { left: 1 }),
      // Without it the chat still works; the server refuses questions once the chat is used up.
      () => setAllowance({ left: 1 }),
    );
  }, [uid]);

  return allowance;
}

/** True from `at` on, re-rendering the moment it arrives. */
export function useReached(at: number | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined || at <= Date.now()) return;
    // Timers longer than about 24.8 days overflow; a reset is never more than a day away.
    const timer = setTimeout(() => setNow(Date.now()), at - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return at !== undefined && now >= at;
}
