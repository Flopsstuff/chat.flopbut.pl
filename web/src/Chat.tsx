import type { User } from 'firebase/auth';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type Allowance, useAllowance, useReached } from './allowance';
import { ApiError, openChat, resetChat, sendMessage } from './api';
import { Markdown } from './Markdown';
import { type Message, type MessagesState, useMessages } from './messages';

const MAX_TEXT = 4000;

/**
 * The answer this tab is streaming over SSE, ahead of what RTDB has caught up with. `question` is
 * null for the greeting that opens the chat, which answers no visible question.
 */
type Live = { question: string | null; id: string | null; text: string };

/**
 * The member's one chat. It runs until it has spent its budget or filled its context, whichever
 * comes first: a bar shows the share left, and once nothing is left the chat stops until a new
 * one can be started (the next day; at once for owners). Earlier chats are not shown.
 */
export function Chat({ user, admin, header }: { user: User; admin: boolean; header: ReactNode }) {
  const chat = useMessages(user.uid);
  const allowance = useAllowance(user.uid);
  const spent = allowance?.left === 0;
  const [live, setLive] = useState<Live | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const messages = chat.state === 'ready' ? chat.messages : [];

  // Once RTDB holds the finished answer, the SSE copy is no longer needed.
  const settled = messages.find((m) => m.id === live?.id && m.status !== 'streaming');
  useEffect(() => {
    if (settled) setLive(null);
  }, [settled]);

  // An empty chat (a new account, or right after a reset) is opened by the bot: it greets the
  // member before they write. Once per empty chat in this tab; the server refuses a second
  // greeting from another tab, which then shows the first one through RTDB.
  const opened = useRef(false);
  const empty = chat.state === 'ready' && messages.length === 0;
  useEffect(() => {
    if (!empty) {
      opened.current = false;
      return;
    }
    if (opened.current || spent) return;
    opened.current = true;
    setLive({ question: null, id: null, text: '' });
    openChat(user, {
      start: (id) => setLive((l) => l && { ...l, id }),
      delta: (piece) => setLive((l) => l && { ...l, text: l.text + piece }),
    }).then(
      (outcome) => outcome !== 'done' && setLive(null),
      () => setLive(null),
    );
  }, [empty, spent, user]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || live) return;
    setProblem(null);
    setDraft('');
    setLive({ question: text, id: null, text: '' });
    try {
      const outcome = await sendMessage(user, text, {
        start: (id) => setLive((l) => l && { ...l, id }),
        delta: (piece) => setLive((l) => l && { ...l, text: l.text + piece }),
      });
      // The SSE copy is only ahead of RTDB while it flows. If it failed or dropped, RTDB
      // alone shows the answer (a dropped one is still being finished on the server).
      if (outcome !== 'done') setLive(null);
    } catch (err) {
      setLive(null);
      setDraft(text); // the question was not saved: give it back
      setProblem(
        err instanceof ApiError && err.code === 'busy'
          ? 'The previous answer is still being written. Try again in a moment.'
          : err instanceof ApiError && err.code === 'limit_reached'
            ? 'This chat has reached its limit.'
            : 'Could not send the message. Check the connection and try again.',
      );
    }
  }

  // Until RTDB shows the answer, the question and a typing answer are drawn from `live`.
  const shown = messages
    .filter((m) => !m.hidden)
    .map((m) =>
      m.id === live?.id && live.text.length > m.text.length ? { ...m, text: live.text } : m,
    );
  const waiting = live !== null && !messages.some((m) => m.id === live.id);

  // Admins start a new chat whenever they like: the current one goes to the archive, as when a
  // used-up chat is reset, and the bot greets them again.
  const [restarting, setRestarting] = useState(false);
  async function restart() {
    if (!window.confirm('Start a new chat? This one is put away, as after a reset.')) return;
    setRestarting(true);
    setProblem(null);
    try {
      await resetChat(user);
    } catch (err) {
      setProblem(
        err instanceof ApiError && err.code === 'busy'
          ? 'An answer is still being written. Try again in a moment.'
          : 'Could not start a new chat. Try again in a moment.',
      );
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div className="chat">
      {header}
      <Transcript
        empty={
          chat.state === 'ready' && shown.length === 0 && !waiting ? (
            <div className="chat-empty">
              <h1>Ask anything</h1>
              <p className="lead">
                Your messages are kept, and the chat picks up where you left off.
              </p>
            </div>
          ) : null
        }
      >
        <ChatStatus state={chat} />
        {shown.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
        {waiting && (
          <>
            {live.question !== null && (
              <Bubble message={{ id: 'q', role: 'user', text: live.question, ts: 0 }} />
            )}
            <Bubble
              message={{ id: 'a', role: 'assistant', text: '', ts: 0, status: 'streaming' }}
            />
          </>
        )}
      </Transcript>
      {admin && !spent && messages.length > 0 && (
        <div className="chat-tools">
          <button
            type="button"
            className="link"
            onClick={restart}
            disabled={restarting || live !== null}
          >
            New chat
          </button>
        </div>
      )}
      {spent && allowance ? (
        <Spent user={user} allowance={allowance} admin={admin} />
      ) : (
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          busy={live !== null}
          problem={problem}
          allowance={allowance}
        />
      )}
    </div>
  );
}

/** The share of the chat's budget left, as a bar with no amounts. */
function AllowanceBar({ left }: { left: number }) {
  const percent = Math.round(left * 100);
  return (
    <meter
      className={`allowance${percent < 20 ? ' low' : ''}`}
      min={0}
      max={100}
      low={20}
      optimum={100}
      value={percent}
      aria-label="Chat allowance left"
      title={`${percent}% left`}
      style={{ '--left': `${percent}%` } as CSSProperties}
    />
  );
}

const resetTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  hour: 'numeric',
  minute: '2-digit',
});

