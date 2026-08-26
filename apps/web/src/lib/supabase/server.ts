/**
 * Server-side Supabase client, acting AS THE AUTHENTICATED USER via the
 * request's cookies (Blueprint §4: the app never connects as table owner and
 * never holds the service-role key on request paths — RLS is the wall).
 * Returns null when auth is not configured (local skeleton mode) so public
 * pages never crash on missing env.
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function authConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export async function supabaseServer() {
  if (!authConfigured()) return null;
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
          } catch {
            // Server Components cannot set cookies; middleware refreshes sessions.
          }
        },
      },
    },
  );
}
