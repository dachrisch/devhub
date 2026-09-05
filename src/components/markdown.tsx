'use client';

import type { ReactNode } from 'react';
import type { MdBlock, MdInline } from '@/lib/markdown';
import { parseMarkdown } from '@/lib/markdown';

// Renders the parsed markdown AST as React elements. No dangerouslySetInnerHTML
// anywhere: raw HTML in the source stays plain text, and link hrefs were
// already restricted to http/https by the parser.

function renderInline(nodes: MdInline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (typeof node === 'string') return node;
    switch (node.type) {
      case 'code':
        return (
          <code key={key} className="md-code">
            {node.text}
          </code>
        );
      case 'bold':
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case 'italic':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer">
            {renderInline(node.children, key)}
          </a>
        );
    }
  });
}

function renderBlock(block: MdBlock, key: string): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
      return (
        <Tag key={key} className="md-heading">
          {renderInline(block.children, key)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {renderInline(block.children, key)}
        </p>
      );
    case 'list':
      return block.ordered ? (
        <ol key={key} className="md-list">
          {block.items.map((item, idx) => (
            <li key={`${key}-${idx}`}>{renderInline(item, `${key}-${idx}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {block.items.map((item, idx) => (
            <li key={`${key}-${idx}`}>{renderInline(item, `${key}-${idx}`)}</li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre key={key} className="md-pre">
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(block.children, key)}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="md-hr" />;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;
  return <div className="md">{blocks.map((b, idx) => renderBlock(b, `b${idx}`))}</div>;
}
