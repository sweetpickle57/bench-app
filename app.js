/**
 * app.js — Bench UI logic
 *
 * Responsibilities:
 *   - Auth state management  
 *   - Page routing
 *   - DOM rendering (targeted, not full re-renders)
 *   - Event delegation (zero inline handlers in HTML)
 *   - Calls supabase.js for all data operations
 *
 * What this file does NOT do:
 *   - Touch Supabase directly
 *   - Store passwords
 *   - Use localStorage (except appearance fallback)
 */

import * as DB from './supabase.js';

/* ── APP STATE ───────────────────────────────────────────────────── */

const state = {
  user:          null,   // { id, name, role, email }
  lists:         null,   // { statuses, closed_statuses, locations, types, staff }
  jobs:          [],     // current page of jobs from the server
  totalJobs:     0,      // total matching current filters (drives pagination)
  savedViews:    [],
  currentJobId:  null,
  commentFiles:  [],     // pending photo attachments for current comment
  bulkSelected:  new Set(),
  // ── filter / sort / pagination ─────────────────────────────────────
  ocFilter:      'open', // 'open' | 'closed' | 'all'
  sortField:     'created',
  sortAsc:       false,
  page:          0,
  pageSize:      25,
  activeChipId:  null,   // currently active saved-view chip id
  searchDebounce:  null,  // timer id for search debounce
  lightboxPhotos:  [],    // [{signedUrl, filename}] for the currently open job
  lightboxIndex:   0,     // which photo is currently shown in the lightbox
};

/* ── APPEARANCE CONSTANTS ────────────────────────────────────────── */

const THEMES = [
  { id: 'classic',  name: 'Classic',  desc: 'Warm gold',    swatches: ['#C9A84C','#1A1714','#FDFAF5'],
    vars: { accent:'#C9A84C', bg:'#FDFAF5', text:'#1A1714', nav:'#1A1714' } },
  { id: 'slate',    name: 'Slate',    desc: 'Cool grey',    swatches: ['#5B8DEF','#1E2330','#F4F6FA'],
    vars: { accent:'#5B8DEF', bg:'#F4F6FA', text:'#1E2330', nav:'#1E2330' } },
  { id: 'forest',   name: 'Forest',   desc: 'Deep green',   swatches: ['#4A8C6F','#1B2B24','#F2F7F4'],
    vars: { accent:'#4A8C6F', bg:'#F2F7F4', text:'#1B2B24', nav:'#1B2B24' } },
  { id: 'midnight', name: 'Midnight', desc: 'Dark mode',    swatches: ['#C9A84C','#0F1117','#1A1D27'],
    vars: { accent:'#C9A84C', bg:'#1A1D27', text:'#E8E4DD', nav:'#0F1117' } },
  { id: 'rose',     name: 'Rose',     desc: 'Warm pink',    swatches: ['#C96B8A','#2B1A1F','#FDF5F7'],
    vars: { accent:'#C96B8A', bg:'#FDF5F7', text:'#2B1A1F', nav:'#2B1A1F' } },
];

const FONTS = [
  { id: 'dmsans',   name: 'DM Sans',            desc: 'Default',   stack: "'DM Sans', sans-serif" },
  { id: 'inter',    name: 'Inter',               desc: 'Clean',     stack: "'Inter', sans-serif" },
  { id: 'lexend',   name: 'Lexend',              desc: 'Readable',  stack: "'Lexend', sans-serif" },
  { id: 'atkinson', name: 'Atkinson Hyperlegible',desc: 'Accessible',stack: "'Atkinson Hyperlegible', sans-serif" },
  { id: 'source',   name: 'Source Sans',          desc: 'Editorial', stack: "'Source Sans 3', sans-serif" },
  { id: 'system',   name: 'System',              desc: 'Device default', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
];

const SIZES = [
  { id: 'small',  label: 'Small',       desc: '13px', base: 13, sm: 11, lg: 15 },
  { id: 'medium', label: 'Medium',      desc: '14px', base: 14, sm: 12, lg: 16 },
  { id: 'large',  label: 'Large',       desc: '16px', base: 16, sm: 13, lg: 18 },
  { id: 'xlarge', label: 'Extra Large', desc: '18px', base: 18, sm: 15, lg: 20 },
];

let workingAppearance = {};

/* ── BOOT ────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  bindEventListeners();

  // Supabase puts the recovery token in the URL hash after a password-reset email.
  // We must handle this BEFORE checking for a normal session, because the hash
  // token is what establishes the temporary session used to update the password.
  const hash      = window.location.hash;
  const params    = new URLSearchParams(hash.replace(/^#/, ''));
  const tokenType = params.get('type');
  if (tokenType === 'recovery' || tokenType === 'invite') {
    // The Supabase client only reads the access_token out of the URL hash
    // once — the moment it's first created (detectSessionInUrl). It hasn't
    // been created yet at this point in boot, so we must force that to
    // happen now, BEFORE we clear the hash below. Previously this used a
    // blind 500ms timeout that never touched the client at all, so the
    // hash was wiped before anything read the token — hence
    // "Auth session missing!" on the reset-password screen.
    await DB.getSession().catch(() => null);
    history.replaceState(null, '', window.location.pathname);
    showScreen('reset');
    return;
  }

  // Check for an existing session
  const session = await DB.getSession().catch(() => null);
  if (session) {
    await bootApp();
  } else {
    showScreen('login');
  }
});

async function bootApp() {
  setLoadingOverlay(true, 'Loading Bench…');
  try {
    state.user  = await DB.getCurrentProfile();
    state.lists = await DB.getLists();

    state.savedViews = await DB.getSavedViews(state.user.id);

    renderTopbar();
    populateFilters();
    renderSavedViewChips();
    renderBulkFilters();
    await renderJobs();   // first server fetch — only current page

    if (state.user.role === 'admin') {
      document.getElementById('admin-nav-btn').removeAttribute('hidden');
      document.getElementById('bulk-nav-btn').removeAttribute('hidden');
    }

    showScreen('app');
    showPage('jobs');

    // Load and apply appearance
    const appearance = await DB.getAppearance(state.user.id).catch(() => null)
                     || await DB.getDefaultAppearance().catch(() => null)
                     || getDefaultAppearanceConfig();
    applyAppearance(appearance);

  } catch (err) {
    console.error('Boot error:', err);
    showScreen('login');
    setLoginError('Could not connect to the database. Please try again.');
  } finally {
    setLoadingOverlay(false);
  }
}

/* ── SCREENS & PAGES ─────────────────────────────────────────────── */

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(`${name}-screen`).classList.add('active');
}

function showPage(name) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === name);
  });
}

/* ── AUTH ────────────────────────────────────────────────────────── */

async function handleLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-pass').value;
  const btn      = document.getElementById('login-btn');

  clearLoginError();
  if (!email || !password) { setLoginError('Please enter your email and password.'); return; }

  btn.disabled   = true;
  btn.textContent = 'Signing in…';

  try {
    await DB.signIn(email, password);
    await bootApp();
  } catch (err) {
    setLoginError('Incorrect email or password.');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Sign in';
  }
}

async function handleLogout() {
  await DB.signOut().catch(() => {});
  state.user       = null;
  state.jobs       = [];
  state.lists      = null;
  state.savedViews = [];
  showScreen('login');
}

/* ── PASSWORD RESET ──────────────────────────────────────────────── */

async function handleResetPassword() {
  const pass    = document.getElementById('reset-pass').value;
  const confirm = document.getElementById('reset-pass-confirm').value;
  const btn     = document.getElementById('reset-btn');
  const errEl   = document.getElementById('reset-error');

  errEl.textContent = '';
  errEl.classList.remove('visible');

  if (!pass || pass.length < 6) {
    errEl.textContent = 'Password must be at least 6 characters.';
    errEl.classList.add('visible');
    return;
  }
  if (pass !== confirm) {
    errEl.textContent = 'Passwords do not match.';
    errEl.classList.add('visible');
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    await DB.resetPassword(pass);
    // Password updated — sign the user out cleanly and send them to login
    await DB.signOut().catch(() => {});
    showScreen('login');
    setLoginError('Password updated — please sign in with your new password.');
  } catch (err) {
    errEl.textContent = err.message || 'Could not update password. Please try again.';
    errEl.classList.add('visible');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Set new password';
  }
}

function setLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.add('visible');
}
function clearLoginError() {
  const el = document.getElementById('login-error');
  el.textContent = '';
  el.classList.remove('visible');
}

/* ── LOADING OVERLAY ─────────────────────────────────────────────── */

/**
 * Show/hide the full-screen loading overlay used during boot and
 * other long async operations. Provides a visual label so the
 * app never appears frozen.
 */
function setLoadingOverlay(visible, label = 'Loading…') {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  document.getElementById('loading-overlay-label').textContent = label;
  el.classList.toggle('active', visible);
}

/* ── INLINE BANNER (replaces alert/confirm for non-modal feedback) ── */

