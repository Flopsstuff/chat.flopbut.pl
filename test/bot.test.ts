import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_PRICES,
  anthropicCache,
  anthropicCost,
  type BotEvent,
  createBackend,
  GREP_MAX_MATCHES,
  Knowledge,
  knowledgeTools,
  LlmBackend,
  loadSystemPrompt,
  localFolder,
  MAX_STEPS,
  MockBackend,
  markCache,
  openRouterCost,
} from '../server/bot/index.js';

// The provider-level stream part, taken from the mock rather than from @ai-sdk/provider, which
// is not a direct dependency.
type LanguageModelV4StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never;

const USAGE = {
  inputTokens: { total: 120, noCache: 10, cacheRead: 100, cacheWrite: 10 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

function model(parts: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
  });
}

function answer(text: string[], providerMetadata?: Record<string, Record<string, unknown>>) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...text.map((delta) => ({ type: 'text-delta', id: 't', delta }) as const),
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: USAGE,
      ...(providerMetadata && { providerMetadata }),
    },
  ] as LanguageModelV4StreamPart[];
}

async function collect(stream: AsyncIterable<BotEvent>) {
  const events: BotEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const input = (signal = new AbortController().signal) => ({
  chatId: 'alice',
  history: [
    { role: 'user' as const, text: 'Earlier question' },
    { role: 'assistant' as const, text: 'Earlier answer' },
    { role: 'user' as const, text: 'Привет' },
  ],
  signal,
});

/** A knowledge base on disk with the things it must leave out. */
function kbDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-'));
  const files: Record<string, string> = {
    'INDEX.md': '# Map\n\n<!-- Generated. Do not edit. -->\n\n- `career/skills.md` - skills\n',
    'CARD.md': '# Card\n<!-- By hand. -->\nHead of Mobile.\n',
    'README.md': 'For the people who keep the base.',
    'SKILLS.md': '# Skills\n- Swift\n',
    'career/skills.md': '# Skills\n\nSwift and Kotlin.\nC++ for native modules.\n',
    'career/companies/loona/odr.md': '# ODR\nOn-demand resources.\n',
    'career/private/rate.md': 'secret',
    'private/notes.md': 'secret',
    'scripts/build.md': 'tooling',
    '.github/notes.md': 'ci',
    'stack.json': '{}',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('LlmBackend', () => {
  it('streams the text, then tokens and the price the provider reported', async () => {
    const backend = new LlmBackend({
      model: model(answer(['При', 'вет!'], { openrouter: { usage: { cost: 0.00042 } } })),
      modelId: 'anthropic/claude-haiku-5.5',
      prompt: () => 'Be brief.',
      costOf: openRouterCost,
    });
    expect(await collect(backend.reply(input()))).toEqual([
      { type: 'text', text: 'При' },
      { type: 'text', text: 'вет!' },
      {
        type: 'usage',
        usage: {
          model: 'anthropic/claude-haiku-5.5',
          input: 120,
          output: 7,
          cached: 100,
          cacheWrite: 10,
          context: 127,
          cost: 0.00042,
        },
      },
    ]);
  });

  it('sends the system prompt and the whole history, marked for the cache', async () => {
    const mock = model(answer(['ok']));
    const backend = new LlmBackend({
      model: mock,
      modelId: 'm',
      prompt: () => 'Be brief.',
      cache: anthropicCache('openrouter'),
      headers: ({ chatId }) => ({ 'x-session-id': chatId }),
      providerOptions: { anthropic: { fallbacks: 'default' } },
    });
    await collect(backend.reply(input()));
    const call = mock.doStreamCalls[0];
    const prompt = call?.prompt ?? [];
    expect(prompt[0]).toMatchObject({
      role: 'system',
      content: 'Be brief.',
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    });
    expect(prompt.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(prompt.at(-1))).toContain('Привет');
    expect(prompt.at(-1)?.providerOptions).toEqual({
      openrouter: { cacheControl: { type: 'ephemeral', ttl: '5m' } },
    });
    expect(prompt[1]?.providerOptions).toBeUndefined();
    expect(call?.headers).toMatchObject({ 'x-session-id': 'alice' });
    expect(call?.providerOptions).toEqual({ anthropic: { fallbacks: 'default' } });
  });

  it('leaves the price out when the provider does not report one', async () => {
    const backend = new LlmBackend({
      model: model(answer(['ok'])),
      modelId: 'm',
      prompt: () => '',
    });
    const usage = (await collect(backend.reply(input()))).at(-1);
    expect(usage).toEqual({
      type: 'usage',
      usage: { model: 'm', input: 120, output: 7, cached: 100, cacheWrite: 10, context: 127 },
    });
  });

  it('reads notes with its tools, then answers; the chat counts without the notes', async () => {
    const kb = new Knowledge(localFolder(kbDir()));
    const steps = [
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Let me see.' },
        { type: 'text-end', id: 't' },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'read_file',
          input: JSON.stringify({ path: 'career/skills.md' }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
          providerMetadata: { openrouter: { usage: { cost: 0.001 } } },
        },
      ],
      answer(['Swift.'], { openrouter: { usage: { cost: 0.002 } } }),
    ] as LanguageModelV4StreamPart[][];
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream(steps[mock.doStreamCalls.length - 1] ?? []),
      }),
    });
    const backend = new LlmBackend({
      model: mock,
      modelId: 'm',
      prompt: () => '',
      costOf: openRouterCost,
      tools: knowledgeTools(kb),
    });
    const events = await collect(backend.reply(input()));
    expect(events.slice(0, 2)).toEqual([
      { type: 'text', text: 'Let me see.' },
      { type: 'text', text: '\n\nSwift.' },
    ]);
    expect(events[2]).toEqual({
      type: 'usage',
      usage: {
        model: 'm',
        input: 1120,
        output: 27,
        cached: 100,
        cacheWrite: 10,
        // The first step's input (prompt and chat) and the answer, not the note read between.
        context: 1007,
        cost: 0.003,
      },
    });
    expect(mock.doStreamCalls[0]?.tools?.map((t) => t.name).sort()).toEqual([
      'grep',
      'list_files',
      'read_file',
    ]);
    expect(JSON.stringify(mock.doStreamCalls[1]?.prompt)).toContain('Swift and Kotlin');
  });

  it('takes the tools away on the last step, so an answer always comes', async () => {
    const call = (n: number) =>
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: `c${n}`, toolName: 'list_files', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE },
      ] as LanguageModelV4StreamPart[];
    const mock = new MockLanguageModelV4({
      doStream: async () => {
        const n = mock.doStreamCalls.length;
        return { stream: convertArrayToReadableStream(n < MAX_STEPS ? call(n) : answer(['ok'])) };
      },
    });
    const backend = new LlmBackend({
      model: mock,
      modelId: 'm',
      prompt: () => '',
      tools: knowledgeTools(new Knowledge(localFolder(kbDir()))),
    });
    await collect(backend.reply(input()));
    expect(mock.doStreamCalls).toHaveLength(MAX_STEPS);
    expect(mock.doStreamCalls.at(-1)?.toolChoice).toEqual({ type: 'none' });
    expect(mock.doStreamCalls[0]?.toolChoice).toEqual({ type: 'auto' });
  });

  it('gives up when the knowledge base stalls past the timeout', async () => {
    const stalled = new Promise<string>(() => {});
    const backend = new LlmBackend({
      model: model(answer(['ok'])),
      modelId: 'm',
      prompt: () => stalled,
    });
    await expect(collect(backend.reply(input(AbortSignal.timeout(50))))).rejects.toThrow();
  });

  it('gives up on a tool call that stalls past the timeout', async () => {
    const kb = new Knowledge({
      list: async () => [{ path: 'a.md', size: 1, updated: 0, stamp: '1' }],
      stat: async () => null,
      read: () => new Promise(() => {}),
    });
    const tools = knowledgeTools(kb);
    const controller = new AbortController();
    const call = tools.read_file.execute?.(
      { path: 'a.md' },
      { toolCallId: 'c', messages: [], abortSignal: controller.signal, context: {} },
    );
    controller.abort(new Error('timed out'));
    await expect(call).rejects.toThrow('timed out');
  });

  it('throws when the provider fails mid-answer', async () => {
    const parts = answer(['half']).slice(0, 3);
    parts.push({ type: 'error', error: new Error('provider down') });
    const backend = new LlmBackend({ model: model(parts), modelId: 'm', prompt: () => '' });
    await expect(collect(backend.reply(input()))).rejects.toThrow('provider down');
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('too slow'));
    const backend = new LlmBackend({
      model: model(answer(['ok'])),
      modelId: 'm',
      prompt: () => '',
    });
    await expect(collect(backend.reply(input(controller.signal)))).rejects.toThrow();
  });
});

