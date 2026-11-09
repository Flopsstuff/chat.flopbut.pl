import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The system prompt lives in prompts/system.md, read once at start. Placeholders, filled in for
// every answer:
//   {{today}}     the current date
//   {{kb}}        the knowledge base's card, map and skills (CARD.md, INDEX.md, SKILLS.md)

const DIR = process.env.PROMPTS_DIR || 'prompts';

/** Loads the prompt and returns a function that renders it with the base for this moment. */
export function loadSystemPrompt(dir = DIR): (kb?: string, now?: Date) => string {
  const template = readFileSync(join(dir, 'system.md'), 'utf8');
  return (kb = '', now = new Date()) =>
    template
      .replaceAll('{{today}}', now.toISOString().slice(0, 10))
      .replaceAll('{{kb}}', kb.trim())
      .trim();
}