/**
 * Shows a dismissible banner inside a given container element.
 * Used instead of alert() so the user is never blocked by a native dialog.
 * @param {string} containerId  — element to prepend the banner into
 * @param {string} message      — message to show
 * @param {'error'|'success'|'info'} type
 */
function showBanner(containerId, message, type = 'error') {
  const container = document.getElementById(containerId);
  if (!container) { showToast(message); return; }

  // Remove any existing banner in this container
  container.querySelector('.inline-banner')?.remove();

  const div = document.createElement('div');
  div.className = `inline-banner inline-banner-${type}`;
  div.innerHTML = `<span>${esc(message)}</span>
    <button class="inline-banner-close" aria-label="Dismiss">×</button>`;
  div.querySelector('.inline-banner-close').addEventListener('click', () => div.remove());
  container.prepend(div);
  // Auto-dismiss success banners
  if (type === 'success') setTimeout(() => div.remove(), 4000);
}

/**
 * Non-blocking inline confirmation dialog.
 * Returns a Promise<boolean> — replaces native confirm() throughout.
 * Renders a small modal-style overlay with labelled confirm/cancel buttons.
 */
function showConfirm(message, confirmLabel = 'Confirm', variant = 'danger') {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-overlay');
    const msgEl   = document.getElementById('confirm-message');
    const yesBtn  = document.getElementById('confirm-yes-btn');
    const noBtn   = document.getElementById('confirm-no-btn');

    msgEl.textContent       = message;
    yesBtn.textContent      = confirmLabel;
    yesBtn.className        = `btn btn-sm btn-${variant === 'danger' ? 'danger' : 'gold'}`;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    const cleanup = () => {
      overlay.classList.remove('open');
      document.body.style.overflow = '';
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click',  onNo);
    };
    const onYes = () => { cleanup(); resolve(true);  };
    const onNo  = () => { cleanup(); resolve(false); };

    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click',  onNo);
  });
}

/* ── TOPBAR ──────────────────────────────────────────────────────── */

function renderTopbar() {
  const initials = state.user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('topbar-initials').textContent = initials;
  document.getElementById('topbar-username').textContent = state.user.name;
}

/* ── UTILITIES ───────────────────────────────────────────────────── */

/** Escape user-supplied strings before inserting into innerHTML */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function populateSelect(selectEl, items, allowEmpty = false, emptyLabel = '— none') {
  const current = selectEl.value;
  selectEl.innerHTML = '';
  if (allowEmpty) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = emptyLabel;
    selectEl.appendChild(opt);
  }
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    selectEl.appendChild(opt);
  });
  // Restore previous selection if still valid
  if (current && items.includes(current)) selectEl.value = current;
}

function isClosedStatus(status) {
  return (state.lists?.closed_statuses ?? []).includes(status);
}

function formatDue(dateStr) {
  const d    = new Date(dateStr + 'T00:00:00');
  const now  = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((d - now) / 86_400_000);
  const fmt  = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  if (diff < 0)  return `<span class="badge badge-overdue">${fmt}</span>`;
  if (diff <= 3) return `<span class="badge badge-due-soon">${fmt}</span>`;
  return `<span class="badge badge-ok">${fmt}</span>`;
}

/* ── FILTER DROPDOWNS ────────────────────────────────────────────── */

function populateFilters() {
  const L = state.lists;
  populateSelect(document.getElementById('filter-status'),   L.statuses,  true, 'All statuses');
  populateSelect(document.getElementById('filter-location'), L.locations, true, 'All locations');
  populateSelect(document.getElementById('filter-type'),     L.types,     true, 'All types');
  populateSelect(document.getElementById('filter-staff'),    L.staff,     true, 'All staff');
}

/* ── QUERY PARAMS HELPER ─────────────────────────────────────────── */

/**
 * Build the params object passed to DB.getJobs() / DB.getJobCount()
 * from current UI state. Single source of truth — used by both functions.
 */
function buildQueryParams() {
  return {
    closedStatuses: state.lists?.closed_statuses ?? [],
    ocFilter:       state.ocFilter,
    search:         document.getElementById('filter-search').value,
    status:         document.getElementById('filter-status').value,
    location:       document.getElementById('filter-location').value,
    type:           document.getElementById('filter-type').value,
    staff:          document.getElementById('filter-staff').value,
    sortField:      state.sortField,
    sortAsc:        state.sortAsc,
    page:           state.page,
    pageSize:       state.pageSize,
  };
}

function getGroupKey(j, groupField) {
  switch (groupField) {
    case 'status':    return j.status   || 'Unassigned';
    case 'location':  return j.location || 'No location';
    case 'staff':     return j.staff    || 'Unassigned';
    case 'type':      return j.type     || 'No type';
    case 'due_week': {
      if (!j.due) return 'No due date';
      const d   = new Date(j.due + 'T00:00:00');
      const mon = new Date(d);
      mon.setDate(d.getDate() - d.getDay() + 1);
      return 'Week of ' + mon.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
    }
    case 'due_month': {
      if (!j.due) return 'No due date';
      return new Date(j.due + 'T00:00:00').toLocaleDateString('en-AU', { month:'long', year:'numeric' });
    }
    default: return null;
  }
}

/* ── JOB TABLE RENDERING ─────────────────────────────────────────── */

/**
 * Fetch the current page from the server and render just the <tbody>.
 * Also fetches the total count so the pagination bar can be drawn.
 * Uses a DocumentFragment to minimise reflows.
 */
async function renderJobs() {
  const tbody      = document.getElementById('jobs-tbody');
  const groupField = document.getElementById('group-field').value;
  const params     = buildQueryParams();

  // Show loading state immediately so the user gets feedback
  tbody.innerHTML = `<tr class="loading-row"><td colspan="8"><div class="spinner"></div> Loading…</td></tr>`;

  try {
    // Run data fetch and count fetch in parallel
    const [jobs, total] = await Promise.all([
      DB.getJobs(params),
      DB.getJobCount(params),
    ]);

    state.jobs      = jobs;
    state.totalJobs = total;

  } catch (err) {
    console.error('Failed to fetch jobs:', err);
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <div class="empty-state-icon">⚠️</div>
      <div class="empty-state-title">Could not load jobs</div>
      <div class="empty-state-sub">Check your connection and try again</div>
    </div></td></tr>`;
    renderPagination();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(state.totalJobs / state.pageSize));
  const start      = state.totalJobs === 0 ? 0 : state.page * state.pageSize + 1;
  const end        = Math.min(start + state.pageSize - 1, state.totalJobs);

  document.getElementById('jobs-count').textContent =
    state.totalJobs === 0
      ? '0 jobs'
      : `${start}–${end} of ${state.totalJobs} job${state.totalJobs !== 1 ? 's' : ''}`;

  const frag = document.createDocumentFragment();

  if (state.jobs.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="8">
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No jobs found</div>
        <div class="empty-state-sub">Try adjusting your filters</div>
      </div>
    </td>`;
    frag.appendChild(tr);
    tbody.replaceChildren(frag);
    renderPagination();
    return;
  }

  if (groupField) {
    const groups = new Map();
    state.jobs.forEach(j => {
      const key = getGroupKey(j, groupField);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(j);
    });
    groups.forEach((jobs, key) => {
      const hdr = document.createElement('tr');
      hdr.className = 'group-header-row';
      hdr.innerHTML = `<td colspan="8">${esc(key)}<span class="group-count">(${jobs.length})</span></td>`;
      frag.appendChild(hdr);
      jobs.forEach(j => frag.appendChild(buildJobRow(j)));
    });
  } else {
    state.jobs.forEach(j => frag.appendChild(buildJobRow(j)));
  }

  tbody.replaceChildren(frag);
  renderPagination();
}

/* ── PAGINATION ──────────────────────────────────────────────────── */

function renderPagination() {
  const bar        = document.getElementById('pagination-bar');
  const totalPages = Math.max(1, Math.ceil(state.totalJobs / state.pageSize));
  const p          = state.page;

  // Page size selector reflects current state
  document.getElementById('page-size-select').value = String(state.pageSize);

  const frag = document.createDocumentFragment();

  // Previous button
  const prev = document.createElement('button');
  prev.className = 'pag-btn';
  prev.textContent = '← Prev';
  prev.disabled = p === 0;
  prev.dataset.action = 'pag-prev';
  frag.appendChild(prev);

  // Page number buttons — show up to 7, with ellipsis
  const pages = paginationRange(p, totalPages);
  pages.forEach(item => {
    if (item === '…') {
      const span = document.createElement('span');
      span.className = 'pag-ellipsis';
      span.textContent = '…';
      frag.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.className = `pag-btn${item === p ? ' pag-btn-active' : ''}`;
      btn.textContent = item + 1; // display 1-indexed
      btn.dataset.action = 'pag-goto';
      btn.dataset.pagePage = item;
      frag.appendChild(btn);
    }
  });

  // Next button
  const next = document.createElement('button');
  next.className = 'pag-btn';
  next.textContent = 'Next →';
  next.disabled = p >= totalPages - 1;
  next.dataset.action = 'pag-next';
  frag.appendChild(next);

  bar.replaceChildren(frag);
}

