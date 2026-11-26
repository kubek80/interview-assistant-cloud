// In-app documentation (OV-3): docs/*.md bundled at build time, so it works offline.

export interface DocPage {
  slug: string;
  title: string;
  markdown: string;
}

export const REQ_ID = /^[A-Z0-9]+-\d+$/;

const raw = import.meta.glob<string>('/docs/*.md', { query: '?raw', import: 'default', eager: true });

/**
 * Pages in filename order, except that the Verification page (which traces every other page) comes
 * last, after pages added later such as 11-interviewers-transcripts-ai.
 */
export function parsePages(files: Record<string, string>): DocPage[] {
  const last = (path: string) => (/-verification\.md$/.test(path) ? 1 : 0);
  return Object.keys(files)
    .sort((a, b) => last(a) - last(b) || a.localeCompare(b))
    .map((path) => {
      const markdown = files[path];
      const slug = path.replace(/^.*\//, '').replace(/\.md$/, '');
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? slug;
      return { slug, title, markdown };
    });
}

export const DOC_PAGES: DocPage[] = parsePages(raw);

export function getDocPage(slug: string | undefined): DocPage | undefined {
  return slug ? DOC_PAGES.find((p) => p.slug === slug) : DOC_PAGES[0];
}

/** Requirement id → slug of the page that defines it (a list item starting with the id in backticks). */
export function buildReqIndex(pages: readonly DocPage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const p of pages) {
    for (const m of p.markdown.matchAll(/^\s*-\s+`([A-Z0-9]+-\d+)`/gm)) if (!index.has(m[1])) index.set(m[1], p.slug);
  }
  return index;
}

export const REQ_INDEX = buildReqIndex(DOC_PAGES);

/** Slug of the page defining a requirement id, e.g. docSlugForReq("SCORE-3") → "04-scoring". */
export function docSlugForReq(req: string): string | undefined {
  return REQ_INDEX.get(req);
}

/**
 * UX-7: a plain name for the help about a requirement: the heading of the docs section that defines
 * it (without its step number), else the page title. E.g. "PRIV-4" → "Consent".
 */
export function reqHelpLabel(req: string, pages: readonly DocPage[] = DOC_PAGES): string {
  const page = pages.find((p) => p.slug === buildReqIndexCached(pages).get(req));
  if (!page) return 'documentation';
  const lines = page.markdown.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s+\`${req}\``).test(l));
  for (let i = at; i >= 0; i--) {
    const h = /^#{2,4}\s+(.+)$/.exec(lines[i]);
    if (h) return h[1].replace(/^\d+\.\s*/, '').trim();
  }
  return page.title;
}

const indexCache = new WeakMap<readonly DocPage[], Map<string, string>>();
function buildReqIndexCached(pages: readonly DocPage[]): Map<string, string> {
  let m = indexCache.get(pages);
  if (!m) indexCache.set(pages, (m = pages === DOC_PAGES ? REQ_INDEX : buildReqIndex(pages)));
  return m;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Router path for a doc page, a requirement, or a section heading. */
export function docHref(opts: { slug?: string; req?: string; section?: string }): string {
  const slug = opts.slug ?? (opts.req ? docSlugForReq(opts.req) : undefined) ?? DOC_PAGES[0]?.slug ?? '';
  const params = new URLSearchParams();
  if (opts.req) params.set('req', opts.req);
  if (opts.section) params.set('section', opts.section);
  const q = params.toString();
  return `/docs/${slug}${q ? `?${q}` : ''}`;
}

export interface SearchHit {
  slug: string;
  pageTitle: string;
  /** Plain-text excerpt around the match. */
  snippet: string;
  /** Requirement id in the matching block, if any (used for the deep link). */
  req?: string;
  /** Nearest heading anchor above the match. */
  section?: string;
}

function plain(md: string): string {
  return md
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>|]/g, '')
    .replace(/^\s*-\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Case-insensitive search across every page, one hit per matching paragraph, list item or table row. */
export function searchDocs(query: string, pages: readonly DocPage[] = DOC_PAGES, limit = 40): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const p of pages) {
    let section: string | undefined;
    const blocks = p.markdown.split(/\n(?=\s*- |\|)|\n\s*\n/);
    for (const block of blocks) {
      const heading = /^(#{2,4})\s+(.+)$/m.exec(block);
      if (heading) section = slugify(heading[2]);
      const text = plain(block);
      const at = text.toLowerCase().indexOf(q);
      if (at < 0 || /^[-: ]+$/.test(text)) continue;
      const start = Math.max(0, at - 60);
      const snippet = (start > 0 ? '…' : '') + text.slice(start, at + q.length + 100) + (at + q.length + 100 < text.length ? '…' : '');
      const req = /`([A-Z0-9]+-\d+)`/.exec(block)?.[1];
      hits.push({ slug: p.slug, pageTitle: p.title, snippet, req, section: req ? undefined : section });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/**
 * The Markdown of one `## ` section of a docs page (its heading and body, up to the next `## `
 * heading), or null. Used to show a section in context, e.g. the AI privacy notice in Admin (AI-2).
 */
export function docSection(slug: string, heading: string, pages: readonly DocPage[] = DOC_PAGES): string | null {
  const page = pages.find((p) => p.slug === slug);
  if (!page) return null;
  const lines = page.markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim() === heading);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}
