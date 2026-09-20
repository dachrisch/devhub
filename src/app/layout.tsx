import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DevHub — personal development command board',
  description: 'Projects, topics, and work runs in one calm command board.',
  icons: { icon: '/logo.png' },
  openGraph: {
    title: 'DevHub',
    description: 'Projects, topics, and work runs in one calm command board.',
    type: 'website',
  },
};

// Chromium honors `interactive-widget=resizes-content` and shrinks the layout
// viewport when the on-screen keyboard opens, so bottom-anchored cockpit
// sheets stay visible. iOS Safari ignores it; the sheets compensate via
// visualViewport insets (use-keyboard-inset.ts).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d1117',
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router: document-level font link, no pages/_document in this app */}
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a href="#board-main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
