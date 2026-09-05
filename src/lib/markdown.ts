// Small, dependency-free markdown block parser for agent result text.
// Parsing lives here (pure, unit-tested); the React renderer
// (src/components/markdown.tsx) maps the AST to elements — it never uses
// dangerouslySetInnerHTML, so raw HTML in the source can only render as
// plain text and cannot execute. Links are restricted to http/https.

export type MdSpan =
  | { type: 'code'; text: string }
  | { type: 'bold'; children: MdInline[] }
  | { type: 'italic'; children: MdInline[] }
  | { type: 'link'; href: string; children: MdInline[] };

export type MdInline = string | MdSpan;

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: MdInline[] }
  | { type: 'hr' };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w+#-]*)\s*$/;
const HR_RE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const UL_ITEM_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_ITEM_RE = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BARE_URL_RE = /https?:\/\/[^\s<>()\[\]]+/;

const INLINE_RE = new RegExp(
  [
    '(`+)([\\s\\S]*?)\\1', // 1,2 code span
    '\\*\\*([\\s\\S]+?)\\*\\*', // 3 bold
    '\\*([^*\\n]+)\\*', // 4 italic
    '_([^_\\n]+)_', // 5 italic
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)', // 6,7 link
    `(https?:\\/\\/[^\\s<>()\\[\\]]+)`, // 8 bare url
  ].join('|'),
  'g'
);

// Agent summaries often start with plain chatter ("All done. Let me provide
// the summary.") before the first markdown heading. Drop those preamble
// lines — but only when a heading exists and the preamble holds no code
// fence that would be lost by stripping.
export function stripPreamble(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) {
      heading = i;
      break;
    }
  }
  if (heading <= 0) return text;
  const preamble = lines.slice(0, heading);
  if (preamble.some((l) => FENCE_RE.test(l))) return text;
  return lines.slice(heading).join('\n').trim();
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  return /^https?:\/\//i.test(href) ? href : null;
}

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let last = 0;
  // matchAll clones the regex, so recursive calls (bold inside a link, etc.)
  // cannot corrupt this loop's lastIndex the way a shared exec() would.
  INLINE_RE.lastIndex = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== undefined) {
      out.push({ type: 'code', text: m[2] });
    } else if (m[3] !== undefined) {
      out.push({ type: 'bold', children: parseInline(m[3]) });
    } else if (m[4] !== undefined) {
      out.push({ type: 'italic', children: parseInline(m[4]) });
    } else if (m[5] !== undefined) {
      out.push({ type: 'italic', children: parseInline(m[5]) });
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const href = safeHref(m[7]);
      if (href) out.push({ type: 'link', href, children: parseInline(m[6]) });
      else out.push(m[0]);
    } else if (m[8] !== undefined) {
      const href = safeHref(m[8]);
      if (href) out.push({ type: 'link', href, children: [m[8]] });
      else out.push(m[0]);
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = stripPreamble(text).split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  const pushParagraph = (buf: string[]) => {
    if (buf.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(buf.join('\n').trim()) });
      buf.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0] === '~' ? '~~~' : '```'}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2].trim()),
      });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const body: string[] = [quote[1]];
      i++;
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        body.push(q[1]);
        i++;
      }
      blocks.push({ type: 'quote', children: parseInline(body.join('\n').trim()) });
      continue;
    }

    const ul = UL_ITEM_RE.exec(line);
    const ol = OL_ITEM_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: MdInline[][] = [];
      let current: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const u = UL_ITEM_RE.exec(l);
        const o = OL_ITEM_RE.exec(l);
        if ((ordered && o) || (!ordered && u)) {
          if (current.length > 0) items.push(parseInline(current.join('\n').trim()));
          current = [(ordered ? o! : u!)![1]];
          i++;
        } else if (current.length > 0 && l.trim() !== '' && /^\s{2,}\S/.test(l)) {
          // Indented continuation of the previous item.
          current.push(l.trim());
          i++;
        } else {
          break;
        }
      }
      if (current.length > 0) items.push(parseInline(current.join('\n').trim()));
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !HEADING_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !UL_ITEM_RE.test(lines[i]) &&
      !OL_ITEM_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    pushParagraph(buf);
  }

  return blocks;
}

export function hasBareUrl(text: string): boolean {
  return BARE_URL_RE.test(text);
}
