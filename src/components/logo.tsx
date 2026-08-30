export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="var(--panel-2)" stroke="var(--accent)" strokeWidth="1.5" />
      <rect x="9" y="9" width="14" height="9" rx="2" stroke="var(--accent)" strokeWidth="1.8" />
      <path d="M10 13.5h6" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12.5 22.5h7" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}