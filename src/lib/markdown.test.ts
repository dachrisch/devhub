import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, stripPreamble } from './markdown';

describe('stripPreamble', () => {
  it('drops chatter lines before the first heading', () => {
    const text = 'All done. Let me provide the summary.\n\n## Summary\n\nBody.';
    expect(stripPreamble(text)).toBe('## Summary\n\nBody.');
  });

  it('keeps text without any heading', () => {
    expect(stripPreamble('Just a plain result.')).toBe('Just a plain result.');
  });

  it('keeps text that starts with a heading', () => {
    expect(stripPreamble('## Summary\n\nBody.')).toBe('## Summary\n\nBody.');
  });

  it('keeps everything when the preamble contains a code fence', () => {
    const text = '```\ncode before heading\n```\n## Summary\n\nBody.';
    expect(stripPreamble(text)).toBe(text);
  });
});

describe('parseInline', () => {
  it('renders bold, italic and inline code', () => {
    expect(parseInline('**bold** and *em* and `code`')).toEqual([
      { type: 'bold', children: ['bold'] },
      ' and ',
      { type: 'italic', children: ['em'] },
      ' and ',
      { type: 'code', text: 'code' },
    ]);
  });

  it('auto-links bare https URLs only', () => {
    expect(parseInline('see https://example.com/x now')).toEqual([
      'see ',
      { type: 'link', href: 'https://example.com/x', children: ['https://example.com/x'] },
      ' now',
    ]);
    expect(parseInline('evil javascript:alert(1)')).toEqual(['evil javascript:alert(1)']);
  });

  it('drops links with unsafe hrefs', () => {
    expect(parseInline('[click](javascript:x)')).toEqual(['[click](javascript:x)']);
  });

  it('keeps raw HTML as plain text', () => {
    expect(parseInline('<script>alert(1)</script>')).toEqual(['<script>alert(1)</script>']);
  });

  it('parses inline markdown inside link text and bold', () => {
    expect(parseInline('[**PR**](https://example.com/p)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com/p',
        children: [{ type: 'bold', children: ['PR'] }],
      },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings, paragraphs and lists from the live recap example', () => {
    const text = [
      'All done. Let me provide the summary.',
      '',
      '## Summary',
      '',
      'PR #164 already existed with the full implementation:',
      '',
      '- **`src/review/`** — New module with review tokens',
      '- **`src/migrations/007_review_tokens.ts`** — DB migration',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const blocks = parseMarkdown(text);
    expect(blocks).toEqual([
      { type: 'heading', level: 2, children: ['Summary'] },
      {
        type: 'paragraph',
        children: ['PR #164 already existed with the full implementation:'],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          [
            { type: 'bold', children: [{ type: 'code', text: 'src/review/' }] },
            ' — New module with review tokens',
          ],
          [
            { type: 'bold', children: [{ type: 'code', text: 'src/migrations/007_review_tokens.ts' }] },
            ' — DB migration',
          ],
        ],
      },
      { type: 'code', lang: 'ts', text: 'const x = 1;' },
    ]);
  });

  it('parses ordered lists and indented continuations', () => {
    const blocks = parseMarkdown('1. First\n   continued\n2. Second');
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: true,
        items: [['First\ncontinued'], ['Second']],
      },
    ]);
  });

  it('parses blockquotes and horizontal rules', () => {
    const blocks = parseMarkdown('> quoted line\n\n---');
    expect(blocks).toEqual([
      { type: 'quote', children: ['quoted line'] },
      { type: 'hr' },
    ]);
  });

  it('treats unterminated fences as code to end of text', () => {
    const blocks = parseMarkdown('```\nunclosed');
    expect(blocks).toEqual([{ type: 'code', lang: '', text: 'unclosed' }]);
  });

  it('renders raw HTML blocks as plain paragraph text', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)>');
    expect(blocks).toEqual([
      { type: 'paragraph', children: ['<img src=x onerror=alert(1)>'] },
    ]);
  });

  it('returns no blocks for empty text', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });
});
