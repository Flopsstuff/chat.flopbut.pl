import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatBackend } from '../server/bot/index.js';
import type { Delivery } from '../server/chat.js';
import { chatService, type MessageRecord } from '../server/chat.js';
import { db } from '../server/firebase.js';
import {
  AskFlop,
  answerNote,
  type ChatDelivery,
  type FlopQuestion,
  QUESTION_TTL_MS,
  quotedAnswer,
} from '../server/flop.js';
import type { Button, TelegramApi, TelegramUpdate } from '../server/telegram.js';
import { telegramWebhook } from '../server/telegramWebhook.js';

const OWNER = 100200300;
const ANSWER_TO = 'answer-1';

type Sent = {
  chat_id: number;
  text: string;
  buttons?: Button[][];
  reply_to?: number;
  message_id: number;
};

/** Telegram as far as the server sees it: what was sent, edited and answered. */
class FakeTelegram implements TelegramApi {
  sent: Sent[] = [];
  edits: { message_id: number; text: string }[] = [];
  callbacks: { callback_query_id: string; text?: string }[] = [];
  failing = false;
  #next = 100;

  async sendMessage(params: Omit<Sent, 'message_id'>) {
    if (this.failing) throw new Error('telegram down');
    const message_id = this.#next++;
    this.sent.push({ ...params, message_id });
    return { message_id };
  }
  async editMessage(params: { chat_id: number; message_id: number; text: string }) {
    this.edits.push({ message_id: params.message_id, text: params.text });
  }
  async answerCallback(params: { callback_query_id: string; text?: string }) {
    this.callbacks.push(params);
  }
  async getUpdates() {
    return [];
  }
  async setWebhook() {}
  async deleteWebhook() {}
  async webhookUrl() {
    return '';
  }
}

/** The chat's side: what was delivered and posted, answering as told. */
class FakeChat implements ChatDelivery {
  delivered: { uid: string; note: string }[] = [];
  posted: { uid: string; text: string }[] = [];
  result: Delivery = 'retold';

  async deliver(uid: string, note: string) {
    this.delivered.push({ uid, note });
    return this.result;
  }
  async post(uid: string, text: string) {
    this.posted.push({ uid, text });
  }
}

const ARGS = {
  question: 'Рассматривает ли Flop релокацию в Берлин?',
  options: ['Да', 'Нет', 'Обсуждаемо'],
  summary: 'Рекрутер агентства ищет Head of Mobile в Берлин.',
  language: 'en',
};

let update = 1;
function button(data: string, from = OWNER): TelegramUpdate {
  return {
    update_id: update++,
    callback_query: { id: `cb${update}`, from: { id: from }, data },
  };
}
function text(body: string, replyTo?: number, from = OWNER): TelegramUpdate {
  return {
    update_id: update++,
    message: {
      message_id: 1000 + update,
      from: { id: from },
      chat: { id: from },
      text: body,
      ...(replyTo !== undefined && { reply_to_message: { message_id: replyTo } }),
    },
  };
}

async function question(id: string) {
  return (await db.ref(`flopQuestions/${id}`).get()).val() as FlopQuestion;
}

async function member(uid: string) {
  await db.ref(`members/${uid}`).set({
    invite: 'abcdefg',
    joinedAt: 1,
    lastSeenAt: 1,
    name: 'Anna Google',
    about: { answeredAt: 1, name: 'Anna', company: 'Acme', role: 'agency-recruiter' },
  });
  await db.ref(`chats/${uid}/messages/${ANSWER_TO}`).set({
    role: 'assistant',
    text: '',
    ts: 1,
    status: 'streaming',
  });
}

function setup(waitMs = 2000, local = false) {
  const telegram = new FakeTelegram();
  const chat = new FakeChat();
  const flop = new AskFlop({
    telegram,
    ownerId: OWNER,
    chat,
    publicUrl: 'https://chat.flopbut.pl/',
    waitMs,
    local,
  });
  /** The id of the question in the last message sent, from its first button. */
  const lastId = () => {
    const data = telegram.sent.at(-1)?.buttons?.[0]?.[0]?.callback_data ?? '';
    return data.split(':')[1] ?? '';
  };
  return { telegram, chat, flop, lastId };
}

/** Waits until the question has gone out to Telegram. */
async function sentOut(telegram: FakeTelegram, count = 1) {
  await expect.poll(() => telegram.sent.length).toBe(count);
}

