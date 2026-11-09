import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { db } from './firebase.js';
import type { AskFlop } from './flop.js';
import type { TelegramApi, TelegramUpdate } from './telegram.js';
import { TelegramError } from './telegram.js';

// How Flop's answers reach the server. In production Telegram calls POST /api/telegram (a
// webhook, checked by its secret header). A local server has no public address, so it takes the
// webhook off while it runs, reads the updates itself, and puts the webhook back when it stops.
// A bot has one or the other at a time: while a local server runs, answers to questions asked in
// production reach it instead, and production gets them again only once the webhook is back.

/** Where Telegram calls in production. */
export const WEBHOOK_PATH = '/api/telegram';

/**
 * Handles an update once: Telegram sends one again when the webhook answers late, so its id is
 * taken in a transaction first.
 */
async function once(update: TelegramUpdate, handle: (u: TelegramUpdate) => Promise<void>) {
  const seen = await db
    .ref(`telegram/updates/${update.update_id}`)
    .transaction((at: number | null) => (at === null ? Date.now() : undefined));
  if (!seen.committed) return;
  await handle(update);
}

function sameSecret(given: string | undefined, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /api/telegram: updates from Telegram, with the secret set along with the webhook. */
export function telegramWebhook(flop: AskFlop, secret: string) {
  return new Hono().post('/', async (c) => {
    if (!sameSecret(c.req.header('x-telegram-bot-api-secret-token'), secret)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const update = await c.req.json<TelegramUpdate>().catch(() => null);
    if (!update || typeof update.update_id !== 'number') return c.json({ error: 'invalid' }, 400);
    // Telegram only needs to hear that the update arrived; a failure is logged, not sent back,
    // so the same update is not retried over and over.
    await once(update, (u) => flop.handleUpdate(u)).catch((err) =>
      console.error('could not handle a Telegram update', err),
    );
    return c.json({ ok: true });
  });
}

/** Points the bot's webhook at this site, unless it already is (production, at start). */
export async function ensureWebhook(telegram: TelegramApi, url: string, secret: string) {
  if ((await telegram.webhookUrl()) === url) return;
  await telegram.setWebhook({ url, secret_token: secret });
  console.log(`Telegram webhook set to ${url}`);
}

/**
 * Reads updates by long polling, for a local server: the webhook comes off first, and `stop` puts
 * it back (when the secret is known). Each update is handled apart from the loop, which goes on
 * reading.
 */
export function pollUpdates(
  telegram: TelegramApi,
  flop: AskFlop,
  restore: { url: string; secret: string | null },
) {
  const controller = new AbortController();
  let offset: number | undefined;

  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        const updates = await telegram.getUpdates({
          offset,
          timeout: 25,
          signal: controller.signal,
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          once(update, (u) => flop.handleUpdate(u)).catch((err) =>
            console.error('could not handle a Telegram update', err),
          );
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        // Production set its webhook again (it does at start): take it off once more.
        if (err instanceof TelegramError && err.code === 409) {
          await telegram.deleteWebhook().catch(() => {});
          continue;
        }
        console.error('Telegram polling failed, trying again shortly', err);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  const started = telegram.deleteWebhook().then(() => {
    console.log('Telegram: webhook off, reading updates here until this server stops');
    void loop();
  });

  return {
    started,
    async stop() {
      controller.abort();
      if (!restore.secret) {
        console.warn('TELEGRAM_WEBHOOK_SECRET is not set: the production webhook stays off');
        return;
      }
      await telegram.setWebhook({ url: restore.url, secret_token: restore.secret });
      console.log(`Telegram webhook set back to ${restore.url}`);
    },
  };
}
