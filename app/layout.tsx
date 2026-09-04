import './styles.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'QA Orchestrator',
  description: 'AI-assisted QA orchestration for APIs and web applications',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
