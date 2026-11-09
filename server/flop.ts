import { tool } from 'ai';
import type { Reference } from 'firebase-admin/database';
import { z } from 'zod';
import { type About, ROLES } from './about.js';
import type { ReplyInput } from './bot/types.js';
import type { Delivery } from './chat.js';
import { db } from './firebase.js';
import type { MemberRecord } from './members.js';
import { escapeHtml, type TelegramApi, type TelegramUpdate } from './telegram.js';

// The bot asks Flop himself, in Telegram, when the knowledge base has no answer and the question
// matters. The question goes to Flop with who is asking, what the conversation is about, a few
// answers to pick from and a link to the chat. The tool waits for him up to FLOP_WAIT_MS inside
// the answer; if he replies in time, the bot answers with it at once. Otherwise the bot says the
// answer will come, and when Flop replies (a button, a reply, or plain text when only one
// question is open) the bot retells it in the chat as a new message, or, when the chat is used
// up, his words are quoted as they are. A question is open for a day.
//
// flopQuestions/{id} is written only by the server. Its status moves in transactions, so an
// answer is delivered exactly once, whichever instance gets it and whenever it comes:
//   waiting      the tool is waiting for it, until waitUntil
//   open         nobody is waiting: an answer is delivered by whoever receives it
//   answered     Flop answered while the tool waited; the tool takes it
//   delivering   Flop answered after the wait; the bot is retelling it in the chat
//   delivered    in the chat (`delivery` says how)
//   expired      answered after a day, or never: nothing reaches the chat
//   undeliverable  answered after the chat was reset or deleted

/** How long the tool waits for Flop inside an answer, well within the reply's timeout. */
export const FLOP_WAIT_MS = 50_000;
/** An answer that comes this much after waitUntil finds nobody waiting for it any more. */
const WAIT_GRACE_MS = 5_000;
/** How long a question stays open. */
export const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
/** How many questions one chat may send Flop in QUESTION_TTL_MS. */
export const QUESTIONS_PER_DAY = 3;
export const MAX_OPTIONS = 4;
const OPTION_LENGTH = 60;
const QUESTION_LENGTH = 500;
const SUMMARY_LENGTH = 400;

export type FlopQuestion = {
  uid: string;
  question: string;
  options?: string[];
  summary: string;
  /** The language of the conversation, for a quoted answer. */
  lang: string;
  askedAt: number;
  expiresAt: number;
  waitUntil: number;
  /** The bot's message being written when it asked: gone once the chat is reset or deleted. */
  answerTo: string;
  telegramMessageId?: number;
  status:
    | 'waiting'
    | 'open'
    | 'answered'
    | 'delivering'
    | 'delivered'
    | 'expired'
    | 'undeliverable';
  answer?: string;
  answeredAt?: number;
  delivery?: 'sync' | 'retold' | 'quoted';
};

/** What flop.ts needs from the chat (chatService in chat.ts). */
export type ChatDelivery = {
  deliver(uid: string, note: string): Promise<Delivery>;
  post(uid: string, text: string): Promise<void>;
};

export type AskFlopOptions = {
  telegram: TelegramApi;
  /** Flop's Telegram account id: questions go there, and only its answers count. */
  ownerId: number;
  /** Where a late answer goes; may also be given later with `connectChat`. */
  chat?: ChatDelivery;
  /** The site, for the link to the chat in the admin pages. */
  publicUrl: string;
  /** A local server: its questions are marked, and the other side tells answers apart. */
  local?: boolean;
  waitMs?: number;
};

const QUESTIONS = 'flopQuestions';

/** Where a pressed button points: `a:` for production, `l:` for a local server. */
function callbackData(local: boolean, id: string, option: number) {
  return `${local ? 'l' : 'a'}:${id}:${option}`;
}

/** The note that brings Flop's later answer to the bot; what to do with it is in the prompt. */
export function answerNote(question: string, answer: string): string {
  return (
    `[Not from the person: earlier you asked Flop in Telegram: "${question}". ` +
    `He has now answered: "${answer}". Pass his answer on to the person.]`
  );
}

const QUOTES: Record<string, (q: string) => string> = {
  ru: (q) => `Flop ответил на вопрос «${q}»:`,
  pl: (q) => `Flop odpowiedział na pytanie „${q}”:`,
  en: (q) => `Flop answered the question "${q}":`,
};