/**
 * Returns an array of page indices (0-based) and '…' ellipsis markers.
 * Always shows first, last, current ±1, with ellipsis where there are gaps.
 */
function paginationRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const pages = new Set([0, total - 1, current]);
  if (current > 0) pages.add(current - 1);
  if (current < total - 1) pages.add(current + 1);
  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  let prev = -1;
  for (const p of sorted) {
    if (p - prev > 1) result.push('…');
    result.push(p);
    prev = p;
  }
  return result;
}

/**
 * Reset to page 0 and re-fetch. Called whenever any filter/sort changes.
 */
async function resetAndFetch() {
  state.page = 0;
  await renderJobs();
}

/**
 * Debounced version of resetAndFetch for the search input.
 * Waits 350 ms after the user stops typing before hitting the server.
 */
function debouncedFetch() {
  clearTimeout(state.searchDebounce);
  state.searchDebounce = setTimeout(resetAndFetch, 350);
}

function buildJobRow(j) {
  const tr = document.createElement('tr');
  tr.dataset.jobId = j.id;

  const due = j.due ? formatDue(j.due) : '<span class="text-soft text-sm">—</span>';

  tr.innerHTML = `
    <td><span class="job-num">${esc(j.num)}</span></td>
    <td>
      <div class="client-name">${esc(j.client_name)}</div>
      ${j.client_contact ? `<div class="client-contact">${esc(j.client_contact)}</div>` : ''}
    </td>
    <td>${j.reference ? esc(j.reference) : '<span class="text-soft">—</span>'}</td>
    <td><span class="badge badge-type">${esc(j.type)}</span></td>
    <td><span class="badge badge-status">${esc(j.status)}</span></td>
    <td>${esc(j.location)}</td>
    <td>${j.staff ? esc(j.staff) : '<span class="text-soft text-sm">—</span>'}</td>
    <td>${due}</td>
  `;
  return tr;
}

/* ── OC FILTER ───────────────────────────────────────────────────── */

function setOCFilter(val) {
  state.ocFilter = val;
  document.querySelectorAll('.oc-btn').forEach(b => {
    b.classList.remove('active', 'active-open', 'active-closed');
  });
  const btn = document.getElementById(`oc-${val}`);
  btn.classList.add('active');
  if (val === 'open')   btn.classList.add('active-open');
  if (val === 'closed') btn.classList.add('active-closed');
  resetAndFetch();
}

function setSortField(field) {
  if (state.sortField === field) {
    // Same field — toggle direction
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortField = field;
    state.sortAsc   = false; // default descending for new field
  }
  document.getElementById('sort-dir-btn').textContent = state.sortAsc ? '↑' : '↓';
  resetAndFetch();
}

function toggleSortDir() {
  state.sortAsc = !state.sortAsc;
  document.getElementById('sort-dir-btn').textContent = state.sortAsc ? '↑' : '↓';
  resetAndFetch();
}

/* ── JOB DETAIL MODAL ────────────────────────────────────────────── */

async function openJobModal(jobId) {
  state.currentJobId   = jobId;
  state.commentFiles   = [];

  // Show modal immediately with the data we already have in state
  const snap = state.jobs.find(j => j.id === jobId);
  if (snap) {
    document.getElementById('detail-job-num').textContent      = snap.num;
    document.getElementById('detail-client-name').textContent  = snap.client_name;
    document.getElementById('detail-client-contact').textContent = snap.client_contact || '';
    document.getElementById('detail-desc').textContent         = snap.description;
    document.getElementById('detail-created').textContent      =
      new Date(snap.created_at).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
  }

  const L = state.lists;
  populateSelect(document.getElementById('detail-status'),   L.statuses,  false);
  populateSelect(document.getElementById('detail-location'), L.locations, false);
  populateSelect(document.getElementById('detail-type'),     L.types,     false);
  populateSelect(document.getElementById('detail-staff'),    L.staff,     true, '— unassigned');

  if (snap) {
    document.getElementById('detail-reference').value = snap.reference || '';
    document.getElementById('detail-status').value    = snap.status;
    document.getElementById('detail-location').value  = snap.location;
    document.getElementById('detail-type').value      = snap.type;
    document.getElementById('detail-staff').value     = snap.staff || '';
    document.getElementById('detail-due').value       = snap.due   || '';
  }

  document.getElementById('new-comment-text').value = '';
  document.getElementById('new-comment-attach-preview').innerHTML = '';
  document.getElementById('detail-photos').innerHTML = '<span class="text-soft text-sm">Loading…</span>';
  document.getElementById('detail-comments').innerHTML = '<div class="text-soft text-sm">Loading…</div>';

  openModal('job-modal');

  // Fetch full job (with comments & photos) in background
  try {
    const full = await DB.getJob(jobId);
    const jobNum = snap?.num ?? full.num ?? 'job';

    // Generate signed URLs for job photos in a single batch request
    const signedJobPhotos = await DB.getSignedUrls(full.job_photos || [])
      .catch(() => []);

    // Generate signed URLs for each comment's photos
    const commentsWithPhotos = await Promise.all(
      (full.comments || []).map(async c => {
        if (!c.comment_photos?.length) return c;
        const signed = await DB.getSignedUrls(c.comment_photos).catch(() => []);
        return { ...c, comment_photos: signed };
      })
    );

    renderDetailPhotos(signedJobPhotos, jobNum);
    renderDetailComments(commentsWithPhotos, jobNum);
  } catch (err) {
    console.error('Failed to load job detail:', err);
    showToast('Could not load full job details');
  }
}

function renderDetailPhotos(photos, jobNum) {
  const el = document.getElementById('detail-photos');
  if (!photos.length) {
    el.innerHTML = '<span class="no-photos">No intake photos attached</span>';
    return;
  }
  const frag = document.createDocumentFragment();
  photos.forEach((p, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'photo-thumb-wrap';

    const img = document.createElement('img');
    img.className        = 'photo-thumb';
    img.src              = p.signedUrl;
    img.alt              = `${jobNum} — photo ${i + 1}`;
    // Store everything the lightbox needs
    img.dataset.signedUrl  = p.signedUrl;
    img.dataset.filename   = `${jobNum}-photo-${i + 1}.jpg`;
    img.dataset.photoIndex = i;

    thumb.appendChild(img);
    frag.appendChild(thumb);
  });
  el.replaceChildren(frag);

  // Keep a reference so the lightbox can navigate prev/next
  state.lightboxPhotos = photos.map((p, i) => ({
    signedUrl: p.signedUrl,
    filename:  `${jobNum}-photo-${i + 1}.jpg`,
  }));
}

function renderDetailComments(comments) {
  const el = document.getElementById('detail-comments');
  if (!comments.length) {
    el.innerHTML = '<div class="text-soft text-sm" style="padding:8px 0 16px;">No comments yet.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  comments.forEach(c => {
    const div = document.createElement('div');
    div.className = 'comment';

    // Build photo thumbnails using signed URLs
    const photoFrag = document.createDocumentFragment();
    (c.comment_photos || []).forEach((p, i) => {
      const img = document.createElement('img');
      img.className          = 'photo-thumb';
      img.src                = p.signedUrl;
      img.alt                = `Comment photo ${i + 1}`;
      img.dataset.signedUrl  = p.signedUrl;
      img.dataset.filename   = `comment-photo-${i + 1}.jpg`;
      photoFrag.appendChild(img);
    });

    div.innerHTML = `
      <div class="comment-meta">
        <span class="comment-author">${esc(c.profiles?.name ?? 'Unknown')}</span>
        <span class="comment-time">${new Date(c.created_at).toLocaleString('en-AU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}</span>
      </div>
      <div class="comment-body">${esc(c.body)}</div>
    `;

    if (c.comment_photos?.length) {
      const photosDiv = document.createElement('div');
      photosDiv.className = 'comment-photos';
      photosDiv.appendChild(photoFrag);
      div.appendChild(photosDiv);
    }

    frag.appendChild(div);
  });
  el.replaceChildren(frag);
}

function closeJobModal() {
  closeModal('job-modal');
  state.currentJobId = null;
}

async function saveDetailChange() {
  if (!state.currentJobId) return;
  const fields = {
    reference: document.getElementById('detail-reference').value.trim(),
    status:    document.getElementById('detail-status').value,
    location:  document.getElementById('detail-location').value,
    type:      document.getElementById('detail-type').value,
    staff:     document.getElementById('detail-staff').value,
    due:       document.getElementById('detail-due').value,
    updatedBy: state.user.id,  // tracked in DB for audit trail
  };
  try {
    await DB.updateJob(state.currentJobId, fields);
    // Update local state so the table reflects the change without a full reload
    const idx = state.jobs.findIndex(j => j.id === state.currentJobId);
    if (idx !== -1) {
      state.jobs[idx] = { ...state.jobs[idx],
        reference: fields.reference,
        status:    fields.status,
        location:  fields.location,
        type:      fields.type,
        staff:     fields.staff,
        due:       fields.due,
      };
    }
    showToast('Saved');
    await renderJobs(); // re-render table to reflect field changes
  } catch (err) {
    console.error(err);
    showToast('Failed to save — please try again');
  }
}

