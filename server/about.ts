import { Hono } from 'hono';
import { type AuthEnv, requireUser } from './auth.js';
import { db } from './firebase.js';
import type { MemberRecord } from './members.js';

// A short form a member fills in once, after the invite: who they are, so the bot can answer to
// the point. It is stored at members/{uid}/about, written only here, and goes to the bot in the
// note that opens each chat (openingNote in chat.ts).

/** Who the member is, as they picked it. */
export const ROLES = {
  'agency-recruiter': 'a recruiter or HR person at a recruitment agency',
  'company-recruiter': 'a recruiter or HR person at the hiring company',
  'hiring-manager': 'a hiring manager or tech lead',
  founder: 'a founder or CEO',
  acquaintance: 'a colleague or acquaintance of Flop',
  other: 'someone else',
} as const;

/** The roles they have in mind for Flop. */
export const POSITIONS = {
  'tech-lead': 'Tech Lead',
  'head-of-mobile': 'Head of Mobile',
  'solution-architect': 'Solution Architect',
  'senior-engineer': 'Senior iOS / React Native engineer',
  exploring: 'none yet, just getting to know him',
} as const;

/** The language they want to talk in; not asked means the browser's. */
export const LANGUAGES = {
  en: 'English',
  pl: 'Polish',
  ru: 'Russian',
} as const;

export type Role = keyof typeof ROLES;
export type Position = keyof typeof POSITIONS;
export type Language = keyof typeof LANGUAGES;

/** members/{uid}/about. `skipped` when they chose not to answer; asked once either way. */
export type About = {
  answeredAt: number;
  skipped?: true;
  role?: Role;
  name?: string;
  company?: string;
  positions?: Position[];
  language?: Language;
};

export const NAME_LENGTH = 60;
export const COMPANY_LENGTH = 80;

/**
 * Free text cut down to letters, digits, spaces and a few marks, so it reads as a name and cannot
 * carry instructions of its own into the bot's note. Empty becomes undefined.
 */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/[^\p{L}\p{M}\p{N}\s.,&'()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return text || undefined;
}

/** The form's answers as one sentence for the bot, or nothing when there are none. */
export function describeAbout(about: About | null | undefined): string {
  if (!about || about.skipped) return '';
  const parts = [
    about.name ? `they want to be called ${about.name}` : '',
    about.role ? `they are ${ROLES[about.role]}` : '',
    about.company ? `their company is ${about.company}` : '',
    about.positions?.length
      ? `the roles they have in mind for Flop: ${about.positions.map((p) => POSITIONS[p]).join(', ')}`
      : '',
    about.language ? `they want to talk in ${LANGUAGES[about.language]}` : '',
  ].filter(Boolean);
  return parts.length ? `They answered a short form: ${parts.join('; ')}.` : '';
}

/** POST /api/about { role?, name?, company?, positions?, language?, skip? }: members only. */
export const about = new Hono<AuthEnv>().post('/', requireUser, async (c) => {
  const user = c.get('user');
  const member = (await db.ref(`members/${user.uid}`).get()).val() as MemberRecord | null;
  if (!member || member.disabled === true) return c.json({ error: 'forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid' }, 400);

  const now = Date.now();
  let record: About;
  if (body.skip === true) {
    record = { answeredAt: now, skipped: true };
  } else {
    const role = typeof body.role === 'string' && body.role in ROLES ? (body.role as Role) : null;
    if (body.role !== undefined && body.role !== null && !role) {
      return c.json({ error: 'invalid' }, 400);
    }
    const positions = Array.isArray(body.positions)
      ? [
          ...new Set(
            body.positions.filter((p): p is Position => typeof p === 'string' && p in POSITIONS),
          ),
        ]
      : [];
    const language =
      typeof body.language === 'string' && body.language in LANGUAGES
        ? (body.language as Language)
        : null;
    const name = cleanText(body.name, NAME_LENGTH);
    const company = cleanText(body.company, COMPANY_LENGTH);
    record = {
      answeredAt: now,
      ...(role && { role }),
      ...(name && { name }),
      ...(company && { company }),
      ...(positions.length > 0 && { positions }),
      ...(language && { language }),
    };
  }
  await db.ref(`members/${user.uid}/about`).set(record);
  return c.json({ ok: true });
});