/** Flop's answer as it is, for a chat whose bot cannot speak any more. */
export function quotedAnswer(lang: string, question: string, answer: string): string {
  const lead = (QUOTES[lang.slice(0, 2).toLowerCase()] ?? QUOTES.en)?.(question) ?? '';
  const quote = answer
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${lead}\n\n${quote}`;
}

/** What Flop sees under an answered question, by how it went. */
const OUTCOMES: Record<string, string> = {
  sync: 'передан в разговор',
  retold: 'бот пересказал его в чате',
  quoted: 'чат исчерпан: ответ отправлен в чат цитатой',
  undeliverable: 'чат уже закончился, ответ не доставлен',
  expired: 'вопрос истёк (прошли сутки), ответ не доставлен',
  pending: 'передаю в чат...',
};

/**
 * Runs a transaction on a question: `change` returns the new record, or undefined to leave it.
 * The first run may see a local null; that is answered with null, so the transaction goes on to
 * the server's value.
 */
async function change(
  ref: Reference,
  update: (q: FlopQuestion) => FlopQuestion | undefined,
): Promise<{ committed: boolean; question: FlopQuestion | null }> {
  const result = await ref.transaction((q: FlopQuestion | null) => (q === null ? null : update(q)));
  return { committed: result.committed, question: result.snapshot.val() as FlopQuestion | null };
}

export class AskFlop {
  private readonly telegram: TelegramApi;
  private readonly ownerId: number;
  private chat: ChatDelivery | undefined;
  private readonly publicUrl: string;
  private readonly local: boolean;
  private readonly waitMs: number;

  constructor(options: AskFlopOptions) {
    this.telegram = options.telegram;
    this.ownerId = options.ownerId;
    this.chat = options.chat;
    this.publicUrl = options.publicUrl.replace(/\/$/, '');
    this.local = options.local ?? false;
    this.waitMs = options.waitMs ?? FLOP_WAIT_MS;
  }

  /** The chat late answers are delivered to (the chat needs this tool first, so it comes later). */
  connectChat(chat: ChatDelivery) {
    this.chat = chat;
  }

  /** The ask_flop tool for one answer, in one chat; none where the answer is not saved. */
  tools(input: ReplyInput) {
    const { chatId, answerId } = input;
    if (!answerId) return undefined;
    return {
      ask_flop: tool({
        description:
          'Ask Flop himself, in Telegram, a question the knowledge base does not answer. Use it ' +
          'only when the person needs that answer and nothing you have read covers it. Waits ' +
          'for him up to about a minute: returns his answer, or says it will come later.',
        inputSchema: z.object({
          question: z
            .string()
            .min(3)
            .max(QUESTION_LENGTH)
            .describe('The question for Flop, short and self-contained, in Russian.'),
          options: z
            .array(z.string().min(1).max(OPTION_LENGTH))
            .max(MAX_OPTIONS)
            .optional()
            .describe('Up to four short answers he can pick with a button, in Russian.'),
          summary: z
            .string()
            .max(SUMMARY_LENGTH)
            .describe(
              'What the conversation is about so far, in one or two sentences, in Russian.',
            ),
          language: z
            .string()
            .max(10)
            .describe('The language of the conversation, as a code: "en", "ru", "pl".'),
        }),
        execute: (args, { abortSignal }) =>
          this.ask(chatId, answerId, args, abortSignal ?? input.signal),
      }),
    };
  }

  /** The tool's work: what it returns is what the model reads. */
  async ask(
    uid: string,
    answerTo: string,
    args: { question: string; options?: string[]; summary: string; language: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const now = Date.now();
    const earlier = Object.values(
      ((await db.ref(QUESTIONS).orderByChild('uid').equalTo(uid).get()).val() ?? {}) as Record<
        string,
        FlopQuestion
      >,
    );
    const pending = earlier.find(
      (q) => (q.status === 'waiting' || q.status === 'open') && q.expiresAt > now,
    );
    if (pending) {
      return (
        `You already asked Flop: "${pending.question}", and he has not answered yet. Do not ask ` +
        'again: his answer will appear in this chat when he replies. Answer the rest yourself.'
      );
    }
    if (earlier.filter((q) => q.askedAt > now - QUESTION_TTL_MS).length >= QUESTIONS_PER_DAY) {
      return 'You cannot ask Flop anything more today. Answer with what you know.';
    }

    const options = (args.options ?? []).slice(0, MAX_OPTIONS);
    const ref = db.ref(QUESTIONS).push();
    const id = ref.key as string;
    const record: FlopQuestion = {
      uid,
      question: args.question.slice(0, QUESTION_LENGTH),
      ...(options.length && { options }),
      summary: args.summary.slice(0, SUMMARY_LENGTH),
      lang: args.language,
      askedAt: now,
      expiresAt: now + QUESTION_TTL_MS,
      waitUntil: now + this.waitMs,
      answerTo,
      status: 'waiting',
    };
    await ref.set(record);

    try {
      const member = (await db.ref(`members/${uid}`).get()).val() as MemberRecord | null;
      const sent = await this.telegram.sendMessage({
        chat_id: this.ownerId,
        text: this.render(record, member),
        buttons: options.map((text, i) => [
          { text, callback_data: callbackData(this.local, id, i) },
        ]),
      });
      await ref.update({ telegramMessageId: sent.message_id });
      record.telegramMessageId = sent.message_id;
    } catch (err) {
      console.error('could not send the question to Flop', err);
      await ref.remove();
      return 'Flop cannot be reached right now. Answer with what you know.';
    }

    await this.answered(ref, this.waitMs, signal);

    // Whatever happened meanwhile, one transaction settles who delivers his answer.
    const settled = await change(ref, (q) => {
      if (q.status === 'answered') return { ...q, status: 'delivered', delivery: 'sync' };
      if (q.status === 'waiting') return { ...q, status: 'open' };
      return undefined;
    });
    const q = settled.question;
    if (q?.status === 'delivered' && q.delivery === 'sync' && q.answer !== undefined) {
      await this.showOutcome(q, 'sync');
      return `Flop answered: "${q.answer}". Pass his answer on to the person, in your own words.`;
    }
    signal?.throwIfAborted();
    return (
      'Flop has not answered yet. Tell the person you have asked him, and that his answer will ' +
      'appear in this chat when he replies. Do not promise when.'
    );
  }

  /** Settles once the question is answered, the wait is over or the answer is aborted. */
  private answered(ref: Reference, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const status = ref.child('status');
      const done = () => {
        clearTimeout(timer);
        status.off('value', listener);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const listener = status.on('value', (snapshot) => {
        if (snapshot.val() === 'answered') done();
      });
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
  }

  /** The question as Flop sees it in Telegram, with its outcome once answered. */
  private render(q: FlopQuestion, member: MemberRecord | null, outcome?: string): string {
    const about: About | undefined = member?.about;
    const who = [
      about?.name ?? member?.name ?? 'без имени',
      about?.company,
      about?.role ? ROLES[about.role] : undefined,
    ]
      .filter(Boolean)
      .map((part) => escapeHtml(String(part)))
      .join(' · ');
    const lines = [
      `❓ <b>Вопрос из чата</b>${this.local ? ' · <i>local</i>' : ''}`,
      `<b>Кто:</b> ${who}`,
      q.summary ? `<b>О чём разговор:</b> ${escapeHtml(q.summary)}` : '',
      '',
      `<b>${escapeHtml(q.question)}</b>`,
      '',
      `<a href="${this.publicUrl}/admin/chats/${encodeURIComponent(q.uid)}">Открыть чат</a>`,
    ];
    if (q.answer !== undefined) {
      lines.push('', `✅ <b>Ответ:</b> ${escapeHtml(q.answer)}`);
    }
    if (outcome) lines.push(`<i>${escapeHtml(outcome)}</i>`);
    return lines.filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
  }

  /** Rewrites the question in Telegram with its answer and outcome; its buttons go. */
  private async showOutcome(q: FlopQuestion, outcome: keyof typeof OUTCOMES) {
    if (q.telegramMessageId === undefined) return;
    const member = (await db.ref(`members/${q.uid}`).get()).val() as MemberRecord | null;
    await this.telegram
      .editMessage({
        chat_id: this.ownerId,
        message_id: q.telegramMessageId,
        text: this.render(q, member, OUTCOMES[outcome]),
      })
      .catch((err) => console.error('could not update the question in Telegram', err));
  }

  private reply(text: string, replyTo?: number) {
    return this.telegram
      .sendMessage({ chat_id: this.ownerId, text, reply_to: replyTo })
      .catch((err) => console.error('could not answer Flop in Telegram', err));
  }

  /** One update from Telegram: a pressed button or a message. Only Flop's count. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const callback = update.callback_query;
    if (callback) {
      if (callback.from.id !== this.ownerId) {
        await this.telegram.answerCallback({ callback_query_id: callback.id }).catch(() => {});
        return;
      }
      const [side, id, index] = (callback.data ?? '').split(':');
      if (!id || side !== (this.local ? 'l' : 'a')) {
        await this.telegram
          .answerCallback({
            callback_query_id: callback.id,
            text: this.local
              ? 'Это вопрос с прода: пока работает локальный сервер, ответ туда не дойдёт.'
              : 'Это вопрос с локального сервера: ответ не доставлен.',
          })
          .catch(() => {});
        return;
      }
      await this.telegram.answerCallback({ callback_query_id: callback.id }).catch(() => {});
      const q = (await db.ref(`${QUESTIONS}/${id}`).get()).val() as FlopQuestion | null;
      const answer = q?.options?.[Number(index)];
      if (!q || answer === undefined) {
        await this.reply('Не нашёл этот вопрос.');
        return;
      }
      await this.accept(id, answer);
      return;
    }

    const message = update.message;
    if (!message || message.from?.id !== this.ownerId || message.chat.id !== this.ownerId) return;
    const text = message.text?.trim();
    if (!text) return;
    if (text.startsWith('/start')) {
      await this.reply(
        'Готов. Сюда будут приходить вопросы из чата, на которые нет ответа в базе.',
      );
      return;
    }

    const repliedTo = message.reply_to_message?.message_id;
    if (repliedTo !== undefined) {
      const found = (
        await db.ref(QUESTIONS).orderByChild('telegramMessageId').equalTo(repliedTo).get()
      ).val() as Record<string, FlopQuestion> | null;
      const id = found ? Object.keys(found)[0] : undefined;
      if (!id) {
        await this.reply(
          this.local
            ? 'Не нашёл этот вопрос здесь. Если он с прода, ответ не дойдёт, пока работает локальный сервер.'
            : 'Не нашёл этот вопрос. Если он с локального сервера, ответ не доставлен.',
          message.message_id,
        );
        return;
      }
      await this.accept(id, text, message.message_id);
      return;
    }

    // Plain text answers the only open question; with several, Flop has to say which.
    const now = Date.now();
    const open = Object.entries(
      ((await db.ref(QUESTIONS).orderByChild('status').get()).val() ?? {}) as Record<
        string,
        FlopQuestion
      >,
    ).filter(([, q]) => (q.status === 'waiting' || q.status === 'open') && q.expiresAt > now);
    if (open.length === 1) {
      await this.accept((open[0] as [string, FlopQuestion])[0], text, message.message_id);
    } else if (open.length === 0) {
      await this.reply('Сейчас нет открытых вопросов.', message.message_id);
    } else {
      await this.reply('Открытых вопросов несколько: ответь reply на нужный.', message.message_id);
    }
  }

  /** Takes Flop's answer to a question and sees it delivered, once. */
  async accept(id: string, answer: string, replyTo?: number): Promise<void> {
    const ref = db.ref(`${QUESTIONS}/${id}`);
    const now = Date.now();
    const taken = await change(ref, (q) => {
      if (q.status === 'waiting' || q.status === 'open') {
        if (now > q.expiresAt) return { ...q, status: 'expired' };
        // Waiting means the tool picks the answer up; past its wait, nobody will.
        const waiting = q.status === 'waiting' && now <= q.waitUntil + WAIT_GRACE_MS;
        return { ...q, status: waiting ? 'answered' : 'delivering', answer, answeredAt: now };
      }
      return undefined;
    });
    const q = taken.question;
    if (!q) {
      await this.reply('Не нашёл этот вопрос.', replyTo);
      return;
    }
    if (!taken.committed) {
      await this.reply(
        q.status === 'expired' ? 'Этот вопрос уже истёк.' : 'На этот вопрос уже есть ответ.',
        replyTo,
      );
      return;
    }
    if (q.status === 'expired') {
      await this.showOutcome(q, 'expired');
      return;
    }
    if (q.status === 'answered') {
      // The tool is waiting: it takes the answer and shows how it went.
      await this.showOutcome(q, 'pending');
      return;
    }
    await this.deliverLater(ref, q, answer);
  }

  /** An answer nobody waits for: the bot retells it in the chat, or it is quoted there. */
  private async deliverLater(ref: Reference, q: FlopQuestion, answer: string) {
    await this.showOutcome({ ...q, answer }, 'pending');

    const alive = (await db.ref(`chats/${q.uid}/messages/${q.answerTo}`).get()).exists();
    if (!alive) {
      await ref.update({ status: 'undeliverable' });
      await this.showOutcome({ ...q, answer }, 'undeliverable');
      return;
    }
    const chat = this.chat;
    if (!chat) throw new Error('AskFlop has no chat to deliver to');
    let delivery: 'retold' | 'quoted' = 'retold';
    const result = await chat
      .deliver(q.uid, answerNote(q.question, answer))
      .catch((err): Delivery => {
        console.error("could not deliver Flop's answer", err);
        return 'failed';
      });
    if (result !== 'retold') {
      delivery = 'quoted';
      await chat.post(q.uid, quotedAnswer(q.lang, q.question, answer));
    }
    await ref.update({ status: 'delivered', delivery });
    await this.showOutcome({ ...q, answer }, delivery);
  }
}
