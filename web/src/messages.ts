import { limitToLast, onValue, query, ref } from 'firebase/database';
import { useEffect, useState } from 'react';
import { database } from './firebase';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  status?: 'streaming' | 'done' | 'error';
  /** The note that opens the chat, so the bot speaks first: it is never shown. */
  hidden?: boolean;
};

/** How many of the latest messages the chat screen keeps loaded. */
const LOADED = 200;

export type MessagesState =
  | { state: 'loading' }
  | { state: 'ready'; messages: Message[] }
  | { state: 'error'; message: string };

/** The account's chat, live from RTDB: the server writes it, the rules let only its owner read. */
export function useMessages(uid: string): MessagesState {
  return useMessagesAt(`chats/${uid}/messages`);
}

/** Messages under any path laid out like a chat's, such as an archived chat for the admin. */
export function useMessagesAt(path: string): MessagesState {
  const [state, setState] = useState<MessagesState>({ state: 'loading' });

  useEffect(() => {
    setState({ state: 'loading' });
    const latest = query(ref(database, path), limitToLast(LOADED));
    return onValue(
      latest,
      (snapshot) => {
        const messages: Message[] = [];
        snapshot.forEach((child) => {
          messages.push({ id: child.key as string, ...(child.val() as Omit<Message, 'id'>) });
        });
        setState({ state: 'ready', messages });
      },
      (err) => setState({ state: 'error', message: err.message }),
    );
  }, [path]);

  return state;
}
