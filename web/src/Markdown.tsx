import { useContext, useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { publicImageUrl } from './imageHosts';
import { kbAssetPath, kbImageUrl, SignedInUser } from './kbImages';

// The bot's answers are Markdown: emphasis, lists, links, code, now and then a table and photos:
// from the knowledge base, or public ones from Flop's repositories and sites (imageHosts.ts).
// Raw HTML in them is not rendered, react-markdown drops unsafe link targets (javascript: and the
// like), and pictures from anywhere else are not loaded.

/** A photo from the knowledge base, fetched with the member's token. */
function KbImage({ path, alt }: { path: string; alt: string }) {
  const user = useContext(SignedInUser);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!user) return;
    let live = true;
    kbImageUrl(user, path).then(
      (address) => live && setUrl(address),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [user, path]);

  if (failed || !user) return alt ? <span className="kb-photo-missing">{alt}</span> : null;
  if (!url) return <span className="kb-photo kb-photo-loading" role="img" aria-label={alt} />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="kb-photo-link">
      <img className="kb-photo" src={url} alt={alt} title={alt} />
    </a>
  );
}

/** A public picture from an allowed host, loaded straight from there, without a referrer. */
function PublicImage({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return alt ? <span className="kb-photo-missing">{alt}</span> : null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="kb-photo-link">
      <img
        className="kb-photo"
        src={url}
        alt={alt}
        title={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

const components: Components = {
  // Links lead out of the chat, so they open beside it.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // A wide table scrolls on its own instead of stretching the chat.
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table">
      <table {...props} />
    </div>
  ),
  img: ({ src, alt }) => {
    const path = typeof src === 'string' ? kbAssetPath(src) : null;
    if (path) return <KbImage path={path} alt={alt ?? ''} />;
    const url = typeof src === 'string' ? publicImageUrl(src) : null;
    if (url) return <PublicImage url={url} alt={alt ?? ''} />;
    // No pictures from elsewhere: their alt text stands in.
    return alt ? <span>{alt}</span> : null;
  },
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
