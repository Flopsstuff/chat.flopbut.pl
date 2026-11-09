import {
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
  type SystemModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
} from 'ai';
import { abortable } from './kb.js';
import type { BotEvent, ChatBackend, ReplyInput, Turn } from './types.js';

type ProviderOptions = SystemModelMessage['providerOptions'];

/**
 * Where to mark the prompt for the provider's cache, for providers that cache only what is
 * marked (Anthropic). Each mark caches everything before it; at most four are allowed, and
 * longer-lived marks must come first.
 */
export type CacheMarks = {
  /** On the system prompt: the same for every chat on a given day. */
  system?: ProviderOptions;
  /**
   * On every `every`-th question, the latest one staying marked as the chat grows: after a pause
   * longer than the short-lived mark lasts, the chat up to there is still read from the cache.
   */
  checkpoint?: ProviderOptions;
  every?: number;
  /** On the newest message, so the next question reads all of this one from the cache. */
  last?: ProviderOptions;
};

export type LlmOptions = {
  model: LanguageModel;
  /** The model's name as stored with each answer's cost. */
  modelId: string;
  /** Renders the system prompt for the current moment, with the knowledge base as it is now. */
  prompt: () => string | Promise<string>;
  /** Cache marks, for providers that need them. */
  cache?: CacheMarks;
  /** Options for the provider on every request, such as Anthropic's fallback on a refusal. */
  providerOptions?: ProviderOptions;
  /** Headers for each request, such as the session that keeps a chat on one provider. */
  headers?: (input: ReplyInput) => Record<string, string>;
  /** The dollar cost of one step, from its provider metadata, where the provider reports it. */
  costOf?: (metadata: ProviderMetadata | undefined) => number | undefined;
  /**
   * Tools the model may call before it answers, such as the ones that read the knowledge base;
   * a function is asked afresh for every answer, with that answer's chat, so the base can change
   * underneath and a tool can know whose chat it works for.
   */
  tools?: ToolSet | ((input: ReplyInput) => ToolSet | undefined | Promise<ToolSet | undefined>);
};

/**
 * Model calls one answer may take: up to five rounds of tool calls, then the answer. The last one
 * is not offered the tools, so the answer always comes.
 */
export const MAX_STEPS = 6;

/**
 * A chat model reached through the AI SDK: one streamText call per answer, which may take several
 * steps when the model reads with its tools. Only the text goes to the chat; the tool calls and
 * what they returned are not kept, so the next question starts from the chat alone.
 */
export class LlmBackend implements ChatBackend {
  constructor(private readonly options: LlmOptions) {}

  async *reply(input: ReplyInput): AsyncIterable<BotEvent> {
    const { history, signal } = input;
    const { model, modelId, prompt, cache, headers, costOf, providerOptions } = this.options;
    // The knowledge base is read from the bucket here, so the timeout covers it too.
    const [system, tools] = await abortable(
      Promise.all([
        prompt(),
        typeof this.options.tools === 'function' ? this.options.tools(input) : this.options.tools,
      ]),
      signal,
    );
    const messages = history.map(toMessage);
    if (cache) markCache(messages, cache);
    const result = streamText({
      model,
      instructions: { role: 'system', content: system, providerOptions: cache?.system },
      messages,
      ...(tools && {
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        prepareStep: ({ stepNumber }) =>
          stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' as const } : undefined,
      }),
      headers: headers?.(input),
      providerOptions,
      abortSignal: signal,
      maxRetries: 1,
    });

    let cost: number | undefined;
    // What the chat itself comes to: the first step's input (prompt, chat and question) and the
    // last step's output (the answer), without the notes read in between, which are not kept.
    let firstInput: number | undefined;
    let lastOutput = 0;
    // Text written before a tool call is kept apart from the text after it.
    let wrote = false;
    let gap = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'start-step':
          if (wrote) gap = true;
          break;
        case 'text-delta':
          if (part.text) {
            yield { type: 'text', text: gap ? `\n\n${part.text}` : part.text };
            wrote = true;
            gap = false;
          }
          break;
        case 'finish-step': {
          const step = costOf?.(part.providerMetadata);
          if (step !== undefined) cost = (cost ?? 0) + step;
          firstInput ??= part.usage.inputTokens ?? 0;
          lastOutput = part.usage.outputTokens ?? 0;
          break;
        }
        case 'finish': {
          const usage = part.totalUsage;
          yield {
            type: 'usage',
            usage: {
              model: modelId,
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cached: usage.inputTokenDetails?.cacheReadTokens ?? 0,
              cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
              context: (firstInput ?? usage.inputTokens ?? 0) + lastOutput,
              ...(cost !== undefined && { cost }),
            },
          };
          break;
        }
        case 'error':
          throw part.error;
        case 'abort':
          throw signal.reason ?? new Error('aborted');
      }
    }
  }
}

/** Puts the checkpoint and the newest-message marks on the chat (the system one goes apart). */
export function markCache(messages: ModelMessage[], marks: CacheMarks) {
  const questions = messages.flatMap((m, index) => (m.role === 'user' ? [index] : []));
  const lastIndex = messages.length - 1;
  let checkpoint: number | undefined;
  if (marks.checkpoint && marks.every) {
    const reached = Math.floor(questions.length / marks.every) * marks.every;
    checkpoint = reached > 0 ? questions[reached - 1] : undefined;
  }
  const at = (index: number | undefined, options: ProviderOptions) => {
    const message = index === undefined ? undefined : messages[index];
    if (message && options) message.providerOptions = options;
  };
  // A question that is itself a checkpoint gets the long-lived mark rather than the short one.
  if (checkpoint !== lastIndex) at(lastIndex, marks.last);
  at(checkpoint, marks.checkpoint);
}

function toMessage(turn: Turn): ModelMessage {
  return turn.role === 'user'
    ? { role: 'user', content: turn.text }
    : { role: 'assistant', content: turn.text };
}

/** OpenRouter reports what each call cost under providerMetadata.openrouter.usage.cost. */
export function openRouterCost(metadata: ProviderMetadata | undefined): number | undefined {
  const usage = metadata?.openrouter?.usage;
  if (usage && typeof usage === 'object' && 'cost' in usage && typeof usage.cost === 'number') {
    return usage.cost;
  }
  return undefined;
}
