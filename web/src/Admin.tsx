import type { User } from 'firebase/auth';
import { onValue, ref } from 'firebase/database';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type ActiveInvite,
  ApiError,
  createInvite,
  deleteChat,
  getKb,
  type KbFile,
  type KbState,
  listInvites,
  type Me,
  type Period,
} from './api';
import { Bubble, ChatStatus, Transcript } from './Chat';
import { database } from './firebase';
import { useMessagesAt } from './messages';
import { navigate } from './path';
import { TopBar } from './TopBar';

// Admin pages. They read RTDB directly: the rules give the `admin` claim read access to
// everything. The one change they make, deleting a chat, goes through the server.

type MemberInfo = {
  email: string | null;
  name: string | null;
  disabled?: boolean;
};

/** members/{uid}/about: the short form after the invite. */
type About = {
  answeredAt: number;
  skipped?: boolean;
  role?: string;
  name?: string;
  company?: string;
  positions?: string[];
  language?: string;
};

const ROLE_LABEL: Record<string, string> = {
  'agency-recruiter': 'recruiter, agency',
  'company-recruiter': 'recruiter, company',
  'hiring-manager': 'hiring manager',
  founder: 'founder',
  acquaintance: 'friend',
  other: 'other',
};

const POSITION_LABEL: Record<string, string> = {
  'tech-lead': 'Tech Lead',
  'head-of-mobile': 'Head of Mobile',
  'solution-architect': 'Solution Architect',
  'senior-engineer': 'Senior engineer',
  exploring: 'just looking',
};

/** members/{uid}, as the users page shows it. */
type MemberRecord = MemberInfo & {
  /** The invite code the account joined through, or "owner". */
  invite: string;
  joinedAt: number;
  lastSeenAt: number;
  about?: About;
};

/** The form's answers in a line or two, for the users page. */
function aboutLines(about: About | undefined): string[] {
  if (!about) return [];
  if (about.skipped) return ['skipped the form'];
  const who = [
    about.name ? `"${about.name}"` : '',
    about.role ? (ROLE_LABEL[about.role] ?? about.role) : '',
    about.company ?? '',
    about.language ?? '',
  ].filter(Boolean);
  const roles = (about.positions ?? []).map((p) => POSITION_LABEL[p] ?? p);
  return [who.join(' · '), roles.length ? `looking at: ${roles.join(', ')}` : ''].filter(Boolean);
}

/** guests/{uid}: signed in, not let in (yet). */
type GuestRecord = {
  email: string | null;
  name: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** The last invite link they opened, when it could not let them in. */
  invite?: string;
};

/** chatIndex/{uid}. Dollar amounts: `cost` for the current chat, `totalCost` for every chat. */
type ChatSummary = {
  lastAt: number;
  preview: string;
  questions: number;
  cost?: number;
  totalCost?: number;
  /** Tokens the chat came to in its last answer. */
  context?: number;
  /** When it ran out of budget or context; absent while it still has some. */
  usedUpAt?: number;
};

/** costs/{uid}/{answerId}: what one answer cost. */
type CostRecord = {
  model: string;
  input: number;
  output: number;
  cached: number;
  /** Absent on answers saved before it was recorded. */
  cacheWrite?: number;
  cost?: number;
};

/** archiveIndex/{uid}/{id}: a chat the member reset; its messages are at archive/{uid}/{id}. */
type ArchivedChat = {
  endedAt: number;
  usedUpAt?: number;
  preview: string;
  questions: number;
  cost: number;
  context: number;
};

type Status = 'active' | 'limit' | 'ended';

const STATUS_LABEL: Record<Status, string> = {
  active: 'active',
  limit: 'limit reached',
  ended: 'ended',
};

/** One chat in the admin's list: a member's current chat, or one of their earlier ones. */
type ChatRow = {
  key: string;
  href: string;
  uid: string;
  /** For an earlier chat: its id under archive/{uid}. */
  archiveId?: string;
  member: MemberInfo | null;
  status: Status;
  /** When it last changed: the last question, or the reset that ended it. */
  at: number;
  preview: string;
  questions: number;
  cost?: number;
  context?: number;
};

const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const count = new Intl.NumberFormat('en-GB');

