import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ToolSet } from 'ai';
import { ANTHROPIC_PRICES, anthropicCost } from './anthropicPrice.js';
import { Knowledge, localFolder } from './kb.js';
import { type CacheMarks, LlmBackend, openRouterCost } from './llm.js';
import { MockBackend } from './mock.js';
import { loadSystemPrompt } from './prompt.js';
import type { ChatBackend, ReplyInput } from './types.js';

export { ANTHROPIC_PRICES, anthropicCost, type ModelPrice } from './anthropicPrice.js';
export {
  GREP_MAX_MATCHES,
  type KbEntry,
  type KbFolder,
  Knowledge,
  knowledgeTools,
  localFolder,
} from './kb.js';
export { type CacheMarks, LlmBackend, MAX_STEPS, markCache, openRouterCost } from './llm.js';
export { MOCK_COST, MOCK_FAILURE, MockBackend } from './mock.js';
export { loadSystemPrompt } from './prompt.js';
export type { BotEvent, ChatBackend, ReplyInput, Turn, Usage } from './types.js';

export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-haiku-5.5';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** How many questions apart the long-lived cache checkpoints are: ten messages. */
export const CACHE_CHECKPOINT_EVERY = 5;

/**
 * Anthropic caches only what is marked. The system prompt and a checkpoint every few questions
 * live an hour (a write costs 2x the input price), the newest message five minutes (1.25x); a
 * read costs 0.1x or less. So a lively chat reads everything before each question from the cache,
 * and after a longer pause only the questions since the last checkpoint are written again. The
 * marks are the same through OpenRouter and straight to Anthropic, under each provider's key.
 */
export function anthropicCache(provider: 'openrouter' | 'anthropic'): CacheMarks {
  const ephemeral = (ttl: '5m' | '1h') => ({
    [provider]: { cacheControl: { type: 'ephemeral', ttl } },
  });
  return {
    system: ephemeral('1h'),
    checkpoint: ephemeral('1h'),
    every: CACHE_CHECKPOINT_EVERY,
    last: ephemeral('5m'),
  };
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string, backend: string): string {
  const value = env[name];
  if (!value) throw new Error(`CHAT_BACKEND=${backend} needs ${name}`);
  return value;
}

/**
 * The prompt and tools over the knowledge base, read afresh for every answer: its folder is read
 * as it is at that moment, so a file changed in the bucket is seen by the next answer.
 */
function knowledge(kb: Knowledge, extra?: ExtraTools) {
  const render = loadSystemPrompt();
  return {
    prompt: async () => render(await kb.preloaded()),
    tools: async (input: ReplyInput) => {
      const tools = { ...(await kb.tools()), ...extra?.(input) };
      return Object.keys(tools).length ? tools : undefined;
    },
  };
}

/** Tools beyond the knowledge base's, made for each answer: asking Flop in Telegram. */
export type ExtraTools = (input: ReplyInput) => ToolSet | undefined;

/**
 * The bot picked by CHAT_BACKEND. A missing key fails here, at start, rather than on the first
 * question. Blank variables count as unset, the way the deploy passes empty repository variables.
 */
export function createBackend(
  env: Env = process.env,
  kb = new Knowledge(localFolder(env.KB_DIR || 'kb')),
  extra?: ExtraTools,
): ChatBackend {
  const kind = env.CHAT_BACKEND || 'mock';
  switch (kind) {
    case 'mock':
      return new MockBackend(Number(env.MOCK_DELAY_MS || 45));

    case 'openrouter': {
      const modelId = env.CHAT_MODEL || DEFAULT_OPENROUTER_MODEL;
      const openrouter = createOpenRouter({
        apiKey: required(env, 'OPENROUTER_API_KEY', kind),
        compatibility: 'strict',
        // Shown as the app in OpenRouter's activity log.
        appName: 'chat.flopbut.pl',
        appUrl: 'https://chat.flopbut.pl',
      });
      return new LlmBackend({
        model: openrouter(modelId, {
          usage: { include: true },
          // Only providers that do not keep or train on what they are sent.
          provider: { data_collection: 'deny' },
        }),
        modelId,
        ...knowledge(kb, extra),
        // Other providers cache on their own, without marks.
        cache: modelId.startsWith('anthropic/') ? anthropicCache('openrouter') : undefined,
        // OpenRouter keeps one session on one provider while it is active, so its cache stays warm.
        headers: ({ chatId }) => ({ 'x-session-id': chatId }),
        costOf: openRouterCost,
      });
    }

    case 'anthropic': {
      const modelId = env.CHAT_MODEL || DEFAULT_ANTHROPIC_MODEL;
      const price = ANTHROPIC_PRICES[modelId];
      if (!price) throw new Error(`No price for ${modelId}: add it to ANTHROPIC_PRICES`);
      const anthropic = createAnthropic({ apiKey: required(env, 'ANTHROPIC_API_KEY', kind) });
      return new LlmBackend({
        model: anthropic(modelId),
        modelId,
        ...knowledge(kb, extra),
        cache: anthropicCache('anthropic'),
        // Where a safety classifier declines, the request is run again on the model Anthropic
        // recommends for that kind of refusal, inside the same call. Haiku has no such fallback.
        ...(!modelId.startsWith('claude-haiku') && {
          providerOptions: { anthropic: { fallbacks: 'default' } },
        }),
        // Anthropic reports tokens only, so the price comes from the published list. An answer a
        // fallback model finished is counted at this model's prices.
        costOf: (metadata) => anthropicCost(price, metadata),
      });
    }

    case 'openai': {
      const modelId = required(env, 'CHAT_MODEL', kind);
      const openai = createOpenAI({ apiKey: required(env, 'OPENAI_API_KEY', kind) });
      // OpenAI reports tokens but not prices, so these answers do not draw on the allowance.
      return new LlmBackend({ model: openai(modelId), modelId, ...knowledge(kb, extra) });
    }

    default:
      throw new Error(`Unknown CHAT_BACKEND: ${kind}`);
  }
}
