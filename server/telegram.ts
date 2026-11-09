// A thin client for the Telegram Bot API, through which the chat's bot asks Flop (flop.ts). Only
// the calls this server makes, plain fetch, no library. Tests stand in with their own TelegramApi.

/** One button under a message: pressing it sends `data` back in a callback query. */
export type Button = { text: string; callback_data: string };

/** The parts of a Telegram message this server reads. */
export type TelegramMessage = {
  message_id: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
};

/** The parts of an update this server reads: a message, or a pressed button. */
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
};

export interface TelegramApi {
  sendMessage(params: {
    chat_id: number;
    text: string;
    buttons?: Button[][];
    reply_to?: number;
  }): Promise<{ message_id: number }>;
  editMessage(params: { chat_id: number; message_id: number; text: string }): Promise<void>;
  answerCallback(params: { callback_query_id: string; text?: string }): Promise<void>;
  getUpdates(params: {
    offset?: number;
    timeout: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  setWebhook(params: { url: string; secret_token: string }): Promise<void>;
  deleteWebhook(): Promise<void>;
  webhookUrl(): Promise<string>;
}

/** How long one call may take, long polls aside. */
const CALL_TIMEOUT_MS = 15_000;

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
  ) {
    super(`Telegram ${method}: ${code} ${description}`);
  }
}

/** The Bot API over HTTPS, as the bot with this token. Messages are sent as HTML. */
export class TelegramBot implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal = AbortSignal.timeout(CALL_TIMEOUT_MS),
  ): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    } | null;
    if (!json?.ok) {
      throw new TelegramError(method, json?.error_code ?? res.status, json?.description ?? '');
    }
    return json.result as T;
  }

  async sendMessage({
    chat_id,
    text,
    buttons,
    reply_to,
  }: Parameters<TelegramApi['sendMessage']>[0]) {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(buttons?.length && { reply_markup: { inline_keyboard: buttons } }),
      ...(reply_to && {
        reply_parameters: { message_id: reply_to, allow_sending_without_reply: true },
      }),
    });
  }

  async editMessage({ chat_id, message_id, text }: Parameters<TelegramApi['editMessage']>[0]) {
    // Without reply_markup the buttons go: an answered question has nothing left to press.
    await this.call('editMessageText', {
      chat_id,
      message_id,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  async answerCallback({ callback_query_id, text }: Parameters<TelegramApi['answerCallback']>[0]) {
    await this.call('answerCallbackQuery', { callback_query_id, ...(text && { text }) });
  }

  async getUpdates({ offset, timeout, signal }: Parameters<TelegramApi['getUpdates']>[0]) {
    const limit = AbortSignal.timeout((timeout + 10) * 1000);
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message', 'callback_query'] },
      signal ? AbortSignal.any([signal, limit]) : limit,
    );
  }

  async setWebhook({ url, secret_token }: Parameters<TelegramApi['setWebhook']>[0]) {
    await this.call('setWebhook', {
      url,
      secret_token,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  async deleteWebhook() {
    // Updates that came in meanwhile stay queued for whoever reads them next.
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async webhookUrl() {
    return (await this.call<{ url: string }>('getWebhookInfo', {})).url;
  }
}

/** Text made safe for a message sent as HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