/* ── PHOTO COMPRESSION ───────────────────────────────────────────── */

function compressImage(file, maxPx = 1400, quality = 0.78) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width  * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ── COMMENTS ────────────────────────────────────────────────────── */

function handleCommentAttach(input) {
  Array.from(input.files).forEach(file => {
    state.commentFiles.push({ name: file.name, file });
    renderCommentAttachPreview();
  });
  input.value = '';
}

function renderCommentAttachPreview() {
  const el   = document.getElementById('new-comment-attach-preview');
  const frag = document.createDocumentFragment();
  state.commentFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `📷 ${esc(f.name)}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.dataset.attachIdx = i;
    chip.appendChild(btn);
    frag.appendChild(chip);
  });
  el.replaceChildren(frag);
}

async function submitComment() {
  const text = document.getElementById('new-comment-text').value.trim();
  if (!text && state.commentFiles.length === 0) {
    showToast('Please write a comment first');
    return;
  }

  const submitBtn = document.querySelector('#job-modal .add-comment-footer .btn');
  submitBtn.disabled = true;

  try {
    const comment = await DB.addComment(state.currentJobId, state.user.id, text);

    // Upload any attached photos
    for (const attachment of state.commentFiles) {
      const compressed = await compressImage(attachment.file);
      const file = new File([compressed], attachment.name, { type: 'image/jpeg' });
      const { path } = await DB.uploadPhoto(file, state.currentJobId);
      await DB.attachCommentPhoto(comment.id, path);
    }

    state.commentFiles = [];
    document.getElementById('new-comment-attach-preview').innerHTML = '';
    document.getElementById('new-comment-text').value = '';

    // Reload the full job to get the new comment with author profile
    const full = await DB.getJob(state.currentJobId);
    renderDetailComments(full.comments || []);
    showToast('Comment added');
  } catch (err) {
    console.error(err);
    showToast('Failed to post comment');
  } finally {
    submitBtn.disabled = false;
  }
}

/* ── NEW JOB MODAL ───────────────────────────────────────────────── */

function openNewJobModal() {
  const L = state.lists;
  populateSelect(document.getElementById('nj-type'),     L.types,     false);
  populateSelect(document.getElementById('nj-status'),   L.statuses,  false);
  populateSelect(document.getElementById('nj-location'), L.locations, false);
  populateSelect(document.getElementById('nj-staff'),    L.staff,     true, '— unassigned');
  ['nj-client-name','nj-client-contact','nj-reference','nj-desc','nj-due'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('nj-photo-preview').innerHTML = '';
  document.getElementById('nj-photos').value = '';
  openModal('new-job-modal');
}

function closeNewJobModal() { closeModal('new-job-modal'); }

async function handleNewJobPhotoPreview(input) {
  const preview = document.getElementById('nj-photo-preview');
  preview.innerHTML = '';
  Array.from(input.files).forEach(file => {
    compressImage(file).then(blob => {
      const img = document.createElement('img');
      img.className = 'photo-thumb';
      img.src = URL.createObjectURL(blob);
      preview.appendChild(img);
    });
  });
}

async function createJob() {
  const clientName = document.getElementById('nj-client-name').value.trim();
  const desc       = document.getElementById('nj-desc').value.trim();
  if (!clientName || !desc) { showToast('Client name and description are required'); return; }

  const createBtn = document.querySelector('#new-job-modal .btn-gold');
  createBtn.disabled    = true;
  createBtn.textContent = 'Creating…';

  try {
    const job = await DB.createJob({
      clientName,
      clientContact: document.getElementById('nj-client-contact').value.trim(),
      reference:     document.getElementById('nj-reference').value.trim(),
      type:          document.getElementById('nj-type').value,
      status:        document.getElementById('nj-status').value,
      location:      document.getElementById('nj-location').value,
      staff:         document.getElementById('nj-staff').value,
      due:           document.getElementById('nj-due').value,
      description:   desc,
    }, state.user.id);

    // Upload photos if any
    const photoFiles = Array.from(document.getElementById('nj-photos').files);
    for (const file of photoFiles) {
      const compressed = await compressImage(file);
      const blob = new File([compressed], file.name, { type: 'image/jpeg' });
      const { path } = await DB.uploadPhoto(blob, job.id);
      await DB.attachJobPhoto(job.id, path, state.user.id);
    }

    closeNewJobModal();
    await resetAndFetch();   // re-fetch from server so new job appears with correct position
    showToast(`Job ${job.num} created`);
  } catch (err) {
    console.error(err);
    showToast('Failed to create job — please try again');
  } finally {
    createBtn.disabled    = false;
    createBtn.textContent = 'Create job';
  }
}

/* ── ADMIN ───────────────────────────────────────────────────────── */

async function renderAdmin() {
  if (!state.user || state.user.role !== 'admin') return;
  renderAdminStatuses();
  renderAdminList('locations', 'admin-locations');
  renderAdminList('types',     'admin-types');
  renderAdminList('staff',     'admin-staff');
  await renderUsersTable();
  renderApiTokens();
}

function renderAdminStatuses() {
  const el     = document.getElementById('admin-statuses');
  const items  = state.lists.statuses;
  const closed = state.lists.closed_statuses || [];

  if (!items.length) {
    el.innerHTML = '<div class="status-row" style="color:var(--ink-faint);">None added yet</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(item => {
    const isClosed = closed.includes(item);
    const row = document.createElement('div');
    row.className = 'status-row';
    row.innerHTML = `
      <span class="status-row-name">${esc(item)}</span>
      <div class="status-oc-toggle">
        <button class="status-oc-btn ${!isClosed ? 'is-open' : ''}"
          data-action="set-status-open" data-status="${esc(item)}">Open</button>
        <button class="status-oc-btn ${isClosed ? 'is-closed' : ''}"
          data-action="set-status-closed" data-status="${esc(item)}">Closed</button>
      </div>
      <button class="status-remove-btn" data-action="remove-status" data-status="${esc(item)}">×</button>
    `;
    frag.appendChild(row);
  });
  el.replaceChildren(frag);
}

function renderAdminList(key, elId) {
  const el    = document.getElementById(elId);
  const items = state.lists[key];

  if (!items.length) {
    el.innerHTML = '<div class="admin-list-item" style="color:var(--ink-faint);">None added yet</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'admin-list-item';
    row.innerHTML = `
      <span>${esc(item)}</span>
      <button data-action="remove-list-item" data-key="${esc(key)}" data-item="${esc(item)}" title="Remove">×</button>
    `;
    frag.appendChild(row);
  });
  el.replaceChildren(frag);
}

async function addAdminItem(key, inputId, elId) {
  const input = document.getElementById(inputId);
  const val   = input.value.trim();
  if (!val) return;
  if (state.lists[key].includes(val)) { showToast('Already exists'); return; }

  state.lists[key] = [...state.lists[key], val];
  try {
    await DB.updateLists({ [key]: state.lists[key] });
    input.value = '';
    if (key === 'statuses') renderAdminStatuses(); else renderAdminList(key, elId);
    populateFilters();
    renderBulkFilters();
    showToast('Added');
  } catch (err) {
    console.error(err);
    state.lists[key] = state.lists[key].filter(i => i !== val); // rollback
    showToast('Failed to save — please try again');
  }
}

async function removeAdminItem(key, item) {
  state.lists[key] = state.lists[key].filter(i => i !== item);
  if (key === 'statuses') {
    state.lists.closed_statuses = (state.lists.closed_statuses || []).filter(s => s !== item);
  }
  try {
    const patch = { [key]: state.lists[key] };
    if (key === 'statuses') patch.closed_statuses = state.lists.closed_statuses;
    await DB.updateLists(patch);
    if (key === 'statuses') renderAdminStatuses(); else renderAdminList(key, key === 'locations' ? 'admin-locations' : key === 'types' ? 'admin-types' : 'admin-staff');
    populateFilters();
    renderBulkFilters();
    showToast('Removed');
  } catch (err) {
    console.error(err);
    showToast('Failed to remove — please try again');
  }
}

async function setStatusClosed(statusName, isClosed) {
  if (!state.lists.closed_statuses) state.lists.closed_statuses = [];
  if (isClosed) {
    if (!state.lists.closed_statuses.includes(statusName)) {
      state.lists.closed_statuses = [...state.lists.closed_statuses, statusName];
    }
  } else {
    state.lists.closed_statuses = state.lists.closed_statuses.filter(s => s !== statusName);
  }
  try {
    await DB.updateLists({ closed_statuses: state.lists.closed_statuses });
    renderAdminStatuses();
    showToast(`${statusName} marked as ${isClosed ? 'closed' : 'open'}`);
  } catch (err) {
    console.error(err);
    showToast('Failed to update — please try again');
  }
}

async function renderUsersTable() {
  const tbody = document.getElementById('users-tbody');
  const users = await DB.listUsers().catch(() => []);
  const frag  = document.createDocumentFragment();

  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(u.name)}</td>
      <td style="font-size:12px;color:var(--ink-soft);">${esc(u.role)}</td>
      <td>
        ${u.id !== state.user.id
          ? `<button class="btn btn-sm btn-secondary" data-action="remove-user" data-user-id="${u.id}">Remove</button>`
          : '<span class="text-soft text-sm">You</span>'
        }
      </td>
    `;
    frag.appendChild(tr);
  });
  tbody.replaceChildren(frag);
}

