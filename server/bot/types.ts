// What the chat needs from a bot, whatever stands behind it: a model reached through the AI SDK
// today, possibly an A2A agent later. Each backend fills in what it can.

export type Turn = { role: 'user' | 'assistant'; text: string };

/** What one answer cost. `cost` is in US dollars and only present when the backend knows it. */
export type Usage = {
  model: string;
  input: number;
  output: number;
  /** Input tokens read from the provider's prompt cache. */
  cached: number;
  /** Input tokens written to the provider's prompt cache, billed above the plain input price. */
  cacheWrite: number;
  /**
   * Tokens the chat itself comes to after this answer, when it differs from input + output: an
   * answer that read notes with tools sent the chat several times, and the notes are not kept.
   */
  context?: number;
  cost?: number;
};

export type BotEvent = { type: 'text'; text: string } | { type: 'usage'; usage: Usage };

export type ReplyInput = {
  /** Which chat this is (the member's uid): keeps a conversation on one provider, for its cache. */
  chatId: string;
  /** The message the answer is written into, when it is saved somewhere. */
  answerId?: string;
  /** Earlier finished messages, oldest first, ending with the question to answer. */
  history: Turn[];
  /** Aborted when the answer takes too long; the backend stops and throws. */
  signal: AbortSignal;
};

export interface ChatBackend {
  /** Streams the reply to the last user turn: text pieces, and usage once it is known. */
  reply(input: ReplyInput): AsyncIterable<BotEvent>;
}