/** Dollars, with enough digits that a cheap answer does not show as $0.00. */
function dollars(amount: number) {
  return `$${amount.toFixed(amount > 0 && amount < 0.1 ? 4 : 2)}`;
}

export function Admin({ me, user, path }: { me: Me; user: User; path: string }) {
  const chatPath = /^\/admin\/chats\/([^/]+)(?:\/archive\/([^/]+))?\/?$/.exec(path);
  const chatUid = chatPath?.[1];
  const archiveId = chatPath?.[2];

  // /admin on its own opens the list of chats.
  useEffect(() => {
    if (path === '/admin' || path === '/admin/') navigate('/admin/chats', { replace: true });
  }, [path]);

  const bar = <TopBar me={me} path={path} />;
  if (chatUid) {
    return <ChatView key={path} user={user} uid={chatUid} archiveId={archiveId} header={bar} />;
  }
  if (path.startsWith('/admin/users')) {
    return (
      <Page header={bar} title="Users" wide>
        <Users />
      </Page>
    );
  }
  if (path.startsWith('/admin/kb')) {
    return (
      <Page header={bar} title="Knowledge base">
        <Knowledge user={user} />
      </Page>
    );
  }
  if (path.startsWith('/admin/invites')) {
    return (
      <Page header={bar} title="Invites">
        <Invites user={user} />
      </Page>
    );
  }
  return (
    <Page header={bar} title="All chats">
      <ChatList user={user} />
    </Page>
  );
}

function Page({
  header,
  title,
  wide = false,
  children,
}: {
  header: ReactNode;
  title: string;
  /** For tables, which need more room than a column of text. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="page">
      {header}
      <main className={wide ? 'page-body wide' : 'page-body'}>
        <h1 className="page-title">{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** Live value of an RTDB path, or undefined while loading. */
function useValue<T>(path: string): { value: T | null | undefined; error: string | null } {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue(undefined);
    setError(null);
    return onValue(
      ref(database, path),
      (snapshot) => setValue(snapshot.val() as T | null),
      (err) => setError(err.message),
    );
  }, [path]);
  return { value, error };
}

function displayName(member: MemberInfo | null, uid: string) {
  return member?.name ?? member?.email ?? uid;
}

/**
 * Asks, then deletes a chat through the server. Resolves to whether it was deleted; a failure
 * is shown as an alert, since the list or the chat it sat in stays as it was.
 */
async function confirmDelete(user: User, who: string, uid: string, archiveId?: string) {
  const what = archiveId ? 'this earlier chat' : 'the current chat';
  if (!window.confirm(`Delete ${what} of ${who}? This cannot be undone.`)) return false;
  try {
    await deleteChat(user, uid, archiveId);
    return true;
  } catch (err) {
    const busy = err instanceof ApiError && err.code === 'busy';
    window.alert(busy ? 'An answer is being written; try again in a moment.' : message(err));
    return false;
  }
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="button button-danger" onClick={onClick}>
      Delete
    </button>
  );
}

