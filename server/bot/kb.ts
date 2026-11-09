import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';

// The knowledge base: notes about Flop Butylkin and their photos, in a folder. The bot works with
// it as with any folder of files: every tool call lists and reads it as it is at that moment. In
// production the folder is in a Cloud Storage bucket (server/kbBucket.ts); locally it is a folder
// on disk (KB_DIR). Three files at its root go into the system prompt of every answer
// (PRELOADED); the bot opens the other notes with the tools below. Only notes can be read, so a
// path can never leave the base or reach a private file.

/** One file in the folder, by its path from the root. `stamp` changes whenever the file does. */
export type KbEntry = { path: string; size: number; updated: number; stamp: string };

/** A folder of files, on disk or in a bucket. */
export interface KbFolder {
  /** Every file in it, hidden ones aside. */
  list(): Promise<KbEntry[]>;
  stat(path: string): Promise<KbEntry | null>;
  read(path: string): Promise<Uint8Array | null>;
}

/** Folders never read: tooling, and anything private. */
const SKIPPED_DIRS = new Set(['node_modules', 'scripts', 'private']);
/** Notes for the people and agents who keep the base, not for the bot. */
const SKIPPED_FILES = new Set(['README.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

/** Pictures kept with the notes, by extension, with the type they are served as. */
export const ASSET_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Never more than this in one picture: the base's photos are resized to a few hundred KB. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
/**
 * The files the bot gets in its system prompt, without asking: the candidate's card (the key
 * facts), the map of every note, and the skills matrix (each technology, where and when).
 */
export const PRELOADED = ['CARD.md', 'INDEX.md', 'SKILLS.md'];

/** How many matching lines one grep returns, and how much of each line. */
export const GREP_MAX_MATCHES = 40;
const GREP_LINE_LENGTH = 240;

/** How many files are read at once. */
const READS_AT_ONCE = 8;

/**
 * Settles with the work, or rejects with the signal's reason as soon as it aborts: a bucket that
 * stalls must not hold an answer past its timeout. The work itself is left to finish or fail.
 */
export function abortable<T>(work: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.resolve(work);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Whether a path may be part of the base at all: no hidden, tooling or private folders. */
function inBase(path: string): boolean {
  const parts = path.split('/');
  return (
    parts.every((part) => part !== '' && !part.startsWith('.')) &&
    !parts.slice(0, -1).some((dir) => SKIPPED_DIRS.has(dir))
  );
}

/** Whether a file of the base is a note for the bot (the PRELOADED ones included). */
export function isNote(path: string): boolean {
  const name = path.split('/').at(-1) ?? '';
  return name.endsWith('.md') && !SKIPPED_FILES.has(name) && inBase(path);
}

/** The type a picture of the base is served as, or null when it is not one. */
export function assetType(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return (ASSET_TYPES[ext] && inBase(path) && ASSET_TYPES[ext]) || null;
}

/**
 * What a file is to the bot: one of the three that go into its prompt, a note it reads with its
 * tools, a photo it may show, or something it never reads (READMEs, stack.json, tooling).
 */
export type FileKind = 'prompt' | 'note' | 'photo' | 'other';

export function fileKind(path: string): FileKind {
  if (PRELOADED.includes(path)) return 'prompt';
  if (isNote(path)) return 'note';
  if (assetType(path)) return 'photo';
  return 'other';
}

/** A folder on disk, such as a local copy of the base. A missing folder is an empty one. */
export function localFolder(dir: string): KbFolder {
  const entry = async (path: string): Promise<KbEntry | null> => {
    try {
      const info = await stat(join(dir, path));
      if (!info.isFile()) return null;
      return {
        path,
        size: info.size,
        updated: info.mtimeMs,
        stamp: `${info.mtimeMs}:${info.size}`,
      };
    } catch {
      return null;
    }
  };
  return {
    async list() {
      let paths: string[];
      try {
        paths = (await readdir(dir, { recursive: true })).map((p) => p.split('\\').join('/'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const visible = paths.filter(
        (p) => !p.split('/').some((part) => part.startsWith('.') || part === 'node_modules'),
      );
      const entries = await Promise.all(visible.map(entry));
      return entries.filter((e): e is KbEntry => e !== null);
    },
    stat: entry,
    async read(path) {
      try {
        return new Uint8Array(await readFile(join(dir, path)));
      } catch {
        return null;
      }
    },
  };
}

const decoder = new TextDecoder();

/** A path as the model may write it: `./career/x.md`, `/career/x.md`, `kb/career/x.md`. */
function normalize(path: string): string {
  const clean = posix.normalize(
    path
      .trim()
      .replace(/^\.?\/+/, '')
      .replace(/^kb\//, ''),
  );
  return clean === '.' ? '' : clean.replace(/\/$/, '');
}

function under(dir: string | undefined) {
  const prefix = dir ? normalize(dir) : '';
  return (path: string) => !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

/** A pattern as a case-insensitive regular expression, or as plain text if it is not one. */
function matcher(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  }
}

/**
 * The knowledge base over its folder. Everything reads the folder as it is now; a file's text is
 * kept only to skip downloading it again while its stamp stays the same.
 */
export class Knowledge {
  #texts = new Map<string, { stamp: string; text: string }>();

  constructor(readonly folder: KbFolder) {}

  /** The text of each file, by path, read a few at a time; a file gone meanwhile is left out. */
  async #read(entries: KbEntry[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    for (let i = 0; i < entries.length; i += READS_AT_ONCE) {
      await Promise.all(
        entries.slice(i, i + READS_AT_ONCE).map(async ({ path, stamp }) => {
          const known = this.#texts.get(path);
          if (known?.stamp === stamp) {
            texts.set(path, known.text);
            return;
          }
          const bytes = await this.folder.read(path);
          if (!bytes) return;
          const text = decoder.decode(bytes);
          this.#texts.set(path, { stamp, text });
          texts.set(path, text);
        }),
      );
    }
    return texts;
  }

  /** The notes the tools may read (all but the PRELOADED ones), sorted, in one folder or all. */
  async notes(dir?: string): Promise<KbEntry[]> {
    return (await this.folder.list())
      .filter((e) => isNote(e.path) && !PRELOADED.includes(e.path) && under(dir)(e.path))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** The PRELOADED files that exist, in that order, without HTML comments; empty without any. */
  async preloaded(): Promise<string> {
    const entries = (await this.folder.list()).filter((e) => PRELOADED.includes(e.path));
    const texts = await this.#read(entries);
    return PRELOADED.flatMap((name) => {
      const text = texts.get(name);
      return text === undefined ? [] : [text.replace(/<!--[\s\S]*?-->\s*/g, '').trim()];
    }).join('\n\n');
  }

  async listFiles(dir?: string): Promise<string> {
    const paths = (await this.notes(dir)).map((e) => e.path);
    if (paths.length) return paths.join('\n');
    return dir ? `No notes under "${dir}".` : 'No notes.';
  }

  async readNote(path: string): Promise<string> {
    const clean = normalize(path);
    const entry = (await this.notes()).find((e) => e.path === clean);
    const text = entry && (await this.#read([entry])).get(clean);
    return (
      text ?? `No note at "${path}". Take a path from the map, or find one with list_files or grep.`
    );
  }

  async grep(pattern: string, dir?: string): Promise<string> {
    const re = matcher(pattern);
    const texts = await this.#read(await this.notes(dir));
    const matches: string[] = [];
    let total = 0;
    for (const [path, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : 1))) {
      text.split('\n').forEach((line, i) => {
        if (!re.test(line)) return;
        total++;
        if (matches.length < GREP_MAX_MATCHES) {
          matches.push(`${path}:${i + 1}: ${line.trim().slice(0, GREP_LINE_LENGTH)}`);
        }
      });
    }
    if (!total) return `No matches for "${pattern}".`;
    const more = total - matches.length;
    return more > 0
      ? `${matches.join('\n')}\n(${more} more matches not shown)`
      : matches.join('\n');
  }

  /** The tools that let the model read the base, or none when it has no notes. */
  async tools() {
    return (await this.notes()).length ? knowledgeTools(this) : undefined;
  }
}

/** The tools that let the model read the base; each gives up when the answer is aborted. */
export function knowledgeTools(kb: Knowledge) {
  const dir = z
    .string()
    .optional()
    .describe('A folder from the map, such as "career/companies/loona". Omit for the whole base.');
  return {
    read_file: tool({
      description:
        'Read one note of the knowledge base in full. Take the path from the map in your instructions.',
      inputSchema: z.object({
        path: z.string().describe('Path from the root of the base, e.g. "career/skills.md".'),
      }),
      execute: ({ path }, { abortSignal }) => abortable(kb.readNote(path), abortSignal),
    }),
    grep: tool({
      description:
        'Find lines in the notes that match a word or a regular expression, case-insensitive. ' +
        'Returns "path:line: text" for each match. Notes are mostly in Russian.',
      inputSchema: z.object({ pattern: z.string().min(1), dir }),
      execute: ({ pattern, dir }, { abortSignal }) => abortable(kb.grep(pattern, dir), abortSignal),
    }),
    list_files: tool({
      description: 'List the paths of the notes in the knowledge base, or in one folder of it.',
      inputSchema: z.object({ dir }),
      execute: ({ dir }, { abortSignal }) => abortable(kb.listFiles(dir), abortSignal),
    }),
  };
}