/** Where the composer was, once the chat's budget is spent. */
function Spent({ user, allowance, admin }: { user: User; allowance: Allowance; admin: boolean }) {
  // Admins need not wait for the reset time.
  const ready = useReached(allowance.resetAt) || admin;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function reset() {
    setBusy(true);
    setProblem(null);
    try {
      // The server clears the chat and the allowance; RTDB brings the empty chat in.
      await resetChat(user);
    } catch {
      setProblem('Could not start a new chat. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="composer spent">
      <AllowanceBar left={0} />
      {ready ? (
        <>
          <p>
            This chat has reached its limit. Start a new one: this one is put away, and you begin
            with a clean page.
          </p>
          <button type="button" className="button primary" onClick={reset} disabled={busy}>
            Start a new chat
          </button>
        </>
      ) : (
        <p>
          This chat has reached its limit. Come back tomorrow
          {allowance.resetAt ? ` (from ${resetTime.format(new Date(allowance.resetAt))})` : ''} to
          start a new one.
        </p>
      )}
      {problem && <p className="error">{problem}</p>}
    </div>
  );
}

/** Loading and error lines for a transcript; nothing once the messages are in. */
export function ChatStatus({ state }: { state: MessagesState }) {
  if (state.state === 'loading') return <p className="chat-note">Loading...</p>;
  if (state.state === 'error') {
    return <p className="error">Could not load the chat: {state.message}</p>;
  }
  return null;
}

/** The scrolling message list. `empty` replaces the messages when there are none. */
export function Transcript({ children, empty }: { children: ReactNode; empty: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // Stay pinned to the bottom while new text arrives, unless the reader scrolled up.
  const pinned = useRef(true);

  // After every render: cheap, and it catches each piece of a streaming answer.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      className="transcript"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      aria-live="polite"
    >
      <div className="transcript-inner">{empty ?? children}</div>
    </div>
  );
}

/** One message. `note` is a line under it, such as the admin's view of what an answer cost. */
export function Bubble({ message, note }: { message: Message; note?: ReactNode }) {
  if (message.role === 'user') {
    return <div className="message user">{message.text}</div>;
  }
  const typing = message.status === 'streaming' && !message.text;
  return (
    <div className={`message assistant${message.status === 'error' ? ' failed' : ''}`}>
      {typing ? (
        <span className="typing" role="status" aria-label="The bot is typing">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <Markdown text={message.text} />
      )}
      {message.status === 'error' && <p className="error">The answer broke off.</p>}
      {note && <p className="message-note">{note}</p>}
    </div>
  );
}

const coarsePointer = window.matchMedia('(pointer: coarse)');

function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  problem,
  allowance,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  problem: string | null;
  allowance: Allowance | undefined;
}) {
  const field = useRef<HTMLTextAreaElement>(null);

  // Grow with the text up to the CSS max-height, then scroll inside.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends on a keyboard; on touch screens it is a new line and the button sends.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    if (coarsePointer.matches) return;
    event.preventDefault();
    onSubmit();
  }

  const empty = value.trim() === '';
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {problem && <p className="error composer-error">{problem}</p>}
      {allowance && <AllowanceBar left={allowance.left} />}
      <div className="composer-row">
        <textarea
          ref={field}
          rows={1}
          value={value}
          maxLength={MAX_TEXT}
          placeholder="Message"
          aria-label="Message"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="button primary send"
          disabled={busy || empty}
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </form>
  );
}
