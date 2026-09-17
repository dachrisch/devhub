'use client';

interface IssueRefProps {
  issue: { owner: string; repo: string; number: number; title: string };
  variant?: 'full' | 'chip';
  className?: string;
}

/** Standardised issue reference text: full ("owner/repo #123: title") or
 *  chip ("owner/repo #123"). Does not render a link — callers own the
 *  surrounding `<a>` / `<Link>`. */
export function IssueRef({ issue, variant = 'full', className = '' }: IssueRefProps) {
  if (variant === 'chip') {
    return (
      <span className={`issue-ref issue-ref--chip ${className}`.trim()}>
        {issue.owner}/{issue.repo} #{issue.number}
      </span>
    );
  }
  return (
    <span className={`issue-ref issue-ref--full ${className}`.trim()}>
      {issue.owner}/{issue.repo} #{issue.number}: {issue.title}
    </span>
  );
}
