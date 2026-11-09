import { serve } from '@hono/node-server';
import { app, askFlop, telegram } from './app.js';
import { config } from './config.js';
import { ensureWebhook, pollUpdates, WEBHOOK_PATH } from './telegramWebhook.js';

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`listening on :${info.port}`);
});

// Flop's answers from Telegram: production points the bot's webhook here (again, in case a local
// server left it off); a local server reads them itself while it runs and gives them back on exit.
const tg = config.telegram;
if (tg && telegram && askFlop) {
  const url = `${config.publicUrl}${WEBHOOK_PATH}`;
  if (tg.mode === 'polling') {
    const poller = pollUpdates(telegram, askFlop, { url, secret: tg.webhookSecret });
    poller.started.catch((err) => console.error('could not start reading Telegram', err));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      poller
        .stop()
        .catch((err) => console.error('could not set the Telegram webhook back', err))
        .finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else if (tg.webhookSecret) {
    ensureWebhook(telegram, url, tg.webhookSecret).catch((err) =>
      console.error('could not set the Telegram webhook', err),
    );
  } else {
    console.warn("TELEGRAM_WEBHOOK_SECRET is not set: Flop's answers cannot reach this server");
  }
}
