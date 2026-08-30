import { buildInfo } from '@/server/build-info';
import type { Metadata } from 'next';
import './globals.css';
import { NavLink, PlainNavLink } from '@/components/nav-link';
import { maybeContext } from '@/server/context';
import { navStatus, type NavTone } from '@/server/nav-status';

export const metadata: Metadata = {
  title: 'TaxFS',
  description: 'E-file-ready personal tax return packages. Computes, validates, explains, prints — never transmits.',
};

// Every page is per-request (cookie-selected workspace, database-backed).
// Root-level so no route is ever prerendered against a live database at
// build time (the TaxOS P64 lesson).
export const dynamic = 'force-dynamic';

// Badge colours by tone (TaxOS P65). Blocked and attention are the two that
// should pull the eye; ok and idle stay quiet so the nav does not become noise.
const TONE_CLASS: Record<NavTone, string> = {
  blocked: 'bg-red-100 text-red-800',
  attention: 'bg-amber-100 text-amber-900',
  ok: 'bg-green-100 text-green-800',
  idle: 'bg-slate-100 text-slate-500',
};

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
  ['/year-round', '11 · Year-Round'],
  ['/risk', '12 · Audit Readiness'],
  ['/amend', '13 · Amend'],
  ['/entities', '14 · Entities'],
  ['/business', '15 · Business Filing'],
  ['/agents', 'Agent traces'],
  ['/workspaces', 'Workspaces'],
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const build = buildInfo();
  // Whose return is every page showing? Best-effort — never blocks the chrome.
  const ctx = await maybeContext();
  // What each step is waiting for. Also best-effort: no badges beats no page.
  const status = ctx ? await navStatus(ctx.userId, ctx.ws.workspace_id) : {};
  return (
    <html lang="en">
      <body className="bg-white text-slate-900">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:bg-white focus:p-2">
          Skip to content
        </a>
        <div className="mx-auto flex min-h-screen max-w-5xl">
          <nav aria-label="Sections" className="w-52 shrink-0 border-r border-slate-200 p-4">
            <PlainNavLink href="/" className="block text-lg font-black tracking-tight">TaxFS</PlainNavLink>
            {ctx ? (
              <PlainNavLink href="/workspaces"
                title="Every section shows this workspace's return. Click to switch."
                className="mb-3 mt-1 block truncate rounded bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-900"
                testid="active-workspace">
                {ctx.ws.display_name} <span className="font-normal text-indigo-400">· switch</span>
              </PlainNavLink>
            ) : (
              <span className="mb-3 block" />
            )}
            <ul className="space-y-1 text-sm">
              {NAV.map(([href, label]) => {
                const st = status[href];
                return (
                  <li key={href}>
                    <NavLink
                      href={href}
                      label={label}
                      {...(st ? { title: st.hint } : {})}
                      {...(st ? {
                        badge: (
                          <span
                            className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold ${TONE_CLASS[st.tone]}`}
                            data-testid={`nav-status-${href.slice(1)}`}
                          >
                            {st.badge}
                          </span>
                        ),
                      } : {})}
                    />
                  </li>
                );
              })}
            </ul>
            <p className="mt-6 text-[10px] leading-4 text-slate-400">
              Rule data is source-verified but not yet dual-sign-off verified. Not for live filing.
            </p>
            {build ? (
              <p className="mt-2 font-mono text-[10px] leading-4 text-slate-400" data-testid="build-stamp"
                title="The exact build this app is running. Quote it when reporting a problem — it says whether a fix has reached this machine.">
                build {build.commit}{build.branch ? ` · ${build.branch}` : ''}
              </p>
            ) : null}
          </nav>
          <div id="main" className="min-w-0 flex-1 p-6">{children}</div>
        </div>
      </body>
    </html>
  );
}
