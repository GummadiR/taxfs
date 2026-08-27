/** The acting auth user for this request, or null when signed out. */
import { LOCAL_OPERATOR_UUID, localOperatorMode, supabaseConfigured } from './env';
import { supabaseServer } from '@/lib/supabase/server';

export async function authUserId(): Promise<string | null> {
  if (localOperatorMode()) return LOCAL_OPERATOR_UUID;
  if (!supabaseConfigured()) return null;
  const supabase = await supabaseServer();
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}
