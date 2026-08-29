import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DevHub',
  description: 'Personal development command board',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