beforeEach(async () => {
  await db.ref().set(null);
  await member('alice');
});

describe('ask_flop', () => {
  it('sends Flop the question, who asks, what about, buttons and a link', async () => {
    const { telegram, flop, lastId } = setup(50);
    const result = await flop.ask('alice', ANSWER_TO, ARGS);
    expect(result).toMatch(/has not answered yet/);
    const sent = telegram.sent[0] as Sent;
    expect(sent.chat_id).toBe(OWNER);
    expect(sent.text).toContain('Anna · Acme · a recruiter or HR person at a recruitment agency');
    expect(sent.text).toContain('<b>Рассматривает ли Flop релокацию в Берлин?</b>');
    expect(sent.text).toContain('Рекрутер агентства ищет Head of Mobile в Берлин.');
    expect(sent.text).toContain('href="https://chat.flopbut.pl/admin/chats/alice"');
    expect(sent.text).not.toContain('local');
    expect(sent.buttons?.map((row) => row[0]?.text)).toEqual(['Да', 'Нет', 'Обсуждаемо']);
    const q = await question(lastId());
    expect(q).toMatchObject({
      uid: 'alice',
      status: 'open',
      answerTo: ANSWER_TO,
      lang: 'en',
      telegramMessageId: sent.message_id,
    });
    expect(q.expiresAt - q.askedAt).toBe(QUESTION_TTL_MS);
  });

  it('escapes what goes into the message', async () => {
    const { telegram, flop } = setup(10);
    await flop.ask('alice', ANSWER_TO, { ...ARGS, question: 'A <b>bold</b> & question?' });
    expect(telegram.sent[0]?.text).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; question?');
  });

  it('returns his answer when he taps a button in time, and shows it went to the chat', async () => {
    const { telegram, flop, lastId } = setup();
    const asking = flop.ask('alice', ANSWER_TO, ARGS);
    await sentOut(telegram);
    await flop.handleUpdate(button(`a:${lastId()}:2`));
    expect(await asking).toBe(
      'Flop answered: "Обсуждаемо". Pass his answer on to the person, in your own words.',
    );
    expect(await question(lastId())).toMatchObject({
      status: 'delivered',
      delivery: 'sync',
      answer: 'Обсуждаемо',
    });
    expect(telegram.edits.at(-1)?.text).toContain('✅ <b>Ответ:</b> Обсуждаемо');
    expect(telegram.edits.at(-1)?.text).toContain('передан в разговор');
  });

  it('takes a reply in his own words too', async () => {
    const { telegram, flop } = setup();
    const asking = flop.ask('alice', ANSWER_TO, { ...ARGS, options: undefined });
    await sentOut(telegram);
    expect(telegram.sent[0]?.buttons).toEqual([]);
    await flop.handleUpdate(text('Да, с 1 марта', telegram.sent[0]?.message_id));
    expect(await asking).toContain('"Да, с 1 марта"');
  });

  it('allows one open question per chat, and three a day', async () => {
    const { flop } = setup(10);
    await flop.ask('alice', ANSWER_TO, ARGS);
    expect(await flop.ask('alice', ANSWER_TO, ARGS)).toMatch(/already asked Flop/);

    await db.ref('flopQuestions').set(null);
    const now = Date.now();
    for (const n of [1, 2, 3]) {
      await db.ref(`flopQuestions/q${n}`).set({
        uid: 'alice',
        status: 'delivered',
        askedAt: now - n * 1000,
        expiresAt: now + QUESTION_TTL_MS,
      });
    }
    expect(await flop.ask('alice', ANSWER_TO, ARGS)).toMatch(/cannot ask Flop anything more today/);
    await db.ref('flopQuestions/q3/askedAt').set(now - QUESTION_TTL_MS - 1);
    expect(await flop.ask('alice', ANSWER_TO, ARGS)).toMatch(/has not answered yet/);
  });

  it('answers without him when Telegram cannot be reached, and keeps no question', async () => {
    const { telegram, flop } = setup(10);
    telegram.failing = true;
    expect(await flop.ask('alice', ANSWER_TO, ARGS)).toMatch(/cannot be reached/);
    expect((await db.ref('flopQuestions').get()).exists()).toBe(false);
  });

  it('stops waiting when the answer is aborted, and leaves the question open', async () => {
    const { flop, lastId } = setup(60_000);
    const controller = new AbortController();
    const asking = flop.ask('alice', ANSWER_TO, ARGS, controller.signal);
    await expect.poll(() => lastId()).not.toBe('');
    controller.abort(new Error('timed out'));
    await expect(asking).rejects.toThrow('timed out');
    expect((await question(lastId())).status).toBe('open');
  });

  it('is offered only for an answer that is saved', () => {
    const { flop } = setup();
    const signal = new AbortController().signal;
    expect(flop.tools({ chatId: 'alice', history: [], signal })).toBeUndefined();
    expect(
      Object.keys(flop.tools({ chatId: 'alice', answerId: 'x', history: [], signal }) ?? {}),
    ).toEqual(['ask_flop']);
  });
});

