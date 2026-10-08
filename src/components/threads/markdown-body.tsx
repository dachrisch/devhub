'use client';

import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type MdBlock, type MdInline } from '@/lib/markdown';

// Dependency-free markdown renderer (v3 details card). Maps the
// parseMarkdown AST to React elements — never dangerouslySetInnerHTML, so
// raw HTML in agent/issue text cannot execute; links are http(s)-only by
// parseInline. UI copy areas (chips, banners) keep using plain strings.

function renderInline(nodes: MdInline[]): ReactNode {
  return nodes.map((n, i) => {
    if (typeof n === 'string') return <Fragment key={i}>{n}</Fragment>;
    switch (n.type) {
      case 'code':
        return <code key={i}>{n.text}</code>;
      case 'bold':
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(n.children)}</em>;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer">
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

function renderBlock(b: MdBlock, i: number): ReactNode {
  switch (b.type) {
    case 'heading': {
      const Tag = (b.level >= 1 && b.level <= 6 ? `h${b.level}` : 'h3') as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag key={i}>{renderInline(b.children)}</Tag>;
    }
    case 'paragraph':
      return <p key={i}>{renderInline(b.children)}</p>;
    case 'list':
      return b.ordered ? (
        <ol key={i}>{b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ol>
      ) : (
        <ul key={i}>{b.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>
      );
    case 'code':
      return <pre key={i}>{b.text}</pre>;
    case 'quote':
      return <blockquote key={i}>{renderInline(b.children)}</blockquote>;
    case 'hr':
      return <hr key={i} />;
  }
}

export function MarkdownBody({ text, className }: { text: string; className?: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const blocks = parseMarkdown(trimmed);
  return (
    <div className={className ?? 'v2-markdown'}>
      {blocks.map(renderBlock)}
    </div>
  );
}