function openInviteUserModal() {
  ['nu-name','nu-email'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('nu-role').value = 'staff';
  const errEl = document.getElementById('nu-error');
  errEl.textContent = ''; errEl.classList.remove('visible');
  openModal('new-user-modal');
}
function closeInviteUserModal() { closeModal('new-user-modal'); }

async function inviteUser() {
  const name  = document.getElementById('nu-name').value.trim();
  const email = document.getElementById('nu-email').value.trim().toLowerCase();
  const role  = document.getElementById('nu-role').value;
  const errEl = document.getElementById('nu-error');

  if (!name || !email) {
    errEl.textContent = 'Name and email are required.';
    errEl.classList.add('visible');
    return;
  }

  const btn = document.querySelector('#new-user-modal .btn-gold');
  btn.disabled = true;

  try {
    await DB.inviteUser(email, name, role);
    closeInviteUserModal();
    await renderUsersTable();
    showToast(`Invitation sent to ${email}`);
  } catch (err) {
    errEl.textContent = err.message || 'Could not invite user.';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false;
  }
}

async function removeUser(userId) {
  // Use inline confirmation instead of blocking native confirm()
  const confirmed = await showConfirm(
    'Remove this user? They will lose access to Bench immediately.',
    'Remove user',
    'danger'
  );
  if (!confirmed) return;

  try {
    await DB.removeUser(userId);
    await renderUsersTable();
    showToast('User removed');
  } catch (err) {
    console.error(err);
    showBanner('page-admin', err.message || 'Could not remove user — please try again.');
  }
}

/* ── API TOKENS ──────────────────────────────────────────────────── */

async function renderApiTokens() {
  const el     = document.getElementById('api-tokens-list');
  if (!el) return;
  const tokens = await DB.getApiTokens().catch(() => []);

  if (!tokens.length) {
    el.innerHTML = '<div style="padding:20px;font-size:13px;color:var(--ink-faint);font-style:italic;">No tokens generated yet.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  tokens.forEach(t => {
    const row = document.createElement('div');
    row.className = `token-row${t.revoked_at ? ' token-revoked' : ''}`;
    row.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div class="token-label">${esc(t.label)}</div>
        <div class="token-meta">
          Created ${new Date(t.created_at).toLocaleDateString('en-AU')}
          ${t.revoked_at ? ' · <span style="color:var(--danger);">Revoked</span>' : ''}
          ${t.last_used_at ? ` · Last used ${new Date(t.last_used_at).toLocaleDateString('en-AU')}` : ''}
        </div>
      </div>
      <div class="token-actions">
        ${!t.revoked_at
          ? `<button class="btn btn-sm btn-secondary" data-action="revoke-token" data-token-id="${t.id}">Revoke</button>`
          : ''}
        <button class="btn btn-sm btn-secondary" data-action="delete-token" data-token-id="${t.id}">Delete</button>
      </div>
    `;
    frag.appendChild(row);
  });
  el.replaceChildren(frag);
}

function openGenerateTokenModal() {
  document.getElementById('new-token-label').value = '';
  document.getElementById('token-reveal-section').hidden = true;
  document.getElementById('token-reveal-value').textContent = '';
  document.getElementById('new-token-error').textContent = '';
  document.getElementById('confirm-generate-token-btn').hidden  = false;
  document.getElementById('close-token-modal-btn').textContent = 'Cancel';
  openModal('generate-token-modal');
  setTimeout(() => document.getElementById('new-token-label').focus(), 50);
}

async function generateApiToken() {
  const label   = document.getElementById('new-token-label').value.trim();
  const errEl   = document.getElementById('new-token-error');
  errEl.textContent = '';

  if (!label) {
    errEl.textContent = 'Please enter a label for this token.';
    return;
  }

  const btn = document.getElementById('confirm-generate-token-btn');
  btn.disabled    = true;
  btn.textContent = 'Generating…';

  try {
    const result = await DB.generateApiToken(label, state.user.id);
    await renderApiTokens();

    // Reveal the raw token in the modal — never via alert()
    document.getElementById('token-reveal-section').hidden = false;
    document.getElementById('token-reveal-value').textContent = result.rawToken;
    btn.hidden = true;
    document.getElementById('close-token-modal-btn').textContent = 'Done';
    showToast('Token generated');
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message || 'Failed to generate token — please try again.';
    btn.disabled    = false;
    btn.textContent = 'Generate token';
  }
}

function copyTokenToClipboard() {
  const val = document.getElementById('token-reveal-value').textContent;
  navigator.clipboard.writeText(val).then(() => showToast('Token copied to clipboard'));
}

async function revokeApiToken(id) {
  const confirmed = await showConfirm(
    'Revoke this token? Any system using it will lose access immediately.',
    'Revoke token',
    'danger'
  );
  if (!confirmed) return;
  try {
    await DB.revokeApiToken(id);
    await renderApiTokens();
    showToast('Token revoked');
  } catch (err) {
    console.error(err);
    showBanner('page-admin', 'Failed to revoke token — please try again.');
  }
}

async function deleteApiToken(id) {
  const confirmed = await showConfirm('Permanently delete this token? This cannot be undone.', 'Delete token');
  if (!confirmed) return;
  try {
    await DB.deleteApiToken(id);
    await renderApiTokens();
    showToast('Token deleted');
  } catch (err) {
    console.error(err);
    showBanner('page-admin', 'Failed to delete token — please try again.');
  }
}

/* ── SAVED VIEWS ─────────────────────────────────────────────────── */

function renderSavedViewChips() {
  const container = document.getElementById('saved-filter-chips');
  const frag      = document.createDocumentFragment();

  state.savedViews.forEach(v => {
    const chip = document.createElement('span');
    chip.className = 'saved-filter-chip';
    chip.dataset.viewId = v.id;
    chip.innerHTML = `${esc(v.name)}`;
    const rm = document.createElement('button');
    rm.className = 'chip-remove';
    rm.textContent = '×';
    rm.dataset.action = 'delete-view';
    rm.dataset.viewId = v.id;
    chip.appendChild(rm);
    frag.appendChild(chip);
  });
  container.replaceChildren(frag);
}

function applyView(viewId) {
  const view = state.savedViews.find(v => v.id === viewId);
  if (!view) return;

  const isActive = state.activeChipId === viewId;
  const f = isActive ? {} : (view.filters || {});

  setOCFilter(f.ocFilter || 'open');
  document.getElementById('filter-search').value   = f.search   || '';
  document.getElementById('filter-status').value   = f.status   || '';
  document.getElementById('filter-location').value = f.location || '';
  document.getElementById('filter-type').value     = f.type     || '';
  document.getElementById('filter-staff').value    = f.staff    || '';

  state.activeChipId = isActive ? null : viewId;
  document.querySelectorAll('.saved-filter-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.viewId === state.activeChipId);
  });
  resetAndFetch();
}

function openSaveViewModal() {
  const f = {
    search:   document.getElementById('filter-search').value,
    status:   document.getElementById('filter-status').value,
    location: document.getElementById('filter-location').value,
    type:     document.getElementById('filter-type').value,
    staff:    document.getElementById('filter-staff').value,
  };
  const parts = [];
  if (state.ocFilter !== 'all') parts.push(state.ocFilter === 'open' ? 'Open jobs' : 'Closed jobs');
  if (f.search)   parts.push(`Search: "${f.search}"`);
  if (f.status)   parts.push(`Status: ${f.status}`);
  if (f.location) parts.push(`Location: ${f.location}`);
  if (f.type)     parts.push(`Type: ${f.type}`);
  if (f.staff)    parts.push(`Staff: ${f.staff}`);

  if (!parts.length) { showToast('Set at least one filter first'); return; }

  document.getElementById('sf-name').value = '';
  document.getElementById('sf-preview').textContent = 'Saving: ' + parts.join(' · ');
  openModal('save-filter-modal');
  setTimeout(() => document.getElementById('sf-name').focus(), 50);
}

async function saveCurrentView() {
  const name = document.getElementById('sf-name').value.trim();
  if (!name) { showToast('Please give this view a name'); return; }
  if (state.savedViews.find(v => v.name === name)) { showToast('A view with that name already exists'); return; }

  const filters = {
    ocFilter: state.ocFilter,
    search:   document.getElementById('filter-search').value,
    status:   document.getElementById('filter-status').value,
    location: document.getElementById('filter-location').value,
    type:     document.getElementById('filter-type').value,
    staff:    document.getElementById('filter-staff').value,
  };

  try {
    const saved = await DB.saveView(state.user.id, name, filters);
    state.savedViews.push(saved);
    closeModal('save-filter-modal');
    renderSavedViewChips();
    showToast(`View saved — "${name}"`);
  } catch (err) {
    console.error(err);
    showToast('Failed to save view');
  }
}

async function deleteView(viewId) {
  try {
    await DB.deleteView(viewId);
    state.savedViews = state.savedViews.filter(v => v.id !== viewId);
    if (state.activeChipId === viewId) state.activeChipId = null;
    renderSavedViewChips();
    showToast('View deleted');
  } catch (err) {
    console.error(err);
    showToast('Failed to delete view');
  }
}

/* ── BULK UPDATE ─────────────────────────────────────────────────── */

function renderBulkFilters() {
  const L = state.lists;
  populateSelect(document.getElementById('bulk-status'),   L.statuses,  true, '— no change —');
  populateSelect(document.getElementById('bulk-location'), L.locations, true, '— no change —');
  populateSelect(document.getElementById('bulk-staff'),    L.staff,     true, '— no change —');
}

function renderBulkSearchResults(jobs) {
  const el   = document.getElementById('bulk-search-results');
  const frag = document.createDocumentFragment();

  if (!jobs.length) {
    el.innerHTML = '<div style="padding:16px;font-size:13px;color:var(--ink-faint);">No matching jobs</div>';
    return;
  }

  jobs.forEach(j => {
    const item = document.createElement('div');
    item.className = `bulk-result-item${state.bulkSelected.has(j.id) ? ' selected' : ''}`;
    item.dataset.jobId = j.id;
    item.dataset.action = 'toggle-bulk';
    item.innerHTML = `
      <div class="bulk-result-check">${state.bulkSelected.has(j.id) ? '✓' : ''}</div>
      <div class="bulk-result-info">
        <div class="bulk-result-num">${esc(j.num)}</div>
        <div class="bulk-result-client">${esc(j.client_name)}</div>
        <div class="bulk-result-meta">${esc(j.status)} · ${esc(j.location)}</div>
      </div>
    `;
    frag.appendChild(item);
  });
  el.replaceChildren(frag);
}

function renderBulkSelected() {
  const el   = document.getElementById('bulk-selected-list');
  const frag = document.createDocumentFragment();
  const count = document.getElementById('bulk-count');

  count.textContent = `${state.bulkSelected.size} selected`;

  state.bulkSelected.forEach(id => {
    const j = state.jobs.find(x => x.id === id);
    if (!j) return;
    const row = document.createElement('div');
    row.className = 'bulk-selected-item';
    row.innerHTML = `
      <span><span class="bulk-selected-num">${esc(j.num)}</span>${esc(j.client_name)}</span>
      <button class="bulk-remove-btn" data-action="deselect-bulk" data-job-id="${j.id}">×</button>
    `;
    frag.appendChild(row);
  });

  if (!state.bulkSelected.size) {
    el.innerHTML = '<div style="padding:14px 16px;font-size:13px;color:var(--ink-faint);">No jobs selected</div>';
  } else {
    el.replaceChildren(frag);
  }
}

function toggleBulkJob(jobId) {
  if (state.bulkSelected.has(jobId)) {
    state.bulkSelected.delete(jobId);
  } else {
    state.bulkSelected.add(jobId);
  }
  const searchTerm = document.getElementById('bulk-search').value.toLowerCase();
  const results = state.jobs.filter(j =>
    [j.num, j.client_name, j.status].join(' ').toLowerCase().includes(searchTerm)
  );
  renderBulkSearchResults(results);
  renderBulkSelected();
}

async function applyBulkUpdate() {
  if (!state.bulkSelected.size) { showToast('Select at least one job'); return; }
  const errEl = document.getElementById('bulk-error');
  errEl.style.display = 'none';

  const fields = {
    status:   document.getElementById('bulk-status').value,
    location: document.getElementById('bulk-location').value,
    staff:    document.getElementById('bulk-staff').value,
    due:      document.getElementById('bulk-due').value,
    comment:  document.getElementById('bulk-comment').value.trim(),
    authorId: state.user.id,
  };

  if (!fields.status && !fields.location && !fields.staff && !fields.due && !fields.comment) {
    errEl.textContent = 'Choose at least one field to update.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.querySelector('#page-bulk .btn-gold');
  btn.disabled    = true;
  btn.textContent = 'Applying…';

  try {
    const ids = [...state.bulkSelected];
    await DB.bulkUpdateJobs(ids, fields);

    // Update local state
    ids.forEach(id => {
      const idx = state.jobs.findIndex(j => j.id === id);
      if (idx === -1) return;
      if (fields.status)   state.jobs[idx].status   = fields.status;
      if (fields.location) state.jobs[idx].location = fields.location;
      if (fields.staff)    state.jobs[idx].staff    = fields.staff;
      if (fields.due)      state.jobs[idx].due      = fields.due;
    });

    state.bulkSelected.clear();
    await resetAndFetch();
    renderBulkSelected();
    document.getElementById('bulk-search-results').innerHTML = '';
    document.getElementById('bulk-success-card').style.display = 'block';
    document.getElementById('bulk-success-body').textContent =
      `Updated ${ids.length} job${ids.length !== 1 ? 's' : ''} successfully.`;
    showToast(`Updated ${ids.length} job${ids.length !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error(err);
    errEl.textContent = 'Update failed — please try again.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Apply to selected jobs';
  }
}

/* ── CSV EXPORT ──────────────────────────────────────────────────── */

async function exportCSV() {
  const btn = document.getElementById('export-csv-btn');
  btn.disabled    = true;
  btn.textContent = 'Exporting…';

  try {
    // Fetch ALL matching rows (no page limit) by passing a very large pageSize.
    // Supabase max range per request is 1000; for larger datasets this would
    // need cursor-based batching — fine for workshop scale.
    const params = buildQueryParams();
    const jobs   = await DB.getJobs({ ...params, page: 0, pageSize: 1000 });

    if (!jobs.length) { showToast('No jobs to export'); return; }

    const headers = [
      'Job #','External Reference','Client Name','Client Contact',
      'Type','Status','Location','Staff','Due Date','Created','Description'
    ];

    const csvEsc = v => {
      const s = String(v ?? '').replace(/"/g, '""');
      return /[,\n\r"]/.test(s) ? `"${s}"` : s;
    };

    const rows = jobs.map(j => [
      j.num,
      j.reference        || '',
      j.client_name,
      j.client_contact   || '',
      j.type,
      j.status,
      j.location,
      j.staff            || '',
      j.due              || '',
      new Date(j.created_at).toLocaleDateString('en-AU'),
      j.description,
    ].map(csvEsc));

    const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `bench-jobs-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${jobs.length} jobs`);
  } catch (err) {
    console.error(err);
    showToast('Export failed — please try again');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Export CSV';
  }
}

/* ── LIGHTBOX ────────────────────────────────────────────────────── */

/**
 * Open the lightbox at a specific photo index within state.lightboxPhotos.
 * If called from a comment photo (no index in the set), falls back to
 * single-photo mode with prev/next hidden.
 */
function openLightbox(signedUrl, filename, photoIndex) {
  const lb      = document.getElementById('lightbox');
  const img     = document.getElementById('lightbox-img');
  const dlBtn   = document.getElementById('lightbox-download');
  const counter = document.getElementById('lightbox-counter');
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');

  // If we have a valid index into state.lightboxPhotos, enable navigation
  const inSet = typeof photoIndex === 'number'
             && photoIndex >= 0
             && photoIndex < state.lightboxPhotos.length;

  state.lightboxIndex = inSet ? photoIndex : 0;

  function renderFrame(index) {
    const photo = inSet ? state.lightboxPhotos[index] : { signedUrl, filename };
    img.src          = photo.signedUrl;
    img.alt          = photo.filename;
    dlBtn.href       = photo.signedUrl;
    dlBtn.download   = photo.filename;

    if (inSet && state.lightboxPhotos.length > 1) {
      counter.textContent = `${index + 1} / ${state.lightboxPhotos.length}`;
      counter.style.display = 'block';
      prevBtn.style.display = index > 0                              ? 'flex' : 'none';
      nextBtn.style.display = index < state.lightboxPhotos.length - 1 ? 'flex' : 'none';
    } else {
      counter.style.display = 'none';
      prevBtn.style.display = 'none';
      nextBtn.style.display = 'none';
    }
  }

  renderFrame(state.lightboxIndex);
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Expose navigation so arrow key handler can call it
  lb._renderFrame = renderFrame;
}

function lightboxNavigate(dir) {
  const lb    = document.getElementById('lightbox');
  const total = state.lightboxPhotos.length;
  state.lightboxIndex = Math.max(0, Math.min(total - 1, state.lightboxIndex + dir));
  lb._renderFrame?.(state.lightboxIndex);
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('open');
  lb._renderFrame = null;
  document.getElementById('lightbox-img').src = '';
  document.body.style.overflow = '';
}

/* ── MODALS ──────────────────────────────────────────────────────── */

function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay.open').forEach(el => closeModal(el.id));
  closeLightbox();
}

/* ── APPEARANCE ──────────────────────────────────────────────────── */

function getDefaultAppearanceConfig() {
  return { themeId: 'classic', font: 'dmsans', size: 'medium',
           vars: { accent:'#C9A84C', bg:'#FDFAF5', text:'#1A1714', nav:'#1A1714' } };
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1,3), 16),
    parseInt(hex.slice(3,5), 16),
    parseInt(hex.slice(5,7), 16),
  ];
}
function rgbToHex(r, g, b) {
  return '#' + [r,g,b].map(v => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2,'0')).join('');
}
function hexTint(hex, amount) {
  try {
    const [r,g,b] = hexToRgb(hex);
    if (amount >= 0) return rgbToHex(r+(255-r)*amount, g+(255-g)*amount, b+(255-b)*amount);
    const a = Math.abs(amount);
    return rgbToHex(r*(1-a), g*(1-a), b*(1-a));
  } catch { return hex; }
}

