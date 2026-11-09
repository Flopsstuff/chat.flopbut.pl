import type { BotEvent, ChatBackend, ReplyInput } from './types.js';

const REPLIES = [
  "I'm a stand-in for the real bot. Until it is switched on I answer every message with a few canned lines, streamed word by word so the chat has something to show.",
  'Noted. The real answer will come from a proper model; for now this is a mock reply, sent in small pieces the way a live model would send them.',
  "Good question. I can't think - I'm the placeholder bot - but your message is saved in the history, so the real one will be able to see it.",
];

/** Text that makes the mock fail halfway, to exercise the error path. */
export const MOCK_FAILURE = '#fail';

/** What every mock answer pretends to cost, so the allowance can be tried without a model. */
export const MOCK_COST = 0.01;

export class MockBackend implements ChatBackend {
  constructor(private readonly delayMs: number) {}

  async *reply({ history, signal }: ReplyInput): AsyncIterable<BotEvent> {
    const question = history.at(-1)?.text ?? '';
    const userTurns = history.filter((t) => t.role === 'user').length;
    const text = REPLIES[(userTurns - 1 + REPLIES.length) % REPLIES.length] ?? '';
    const words = text.split(/(?<= )/);
    for (const [index, word] of words.entries()) {
      signal.throwIfAborted();
      if (question.includes(MOCK_FAILURE) && index === Math.floor(words.length / 2)) {
        throw new Error('mock failure');
      }
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      yield { type: 'text', text: word };
    }
    yield {
      type: 'usage',
      usage: {
        model: 'mock',
        // A character for a token: the whole chat goes in, as it would to a model.
        input: history.reduce((sum, turn) => sum + turn.text.length, 0),
        output: text.length,
        cached: 0,
        cacheWrite: 0,
        cost: MOCK_COST,
      },
    };
  }
}
