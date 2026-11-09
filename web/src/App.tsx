import { FirebaseError } from 'firebase/app';
import { signInWithPopup, signInWithRedirect, signOut, type User } from 'firebase/auth';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { About } from './About';
import { Admin } from './Admin';
import { type Me, redeemInvite } from './api';
import { Chat } from './Chat';
import { auth, googleProvider } from './firebase';
import { SignedInUser } from './kbImages';
import { navigate, usePath } from './path';
import { useSession } from './session';
import { TopBar } from './TopBar';

/**
 * The invite code when the page is /invite/{code}. Not URL-decoded: codes are plain letters and
 * digits, and decoding a stray `%` would throw. The server rejects anything that is not a code.
 */
function inviteCodeFromPath(path: string): string | null {
  const match = /^\/invite\/([^/]+)\/?$/.exec(path);
  return match?.[1] ?? null;
}

function goHome() {
  navigate('/', { replace: true });
}

export function App() {
  const [session, refresh] = useSession();
  const path = usePath();
  const inviteCode = inviteCodeFromPath(path);
  const alreadyIn = session.state === 'signed-in' && (session.me.member || session.me.disabled);

  // A member opening an invite link has nothing to redeem: show the home address instead.
  useEffect(() => {
    if (inviteCode && alreadyIn) goHome();
  }, [inviteCode, alreadyIn]);

  // Admin pages are for admins; anyone else is sent to their chat.
  const strayAdmin =
    session.state === 'signed-in' && !session.me.admin && path.startsWith('/admin');
  useEffect(() => {
    if (strayAdmin) goHome();
  }, [strayAdmin]);

  switch (session.state) {
    case 'loading':
      return <Shell aria-busy="true" />;
    case 'signed-out':
      return inviteCode ? (
        <SignIn
          title="You're invited"
          intro={<Intro for="invited" />}
          lead="Sign in with your Google account to join the chat."
        />
      ) : (
        <SignIn title="Flop Butylkin's AI assistant" intro={<Intro for="visitor" />} />
      );
    case 'error':
      return (
        <Shell title="Something went wrong" lead={session.message}>
          <SignOutButton />
        </Shell>
      );
    case 'signed-in': {
      const { me, user } = session;
      if (inviteCode && !me.member && !me.disabled) {
        return <Redeem user={user} code={inviteCode} onDone={refresh} />;
      }
      return <SignedIn me={me} user={user} path={path} onRefresh={refresh} />;
    }
  }
}

/**
 * What this site is, for someone who did not come with an invite or does not remember getting
 * one: whose assistant, what it answers, who it is for and how to get in.
 */
function Intro({ for: who }: { for: 'visitor' | 'invited' | 'waiting' }) {
  return (
    <div className="intro">
      <p>
        {/* Under the visitor's title, which already says whose assistant this is. */}
        {who === 'visitor'
          ? 'It answers questions about Flop, a mobile engineering lead'
          : 'This is an AI assistant that answers questions about Flop Butylkin, a mobile engineering lead'}
        : his experience, skills, projects and the work he is looking for. It speaks from notes Flop
        wrote himself, and checks with him when they don't cover something.
      </p>
      <p>
        It is for recruiters and hiring teams, and for people Flop knows. Entry is by invitation:
        Flop sends a link.
      </p>
      {who === 'visitor' && (
        <p>
          Got here by chance? Sign in and you'll be on the waiting list, or find Flop at{' '}
          <a href="https://flopbut.pl">flopbut.pl</a>.
        </p>
      )}
      {who === 'waiting' && (
        <p>
          In the meantime, more about Flop is at <a href="https://flopbut.pl">flopbut.pl</a>.
        </p>
      )}
      {who !== 'waiting' && (
        <p className="fine">
          Signing in shares your name and email with Flop. Flop can read the conversations held
          here.
        </p>
      )}
    </div>
  );
}

function SignIn({ title, intro, lead }: { title: string; intro: ReactNode; lead?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      // Where popups are not allowed, the whole page goes to Google and comes back signed in.
      if (err instanceof FirebaseError && err.code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, googleProvider);
        return;
      }
      const closed =
        err instanceof FirebaseError &&
        (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request');
      if (!closed) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title={title} intro={intro} lead={lead}>
      <button type="button" className="button primary" onClick={signIn} disabled={busy}>
        Sign in with Google
      </button>
      {error && <p className="error">{error}</p>}
    </Shell>
  );
}

/**
 * Tries the invite once, then goes home either way: /api/me then says whether the account
 * got in. A link that could not let them in leaves them on the waiting list, whatever the
 * reason, so there is no separate screen per refusal.
 */
function Redeem({ user, code, onDone }: { user: User; code: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    redeemInvite(user, code).then(
      () => {
        goHome();
        onDone();
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [user, code, onDone]);

  if (error) {
    return (
      <Shell title="Something went wrong" lead={error}>
        <SignOutButton />
      </Shell>
    );
  }
  return <Shell title="Joining" lead="Checking your invite..." aria-busy="true" />;
}

function SignedIn({
  me,
  user,
  path,
  onRefresh,
}: {
  me: Me;
  user: User;
  path: string;
  onRefresh: () => void;
}) {
  const who = me.email ?? me.name ?? 'your account';

  if (me.disabled) {
    return (
      <Shell title="Access disabled" lead={`Access for ${who} has been turned off.`}>
        <SignOutButton />
      </Shell>
    );
  }

  if (!me.member) {
    return (
      <Shell
        title="You're on the list"
        intro={<Intro for="waiting" />}
        lead={`This chat is invite-only. We have noted ${who} and will send you an invite when a place opens up.`}
      >
        <SignOutButton />
      </Shell>
    );
  }

  // Once, after the invite: who they are, so the bot opens the chat knowing it.
  if (me.askAbout) return <About user={user} name={me.name} onDone={onRefresh} />;

  return (
    <SignedInUser.Provider value={user}>
      {me.admin && path.startsWith('/admin') ? (
        <Admin me={me} user={user} path={path} />
      ) : (
        <Chat user={user} admin={me.admin} header={<TopBar me={me} path={path} />} />
      )}
    </SignedInUser.Provider>
  );
}

function SignOutButton() {
  return (
    <button
      type="button"
      className="button"
      onClick={() => {
        goHome();
        signOut(auth);
      }}
    >
      Sign out
    </button>
  );
}

function Shell({
  title,
  intro,
  lead,
  children,
  ...rest
}: {
  title?: string;
  intro?: ReactNode;
  lead?: string;
  children?: ReactNode;
  'aria-busy'?: 'true';
}) {
  return (
    <main className="placeholder" {...rest}>
      <p className="eyebrow">chat.flopbut.pl</p>
      {title && <h1>{title}</h1>}
      {intro}
      {lead && <p className="lead">{lead}</p>}
      {children && <div className="actions">{children}</div>}
      <p className="sign">Flop Butylkin</p>
    </main>
  );
}