/** Every chat, current and ended, newest first, each with its status. */
function ChatList({ user }: { user: User }) {
  const index = useValue<Record<string, ChatSummary>>('chatIndex');
  const archive = useValue<Record<string, Record<string, ArchivedChat>>>('archiveIndex');
  const members = useValue<Record<string, MemberInfo>>('members');
  const error = index.error ?? archive.error ?? members.error;

  if (error) return <p className="error">Could not load the chats: {error}</p>;
  if (index.value === undefined || archive.value === undefined || members.value === undefined) {
    return <p className="chat-note">Loading...</p>;
  }

  const member = (uid: string) => members.value?.[uid] ?? null;
  const current: ChatRow[] = Object.entries(index.value ?? {})
    // A chat with a question, or one the bot has greeted (it has a size then); not one just reset
    // or cleared, with nothing in it yet.
    .filter(([, chat]) => chat.questions > 0 || (chat.context ?? 0) > 0)
    .map(([uid, chat]) => ({
      key: uid,
      href: `/admin/chats/${uid}`,
      uid,
      member: member(uid),
      status: chat.usedUpAt ? 'limit' : 'active',
      at: chat.lastAt,
      preview: chat.preview,
      questions: chat.questions,
      cost: chat.cost,
      context: chat.context,
    }));
  const ended: ChatRow[] = Object.entries(archive.value ?? {}).flatMap(([uid, chats]) =>
    Object.entries(chats).map(([id, chat]) => ({
      key: `${uid}/${id}`,
      href: `/admin/chats/${uid}/archive/${id}`,
      uid,
      archiveId: id,
      member: member(uid),
      status: 'ended' as const,
      at: chat.endedAt,
      preview: chat.preview,
      questions: chat.questions,
      cost: chat.cost,
      context: chat.context,
    })),
  );
  const rows = [...current, ...ended].sort((a, b) => b.at - a.at);

  if (rows.length === 0) return <p className="chat-note">Nobody has written yet.</p>;

  return (
    <ul className="chat-list">
      {rows.map((row) => (
        <li key={row.key}>
          <a href={row.href} onClick={go(row.href)}>
            <span className="chat-list-head">
              <strong>{displayName(row.member, row.uid)}</strong>
              <StatusBadge status={row.status} />
              <time dateTime={new Date(row.at).toISOString()}>
                {dateTime.format(new Date(row.at))}
              </time>
            </span>
            <span className="chat-list-meta">
              {row.member?.name && row.member.email ? `${row.member.email} · ` : ''}
              {row.questions > 0
                ? `${row.questions} ${row.questions === 1 ? 'question' : 'questions'}`
                : 'greeted, no questions yet'}
              {row.cost !== undefined ? ` · ${dollars(row.cost)}` : ''}
              {row.context ? ` · ${count.format(row.context)} tokens` : ''}
              {row.member?.disabled ? ' · disabled' : ''}
            </span>
            {row.preview && <span className="chat-list-preview">{row.preview}</span>}
          </a>
          <DeleteButton
            onClick={() =>
              confirmDelete(user, displayName(row.member, row.uid), row.uid, row.archiveId)
            }
          />
        </li>
      ))}
    </ul>
  );
}

/** How far a member has got with their current chat, for the users page. */
function chatState(chat: ChatSummary | undefined) {
  const questions = chat?.questions ?? 0;
  if (questions > 0) return `${questions} ${questions === 1 ? 'question' : 'questions'}`;
  if ((chat?.context ?? 0) > 0) return 'greeted, no questions yet';
  return 'not opened';
}

function Person({ name, email, uid }: { name: string | null; email: string | null; uid: string }) {
  return (
    <>
      <strong>{name ?? email ?? uid}</strong>
      {name && email && <span className="users-sub">{email}</span>}
    </>
  );
}

function When({ at }: { at: number | undefined }) {
  if (!at) return <span className="users-sub">-</span>;
  return <time dateTime={new Date(at).toISOString()}>{dateTime.format(new Date(at))}</time>;
}

/**
 * Everyone who signed in: members (how they got in, when they were last here, how far their chat
 * has got and what they have spent), then guests still waiting, with the link they tried.
 */
