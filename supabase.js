/**
 * supabase.js — Data layer for Bench
 *
 * All database interaction lives here. The rest of the app calls
 * these functions and never touches Supabase directly.
 *
 * Environment variables are injected by Vercel at build time via
 * a thin config script (see index.html). They are never hard-coded.
 */

/* ── CLIENT ─────────────────────────────────────────────────────── */

/**
 * Lazily initialise the Supabase client.
 * Throws a clear error if the env vars are missing (dev misconfiguration).
 */
function getClient() {
  const url = window.__BENCH_CONFIG__?.supabaseUrl;
  const key = window.__BENCH_CONFIG__?.supabaseAnonKey;

  if (!url || !key) {
    throw new Error(
      'Supabase credentials are missing. ' +
      'Ensure SUPABASE_URL and SUPABASE_ANON_KEY are set in your Vercel environment.'
    );
  }

  // Re-use a single instance (createClient is idempotent given the same args)
  if (!window.__supabaseClient__) {
    window.__supabaseClient__ = supabase.createClient(url, key);
  }
  return window.__supabaseClient__;
}

/* ── AUTH ────────────────────────────────────────────────────────── */

export async function signIn(email, password) {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  const { error } = await getClient().auth.signOut();
  if (error) throw error;
}

/**
 * Update the current user's password.
 * Called after Supabase redirects back with a recovery token — by that
 * point the client already has a session, so updateUser works directly.
 */
export async function resetPassword(newPassword) {
  const { error } = await getClient().auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await getClient().auth.getSession();
  if (error) throw error;
  return data.session;
}

/**
 * Returns the current user's JWT access token.
 * Used to authenticate calls to server-side API endpoints.
 * The token is a standard JWT — it does not grant service_role access.
 */
export async function getSessionToken() {
  const { data, error } = await getClient().auth.getSession();
  if (error || !data.session) throw new Error('No active session.');
  return data.session.access_token;
}

export async function getCurrentProfile() {
  const { data: { user }, error: authError } = await getClient().auth.getUser();
  if (authError || !user) return null;

  const { data, error } = await getClient()
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (error) throw error;
  return data;
}

/* ── Admin API calls (server-side, via /api/admin) ───────────────────
 *
 * These functions call the Vercel serverless function at /api/admin.
 * That function uses the service_role key, which lives ONLY on the server.
 * The browser never sees or sends the service_role key.
 *
 * The user's JWT is sent as a Bearer token so the server can verify
 * the caller is authenticated and has the admin role.
 */

async function callAdminApi(body) {
  const token = await getSessionToken();
  const res   = await fetch('/api/admin', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    // Surface the server's error message cleanly
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return data;
}

/** Admin only — invite a new user. Calls /api/admin server-side. */
export async function inviteUser(email, name, role) {
  return callAdminApi({ action: 'invite', email, name, role });
}

/** Admin only — permanently remove a user. Calls /api/admin server-side. */
export async function removeUser(userId) {
  return callAdminApi({ action: 'remove', userId });
}

export async function listUsers() {
  const { data, error } = await getClient()
    .from('profiles')
    .select('*')
    .order('name');
  if (error) throw error;
  return data;
}

/* ── LISTS ───────────────────────────────────────────────────────── */

export async function getLists() {
  const { data, error } = await getClient()
    .from('lists')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) throw error;
  return data;
}

export async function updateLists(patch) {
  const { error } = await getClient()
    .from('lists')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) throw error;
}

/* ── JOBS ────────────────────────────────────────────────────────── */

/**
 * Column names the DB accepts for ordering.
 * Validated here so user-controlled sort values can never reach the query raw.
 */
const SORT_COLUMN_MAP = {
  created:  'created_at',
  due:      'due',
  client:   'client_name',
  status:   'status',
  location: 'location',
  staff:    'staff',
  type:     'type',
  num:      'num',
};

