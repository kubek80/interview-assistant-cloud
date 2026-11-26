import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { REQ_ID, REQ_INDEX, slugify, type DocPage } from './content';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Markdown → sanitised HTML. Requirement ids defined on this page get an anchor (id="req-ID");
 * references to ids defined elsewhere (or repeated) link to the defining page (?req=ID).
 */
export function renderDocHtml(page: DocPage, reqIndex: ReadonlyMap<string, string> = REQ_INDEX): string {
  const anchored = new Set<string>();
  const marked = new Marked({
    gfm: true,
    renderer: {
      codespan({ text }: Tokens.Codespan) {
        if (REQ_ID.test(text)) {
          const home = reqIndex.get(text);
          if (home === page.slug && !anchored.has(text)) {
            anchored.add(text);
            return `<code id="req-${text}" class="req-id">${text}</code>`;
          }
          if (home) return `<a class="req-link" href="#/docs/${home}?req=${text}"><code>${text}</code></a>`;
        }
        return `<code>${escapeHtml(text)}</code>`;
      },
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        return depth === 1 ? `<h1 tabindex="-1">${inner}</h1>\n` : `<h${depth} id="sec-${slugify(inner)}">${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const internal = href.startsWith('#');
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return internal
          ? `<a href="${escapeHtml(href)}"${t}>${text}</a>`
          : `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    },
  });
  // Wide tables scroll inside their own focusable region, never the page (A11Y-6, axe
  // "scrollable-region-focusable"); the region is named by the table's position on the page.
  let n = 0;
  const html = marked
    .parse(page.markdown, { async: false })
    .replace(/<table>/g, () => `<div class="doc-table" role="region" tabindex="0" aria-label="Table ${++n}"><table>`)
    .replace(/<\/table>/g, '</table></div>');
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

const cache = new Map<string, string>();

export function renderedDoc(page: DocPage): string {
  let html = cache.get(page.slug);
  if (html === undefined) {
    html = renderDocHtml(page);
    cache.set(page.slug, html);
  }
  return html;
}
