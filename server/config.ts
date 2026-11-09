// Runtime configuration, read once from the environment.
// Defaults point at production; local development and tests override them through .env and
// the emulator variables (FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_DATABASE_EMULATOR_HOST),
// which the Admin SDK picks up by itself.

export const config = {
  projectId: process.env.FIREBASE_PROJECT_ID ?? 'flopbut',
  databaseURL:
    process.env.FIREBASE_DATABASE_URL ??
    'https://flopbut-default-rtdb.europe-west1.firebasedatabase.app',
  ownerEmails: parseEmails(process.env.OWNER_EMAILS),
  version: process.env.APP_VERSION ?? 'dev',
  /** What one chat may spend, in US dollars, before it stops until the next day. */
  chatBudgetUsd: positive('CHAT_BUDGET_USD', 1),
  /**
   * How large one chat may grow, in tokens, before it stops: the bot sees the whole chat, so keep
   * this well inside the model's context window, leaving room for a question and its answer.
   */
  chatContextTokens: positive('CHAT_CONTEXT_TOKENS', 200_000),
  /**
   * The part of that context the allowance bar does not count: every chat starts with the system
   * prompt and the knowledge base's card, map and skills (about 36K tokens) and the greeting, so
   * the bar stays full until a chat has grown past this.
   */
  chatContextGapTokens: 40_000,
  /**
   * The Cloud Storage bucket that holds the knowledge base (server/kbBucket.ts). Without it, as in
   * local development and tests, the bot reads the folder at KB_DIR.
   */
  kbBucket: process.env.KB_BUCKET || null,
  /** Where the site is, for links sent out of it (to Flop in Telegram). */
  publicUrl: process.env.PUBLIC_URL || 'https://chat.flopbut.pl',
  /**
   * The Telegram bot through which the chat's bot asks Flop (server/flop.ts). Without the token
   * or Flop's account id the bot is not offered the ask_flop tool.
   */
  telegram: telegramConfig(),
};

function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN || null;
  const ownerId = Number(process.env.TELEGRAM_OWNER_ID);
  if (!token || !Number.isSafeInteger(ownerId) || ownerId <= 0) return null;
  return {
    token,
    /** Flop's Telegram account: the only one whose messages and buttons count. */
    ownerId,
    /** Checks that a webhook call comes from Telegram; also needed to set the webhook back. */
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || null,
    /**
     * `webhook` in production: Telegram calls POST /api/telegram. `polling` locally: this server
     * takes the webhook off while it runs, reads the updates itself, and puts it back on exit.
     */
    mode: process.env.TELEGRAM_MODE === 'polling' ? ('polling' as const) : ('webhook' as const),
  };
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function parseEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

if (config.ownerEmails.size === 0) {
  console.warn('OWNER_EMAILS is empty: nobody is an owner, and admin claims are left as they are');
}
