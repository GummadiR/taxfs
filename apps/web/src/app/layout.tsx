import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TaxFS',
  description: 'E-file-ready personal tax return packages. Computes, validates, explains, prints — never transmits.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="mx-auto min-h-screen max-w-5xl bg-white p-6 text-slate-900">{children}</body>
    </html>
  );
}