function applyAppearance(app) {
  if (!app) return;
  const root = document.documentElement;
  const v    = app.vars || {};

  root.style.setProperty('--gold',          v.accent || '#C9A84C');
  root.style.setProperty('--gold-light',    hexTint(v.accent || '#C9A84C', 0.4));
  root.style.setProperty('--gold-pale',     hexTint(v.accent || '#C9A84C', 0.85));

  const ink = v.text || '#1A1714';
  root.style.setProperty('--ink',           ink);
  root.style.setProperty('--ink-mid',       hexTint(ink, 0.15));
  root.style.setProperty('--ink-soft',      hexTint(ink, 0.45));
  root.style.setProperty('--ink-faint',     hexTint(ink, 0.65));

  const bg = v.bg || '#FDFAF5';
  root.style.setProperty('--surface',       bg);
  root.style.setProperty('--surface-2',     hexTint(bg, -0.04));
  root.style.setProperty('--surface-3',     hexTint(bg, -0.09));
  root.style.setProperty('--border',        hexTint(bg, -0.14));
  root.style.setProperty('--border-strong', hexTint(bg, -0.22));

  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.style.background = v.nav || '#1A1714';

  const fontObj = FONTS.find(f => f.id === app.font) || FONTS[0];
  document.body.style.fontFamily = fontObj.stack;

  const sizeObj = SIZES.find(s => s.id === app.size) || SIZES[1];
  document.body.style.fontSize = sizeObj.base + 'px';
}