describe('markCache', () => {
  const LONG = { ttl: '1h' };
  const SHORT = { ttl: '5m' };
  const marks = { checkpoint: { m: LONG }, every: 5, last: { m: SHORT } };

  /** A chat of `questions` questions, each answered but the last. */
  function chat(questions: number): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (let q = 1; q <= questions; q++) {
      messages.push({ role: 'user', content: `q${q}` });
      if (q < questions) messages.push({ role: 'assistant', content: `a${q}` });
    }
    return messages;
  }

  /** Which messages carry which mark, by content. */
  function marked(questions: number) {
    const messages = chat(questions);
    markCache(messages, marks);
    return Object.fromEntries(
      messages
        .filter((m) => m.providerOptions)
        .map((m) => [m.content, m.providerOptions?.m === LONG ? '1h' : '5m']),
    );
  }

  it('marks only the newest message before the first checkpoint', () => {
    expect(marked(1)).toEqual({ q1: '5m' });
    expect(marked(4)).toEqual({ q4: '5m' });
  });

  it('gives a question that is itself a checkpoint the long-lived mark', () => {
    expect(marked(5)).toEqual({ q5: '1h' });
    expect(marked(10)).toEqual({ q10: '1h' });
  });

  it('keeps the latest checkpoint marked as the chat goes on, and only that one', () => {
    expect(marked(6)).toEqual({ q5: '1h', q6: '5m' });
    expect(marked(9)).toEqual({ q5: '1h', q9: '5m' });
    expect(marked(13)).toEqual({ q10: '1h', q13: '5m' });
  });

  it('uses at most four marks with the system one, the long-lived before the short', () => {
    const messages = chat(23);
    markCache(messages, marks);
    const order = messages.filter((m) => m.providerOptions).map((m) => m.providerOptions?.m);
    expect(order).toEqual([LONG, SHORT]);
  });
});

