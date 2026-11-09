import { signOut } from 'firebase/auth';
import type { Me } from './api';
import { auth } from './firebase';
import { navigate } from './path';

const ADMIN_LINKS = [
  { href: '/', label: 'My chat' },
  { href: '/admin/chats', label: 'All chats' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/invites', label: 'Invites' },
  { href: '/admin/kb', label: 'Knowledge' },
];

/** The bar over the chat and the admin pages. Admins get links between the two. */
export function TopBar({ me, path }: { me: Me; path: string }) {
  return (
    <header className="topbar">
      <a
        className="topbar-brand"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate('/');
        }}
      >
        {/* The favicon itself: it follows the colour scheme the same way the page does. */}
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <span className="eyebrow">chat.flopbut.pl</span>
      </a>
      <nav>
        {me.admin &&
          ADMIN_LINKS.map((link) => {
            const current = link.href === '/' ? path === '/' : path.startsWith(link.href);
            return (
              <a
                key={link.href}
                className="link"
                href={link.href}
                aria-current={current ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(link.href);
                }}
              >
                {link.label}
              </a>
            );
          })}
        <button
          type="button"
          className="link"
          title={me.email ?? undefined}
          onClick={() => {
            navigate('/', { replace: true });
            signOut(auth);
          }}
        >
          Sign out
        </button>
      </nav>
    </header>
  );
}
