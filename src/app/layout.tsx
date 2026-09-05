import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DevHub',
  description: 'Personal development command board',
  icons: { icon: '/logo.png' },
};

// Chromium honors `interactive-widget=resizes-content` and shrinks the layout
// viewport when the on-screen keyboard opens, so bottom-anchored cockpit
// sheets stay visible. iOS Safari ignores it; the sheets compensate via
// visualViewport insets (use-keyboard-inset.ts).
export const viewport: Viewport = {
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
