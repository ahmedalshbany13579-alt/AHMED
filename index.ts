import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const readDefaultKey = (raw: string | undefined): string => {
    if (!raw) return ''
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return String(parsed.default ?? Object.values(parsed)[0] ?? '')
    } catch { /* Legacy key values are plain strings. */ }
    return raw
  }
  // Supabase is migrating to named publishable/secret keys. Keep legacy fallbacks for older projects.
  const publishable = readDefaultKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')) ||
    Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || ''
  const serviceKey = readDefaultKey(Deno.env.get('SUPABASE_SECRET_KEYS')) ||
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!url || !publishable || !serviceKey) return reply({ error: 'Supabase default publishable/secret keys were not injected into this Edge Function environment' }, 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return reply({ error: 'Unauthorized' }, 401)

  const caller = createClient(url, publishable, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await caller.auth.getUser()
  if (userError || !userData.user) return reply({ error: 'Invalid user session' }, 401)

  const { data: profile, error: profileError } = await caller
    .schema('shaibani_erp').from('profiles').select('role,is_active').eq('id', userData.user.id).maybeSingle()
  if (profileError || !profile || !profile.is_active || profile.role !== 'manager') {
    return reply({ error: 'Only an active manager can invite employees' }, 403)
  }

  let payload: { email?: string; full_name?: string; role?: string }
  try { payload = await req.json() } catch { return reply({ error: 'Invalid JSON body' }, 400) }
  const email = String(payload.email ?? '').trim().toLowerCase()
  const fullName = String(payload.full_name ?? '').trim().slice(0, 120)
  const role = String(payload.role ?? 'cashier')
  if (!/^\S+@\S+\.\S+$/.test(email) || !fullName) return reply({ error: 'Enter a valid email and employee name' }, 400)
  if (!['manager', 'accountant', 'cashier'].includes(role)) return reply({ error: 'Invalid employee role' }, 400)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
  })
  if (inviteError || !invited.user) return reply({ error: inviteError?.message ?? 'Could not invite user' }, 400)

  const { error: upsertError } = await admin.schema('shaibani_erp').from('profiles').upsert({
    id: invited.user.id,
    full_name: fullName,
    role,
    is_active: true,
  }, { onConflict: 'id' })
  if (upsertError) return reply({ error: `Invitation sent but profile update failed: ${upsertError.message}` }, 500)

  return reply({ ok: true, user_id: invited.user.id, email })
})
