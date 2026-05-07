/**
 * /api/admin.js — Vercel Serverless Function
 *
 * Handles admin-level operations that require the Supabase service_role key.
 *
 * The service_role key is available ONLY here, as a server-side environment
 * variable set in the Vercel dashboard. It is never sent to or accessible
 * by the browser under any circumstances.
 *
 * ── Security model ─────────────────────────────────────────────────────
 *   1. Every request must carry a valid Supabase JWT in the Authorization
 *      header: "Authorization: Bearer <token>"
 *   2. The JWT is verified by Supabase's auth.getUser() — confirms the
 *      token is genuine and unexpired.
 *   3. The verified user's ID is used to look up their profile row with
 *      the SERVICE client (bypasses RLS, cannot be blocked by policy bugs),
 *      confirming role = 'admin'.
 *   4. Only after both checks pass is any admin operation performed.
 *
 * ── Environment variables (Vercel dashboard → Settings → Environment) ─
 *   SUPABASE_URL              — your project URL
 *   SUPABASE_ANON_KEY         — public anon key (same value the frontend uses)
 *   SUPABASE_SERVICE_ROLE_KEY — secret service key (NEVER expose to the browser)
 *   ALLOWED_ORIGIN            — your domain e.g. https://bench.yourbusiness.com.au
 *
 * ── Supported POST actions ─────────────────────────────────────────────
 *   { action: 'invite', email, name, role }
 *   { action: 'remove', userId }
 */

import { createClient } from '@supabase/supabase-js';

/* ── CORS ──────────────────────────────────────────────────────────────
 * Lock requests to your own domain.
 * Set ALLOWED_ORIGIN in Vercel env vars → e.g. https://bench.yourbusiness.com.au
 * Falls back to '*' only if unset, which is acceptable during Vercel
 * preview deployments before your custom domain is connected.
 * ---------------------------------------------------------------------- */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/* ── CLIENT FACTORIES ──────────────────────────────────────────────────
 * Fresh clients are built per-request rather than cached at module level.
 * Vercel can share module state across warm invocations, and caching auth
 * clients risks leaking session state between unrelated requests.
 * The performance cost is negligible compared to network round-trips.
 * ---------------------------------------------------------------------- */

/**
 * Anon client — used ONLY to verify the caller's JWT.
 * Has the same RLS access as any authenticated browser user.
 */
function makeAnonClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  );
}

/**
 * Service-role client — bypasses RLS entirely.
 * ONLY instantiated after the caller has been verified as an admin.
 * Never returned to the caller or referenced outside this file.
 */
function makeServiceClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  );
}

/* ── AUTH GUARD ────────────────────────────────────────────────────────
 * Verifies the JWT and confirms the caller is an admin.
 * Returns the verified Supabase user object on success.
 * Throws a structured { status, message } object on any failure —
 * caught by the main handler and returned as a JSON error response.
 * ---------------------------------------------------------------------- */
async function requireAdmin(req) {
  // Step 1: extract the Bearer token
  const authHeader = (req.headers['authorization'] || '').trim();

  if (!authHeader.startsWith('Bearer ')) {
    throw { status: 401, message: 'Missing or malformed Authorization header.' };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw { status: 401, message: 'Authorization token is empty.' };
  }

  // Step 2: verify the JWT with Supabase
  // auth.getUser(token) validates the token signature and expiry server-side.
  const { data: { user }, error: authError } = await makeAnonClient().auth.getUser(token);

  if (authError || !user?.id) {
    // Deliberately vague — don't reveal whether token was malformed vs expired
    throw { status: 401, message: 'Invalid or expired session. Please sign in again.' };
  }

  // Step 3: confirm admin role using the service client
  // Using the service client here (not anon) means this check cannot be
  // blocked by a misconfigured RLS policy. The user ID comes from the
  // verified JWT — not from user input — so there is no injection risk.
  const { data: profile, error: profileError } = await makeServiceClient()
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    console.error(`[admin] Profile lookup error for user ${user.id}:`, profileError.message);
    throw { status: 500, message: 'Could not verify user permissions.' };
  }

  if (!profile) {
    throw { status: 403, message: 'No profile found for this account.' };
  }

  if (profile.role !== 'admin') {
    throw { status: 403, message: 'Admin access required.' };
  }

  return user;
}

/* ── RESPONSE HELPER ───────────────────────────────────────────────────*/

function sendJSON(res, status, body) {
  res.status(status).json(body);
}