describe('openRouterCost', () => {
  it('reads the cost and ignores anything else', () => {
    expect(openRouterCost({ openrouter: { usage: { cost: 0.5 } } })).toBe(0.5);
    expect(openRouterCost({ openrouter: { usage: {} } })).toBeUndefined();
    expect(openRouterCost({ other: { cost: 1 } })).toBeUndefined();
    expect(openRouterCost(undefined)).toBeUndefined();
  });
});

describe('anthropicCost', () => {
  const haiku = ANTHROPIC_PRICES['claude-haiku-5-5'];
  if (!haiku) throw new Error('no Haiku price');
  const usage = (fields: Record<string, number | Record<string, number>>) => ({
    anthropic: { usage: fields },
  });

  it('prices each kind of token, cache writes by how long they live', () => {
    const cost = anthropicCost(
      haiku,
      usage({
        input_tokens: 1_000,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 3_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
        output_tokens: 500,
      }),
    );
    // $0.10 in, $0.125 and $0.20 written, $0.01 read, $0.50 out, per million.
    expect(cost).toBeCloseTo(
      (1_000 * 0.1 + 1_000 * 0.125 + 2_000 * 0.2 + 40_000 * 0.01 + 500 * 0.5) / 1e6,
      12,
    );
  });

  it('prices a prompt over 100K tokens, cache included, at the dearer tier', () => {
    const cost = anthropicCost(
      haiku,
      usage({ input_tokens: 1_000, cache_read_input_tokens: 100_000, output_tokens: 100 }),
    );
    expect(cost).toBeCloseTo((1_000 * 0.5 + 100_000 * 0.05 + 100 * 2.5) / 1e6, 12);
  });

  it('counts writes without a split at the hour-long price, and nothing without usage', () => {
    expect(
      anthropicCost(haiku, usage({ input_tokens: 0, cache_creation_input_tokens: 50_000 })),
    ).toBeCloseTo(0.01, 12);
    expect(anthropicCost(haiku, { openrouter: { usage: { cost: 1 } } })).toBeUndefined();
    expect(anthropicCost(haiku, undefined)).toBeUndefined();
  });
});