describe("Flop's later answer", () => {
  async function asked(waitMs = 10) {
    const s = setup(waitMs);
    expect(await s.flop.ask('alice', ANSWER_TO, ARGS)).toMatch(/has not answered yet/);
    return { ...s, id: s.lastId(), messageId: s.telegram.sent[0]?.message_id as number };
  }

  it('is retold by the bot in the chat', async () => {
    const { chat, flop, telegram, id } = await asked();
    await flop.handleUpdate(button(`a:${id}:0`));
    expect(chat.delivered).toEqual([{ uid: 'alice', note: answerNote(ARGS.question, 'Да') }]);
    expect(chat.posted).toEqual([]);
    expect(await question(id)).toMatchObject({ status: 'delivered', delivery: 'retold' });
    expect(telegram.edits.at(-1)?.text).toContain('бот пересказал его в чате');
  });

  it('is quoted as it is when the chat is used up or the bot fails', async () => {
    const { chat, flop, id } = await asked();
    chat.result = 'limit_reached';
    await flop.handleUpdate(button(`a:${id}:1`));
    expect(chat.posted).toEqual([{ uid: 'alice', text: quotedAnswer('en', ARGS.question, 'Нет') }]);
    expect(await question(id)).toMatchObject({ status: 'delivered', delivery: 'quoted' });
  });

  it('counts once, however many times he answers', async () => {
    const { chat, flop, telegram, id, messageId } = await asked();
    await Promise.all([
      flop.handleUpdate(button(`a:${id}:0`)),
      flop.handleUpdate(text('Нет, передумал', messageId)),
    ]);
    expect(chat.delivered).toHaveLength(1);
    expect(telegram.sent.at(-1)?.text).toBe('На этот вопрос уже есть ответ.');
  });

  it('answers the only open question when he writes without a reply', async () => {
    const { chat, flop, telegram } = await asked();
    await flop.handleUpdate(text('Да, рассмотрит'));
    expect(chat.delivered[0]?.note).toContain('"Да, рассмотрит"');
    await flop.handleUpdate(text('Ещё что-то'));
    expect(telegram.sent.at(-1)?.text).toBe('Сейчас нет открытых вопросов.');
  });

  it('asks which question he means when several are open', async () => {
    const { flop, telegram } = await asked();
    await member('bob');
    await flop.ask('bob', ANSWER_TO, ARGS);
    await flop.handleUpdate(text('Да'));
    expect(telegram.sent.at(-1)?.text).toBe('Открытых вопросов несколько: ответь reply на нужный.');
  });

  it('does not reach the chat after a day', async () => {
    const { chat, flop, telegram, id } = await asked();
    await db.ref(`flopQuestions/${id}/expiresAt`).set(Date.now() - 1);
    await flop.handleUpdate(button(`a:${id}:0`));
    expect(chat.delivered).toEqual([]);
    expect((await question(id)).status).toBe('expired');
    expect(telegram.edits.at(-1)?.text).toContain('вопрос истёк');
  });

  it('does not reach a chat that was reset or deleted', async () => {
    const { chat, flop, telegram, id } = await asked();
    await db.ref('chats/alice/messages').set(null);
    await flop.handleUpdate(button(`a:${id}:0`));
    expect(chat.delivered).toEqual([]);
    expect((await question(id)).status).toBe('undeliverable');
    expect(telegram.edits.at(-1)?.text).toContain('чат уже закончился');
  });

  it("counts only Flop's own buttons and messages", async () => {
    const { chat, flop, telegram, id, messageId } = await asked();
    await flop.handleUpdate(button(`a:${id}:0`, 42));
    await flop.handleUpdate(text('Да', messageId, 42));
    expect(chat.delivered).toEqual([]);
    expect(telegram.callbacks).toEqual([{ callback_query_id: expect.any(String) }]);
    expect((await question(id)).status).toBe('open');
  });

  it('tells production from a local server', async () => {
    const { flop, telegram, id } = await asked();
    await flop.handleUpdate(button(`l:${id}:0`));
    expect(telegram.callbacks.at(-1)?.text).toMatch(/локального сервера/);

    const local = setup(10, true);
    await member('bob');
    await local.flop.ask('bob', ANSWER_TO, { ...ARGS, question: 'Ещё вопрос?' }).catch(() => {});
    expect(local.telegram.sent.at(-1)?.text).toContain('<i>local</i>');
    expect(local.telegram.sent.at(-1)?.buttons?.[0]?.[0]?.callback_data).toMatch(/^l:/);
  });

  it('greets him on /start', async () => {
    const { flop, telegram } = setup();
    await flop.handleUpdate(text('/start'));
    expect(telegram.sent.at(-1)?.text).toMatch(/^Готов/);
  });
});

