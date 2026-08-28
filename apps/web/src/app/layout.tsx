import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'TaxFS',
  description: 'E-file-ready personal tax return packages. Computes, validates, explains, prints — never transmits.',
};

// Every page is per-request (cookie-selected workspace, database-backed).
// Root-level so no route is ever prerendered against a live database at
// build time (the TaxOS P64 lesson).
export const dynamic = 'force-dynamic';

const NAV: [string, string][] = [
  ['/get-started', '1 · Get Started'],
  ['/documents', '2 · Documents'],
  ['/data', '3 · Add Data'],
  ['/interview', '4 · Interview'],
  ['/review', '5 · Review'],
  ['/gates', '6 · Gates Board'],
  ['/forms', '7 · Forms'],
  ['/file-it', '8 · File It'],
  ['/efile', '9 · E-file Sheet'],
  ['/history', '10 · History'],
  ['/agents', 'Agent traces'],
  ['/workspaces', 'Workspaces'],
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-slate-900">
        <div className="mx-auto flex min-h-screen max-w-5xl">
          <nav aria-label="Sections" className="w-48 shrink-0 border-r border-slate-200 p-4">
            <Link href="/" className="mb-3 block text-lg font-black tracking-tight">TaxFS</Link>
            <ul className="space-y-1 text-sm">
              {NAV.map(([href, label]) => (
                <li key={href}>
                  <Link href={href} className="block rounded px-2 py-1 hover:bg-slate-100">{label}</Link>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[10px] leading-4 text-slate-400">
              Rule data is source-verified but not yet dual-sign-off verified. Not for live filing.
            </p>
          </nav>
          <div className="min-w-0 flex-1 p-6">{children}</div>
        </div>
      </body>
    </html>
  );
}
