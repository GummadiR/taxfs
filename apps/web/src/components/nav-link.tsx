'use client';

/**
 * A nav item that SHOWS it was clicked — ported from TaxOS.
 *
 * Section pages render on the server (they read the spine, the rule data and
 * the gate state), so a click can take a beat. With a plain link nothing
 * changes on screen in that beat: the old page just sits there, the honest
 * read is "my click didn't land", and the natural response is to click again
 * — which only queues more work and makes it slower.
 *
 * Three things change the moment a link is pressed, all driven by Next's
 * useLinkStatus (which reports the pending state of its nearest parent Link,
 * so this component MUST render inside one):
 *   - a spinner appears next to the label being opened,
 *   - that row highlights, so it is obvious WHICH section is coming,
 *   - the row is marked aria-busy for screen readers.
 * The current section is marked too — half the confusion is not being able
 * to tell where you already are.
 */
import Link from 'next/link';
import { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Sidebar links opt OUT of prefetching (TaxOS P88). Every page here is
 * per-request dynamic, so there is nothing cacheable to warm up, while
 * prefetching every sidebar link on mount — and again after every server
 * action's revalidation — costs a request storm in the production build
 * only, which is exactly where no dev-mode test would see it.
 */
const PREFETCH = false;

function Spinner() {
  return (
    <span
      aria-hidden
      data-testid="nav-spinner"
      className="ml-1 inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-sky-300 border-t-sky-700"
    />
  );
}

/** The row body. Inside <Link>, so it can read the link's pending state. */
function Row({ label, badge, active }: { label: ReactNode; badge?: ReactNode; active: boolean }) {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      className={[
        'flex items-center justify-between gap-1 rounded px-2 py-1',
        pending ? 'bg-sky-100 ring-1 ring-sky-300' : '',
        active && !pending ? 'bg-slate-100 font-semibold' : '',
      ].join(' ')}
    >
      <span className="flex min-w-0 items-center">
        <span className="truncate">{label}</span>
        {pending ? <Spinner /> : null}
      </span>
      {badge}
    </span>
  );
}

export function NavLink({
  href, label, badge, title, testid,
}: {
  href: string; label: ReactNode; badge?: ReactNode; title?: string; testid?: string;
}) {
  const pathname = usePathname();
  // "/" must match exactly; every other section also owns its subpaths.
  const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      prefetch={PREFETCH}
      title={title}
      data-testid={testid}
      aria-current={active ? 'page' : undefined}
      className="block rounded hover:bg-slate-100"
    >
      <Row label={label} badge={badge} active={active} />
    </Link>
  );
}

/** The workspace chip and the wordmark are links too, and were equally silent. */
export function PlainNavLink({
  href, children, className, title, testid,
}: {
  href: string; children: ReactNode; className?: string; title?: string; testid?: string;
}) {
  return (
    <Link href={href} prefetch={PREFETCH} title={title} data-testid={testid} className={className}>
      <PlainBody>{children}</PlainBody>
    </Link>
  );
}

function PlainBody({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-busy={pending || undefined} className={pending ? 'opacity-60' : undefined}>
      {children}
      {pending ? <Spinner /> : null}
    </span>
  );
}