/* ── ACTION: invite ────────────────────────────────────────────────────
 * Sends a Supabase Auth invitation email to a new user.
 * The handle_new_user() DB trigger (schema.sql) creates their profile row
 * automatically when they accept and complete sign-up.
 * ---------------------------------------------------------------------- */
async function handleInvite(body, res) {
  const { email, name, role } = body;

  // Input validation — never trust client-supplied data
  if (typeof email !== 'string' || !email.trim()) {
    return sendJSON(res, 400, { error: 'A valid email address is required.' });
  }
  if (typeof name !== 'string' || !name.trim()) {
    return sendJSON(res, 400, { error: 'A name is required.' });
  }
  // Whitelist roles explicitly — ignore any other value
  if (!['admin', 'staff'].includes(role)) {
    return sendJSON(res, 400, { error: 'Role must be "admin" or "staff".' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const { data, error } = await makeServiceClient().auth.admin.inviteUserByEmail(
    normalizedEmail,
    { data: { name: name.trim(), role } }
  );

  if (error) {
    const isExisting =
      error.message?.toLowerCase().includes('already registered') ||
      error.message?.toLowerCase().includes('already been invited');

    const msg = isExisting
      ? 'A user with that email address already exists.'
      : 'Failed to send the invitation. Please try again.';

    console.error(`[admin] inviteUserByEmail failed for ${normalizedEmail}:`, error.message);
    return sendJSON(res, 400, { error: msg });
  }

  console.log(`[admin] Invitation sent → ${normalizedEmail} (role: ${role})`);
  return sendJSON(res, 200, { id: data.user?.id ?? null });
}

/* ── ACTION: remove ────────────────────────────────────────────────────
 * Permanently deletes a user from auth.users.
 * The profiles row cascades automatically via the FK defined in schema.sql.
 * ---------------------------------------------------------------------- */
async function handleRemove(body, callerUser, res) {
  const { userId } = body;

  if (typeof userId !== 'string' || !userId.trim()) {
    return sendJSON(res, 400, { error: 'userId is required.' });
  }

  // Prevent an admin from deleting their own account — this would break the
  // session immediately and could leave the system without any admin.
  if (userId.trim() === callerUser.id) {
    return sendJSON(res, 400, { error: 'You cannot remove your own account.' });
  }

  const { error } = await makeServiceClient().auth.admin.deleteUser(userId.trim());

  if (error) {
    console.error(`[admin] deleteUser failed for ${userId}:`, error.message);
    return sendJSON(res, 400, { error: 'Failed to remove user. Please try again.' });
  }

  console.log(`[admin] User ${userId} removed by admin ${callerUser.id}`);
  return sendJSON(res, 200, { removed: true });
}

/* ── MAIN HANDLER ──────────────────────────────────────────────────────*/

export default async function handler(req, res) {
  // CORS headers must be set on every response, including errors
  setCorsHeaders(res);

  // Handle browser preflight (OPTIONS) — required for cross-origin POSTs
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Only POST is accepted
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method not allowed.' });
  }

  // Validate environment — missing vars mean a deployment misconfiguration,
  // not a user error. Log clearly on the server side.
  const missingEnv = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(k => !process.env[k]);

  if (missingEnv.length) {
    console.error(`[admin] Missing environment variables: ${missingEnv.join(', ')}`);
    return sendJSON(res, 500, { error: 'Server configuration error.' });
  }

  // Vercel parses JSON bodies automatically, but guard against
  // malformed or missing bodies defensively.
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { action } = body;

  if (!action || typeof action !== 'string') {
    return sendJSON(res, 400, { error: 'Request body must include an "action" field.' });
  }

  try {
    // Auth guard — throws a structured error on any auth/permission failure
    const callerUser = await requireAdmin(req);

    switch (action) {
      case 'invite':
        return await handleInvite(body, res);

      case 'remove':
        // callerUser passed so handleRemove can block self-deletion
        return await handleRemove(body, callerUser, res);

      default:
        return sendJSON(res, 400, { error: `Unknown action: "${action}".` });
    }

  } catch (err) {
    // Structured error thrown by requireAdmin
    if (err.status && err.message) {
      return sendJSON(res, err.status, { error: err.message });
    }
    // Unexpected runtime error — log full details server-side only
    console.error('[admin] Unexpected error:', err);
    return sendJSON(res, 500, { error: 'An unexpected error occurred.' });
  }
}