describe('createBackend', () => {
  it('is the mock unless told otherwise, blank counting as unset', () => {
    expect(createBackend({})).toBeInstanceOf(MockBackend);
    expect(createBackend({ CHAT_BACKEND: '' })).toBeInstanceOf(MockBackend);
  });

  it('builds the OpenRouter and OpenAI backends from their keys', () => {
    expect(createBackend({ CHAT_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'k' })).toBeInstanceOf(
      LlmBackend,
    );
    expect(
      createBackend({ CHAT_BACKEND: 'openai', OPENAI_API_KEY: 'k', CHAT_MODEL: 'gpt-x' }),
    ).toBeInstanceOf(LlmBackend);
  });

  it('builds the Anthropic backend for a model it has a price for', () => {
    expect(createBackend({ CHAT_BACKEND: 'anthropic', ANTHROPIC_API_KEY: 'k' })).toBeInstanceOf(
      LlmBackend,
    );
    expect(() => createBackend({ CHAT_BACKEND: 'anthropic' })).toThrow('ANTHROPIC_API_KEY');
    expect(() =>
      createBackend({ CHAT_BACKEND: 'anthropic', ANTHROPIC_API_KEY: 'k', CHAT_MODEL: 'claude-x' }),
    ).toThrow('No price for claude-x');
  });

  it('refuses to start without what a backend needs', () => {
    expect(() => createBackend({ CHAT_BACKEND: 'openrouter' })).toThrow('OPENROUTER_API_KEY');
    expect(() => createBackend({ CHAT_BACKEND: 'openai', OPENAI_API_KEY: 'k' })).toThrow(
      'CHAT_MODEL',
    );
    expect(() => createBackend({ CHAT_BACKEND: 'gpt' })).toThrow('Unknown CHAT_BACKEND');
  });
});

