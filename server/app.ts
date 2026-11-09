import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { about } from './about.js';
import { adminChats } from './adminChats.js';
import { adminKb } from './adminKb.js';
import { authProxy } from './authProxy.js';
import { createBackend, Knowledge, localFolder } from './bot/index.js';
import { chatService } from './chat.js';
import { config } from './config.js';
import { AskFlop } from './flop.js';
import { gcsBucket, gcsStore } from './gcs.js';
import { adminInvites, redeem } from './invites.js';
import { bucketFolder } from './kbBucket.js';
import { kbFiles } from './kbFiles.js';
import { me } from './me.js';
import { TelegramBot } from './telegram.js';
import { telegramWebhook, WEBHOOK_PATH } from './telegramWebhook.js';

/**
 * The knowledge base: a folder the bot reads as it is at each moment. In production it is the
 * bucket's base/ folder (server/kbBucket.ts); without a bucket, as in local development, it is
 * the folder at KB_DIR.
 */
const kbFolder = config.kbBucket
  ? bucketFolder(gcsStore(gcsBucket(config.kbBucket)))
  : localFolder(process.env.KB_DIR || 'kb');
const knowledge = new Knowledge(kbFolder);

/**
 * Asking Flop in Telegram (server/flop.ts), when the bot token and his account are set. The bot
 * gets the ask_flop tool, and his late answers go back to the chat through `deliver`.
 */
export const telegram = config.telegram ? new TelegramBot(config.telegram.token) : null;
export const askFlop =
  config.telegram && telegram
    ? new AskFlop({
        telegram,
        ownerId: config.telegram.ownerId,
        publicUrl: config.publicUrl,
        local: config.telegram.mode === 'polling',
      })
    : null;
const chat = chatService(
  createBackend(process.env, knowledge, askFlop ? (input) => askFlop.tools(input) : undefined),
);
askFlop?.connectChat(chat);

export const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true, version: config.version }));
app.route('/api/me', me);
app.route('/api/redeem', redeem);
app.route('/api/about', about);
app.route('/api/kb', kbFiles(kbFolder));
app.route('/api/chat', chat.route);
if (askFlop && config.telegram?.mode === 'webhook' && config.telegram.webhookSecret) {
  app.route(WEBHOOK_PATH, telegramWebhook(askFlop, config.telegram.webhookSecret));
}
app.route('/api/admin/invites', adminInvites);
app.route('/api/admin/chats', adminChats);
app.route('/api/admin/kb', adminKb(kbFolder, config.kbBucket));
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

// Google sign-in's handler pages, served from our own domain (see authProxy.ts).
app.route('/__', authProxy());

// The built SPA. Unknown paths fall back to index.html so client routes work on reload.
app.use('/*', serveStatic({ root: './dist/web' }));
app.get('/*', serveStatic({ root: './dist/web', path: 'index.html' }));