function Users() {
  const members = useValue<Record<string, MemberRecord>>('members');
  const guests = useValue<Record<string, GuestRecord>>('guests');
  const index = useValue<Record<string, ChatSummary>>('chatIndex');
  const archive = useValue<Record<string, Record<string, ArchivedChat>>>('archiveIndex');
  const error = members.error ?? guests.error ?? index.error ?? archive.error;

  if (error) return <p className="error">Could not load the users: {error}</p>;
  if (
    members.value === undefined ||
    guests.value === undefined ||
    index.value === undefined ||
    archive.value === undefined
  ) {
    return <p className="chat-note">Loading...</p>;
  }

  const people = Object.entries(members.value ?? {}).sort(
    ([, a], [, b]) => b.lastSeenAt - a.lastSeenAt,
  );
  const waiting = Object.entries(guests.value ?? {}).sort(
    ([, a], [, b]) => b.lastSeenAt - a.lastSeenAt,
  );

  return (
    <>
      <section className="users" aria-labelledby="members-title">
        <h2 id="members-title">Members ({people.length})</h2>
        {people.length === 0 ? (
          <p className="meta">Nobody has joined yet.</p>
        ) : (
          <div className="users-table">
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Joined</th>
                  <th>Last seen</th>
                  <th>Chat</th>
                  <th className="users-num">Spent</th>
                </tr>
              </thead>
              <tbody>
                {people.map(([uid, member]) => {
                  const chat = index.value?.[uid];
                  const earlier = Object.keys(archive.value?.[uid] ?? {}).length;
                  const href = `/admin/chats/${uid}`;
                  return (
                    <tr key={uid}>
                      <td>
                        <Person name={member.name} email={member.email} uid={uid} />
                        {member.disabled && <span className="status status-ended">disabled</span>}
                        {aboutLines(member.about).map((line) => (
                          <span key={line} className="users-sub users-about">
                            {line}
                          </span>
                        ))}
                      </td>
                      <td>
                        <When at={member.joinedAt} />
                        <span className="users-sub">
                          {member.invite === 'owner' ? 'owner' : <code>{member.invite}</code>}
                        </span>
                      </td>
                      <td>
                        <When at={member.lastSeenAt} />
                      </td>
                      <td>
                        <a className="link" href={href} onClick={go(href)}>
                          {chatState(chat)}
                        </a>
                        {chat?.usedUpAt && <StatusBadge status="limit" />}
                        {earlier > 0 && (
                          <span className="users-sub">
                            +{earlier} earlier {earlier === 1 ? 'chat' : 'chats'}
                          </span>
                        )}
                      </td>
                      <td className="users-num">{dollars(chat?.totalCost ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="users" aria-labelledby="guests-title">
        <h2 id="guests-title">Waiting ({waiting.length})</h2>
        {waiting.length === 0 ? (
          <p className="meta">Nobody is waiting.</p>
        ) : (
          <div className="users-table">
            <table>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                  <th>Link tried</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map(([uid, guest]) => (
                  <tr key={uid}>
                    <td>
                      <Person name={guest.name} email={guest.email} uid={uid} />
                    </td>
                    <td>
                      <When at={guest.firstSeenAt} />
                    </td>
                    <td>
                      <When at={guest.lastSeenAt} />
                    </td>
                    <td>{guest.invite ? <code>{guest.invite}</code> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>;
}

function go(href: string) {
  return (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(href);
  };
}

/** One member's chat, read-only and live: the current one, or one they reset (`archiveId`). */
function ChatView({
  user,
  uid,
  archiveId,
  header,
}: {
  user: User;
  uid: string;
  archiveId?: string;
  header: ReactNode;
}) {
  const chat = useMessagesAt(
    archiveId ? `archive/${uid}/${archiveId}/messages` : `chats/${uid}/messages`,
  );
  const member = useValue<MemberInfo>(`members/${uid}`);
  const costs = useValue<Record<string, CostRecord>>(`costs/${uid}`);
  const summary = useValue<ChatSummary>(`chatIndex/${uid}`);
  const archive = useValue<Record<string, ArchivedChat>>(`archiveIndex/${uid}`);
  // The opening note is the bot's cue, not something the member wrote.
  const messages = chat.state === 'ready' ? chat.messages.filter((m) => !m.hidden) : [];
  const earlier = Object.entries(archive.value ?? {}).sort(([, a], [, b]) => b.endedAt - a.endedAt);
  const shown = archiveId ? archive.value?.[archiveId] : undefined;
  const status: Status = archiveId ? 'ended' : summary.value?.usedUpAt ? 'limit' : 'active';
  const back = archiveId ? `/admin/chats/${uid}` : '/admin/chats';

  return (
    <div className="chat">
      {header}
      <div className="chat-heading">
        <a className="link" href={back} onClick={go(back)}>
          {archiveId ? '← Current chat' : '← All chats'}
        </a>
        <span>
          <strong>{displayName(member.value ?? null, uid)}</strong>
          {member.value?.name && member.value.email && (
            <span className="chat-list-meta"> {member.value.email}</span>
          )}
        </span>
        <span className="chat-note">
          <StatusBadge status={status} />{' '}
          {shown
            ? `${dateTime.format(new Date(shown.endedAt))} · ${dollars(shown.cost)}`
            : 'read-only'}
        </span>
        {(messages.length > 0 || shown) && (
          <DeleteButton
            onClick={async () => {
              const who = displayName(member.value ?? null, uid);
              if (await confirmDelete(user, who, uid, archiveId)) navigate(back);
            }}
          />
        )}
        {!archiveId && earlier.length > 0 && (
          <nav className="chat-earlier" aria-label="Earlier chats">
            <span className="chat-note">Earlier chats:</span>
            {earlier.map(([id, old]) => (
              <a
                key={id}
                className="link"
                href={`/admin/chats/${uid}/archive/${id}`}
                onClick={go(`/admin/chats/${uid}/archive/${id}`)}
              >
                {dateTime.format(new Date(old.endedAt))}
              </a>
            ))}
          </nav>
        )}
      </div>
      <Transcript
        empty={
          chat.state === 'ready' && messages.length === 0 ? (
            <p className="chat-note">No messages in this chat.</p>
          ) : null
        }
      >
        <ChatStatus state={chat} />
        {messages.map((m) => (
          <Bubble key={m.id} message={m} note={costNote(costs.value?.[m.id])} />
        ))}
      </Transcript>
    </div>
  );
}

/** What an answer cost, under it in the admin's view. */
function costNote(record: CostRecord | undefined) {
  if (!record) return undefined;
  const price = record.cost !== undefined ? `${dollars(record.cost)} · ` : '';
  const cache = [
    record.cached > 0 ? `${count.format(record.cached)} from cache` : '',
    record.cacheWrite ? `${count.format(record.cacheWrite)} to cache` : '',
  ].filter(Boolean);
  const cached = cache.length > 0 ? ` (${cache.join(', ')})` : '';
  return `${price}${count.format(record.input)} in${cached} / ${count.format(record.output)} out · ${record.model}`;
}

/**
 * The knowledge base: its folder (the bucket in production) as it is now, which is what the bot
 * reads, with the last change and the map of every file.
 */
function Knowledge({ user }: { user: User }) {
  const [state, setState] = useState<KbState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getKb(user).then(setState, (err: unknown) => setError(message(err)));
  }, [user]);

  if (!state) return error ? <p className="error">{error}</p> : <p className="meta">Loading...</p>;

  const { files } = state;
  const notes = files.filter((file) => file.kind === 'note' || file.kind === 'prompt').length;
  const last = files.reduce<KbFile | null>(
    (newest, file) => (!newest || file.updated > newest.updated ? file : newest),
    null,
  );

  return (
    <section className="kb">
      <dl className="kb-facts">
        <dt>Folder</dt>
        <dd>
          {state.bucket ? (
            <code>gs://{state.bucket}/base</code>
          ) : (
            <span className="meta">a local folder (KB_DIR)</span>
          )}
          <span className="meta">
            {' '}
            · {files.length} files · {notes} notes
          </span>
        </dd>
        <dt>Last change</dt>
        <dd>
          {last ? (
            <>
              {dateTime.format(new Date(last.updated))}
              <span className="meta">
                {' '}
                · <code>{last.path}</code>
              </span>
            </>
          ) : (
            <span className="meta">-</span>
          )}
        </dd>
      </dl>
      {files.length > 0 ? (
        <KbMap files={files} />
      ) : (
        <p className="meta">The folder is empty: the bot answers from its prompt alone.</p>
      )}
    </section>
  );
}

/** A folder of the knowledge base's map: its files, its folders, and its newest change. */
type KbFolder = { name: string; files: KbFile[]; folders: Map<string, KbFolder>; updated: number };

function kbTree(files: KbFile[]): KbFolder {
  const root: KbFolder = { name: '', files: [], folders: new Map(), updated: 0 };
  for (const file of files) {
    const parts = file.path.split('/');
    let folder = root;
    folder.updated = Math.max(folder.updated, file.updated);
    for (const name of parts.slice(0, -1)) {
      let next = folder.folders.get(name);
      if (!next) {
        next = { name, files: [], folders: new Map(), updated: 0 };
        folder.folders.set(name, next);
      }
      folder = next;
      folder.updated = Math.max(folder.updated, file.updated);
    }
    folder.files.push(file);
  }
  return root;
}

function fileCount(folder: KbFolder): number {
  let total = folder.files.length;
  for (const sub of folder.folders.values()) total += fileCount(sub);
  return total;
}

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${count.format(Math.round(bytes / 1024))} KB`;
}

const KIND_LABEL: Record<KbFile['kind'], string | null> = {
  prompt: 'in the prompt',
  note: null,
  photo: 'photo',
  other: 'not read',
};

/**
 * The map of the knowledge base: every file under base/ in the bucket, folder by folder, with its
 * size and when it last changed.
 */
function KbMap({ files }: { files: KbFile[] }) {
  const tree = kbTree(files);

  const folder = (node: KbFolder, path: string, depth: number): ReactNode => (
    <ul className="kb-tree" key={path}>
      {[...node.folders.values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((sub) => (
          <li key={`${path}${sub.name}/`}>
            <details open={depth === 0}>
              <summary className="kb-row">
                <span className="kb-name">{sub.name}/</span>
                <span className="kb-kind meta">
                  {fileCount(sub)} {fileCount(sub) === 1 ? 'file' : 'files'}
                </span>
                <span />
                <span className="kb-date meta">{dateTime.format(new Date(sub.updated))}</span>
              </summary>
              {folder(sub, `${path}${sub.name}/`, depth + 1)}
            </details>
          </li>
        ))}
      {node.files.map((file) => (
        <li key={file.path} className={`kb-row kb-file ${file.kind}`}>
          <span className="kb-name">{file.path.split('/').at(-1)}</span>
          <span className="kb-kind meta">{KIND_LABEL[file.kind] ?? ''}</span>
          <span className="kb-size meta">{size(file.size)}</span>
          <span className="kb-date meta">{dateTime.format(new Date(file.updated))}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="kb-map" aria-labelledby="kb-map-title">
      <h2 id="kb-map-title" className="kb-map-title">
        In the bucket
      </h2>
      {folder(tree, '', 0)}
    </section>
  );
}

const PERIODS: { value: Period; label: string }[] = [
  { value: 'day', label: '1 day' },
  { value: 'week', label: '1 week' },
  { value: 'month', label: '1 month' },
  { value: 'year', label: '1 year' },
];

const MAX_PLACES = 100;

function inviteLink(code: string) {
  return `${window.location.origin}/invite/${code}`;
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/** Active invite links (places left, not expired) and a way to make a new one. */
function Invites({ user }: { user: User }) {
  const [invites, setInvites] = useState<ActiveInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(() => {
    listInvites(user).then(
      (list) => {
        setInvites(list);
        setError(null);
      },
      (err: unknown) => setError(message(err)),
    );
  }, [user]);

  useEffect(load, [load]);

  return (
    <section className="invites" aria-labelledby="invites-title">
      <header className="invites-head">
        <h2 id="invites-title">Active links</h2>
        {!creating && (
          <button type="button" className="button" onClick={() => setCreating(true)}>
            New link
          </button>
        )}
      </header>
      {creating && (
        <NewInvite
          user={user}
          onCreated={(code) => {
            setCreating(false);
            setFresh(code);
            load();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {error && <p className="error">{error}</p>}
      {invites === null ? (
        !error && <p className="meta">Loading...</p>
      ) : invites.length === 0 ? (
        <p className="meta">No active links.</p>
      ) : (
        <ul className="invite-list">
          {invites.map((invite) => (
            <InviteRow key={invite.code} invite={invite} fresh={invite.code === fresh} />
          ))}
        </ul>
      )}
    </section>
  );
}

function InviteRow({ invite, fresh }: { invite: ActiveInvite; fresh: boolean }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(invite.code);

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }

  return (
    <li className={fresh ? 'invite fresh' : 'invite'}>
      <code>{link}</code>
      <button type="button" className="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <p className="meta">
        {invite.left} of {invite.limit} {invite.limit === 1 ? 'place' : 'places'} left
        {' · '}
        {invite.expiresAt === null
          ? 'no expiry'
          : `until ${dateTime.format(new Date(invite.expiresAt))}`}
      </p>
    </li>
  );
}

function NewInvite({
  user,
  onCreated,
  onCancel,
}: {
  user: User;
  onCreated: (code: string) => void;
  onCancel: () => void;
}) {
  const [places, setPlaces] = useState('1');
  const [period, setPeriod] = useState<Period>('week');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await createInvite(user, { limit: Number(places), period }));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <form className="invite-form" onSubmit={submit}>
      <label>
        Places
        <input
          type="number"
          required
          min={1}
          max={MAX_PLACES}
          step={1}
          value={places}
          onChange={(e) => setPlaces(e.target.value)}
        />
      </label>
      <label>
        Valid for
        <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button primary" disabled={busy}>
        Create
      </button>
      <button type="button" className="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
