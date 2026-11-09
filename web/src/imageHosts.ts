// Pictures from the open web the chat shows in the bot's answers: public files of Flop's
// repositories on GitHub and of his sites. Anything else shows as its alt text, so an answer
// cannot pull in arbitrary pictures (or track whoever reads it) through a note or the bot.

/** The address of an allowed public picture, or null when it is not one. */
export function publicImageUrl(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const allowed =
    host === 'raw.githubusercontent.com' ||
    // Where github.com/.../raw/... sends files kept in Git LFS; public repositories only.
    host === 'media.githubusercontent.com' ||
    // github.com/<owner>/<repo>/raw/<ref>/<path>, which redirects to the raw file.
    (host === 'github.com' && /^\/[^/]+\/[^/]+\/raw\/.+/.test(path)) ||
    host === 'flopbut.pl' ||
    host === 'stuff.flopbut.pl';
  return allowed ? url.toString() : null;
}
