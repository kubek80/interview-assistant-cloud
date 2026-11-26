import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { DOC_PAGES, REQ_ID, docHref, getDocPage, searchDocs } from '../docs/content';
import { renderedDoc } from '../docs/render';
import { TextInput } from '../ui/Field';
import { Icon } from '../ui/Icon';
import { useDocumentTitle } from '../ui/hooks';
import { EmptyState } from '../ui/Card';

function Highlight({ text, query }: { text: string; query: string }) {
  const i = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (!query.trim() || i < 0) return <>{text}</>;
  const n = query.trim().length;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </>
  );
}

/** OV-3: the documentation, rendered in the app and available offline. */
export default function Docs() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const req = params.get('req');
  const section = params.get('section');
  const page = getDocPage(slug);
  const [query, setQuery] = useState('');
  const articleRef = useRef<HTMLElement>(null);
  const hits = useMemo(() => searchDocs(query), [query]);
  const html = useMemo(() => (page ? renderedDoc(page) : ''), [page]);

  useDocumentTitle(page ? `${page.title} – Docs` : 'Docs');

  // Deep link: highlight and focus the requirement (?req=SCORE-3) or scroll to a section (?section=bands).
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    root.querySelectorAll('.req-highlight').forEach((el) => el.classList.remove('req-highlight'));
    root.querySelectorAll('[data-focus-target]').forEach((el) => el.removeAttribute('data-focus-target'));
    let target: HTMLElement | null = null;
    if (req && REQ_ID.test(req)) {
      const code = root.querySelector<HTMLElement>(`#req-${CSS.escape(req)}`);
      target = (code?.closest('li, tr, p') as HTMLElement | null) ?? code;
      target?.classList.add('req-highlight');
    } else if (section) {
      target = root.querySelector<HTMLElement>(`#sec-${CSS.escape(section)}`);
    }
    if (target) {
      target.setAttribute('tabindex', '-1');
      target.setAttribute('data-focus-target', '');
      target.scrollIntoView({ block: 'center' });
      // Same page, new anchor: the layout won't move focus, so do it here.
      target.focus({ preventScroll: true });
    } else {
      window.scrollTo(0, 0);
    }
  }, [html, req, section, location.key]);

  return (
    <div className="docs-layout">
      <nav className="docs-nav no-print" aria-label="Documentation">
        <div role="search">
          <label htmlFor="docs-search" className="visually-hidden">
            Search the documentation
          </label>
          <TextInput id="docs-search" type="search" placeholder="Search docs…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        </div>
        {query.trim().length >= 2 ? (
          <div aria-live="polite">
            <p className="small muted">
              {hits.length ? `${hits.length}${hits.length >= 40 ? '+' : ''} result${hits.length === 1 ? '' : 's'}` : 'No results'}
            </p>
            <ul className="docs-results">
              {hits.map((h, i) => (
                <li key={`${h.slug}-${i}`}>
                  <Link to={docHref({ slug: h.slug, req: h.req, section: h.section })}>
                    <span className="docs-results__page">
                      {h.pageTitle}
                      {h.req && ` · ${h.req}`}
                    </span>
                    <span className="docs-results__snippet">
                      <Highlight text={h.snippet} query={query} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="docs-nav__list">
            {DOC_PAGES.map((p, i) => (
              <li key={p.slug}>
                <Link to={docHref({ slug: p.slug })} aria-current={p.slug === page?.slug ? 'page' : undefined}>
                  <span className="docs-nav__num">{i + 1}</span>
                  <span>{p.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>
      {page ? (
        // Content is our own bundled Markdown, sanitised with DOMPurify in renderDocHtml.
        <article ref={articleRef} className="doc-content" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <article ref={articleRef} className="doc-content">
          <h1 tabIndex={-1}>Page not found</h1>
          <EmptyState title="There is no documentation page with that name.">
            <p>
              <Link to={docHref({})}>
                <Icon name="doc" /> Go to the overview
              </Link>
            </p>
          </EmptyState>
        </article>
      )}
    </div>
  );
}