describe('quotedAnswer', () => {
  it('leads in the language of the chat and quotes every line', () => {
    expect(quotedAnswer('ru', 'Когда?', 'С марта.\nМожно раньше.')).toBe(
      'Flop ответил на вопрос «Когда?»:\n\n> С марта.\n> Можно раньше.',
    );
    expect(quotedAnswer('pl-PL', 'Kiedy?', 'Tak')).toBe(
      'Flop odpowiedział na pytanie „Kiedy?”:\n\n> Tak',
    );
    expect(quotedAnswer('de', 'When?', 'Yes')).toBe('Flop answered the question "When?":\n\n> Yes');
  });
});

describe('POST /api/telegram', () => {
  function app() {
    const { flop, chat } = setup(10);
    return { chat, flop, app: new Hono().route('/api/telegram', telegramWebhook(flop, 's3cret')) };
  }
  const post = (target: Hono, body: unknown, secret?: string) =>
    target.request('/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret && { 'x-telegram-bot-api-secret-token': secret }),
      },
      body: JSON.stringify(body),
    });

  it('refuses a call without the secret', async () => {
    const { app: target } = app();
    expect((await post(target, text('Да'))).status).toBe(403);
    expect((await post(target, text('Да'), 'wrong')).status).toBe(403);
  });

  it('handles an update once, however often Telegram sends it', async () => {
    const { app: target, chat, flop } = app();
    expect(await flop.ask('alice', ANSWER_TO, ARGS)).toMatch(/has not answered yet/);
    const same = text('Да');
    expect((await post(target, same, 's3cret')).status).toBe(200);
    expect((await post(target, same, 's3cret')).status).toBe(200);
    expect(chat.delivered).toHaveLength(1);
  });
});

describe('the chat takes a late answer', () => {
  beforeEach(async () => {
    await db.ref('chats/alice').set(null);
  });

  function service(backend?: ChatBackend) {
    return chatService(
      backend ?? {
        async *reply({ history }) {
          yield {
            type: 'text',
            text: `Flop says: ${history.at(-1)?.text.includes('"Да"') ? 'yes' : '?'}`,
          };
        },
      },
    );
  }

  it('retells it as a new message, after a hidden note', async () => {
    const chat = service();
    expect(await chat.deliver('alice', answerNote('Берлин?', 'Да'))).toBe('retold');
    const list = Object.values(
      ((await db.ref('chats/alice/messages').get()).val() ?? {}) as Record<string, MessageRecord>,
    );
    expect(list.at(-2)).toMatchObject({ role: 'user', hidden: true });
    expect(list.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'done',
      text: 'Flop says: yes',
    });
    expect((await db.ref('chatIndex/alice/questions').get()).val()).toBeNull();
  });

  it('says the chat is used up instead of answering', async () => {
    await db.ref('chatIndex/alice').set({ lastAt: 1, preview: '', questions: 1, cost: 100 });
    expect(await service().deliver('alice', 'note')).toBe('limit_reached');
  });

  it('waits for a question in progress, and gives up after a while', async () => {
    await db.ref('chats/alice/pending').set(Date.now());
    expect(await service().deliver('alice', 'note', 100)).toBe('busy');
  });

  it('posts a finished message as it is', async () => {
    await service().post('alice', '> quoted');
    const list = Object.values(
      ((await db.ref('chats/alice/messages').get()).val() ?? {}) as Record<string, MessageRecord>,
    );
    expect(list.at(-1)).toMatchObject({ role: 'assistant', status: 'done', text: '> quoted' });
  });
});
