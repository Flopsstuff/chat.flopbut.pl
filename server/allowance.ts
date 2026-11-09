import type { ChatSummary } from './chat.js';
import { db } from './firebase.js';

// A chat runs until it has spent its budget (CHAT_BUDGET_USD) or filled the context it may use
// (CHAT_CONTEXT_TOKENS), whichever comes first: the bot sees the whole chat, and nothing is
// summarised away. What the chat has spent and how large it is are admin-only, in
// chatIndex/{uid}; the member sees only chats/{uid}/allowance: the share left, rounded, and once
// it runs out, when a new chat may be started. For members that is the next midnight in
// Warsaw; owners, who have no budget, may start a new chat at once.

export const RESET_TIME_ZONE = 'Europe/Warsaw';

/** chats/{uid}/allowance. Absent means a fresh chat with all of it left. */
export type Allowance = {
  /** Share left, 0 to 1 in steps of 0.01. Only 0 when nothing is left. */
  left: number;
  /** Set once the chat is used up: from this moment a new one may be started. */
  resetAt?: number;
};

export type Limits = {
  /** Dollars a chat may spend; Infinity for owners. */
  budgetUsd: number;
  /** Tokens a chat may grow to. */
  contextTokens: number;
  /** Tokens at the start of every chat (the prompt) that the share does not count. */
  contextGapTokens?: number;
};

/** The share left once `used` (0 to 1, or more) is gone, rounded up so a sliver still shows. */
export function shareLeft(used: number): number {
  if (used >= 1) return 0;
  return Math.max(0.01, Math.ceil((1 - used) * 100) / 100);
}

/**
 * How much of the chat is used: the larger of the budget spent and the context filled. The
 * context counts only above the gap, the prompt every chat starts with, so a fresh chat shows
 * all of its allowance; the limit still holds for the whole context.
 */
export function shareUsed(summary: Pick<ChatSummary, 'cost' | 'context'> | null, limits: Limits) {
  const cost = summary?.cost ?? 0;
  const context = summary?.context ?? 0;
  const gap = Math.min(limits.contextGapTokens ?? 0, limits.contextTokens);
  const room = limits.contextTokens - gap;
  const filled = room > 0 ? Math.max(0, context - gap) / room : context > gap ? 1 : 0;
  return Math.max(cost / limits.budgetUsd, filled);
}

/** The next midnight in `timeZone` after `now`, as a timestamp. */
export function nextDayStart(now: number, timeZone = RESET_TIME_ZONE): number {
  const today = zoned(now, timeZone);
  const midnight = Date.UTC(today.year, today.month - 1, today.day + 1);
  // The zone's offset at midnight, found by asking the zone what time that instant is; asking
  // twice settles the night the clocks change.
  let result = midnight - offset(midnight, timeZone);
  result = midnight - offset(result, timeZone);
  return result;
}

function zoned(ts: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ts);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function offset(ts: number, timeZone: string): number {
  const t = zoned(ts, timeZone);
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  return wall - Math.floor(ts / 1000) * 1000;
}

/**
 * Rewrites chats/{uid}/allowance from chatIndex/{uid} and returns the share left. Called after
 * every answer, before every question and on every visit, so changed limits show up without
 * waiting. A used-up chat keeps the reset time it was first given.
 */
export async function refreshAllowance(
  uid: string,
  limits: Limits,
  now = Date.now(),
): Promise<number> {
  const summary = (await db.ref(`chatIndex/${uid}`).get()).val() as ChatSummary | null;
  const left = shareLeft(shareUsed(summary, limits));
  if (left > 0) {
    // A raised limit can bring a used-up chat back, so the mark for the admin goes too.
    await db.ref().update({
      [`chats/${uid}/allowance`]: { left } satisfies Allowance,
      ...(summary?.usedUpAt !== undefined && { [`chatIndex/${uid}/usedUpAt`]: null }),
    });
    return left;
  }
  const resetAt = Number.isFinite(limits.budgetUsd) ? nextDayStart(now) : now;
  await db
    .ref(`chats/${uid}/allowance`)
    .transaction((current: Allowance | null) =>
      current?.resetAt ? { ...current, left: 0 } : { left: 0, resetAt },
    );
  if (summary?.usedUpAt === undefined) await db.ref(`chatIndex/${uid}/usedUpAt`).set(now);
  return 0;
}