function openAppearanceModal() {
  workingAppearance = JSON.parse(JSON.stringify(getDefaultAppearanceConfig()));

  // Render presets
  document.getElementById('theme-presets').innerHTML = THEMES.map(t => `
    <div class="theme-preset${workingAppearance.themeId === t.id ? ' active' : ''}" data-action="select-preset" data-theme-id="${t.id}">
      <div class="theme-swatch-row">
        ${t.swatches.map(s => `<div class="theme-swatch" style="background:${s}"></div>`).join('')}
      </div>
      <div class="theme-preset-name">${t.name}</div>
      <div class="theme-preset-desc">${t.desc}</div>
    </div>
  `).join('');

  syncAllColourInputs();

  document.getElementById('font-options').innerHTML = FONTS.map(f => `
    <div class="font-option${workingAppearance.font === f.id ? ' active' : ''}" data-action="select-font" data-font-id="${f.id}" style="font-family:${f.stack}">
      <div class="font-option-name">${f.name}</div>
      <div class="font-option-sample">${f.desc}</div>
    </div>
  `).join('');

  document.getElementById('size-options').innerHTML = SIZES.map(s => `
    <div class="size-option${workingAppearance.size === s.id ? ' active' : ''}" data-action="select-size" data-size-id="${s.id}">
      <div class="size-option-label" style="font-size:${s.base}px">${s.label}</div>
      <div class="size-option-sub">${s.desc}</div>
    </div>
  `).join('');

  const adminSection = document.getElementById('admin-default-section');
  if (adminSection) adminSection.style.display = state.user?.role === 'admin' ? 'block' : 'none';

  updateAppearancePreview();
  openModal('appearance-modal');
}

function closeAppearanceModal() { closeModal('appearance-modal'); }

function selectPreset(id) {
  const theme = THEMES.find(t => t.id === id);
  if (!theme) return;
  workingAppearance.themeId = id;
  workingAppearance.vars    = { ...theme.vars };
  document.querySelectorAll('.theme-preset').forEach(el => {
    el.classList.toggle('active', el.dataset.themeId === id);
  });
  syncAllColourInputs();
  updateAppearancePreview();
}

function selectFont(id) {
  workingAppearance.font = id;
  document.querySelectorAll('.font-option').forEach(el => {
    el.classList.toggle('active', el.dataset.fontId === id);
  });
  updateAppearancePreview();
}

function selectSize(id) {
  workingAppearance.size = id;
  document.querySelectorAll('.size-option').forEach(el => {
    el.classList.toggle('active', el.dataset.sizeId === id);
  });
  updateAppearancePreview();
}

function syncAllColourInputs() {
  const v = workingAppearance.vars;
  ['accent','bg','text','nav'].forEach(key => {
    const val = v[key] || '#000000';
    const cp  = document.getElementById(`cp-${key}`);
    const ch  = document.getElementById(`ch-${key}`);
    if (cp) cp.value = val;
    if (ch) ch.value = val;
  });
}

function syncColourHex(key, val) {
  workingAppearance.vars[key] = val;
  const ch = document.getElementById(`ch-${key}`);
  if (ch) ch.value = val;
  workingAppearance.themeId = 'custom';
  document.querySelectorAll('.theme-preset').forEach(el => el.classList.remove('active'));
  updateAppearancePreview();
}

function syncColourPicker(key, val) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(val)) return;
  workingAppearance.vars[key] = val;
  const cp = document.getElementById(`cp-${key}`);
  if (cp) cp.value = val;
  workingAppearance.themeId = 'custom';
  document.querySelectorAll('.theme-preset').forEach(el => el.classList.remove('active'));
  updateAppearancePreview();
}

function updateAppearancePreview() {
  const preview  = document.getElementById('appearance-preview-text');
  const fontObj  = FONTS.find(f => f.id === workingAppearance.font) || FONTS[0];
  const sizeObj  = SIZES.find(s => s.id === workingAppearance.size) || SIZES[1];
  preview.style.fontFamily = fontObj.stack;
  preview.style.fontSize   = sizeObj.base + 'px';
  preview.style.color      = workingAppearance.vars.text || '#1A1714';
}

async function saveAppearance() {
  try {
    await DB.saveAppearance(state.user.id, workingAppearance);
    applyAppearance(workingAppearance);

    if (state.user.role === 'admin' && document.getElementById('set-as-default-cb')?.checked) {
      await DB.updateLists({ default_appearance: workingAppearance });
    }

    closeAppearanceModal();
    showToast('Appearance saved');
  } catch (err) {
    console.error(err);
    showToast('Failed to save appearance');
  }
}

async function resetAppearance() {
  workingAppearance = getDefaultAppearanceConfig();
  syncAllColourInputs();
  updateAppearancePreview();
  await DB.saveAppearance(state.user.id, workingAppearance).catch(() => {});
  applyAppearance(workingAppearance);
  closeAppearanceModal();
  showToast('Appearance reset');
}

/* ── EVENT DELEGATION ────────────────────────────────────────────── */
/**
 * All interactive elements use data-action attributes.
 * Zero onclick= in HTML. This single function handles everything.
 */