/**
 * Fetch one page of jobs from the server.
 *
 * All filtering, sorting, and pagination happen in Postgres — nothing is
 * loaded into the browser that isn't actually displayed.
 *
 * @param {object} params
 * @param {string[]} params.closedStatuses   - list of statuses that count as "closed"
 * @param {'open'|'closed'|'all'} params.ocFilter
 * @param {string}  params.search            - full-text search string (client-side ilike)
 * @param {string}  params.status
 * @param {string}  params.location
 * @param {string}  params.type
 * @param {string}  params.staff
 * @param {string}  params.sortField         - key from SORT_COLUMN_MAP
 * @param {boolean} params.sortAsc
 * @param {number}  params.page              - 0-indexed
 * @param {number}  params.pageSize
 */
export async function getJobs({
  closedStatuses = [],
  ocFilter       = 'open',
  search         = '',
  status         = '',
  location       = '',
  type           = '',
  staff          = '',
  sortField      = 'created',
  sortAsc        = false,
  page           = 0,
  pageSize       = 25,
} = {}) {
  const col = SORT_COLUMN_MAP[sortField] ?? 'created_at';

  let q = getClient()
    .from('jobs')
    .select(`
      id, num, created_at, client_name, client_contact,
      reference, type, status, location, staff, due, description,
      job_photos ( id, url )
    `)
    .order(col, { ascending: sortAsc })
    // Nulls last for due-date sort so undated jobs sink to the bottom
    .order('created_at', { ascending: false });

  // ── Open / closed filter ──────────────────────────────────────────
  if (ocFilter === 'open' && closedStatuses.length) {
    q = q.not('status', 'in', `(${closedStatuses.map(s => `"${s}"`).join(',')})`);
  } else if (ocFilter === 'closed' && closedStatuses.length) {
    q = q.in('status', closedStatuses);
  }

  // ── Dropdown filters ──────────────────────────────────────────────
  if (status)   q = q.eq('status',   status);
  if (location) q = q.eq('location', location);
  if (type)     q = q.eq('type',     type);
  if (staff)    q = q.eq('staff',    staff);

  // ── Full-text search (ilike across key columns) ───────────────────
  // Supabase doesn't support multi-column OR with a single .ilike(), so we
  // use .or() with explicit column list. This is indexed-friendly on short
  // strings and correct for the scale of a workshop management app.
  if (search.trim()) {
    const s = search.trim().replace(/[%_]/g, '\\$&'); // escape wildcards
    q = q.or(
      [
        `num.ilike.%${s}%`,
        `client_name.ilike.%${s}%`,
        `client_contact.ilike.%${s}%`,
        `reference.ilike.%${s}%`,
        `description.ilike.%${s}%`,
        `type.ilike.%${s}%`,
        `status.ilike.%${s}%`,
        `location.ilike.%${s}%`,
        `staff.ilike.%${s}%`,
      ].join(',')
    );
  }

  // ── Pagination ────────────────────────────────────────────────────
  const from = page * pageSize;
  const to   = from + pageSize - 1;
  q = q.range(from, to);

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/**
 * Return the total count matching the same filters as getJobs().
 * Uses Supabase's { count: 'exact', head: true } — fetches zero rows.
 */
export async function getJobCount({
  closedStatuses = [],
  ocFilter       = 'open',
  search         = '',
  status         = '',
  location       = '',
  type           = '',
  staff          = '',
} = {}) {
  let q = getClient()
    .from('jobs')
    .select('id', { count: 'exact', head: true });

  if (ocFilter === 'open' && closedStatuses.length) {
    q = q.not('status', 'in', `(${closedStatuses.map(s => `"${s}"`).join(',')})`);
  } else if (ocFilter === 'closed' && closedStatuses.length) {
    q = q.in('status', closedStatuses);
  }

  if (status)   q = q.eq('status',   status);
  if (location) q = q.eq('location', location);
  if (type)     q = q.eq('type',     type);
  if (staff)    q = q.eq('staff',    staff);

  if (search.trim()) {
    const s = search.trim().replace(/[%_]/g, '\\$&');
    q = q.or(
      [
        `num.ilike.%${s}%`,
        `client_name.ilike.%${s}%`,
        `client_contact.ilike.%${s}%`,
        `reference.ilike.%${s}%`,
        `description.ilike.%${s}%`,
        `type.ilike.%${s}%`,
        `status.ilike.%${s}%`,
        `location.ilike.%${s}%`,
        `staff.ilike.%${s}%`,
      ].join(',')
    );
  }

  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function getJob(id) {
  const { data, error } = await getClient()
    .from('jobs')
    .select(`
      *,
      job_photos ( id, url, storage_path ),
      comments (
        id, body, created_at,
        profiles ( id, name ),
        comment_photos ( id, url, storage_path )
      )
    `)
    .eq('id', id)
    .order('created_at', { ascending: true, foreignTable: 'comments' })
    .single();

  if (error) throw error;
  return data;
}

export async function createJob(fields, createdBy) {
  const { data, error } = await getClient()
    .from('jobs')
    .insert({
      // num is auto-set by DB trigger
      client_name:    fields.clientName,
      client_contact: fields.clientContact || null,
      reference:      fields.reference     || null,
      type:           fields.type,
      status:         fields.status,
      location:       fields.location,
      staff:          fields.staff         || null,
      due:            fields.due           || null,
      description:    fields.description,
      created_by:     createdBy,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateJob(id, fields) {
  // Only send the columns we explicitly want to change
  const patch = {};
  const map = {
    clientName:    'client_name',
    clientContact: 'client_contact',
    reference:     'reference',
    type:          'type',
    status:        'status',
    location:      'location',
    staff:         'staff',
    due:           'due',
    description:   'description',
  };
  for (const [jsKey, dbCol] of Object.entries(map)) {
    if (jsKey in fields) patch[dbCol] = fields[jsKey] || null;
  }

  // Track who made the last change — updated_at is handled by the DB trigger
  if (fields.updatedBy) patch.updated_by = fields.updatedBy;

  const { error } = await getClient()
    .from('jobs')
    .update(patch)
    .eq('id', id);

  if (error) throw error;
}

export async function bulkUpdateJobs(ids, fields) {
  const patch = {};
  if (fields.status)   patch.status   = fields.status;
  if (fields.location) patch.location = fields.location;
  if (fields.staff)    patch.staff    = fields.staff;
  if (fields.due)      patch.due      = fields.due;

  if (Object.keys(patch).length === 0 && !fields.comment) return;

  if (Object.keys(patch).length > 0) {
    const { error } = await getClient()
      .from('jobs')
      .update(patch)
      .in('id', ids);
    if (error) throw error;
  }

  // Add comment to each job if provided
  if (fields.comment && fields.authorId) {
    const commentRows = ids.map(jobId => ({
      job_id:    jobId,
      author_id: fields.authorId,
      body:      fields.comment,
    }));
    const { error } = await getClient()
      .from('comments')
      .insert(commentRows);
    if (error) throw error;
  }
}

/* ── PHOTOS ──────────────────────────────────────────────────────── */

const BUCKET = 'job-photos';

// Signed URL lifetime in seconds.
// 1 hour is long enough for a working session; short enough that a
// leaked URL becomes useless quickly.
const SIGNED_URL_TTL = 3600;

/**
 * Upload a File object to Supabase Storage.
 * The bucket is PRIVATE — no public URL is generated.
 * Returns the storage path only; signed URLs are generated on demand.
 *
 * Path structure: {jobId}/{uuid}.{ext}
 */
export async function uploadPhoto(file, jobId) {
  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${jobId}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await getClient()
    .storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });

  if (uploadError) throw uploadError;

  // Return path only — no public URL exists for a private bucket
  return { path };
}

/**
 * Generate a short-lived signed URL for a single storage path.
 * Requires an active authenticated session — unauthenticated callers
 * will receive an error from Supabase before a URL is issued.
 *
 * @param {string} storagePath  - the path stored in job_photos.storage_path
 * @returns {Promise<string>}   - a signed URL valid for SIGNED_URL_TTL seconds
 */
export async function getSignedUrl(storagePath) {
  const { data, error } = await getClient()
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL);

  if (error) throw error;
  return data.signedUrl;
}

/**
 * Generate signed URLs for an array of photos in a single batch call.
 * Returns the same array with a `signedUrl` field added to each item.
 * Photos that fail signing are excluded rather than breaking the whole set.
 *
 * @param {Array<{id, storage_path, ...}>} photos
 * @returns {Promise<Array>}
 */
export async function getSignedUrls(photos) {
  if (!photos.length) return [];

  const paths = photos.map(p => p.storage_path);

  const { data, error } = await getClient()
    .storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);

  if (error) throw error;

  // Map signed URLs back to the original photo objects by index
  return photos.map((photo, i) => ({
    ...photo,
    signedUrl: data[i]?.signedUrl ?? null,
  })).filter(p => p.signedUrl !== null);
}

export async function attachJobPhoto(jobId, storagePath, uploadedBy) {
  // url column removed — we no longer store public URLs in the DB.
  // Signed URLs are generated fresh each time a job is opened.
  const { error } = await getClient()
    .from('job_photos')
    .insert({ job_id: jobId, storage_path: storagePath, uploaded_by: uploadedBy });
  if (error) throw error;
}

export async function attachCommentPhoto(commentId, storagePath) {
  const { error } = await getClient()
    .from('comment_photos')
    .insert({ comment_id: commentId, storage_path: storagePath });
  if (error) throw error;
}

export async function deletePhoto(storagePath, jobPhotoId) {
  // Remove from storage first, then remove the metadata row.
  // If storage removal fails, we leave the DB row so re-attempts are possible.
  const { error: storageError } = await getClient()
    .storage
    .from(BUCKET)
    .remove([storagePath]);

  if (storageError) throw storageError;

  if (jobPhotoId) {
    const { error } = await getClient()
      .from('job_photos')
      .delete()
      .eq('id', jobPhotoId);
    if (error) throw error;
  }
}

/* ── COMMENTS ────────────────────────────────────────────────────── */

export async function addComment(jobId, authorId, body) {
  const { data, error } = await getClient()
    .from('comments')
    .insert({ job_id: jobId, author_id: authorId, body })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* ── SAVED VIEWS ─────────────────────────────────────────────────── */

export async function getSavedViews(userId) {
  const { data, error } = await getClient()
    .from('saved_views')
    .select('*')
    .eq('user_id', userId)
    .order('created_at');
  if (error) throw error;
  return data;
}

export async function saveView(userId, name, filters) {
  const { data, error } = await getClient()
    .from('saved_views')
    .insert({ user_id: userId, name, filters })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteView(id) {
  const { error } = await getClient()
    .from('saved_views')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

/* ── APPEARANCE ──────────────────────────────────────────────────── */

export async function getAppearance(userId) {
  const { data, error } = await getClient()
    .from('appearance')
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.settings ?? null;
}

export async function saveAppearance(userId, settings) {
  const { error } = await getClient()
    .from('appearance')
    .upsert({ user_id: userId, settings, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function getDefaultAppearance() {
  // Stored against a sentinel user_id convention, or a separate table row.
  // Simplest approach: admin saves a well-known key in localStorage as fallback.
  // Full implementation: add a `default_appearance` column to `lists`.
  const { data, error } = await getClient()
    .from('lists')
    .select('default_appearance')
    .eq('id', 1)
    .maybeSingle();
  if (error) return null;
  return data?.default_appearance ?? null;
}

/* ── API TOKENS ──────────────────────────────────────────────────── */

export async function getApiTokens() {
  const { data, error } = await getClient()
    .from('api_tokens')
    .select('id, label, created_at, revoked_at, last_used_at, created_by')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Generate a new token.
 * The raw token is shown to the user once and then discarded.
 * Only the SHA-256 hash is stored.
 */
export async function generateApiToken(label, createdBy) {
  const rawToken = 'bk_' + Array.from(
    crypto.getRandomValues(new Uint8Array(32))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const encoder  = new TextEncoder();
  const hashBuf  = await crypto.subtle.digest('SHA-256', encoder.encode(rawToken));
  const hashHex  = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const { data, error } = await getClient()
    .from('api_tokens')
    .insert({ label, token_hash: hashHex, created_by: createdBy })
    .select()
    .single();

  if (error) throw error;
  // Return the raw token so we can show it once to the user
  return { ...data, rawToken };
}

export async function revokeApiToken(id) {
  const { error } = await getClient()
    .from('api_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteApiToken(id) {
  const { error } = await getClient()
    .from('api_tokens')
    .delete()
    .eq('id', id);
  if (error) throw error;
}