describe('knowledge base', () => {
  const dir = kbDir();
  const kb = new Knowledge(localFolder(dir));

  it('gives the card, map and skills for the prompt, in that order and without comments', async () => {
    expect(await kb.preloaded()).toBe(
      '# Card\nHead of Mobile.\n\n# Map\n\n- `career/skills.md` - skills\n\n# Skills\n- Swift',
    );
  });

  it('offers the other notes only: no READMEs, tooling, hidden or private folders', async () => {
    expect((await kb.notes()).map((e) => e.path)).toEqual([
      'career/companies/loona/odr.md',
      'career/skills.md',
    ]);
  });

  it('preloads whichever of the three files exist', async () => {
    const one = mkdtempSync(join(tmpdir(), 'kb-'));
    writeFileSync(join(one, 'INDEX.md'), '# Map\n');
    expect(await new Knowledge(localFolder(one)).preloaded()).toBe('# Map');
  });

  it('is empty, with no tools, where there is no folder', async () => {
    const none = new Knowledge(localFolder(join(tmpdir(), 'no-such-kb')));
    expect(await none.preloaded()).toBe('');
    expect(await none.notes()).toEqual([]);
    expect(await none.tools()).toBeUndefined();
    expect(await kb.tools()).toBeDefined();
  });

  it('reads a note by any spelling of its path, and nothing outside the base', async () => {
    for (const path of [
      'career/skills.md',
      './career/skills.md',
      '/career/skills.md',
      'kb/career/skills.md',
    ]) {
      expect(await kb.readNote(path)).toContain('Swift and Kotlin');
    }
    for (const path of ['../career/skills.md', 'private/notes.md', 'README.md', 'SKILLS.md']) {
      expect(await kb.readNote(path)).toMatch(/^No note at/);
    }
  });

  it('lists notes, all or in one folder', async () => {
    expect(await kb.listFiles('career/companies')).toBe('career/companies/loona/odr.md');
    expect(await kb.listFiles('kb/career/')).toBe(
      'career/companies/loona/odr.md\ncareer/skills.md',
    );
    expect(await kb.listFiles('nowhere')).toBe('No notes under "nowhere".');
  });

  it('greps case-insensitively, with plain text where the pattern is no regular expression', async () => {
    expect(await kb.grep('swift')).toBe('career/skills.md:3: Swift and Kotlin.');
    expect(await kb.grep('swift', 'career')).toBe('career/skills.md:3: Swift and Kotlin.');
    expect(await kb.grep('C++')).toBe('career/skills.md:4: C++ for native modules.');
    expect(await kb.grep('demand|kotlin')).toContain('odr.md:2:');
    expect(await kb.grep('Haskell')).toBe('No matches for "Haskell".');
  });

  it('caps the matches it returns', async () => {
    const many = mkdtempSync(join(tmpdir(), 'kb-'));
    writeFileSync(join(many, 'a.md'), 'x\n'.repeat(GREP_MAX_MATCHES + 5));
    const out = (await new Knowledge(localFolder(many)).grep('x')).split('\n');
    expect(out).toHaveLength(GREP_MAX_MATCHES + 1);
    expect(out.at(-1)).toBe('(5 more matches not shown)');
  });

  it('sees a note added, changed or deleted at once, as a folder does', async () => {
    const live = mkdtempSync(join(tmpdir(), 'kb-'));
    const folder = new Knowledge(localFolder(live));
    expect(await folder.listFiles()).toBe('No notes.');
    writeFileSync(join(live, 'a.md'), 'First.');
    expect(await folder.readNote('a.md')).toBe('First.');
    writeFileSync(join(live, 'a.md'), 'Second, longer.');
    expect(await folder.readNote('a.md')).toBe('Second, longer.');
    rmSync(join(live, 'a.md'));
    expect(await folder.readNote('a.md')).toMatch(/^No note at/);
  });
});

describe('loadSystemPrompt', () => {
  function promptDir(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it('fills in the date and the knowledge base map', () => {
    const render = loadSystemPrompt(promptDir({ 'system.md': 'Today is {{today}}.\n\n{{kb}}\n' }));
    expect(render('# Map\n', new Date('2026-11-04T10:00:00Z'))).toBe(
      'Today is 2026-11-04.\n\n# Map',
    );
  });

  it('works without a map', () => {
    const render = loadSystemPrompt(promptDir({ 'system.md': 'Hi.\n\n{{kb}}\n' }));
    expect(render()).toBe('Hi.');
  });

  it('the prompt in the repository uses only the placeholders it knows', () => {
    const rendered = loadSystemPrompt()();
    expect(rendered).not.toContain('{{');
    expect(readFileSync('prompts/system.md', 'utf8')).toContain('{{today}}');
  });
});