function bindEventListeners() {

  // Login form
  document.getElementById('login-btn').addEventListener('click', handleLogin);
  document.getElementById('login-pass').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });

  // Password reset form
  document.getElementById('reset-btn').addEventListener('click', handleResetPassword);
  document.getElementById('reset-pass-confirm').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleResetPassword();
  });

  // Topbar
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('appearance-btn').addEventListener('click', openAppearanceModal);

  // Nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      showPage(page);
      if (page === 'admin') renderAdmin();
    });
  });

  // Open/Closed toggle
  document.querySelectorAll('.oc-btn').forEach(btn => {
    btn.addEventListener('click', () => setOCFilter(btn.dataset.ocFilter));
  });

  // Filter controls — all reset to page 0 and re-fetch from server
  document.getElementById('filter-search').addEventListener('input', debouncedFetch);
  ['filter-status','filter-location','filter-type','filter-staff','group-field']
    .forEach(id => {
      document.getElementById(id)?.addEventListener('change', resetAndFetch);
    });

  // Sort field change
  document.getElementById('sort-field').addEventListener('change', e => {
    state.sortField = e.target.value;
    resetAndFetch();
  });

  // Sort direction toggle
  document.getElementById('sort-dir-btn').addEventListener('click', toggleSortDir);

  // Page size selector
  document.getElementById('page-size-select').addEventListener('change', e => {
    state.pageSize = parseInt(e.target.value, 10);
    resetAndFetch();
  });

  // Pagination bar — event delegation
  document.getElementById('pagination-bar').addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const totalPages = Math.max(1, Math.ceil(state.totalJobs / state.pageSize));
    if (el.dataset.action === 'pag-prev' && state.page > 0) {
      state.page--;
      renderJobs();
    } else if (el.dataset.action === 'pag-next' && state.page < totalPages - 1) {
      state.page++;
      renderJobs();
    } else if (el.dataset.action === 'pag-goto') {
      state.page = parseInt(el.dataset.pagePage, 10);
      renderJobs();
    }
  });

  // Save filter view
  document.getElementById('save-filter-btn').addEventListener('click', openSaveViewModal);
  document.getElementById('save-view-btn').addEventListener('click', saveCurrentView);
  document.getElementById('cancel-save-view-btn').addEventListener('click', () => closeModal('save-filter-modal'));
  document.getElementById('sf-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveCurrentView();
  });

  // Jobs table — event delegation on tbody
  document.getElementById('jobs-tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-job-id]');
    if (tr) openJobModal(tr.dataset.jobId);
  });

  // New job
  document.getElementById('new-job-btn').addEventListener('click', openNewJobModal);
  document.getElementById('cancel-new-job-btn').addEventListener('click', closeNewJobModal);
  document.getElementById('create-job-btn').addEventListener('click', createJob);
  document.getElementById('nj-photos').addEventListener('change', function() {
    handleNewJobPhotoPreview(this);
  });

  // Export
  document.getElementById('export-csv-btn').addEventListener('click', exportCSV);

  // Job detail modal — detail change fields
  ['detail-reference','detail-due'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveDetailChange);
  });
  ['detail-status','detail-location','detail-type','detail-staff'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveDetailChange);
  });
  document.getElementById('close-job-modal-btn').addEventListener('click', closeJobModal);

  // Comments
  document.querySelector('#job-modal .add-comment-footer .btn')
    .addEventListener('click', submitComment);
  document.getElementById('comment-attach-input').addEventListener('change', function() {
    handleCommentAttach(this);
  });
  // Delegate chip remove (attach preview)
  document.getElementById('new-comment-attach-preview').addEventListener('click', e => {
    const btn = e.target.closest('button[data-attach-idx]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.attachIdx, 10);
    state.commentFiles.splice(idx, 1);
    renderCommentAttachPreview();
  });

  // Job detail photo click → lightbox (with index for prev/next navigation)
  document.getElementById('detail-photos').addEventListener('click', e => {
    const img = e.target.closest('img.photo-thumb');
    if (!img?.dataset.signedUrl) return;
    openLightbox(
      img.dataset.signedUrl,
      img.dataset.filename,
      parseInt(img.dataset.photoIndex ?? '0', 10)
    );
  });

  // Comment photo click → lightbox (single-photo mode, no set navigation)
  document.getElementById('detail-comments').addEventListener('click', e => {
    const img = e.target.closest('img.photo-thumb');
    if (!img?.dataset.signedUrl) return;
    openLightbox(img.dataset.signedUrl, img.dataset.filename, null);
  });

  // Lightbox — close on backdrop click (not on controls)
  document.getElementById('lightbox').addEventListener('click', e => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
  });
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', e => {
    e.stopPropagation();
    lightboxNavigate(-1);
  });
  document.getElementById('lightbox-next').addEventListener('click', e => {
    e.stopPropagation();
    lightboxNavigate(1);
  });

  // Admin — event delegation on the whole admin page
  document.getElementById('page-admin').addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset?.action;
    if (!action) return;
    const el = e.target.closest('[data-action]');

    switch (action) {
      case 'set-status-open':   setStatusClosed(el.dataset.status, false); break;
      case 'set-status-closed': setStatusClosed(el.dataset.status, true);  break;
      case 'remove-status':     removeAdminItem('statuses',  el.dataset.status); break;
      case 'remove-list-item':  removeAdminItem(el.dataset.key, el.dataset.item); break;
      case 'remove-user':       removeUser(el.dataset.userId); break;
      case 'revoke-token':      revokeApiToken(el.dataset.tokenId); break;
      case 'delete-token':      deleteApiToken(el.dataset.tokenId); break;
    }
  });

  // Admin — add item buttons
  document.getElementById('add-status-btn').addEventListener('click', () =>
    addAdminItem('statuses', 'new-status-input', 'admin-statuses'));
  document.getElementById('add-location-btn').addEventListener('click', () =>
    addAdminItem('locations', 'new-location-input', 'admin-locations'));
  document.getElementById('add-type-btn').addEventListener('click', () =>
    addAdminItem('types', 'new-type-input', 'admin-types'));
  document.getElementById('add-staff-btn').addEventListener('click', () =>
    addAdminItem('staff', 'new-staff-input', 'admin-staff'));

  // Add on Enter too
  [['new-status-input','statuses','admin-statuses'],
   ['new-location-input','locations','admin-locations'],
   ['new-type-input','types','admin-types'],
   ['new-staff-input','staff','admin-staff']].forEach(([inputId, key, elId]) => {
    document.getElementById(inputId).addEventListener('keydown', e => {
      if (e.key === 'Enter') addAdminItem(key, inputId, elId);
    });
  });

  // Invite user
  document.getElementById('invite-user-btn').addEventListener('click', openInviteUserModal);
  document.getElementById('confirm-invite-btn').addEventListener('click', inviteUser);
  document.getElementById('cancel-invite-btn').addEventListener('click', closeInviteUserModal);

  // Generate API token — open modal instead of prompt()
  document.getElementById('generate-token-btn').addEventListener('click', openGenerateTokenModal);
  document.getElementById('confirm-generate-token-btn').addEventListener('click', generateApiToken);
  document.getElementById('close-token-modal-btn').addEventListener('click', () => closeModal('generate-token-modal'));
  document.getElementById('copy-token-btn').addEventListener('click', copyTokenToClipboard);

  // Bulk update page — event delegation
  document.getElementById('bulk-search').addEventListener('input', e => {
    const term    = e.target.value.toLowerCase();
    const results = state.jobs.filter(j =>
      [j.num, j.client_name, j.status].join(' ').toLowerCase().includes(term)
    );
    renderBulkSearchResults(results);
  });

  document.getElementById('bulk-search-results').addEventListener('click', e => {
    const item = e.target.closest('[data-action="toggle-bulk"]');
    if (item) toggleBulkJob(item.dataset.jobId);
  });

  document.getElementById('bulk-selected-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="deselect-bulk"]');
    if (btn) toggleBulkJob(btn.dataset.jobId);
  });

  document.getElementById('apply-bulk-btn').addEventListener('click', applyBulkUpdate);

  // Saved views — event delegation on the chips container
  document.getElementById('saved-filter-chips').addEventListener('click', e => {
    const rm   = e.target.closest('[data-action="delete-view"]');
    const chip = e.target.closest('.saved-filter-chip');
    if (rm) {
      e.stopPropagation();
      deleteView(rm.dataset.viewId);
    } else if (chip) {
      applyView(chip.dataset.viewId);
    }
  });

  // Appearance modal — colour inputs
  ['accent','bg','text','nav'].forEach(key => {
    document.getElementById(`cp-${key}`)?.addEventListener('input', e => syncColourHex(key, e.target.value));
    document.getElementById(`ch-${key}`)?.addEventListener('input', e => syncColourPicker(key, e.target.value));
  });

  // Appearance modal — preset/font/size via event delegation
  document.getElementById('appearance-modal').addEventListener('click', e => {
    const el     = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'select-preset') selectPreset(el.dataset.themeId);
    if (action === 'select-font')   selectFont(el.dataset.fontId);
    if (action === 'select-size')   selectSize(el.dataset.sizeId);
  });

  document.getElementById('save-appearance-btn').addEventListener('click', saveAppearance);
  document.getElementById('reset-appearance-btn').addEventListener('click', resetAppearance);
  document.getElementById('cancel-appearance-btn').addEventListener('click', closeAppearanceModal);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Keyboard navigation
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllModals();
    const lbOpen = document.getElementById('lightbox').classList.contains('open');
    if (lbOpen && e.key === 'ArrowLeft')  lightboxNavigate(-1);
    if (lbOpen && e.key === 'ArrowRight') lightboxNavigate(1);
  });
}
