'use strict';

/* =========================================================
   Bookmark — remembers your books and the page you're on.
   Data lives in Supabase (one row per book, protected by RLS).
   Book search uses Open Library.

   Sync model
   - Supabase is the source of truth.
   - Every change is turned into an "upsert this row" or "delete this id"
     and put in a small outbox, which is flushed to Supabase straight away.
     If the phone is offline the outbox waits and is retried when the
     connection returns, so page updates are never lost.
   - A copy of the last-known library is kept on the device so the app
     opens instantly (and works offline); it is refreshed from Supabase on
     launch and whenever the app comes back to the foreground.
   ========================================================= */

const CONFIG = window.BOOKMARK_CONFIG || {};
const TABLE = 'books';
const LEGACY_KEY = 'bookmark.library.v1'; // pre-Supabase localStorage library
const OL_SEARCH = 'https://openlibrary.org/search.json';
const OL_FIELDS = 'key,title,author_name,cover_i,number_of_pages_median,first_publish_year';
const STATUSES = ['reading', 'want', 'finished'];
const STATUS_LABEL = { reading: 'Reading', want: 'To read', finished: 'Finished' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  status: 'reading', // active tab
  filter: '',        // search-my-books text
  editingId: null,   // book open in the sheet
  results: [],       // last Open Library results
  searchCtrl: null,  // AbortController for in-flight search
};

let sb = null;      // Supabase client
let user = null;    // signed-in Supabase user
let books = [];     // in-memory library (camelCase records)
let outbox = {};    // { [bookId]: row to upsert | null to delete }
let syncError = false;

/* ---------------- device cache (per user) ---------------- */

const cacheKey = () => `bookmark.cache.${user.id}`;
const outboxKey = () => `bookmark.outbox.${user.id}`;

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked: sync still works */ }
}

/* ---------------- records ---------------- */

/** Coerce anything (cache, imports, API results, DB rows) into a clean book record. */
function normalize(b) {
  if (!b || typeof b.title !== 'string' || !b.title.trim()) return null;
  const now = Date.now();
  return {
    id: UUID_RE.test(b.id) ? b.id : uid(),
    olKey: typeof b.olKey === 'string' ? b.olKey : null,
    title: b.title.trim().slice(0, 500),
    authors: Array.isArray(b.authors) ? b.authors.map(String).filter(Boolean) : [],
    coverId: Number.isFinite(Number(b.coverId)) && b.coverId ? Number(b.coverId) : null,
    year: Number.isFinite(Number(b.year)) && b.year ? Number(b.year) : null,
    totalPages: posInt(b.totalPages),
    currentPage: posInt(b.currentPage) || 0,
    status: STATUSES.includes(b.status) ? b.status : 'reading',
    addedAt: Number(b.addedAt) || now,
    updatedAt: Number(b.updatedAt) || now,
  };
}

function toRow(b) {
  return {
    id: b.id,
    user_id: user.id,
    ol_key: b.olKey,
    title: b.title,
    authors: b.authors,
    cover_id: b.coverId,
    year: b.year,
    total_pages: b.totalPages,
    current_page: b.currentPage,
    status: b.status,
    added_at: new Date(b.addedAt).toISOString(),
    updated_at: new Date(b.updatedAt).toISOString(),
  };
}

function fromRow(r) {
  return normalize({
    id: r.id,
    olKey: r.ol_key,
    title: r.title,
    authors: r.authors,
    coverId: r.cover_id,
    year: r.year,
    totalPages: r.total_pages,
    currentPage: r.current_page,
    status: r.status,
    addedAt: Date.parse(r.added_at),
    updatedAt: Date.parse(r.updated_at),
  });
}

function posInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---------------- sync ---------------- */

/** Record a change to one book and push it to Supabase. */
function persist(book) {
  outbox[book.id] = toRow(book);
  changed();
}

function persistDelete(id) {
  outbox[id] = null;
  changed();
}

function changed() {
  writeJSON(outboxKey(), outbox);
  writeJSON(cacheKey(), books);
  flush();
}

let flushing = false;
let flushAgain = false;

/** Send everything in the outbox to Supabase. Safe to call any time. */
async function flush() {
  if (!user) return;
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    do {
      flushAgain = false;
      for (const [id, row] of Object.entries(outbox)) {
        const { error } = row
          ? await sb.from(TABLE).upsert(row)
          : await sb.from(TABLE).delete().eq('id', id);

        if (error) {
          if (isRetryable(error)) throw error; // offline etc. — keep the outbox, try later
          // The server rejected this change outright (e.g. a constraint) — drop it
          // so it can't block the queue, and tell the user.
          console.error('Supabase rejected change', id, error);
          toast(`Couldn't save a change: ${error.message}`);
        }
        // Only clear the entry if it wasn't replaced while we were waiting.
        if (outbox[id] === row) delete outbox[id];
        writeJSON(outboxKey(), outbox);
      }
    } while (flushAgain);
    syncError = false;
  } catch (err) {
    console.warn('Sync paused:', err);
    syncError = true;
  } finally {
    flushing = false;
    renderSyncStatus();
  }
}

function isRetryable(error) {
  // Network failures come back with no Postgres code; PGRST3xx are auth/JWT issues
  // that resolve once the session refreshes.
  return !error.code || String(error.code).startsWith('PGRST3');
}

/** Pull the latest library from Supabase (after pushing local changes). */
async function refresh() {
  if (!user) return;
  await flush();
  const { data, error } = await sb.from(TABLE).select('*').order('updated_at', { ascending: false });
  if (error) {
    syncError = true;
    renderSyncStatus();
    return;
  }
  let fresh = data.map(fromRow).filter(Boolean);
  // Changes still waiting in the outbox win over what the server has.
  for (const [id, row] of Object.entries(outbox)) {
    fresh = fresh.filter(b => b.id !== id);
    if (row) fresh.push(fromRow(row));
  }
  books = fresh;
  writeJSON(cacheKey(), books);
  syncError = false;
  renderSyncStatus();
  renderLibrary();
  if (!$('#addView').hidden && state.results.length) renderResults();
}

function pendingCount() {
  return Object.keys(outbox).length;
}

function renderSyncStatus() {
  const n = pendingCount();
  const badge = $('#syncBadge');
  const offline = !navigator.onLine;
  if (!user || (n === 0 && !syncError)) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
    badge.textContent = offline ? 'Offline' : syncError ? 'Sync failed · retry' : 'Saving…';
    badge.classList.toggle('warn', syncError && !offline);
  }
  $('#syncLine').textContent = n === 0
    ? (syncError ? 'Could not reach Supabase.' : 'All changes saved.')
    : `${n} change${n === 1 ? '' : 's'} waiting to sync${offline ? ' — you’re offline' : ''}.`;
}

$('#syncBadge').addEventListener('click', () => refresh());
window.addEventListener('online', () => refresh());
window.addEventListener('offline', renderSyncStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

/** One-time move of a library saved by the old localStorage-only version. */
function migrateLegacy() {
  const legacy = readJSON(LEGACY_KEY, null);
  if (!Array.isArray(legacy) || !legacy.length) return;
  const have = new Set(books.map(b => b.id));
  let moved = 0;
  for (const b of legacy.map(normalize).filter(Boolean)) {
    if (have.has(b.id)) continue;
    books.push(b);
    outbox[b.id] = toRow(b);
    moved++;
  }
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  if (moved) {
    changed();
    toast(`Moved ${moved} book${moved === 1 ? '' : 's'} from this device to your account`);
  }
}

/* ---------------- auth & screens ---------------- */

function showScreen(name) {
  document.body.classList.remove('booting');
  document.body.classList.toggle('signed-out', name !== 'app');
  $('#bootView').hidden = true;
  $('#setupView').hidden = name !== 'setup';
  $('#authView').hidden = name !== 'auth';
  if (name === 'app') route();
  else { $('#libraryView').hidden = true; $('#addView').hidden = true; }
}

let signUpMode = false;

function setAuthMode(signUp) {
  signUpMode = signUp;
  $('#authTitle').textContent = signUp ? 'Create an account' : 'Sign in';
  $('#authSubmit').textContent = signUp ? 'Create account' : 'Sign in';
  $('#authToggle').textContent = signUp ? 'Already have an account? Sign in' : 'New here? Create an account';
  $('#authForm [name=password]').autocomplete = signUp ? 'new-password' : 'current-password';
  authMessage('');
}

function authMessage(msg, ok = false) {
  const el = $('#authMsg');
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('ok', ok);
}

$('#authToggle').addEventListener('click', () => setAuthMode(!signUpMode));

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const email = String(f.get('email')).trim();
  const password = String(f.get('password'));
  const btn = $('#authSubmit');
  btn.disabled = true;
  authMessage('');
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      if (!data.session) {
        setAuthMode(false);
        authMessage('Check your email to confirm your account, then sign in here.', true);
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    authMessage(err.message || 'Something went wrong. Please try again.');
  } finally {
    btn.disabled = false;
  }
});

let sessionSeen = false;

function handleSession(session) {
  const next = session?.user ?? null;
  // Token refreshes re-fire with the same user — nothing to do.
  if (sessionSeen && next?.id === user?.id) return;
  sessionSeen = true;
  user = next;

  if (!user) {
    books = [];
    outbox = {};
    $('#bookDialog').open && $('#bookDialog').close();
    $('#menuDialog').open && $('#menuDialog').close();
    renderSyncStatus();
    setAuthMode(false);
    showScreen('auth');
    return;
  }

  // Show the cached library immediately, then sync with Supabase.
  outbox = readJSON(outboxKey(), {});
  books = readJSON(cacheKey(), []).map(normalize).filter(Boolean);
  $('#accountEmail').textContent = user.email || '';
  $('#authForm').reset();
  showScreen('app');
  migrateLegacy();
  renderSyncStatus();
  refresh();
}

$('#signOutBtn').addEventListener('click', async () => {
  const n = pendingCount();
  if (n && !confirm(`${n} change${n === 1 ? ' hasn’t' : 's haven’t'} synced yet and will be lost. Sign out anyway?`)) return;
  try {
    localStorage.removeItem(cacheKey());
    localStorage.removeItem(outboxKey());
  } catch { /* ignore */ }
  // 'local' signs out this device only and works offline.
  await sb.auth.signOut({ scope: 'local' });
});

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function percent(b) {
  if (b.status === 'finished') return 100;
  if (!b.totalPages) return 0;
  return Math.min(100, Math.round((b.currentPage / b.totalPages) * 100));
}

function coverHtml(b, size = 'M') {
  const initial = esc((b.title || '?').trim().charAt(0).toUpperCase());
  const img = b.coverId
    ? `<img src="https://covers.openlibrary.org/b/id/${encodeURIComponent(b.coverId)}-${size}.jpg?default=false" alt="" loading="lazy" decoding="async">`
    : '';
  return `<span class="cover"><span class="cover-fallback" aria-hidden="true">${initial}</span>${img}</span>`;
}

// Hide cover images that fail to load so the fallback letter shows through.
document.addEventListener('error', e => {
  if (e.target instanceof HTMLImageElement) e.target.classList.add('broken');
}, true);

/* ---------------- routing ---------------- */

function route() {
  if (!user) return;
  const view = location.hash === '#add' ? 'add' : 'library';
  $('#libraryView').hidden = view !== 'library';
  $('#addView').hidden = view !== 'add';
  for (const a of $$('.nav-item')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (view === 'library') renderLibrary();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

/* ---------------- library ---------------- */

function matches(b, q) {
  return b.title.toLowerCase().includes(q) ||
    b.authors.some(a => a.toLowerCase().includes(q));
}

function renderLibrary() {
  const q = state.filter.trim().toLowerCase();

  const counts = { reading: 0, want: 0, finished: 0, all: books.length };
  for (const b of books) counts[b.status]++;
  for (const tab of $$('.tab')) {
    const s = tab.dataset.status;
    tab.querySelector('.count').textContent = counts[s];
    tab.setAttribute('aria-selected', String(s === state.status));
  }

  // While searching, look across every shelf and hide the tabs.
  $('#tabs').hidden = Boolean(q);
  const list = (q
    ? books.filter(b => matches(b, q))
    : books.filter(b => state.status === 'all' || b.status === state.status)
  ).sort((a, b) => b.updatedAt - a.updatedAt);

  const showStatus = Boolean(q) || state.status === 'all';
  $('#bookList').innerHTML = list.map(b => bookCard(b, showStatus)).join('');

  const empty = $('#emptyState');
  empty.hidden = list.length > 0;
  if (list.length) return;

  if (!books.length) {
    empty.innerHTML = `
      <p class="empty-title">Your shelf is empty</p>
      <p>Find a book to start remembering your page.</p>
      <a class="btn primary" href="#add">Find a book</a>`;
  } else if (q) {
    empty.innerHTML = `
      <p class="empty-title">No matches</p>
      <p>Nothing on your shelf matches “${esc(state.filter.trim())}”.</p>
      <button type="button" class="btn primary" data-search-ol>Search Open Library</button>`;
  } else {
    const msg = {
      reading: 'Books you’re reading will show up here.',
      want: 'Books you want to read will show up here.',
      finished: 'Books you finish will show up here.',
      all: '',
    }[state.status];
    empty.innerHTML = `<p class="empty-title">Nothing here yet</p><p>${msg}</p>`;
  }
}

function bookCard(b, showStatus) {
  const pct = percent(b);
  let meta;
  if (b.status === 'finished') {
    meta = 'Finished' + (b.totalPages ? ` · ${b.totalPages} pages` : '');
  } else if (b.status === 'want' && !b.currentPage) {
    meta = b.totalPages ? `${b.totalPages} pages` : 'Not started';
  } else {
    meta = b.totalPages
      ? `Page ${b.currentPage} of ${b.totalPages} · ${pct}%`
      : `Page ${b.currentPage}`;
  }
  const authors = b.authors.join(', ');
  return `<li>
    <button type="button" class="book-card" data-id="${esc(b.id)}" aria-label="${esc(b.title)}, ${esc(meta)}">
      ${coverHtml(b)}
      <span class="info">
        <span class="title">${esc(b.title)}</span>
        ${authors ? `<span class="author">${esc(authors)}</span>` : ''}
        ${showStatus ? `<span class="badge badge-${b.status}">${STATUS_LABEL[b.status]}</span>` : ''}
        <span class="progress" aria-hidden="true"><span style="width:${pct}%"></span></span>
        <span class="meta">${esc(meta)}</span>
      </span>
    </button>
  </li>`;
}

$('#tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  state.status = tab.dataset.status;
  renderLibrary();
});

$('#libFilter').addEventListener('input', e => {
  state.filter = e.target.value;
  renderLibrary();
});

$('#bookList').addEventListener('click', e => {
  const card = e.target.closest('.book-card');
  if (card) openBook(card.dataset.id);
});

$('#emptyState').addEventListener('click', e => {
  if (!e.target.closest('[data-search-ol]')) return;
  const q = state.filter.trim();
  $('#olQuery').value = q;
  location.hash = '#add';
  if (q) searchOpenLibrary(q);
});

/* ---------------- book sheet ---------------- */

const dialog = $('#bookDialog');
const pageInput = $('#pageInput');
const totalInput = $('#totalInput');

function openBook(id) {
  const b = books.find(x => x.id === id);
  if (!b) return;
  state.editingId = id;
  $('#sheetCover').innerHTML = coverHtml(b);
  $('#sheetTitle').textContent = b.title;
  $('#sheetAuthor').textContent = b.authors.join(', ');
  pageInput.value = b.currentPage;
  totalInput.value = b.totalPages ?? '';
  $(`input[name="status"][value="${b.status}"]`).checked = true;
  updateSheetProgress();
  dialog.showModal();
}

function sheetValues() {
  const total = posInt(totalInput.value);
  let page = Math.max(0, parseInt(pageInput.value, 10) || 0);
  if (total) page = Math.min(page, total);
  return { total, page };
}

function updateSheetProgress() {
  const { total, page } = sheetValues();
  const pct = total ? Math.min(100, Math.round((page / total) * 100)) : 0;
  $('#sheetBar').style.width = pct + '%';
  $('#sheetPct').textContent = total
    ? `${pct}% · ${Math.max(0, total - page)} pages to go`
    : 'Add the total pages to see your progress';
}

$('.stepper').addEventListener('click', e => {
  const btn = e.target.closest('[data-step]');
  if (!btn) return;
  const { total } = sheetValues();
  let next = (parseInt(pageInput.value, 10) || 0) + Number(btn.dataset.step);
  next = Math.max(0, next);
  if (total) next = Math.min(next, total);
  pageInput.value = next;
  updateSheetProgress();
});

pageInput.addEventListener('input', updateSheetProgress);
totalInput.addEventListener('input', updateSheetProgress);
pageInput.addEventListener('focus', () => pageInput.select());

$('#bookForm').addEventListener('submit', e => {
  e.preventDefault();
  const b = books.find(x => x.id === state.editingId);
  if (!b) return dialog.close();

  const { total, page: rawPage } = sheetValues();
  let page = rawPage;
  let status = $('input[name="status"]:checked').value;
  const prev = b.status;

  // Small conveniences when the status wasn't changed by hand.
  if (status === prev) {
    if (status === 'want' && page > 0) status = 'reading';
    if (status === 'reading' && total && page >= total) status = 'finished';
  }
  if (status === 'finished' && prev !== 'finished' && total) page = total;

  Object.assign(b, { currentPage: page, totalPages: total, status, updatedAt: Date.now() });
  persist(b);
  dialog.close();
  renderLibrary();

  if (status === 'finished' && prev !== 'finished') toast(`Finished “${b.title}” 🎉`);
  else if (status !== prev) toast(`Moved to ${STATUS_LABEL[status]}`);
  else toast(`Saved — page ${page}`);
});

$('#deleteBtn').addEventListener('click', () => {
  const idx = books.findIndex(x => x.id === state.editingId);
  if (idx === -1) return;
  const [removed] = books.splice(idx, 1);
  persistDelete(removed.id);
  dialog.close();
  renderLibrary();
  toast(`Removed “${removed.title}”`, 'Undo', () => {
    books.splice(Math.min(idx, books.length), 0, removed);
    persist(removed);
    renderLibrary();
  });
});

/* ---------------- dialogs: shared close behaviour ---------------- */

for (const d of $$('dialog')) {
  d.addEventListener('click', e => {
    if (e.target === d || e.target.closest('[data-close]')) d.close(); // backdrop or ✕
  });
}

$('#menuBtn').addEventListener('click', () => {
  renderSyncStatus();
  $('#menuDialog').showModal();
});

/* ---------------- Open Library search ---------------- */

let debounceTimer;

$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  clearTimeout(debounceTimer);
  const q = $('#olQuery').value.trim();
  if (q) {
    $('#olQuery').blur(); // dismiss the mobile keyboard to reveal results
    searchOpenLibrary(q);
  }
});

$('#olQuery').addEventListener('input', e => {
  clearTimeout(debounceTimer);
  const q = e.target.value.trim();
  if (q.length >= 3) debounceTimer = setTimeout(() => searchOpenLibrary(q), 600);
});

async function searchOpenLibrary(q) {
  state.searchCtrl?.abort();
  const ctrl = new AbortController();
  state.searchCtrl = ctrl;

  const status = $('#searchStatus');
  status.textContent = 'Searching…';
  $('#results').innerHTML = '<li class="skeleton"></li>'.repeat(3);

  const params = new URLSearchParams({ q, fields: OL_FIELDS, limit: '20' });
  try {
    const res = await fetch(`${OL_SEARCH}?${params}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.results = (data.docs || []).filter(d => d.title);
    renderResults();
    status.textContent = state.results.length
      ? `Showing ${state.results.length} of ${Number(data.numFound || 0).toLocaleString()} results`
      : 'No books found. Try other words, or add it manually below.';
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#results').innerHTML = '';
    status.textContent = 'Search failed — check your connection and try again.';
  }
}

function renderResults() {
  const onShelf = new Map(books.filter(b => b.olKey).map(b => [b.olKey, b.id]));
  $('#results').innerHTML = state.results.map((d, i) => {
    const authors = (d.author_name || []).slice(0, 3).join(', ');
    const bits = [
      d.first_publish_year,
      d.number_of_pages_median && `${d.number_of_pages_median} pages`,
    ].filter(Boolean).join(' · ');
    const shelfId = onShelf.get(d.key);
    const action = shelfId
      ? `<button type="button" class="btn small ghost" data-open="${esc(shelfId)}">On shelf</button>`
      : `<button type="button" class="btn small primary" data-add="${i}">Add</button>`;
    return `<li class="result">
      ${coverHtml({ title: d.title, coverId: d.cover_i })}
      <div class="info">
        <p class="title">${esc(d.title)}</p>
        ${authors ? `<p class="author">${esc(authors)}</p>` : ''}
        ${bits ? `<p class="meta">${esc(bits)}</p>` : ''}
      </div>
      ${action}
    </li>`;
  }).join('');
}

$('#results').addEventListener('click', e => {
  const add = e.target.closest('[data-add]');
  const open = e.target.closest('[data-open]');
  if (open) return openBook(open.dataset.open);
  if (!add) return;
  const d = state.results[Number(add.dataset.add)];
  if (!d) return;
  addBook({
    olKey: d.key,
    title: d.title,
    authors: (d.author_name || []).slice(0, 3),
    coverId: d.cover_i,
    totalPages: d.number_of_pages_median,
    year: d.first_publish_year,
  });
});

$('#manualForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const author = String(f.get('author') || '').trim();
  addBook({
    title: String(f.get('title') || ''),
    authors: author ? [author] : [],
    totalPages: f.get('pages'),
  });
  e.target.reset();
  $('#manualDetails').open = false;
});

function addBook(data) {
  const book = normalize({ ...data, id: uid(), status: 'reading', currentPage: 0 });
  if (!book) return;
  books.push(book);
  persist(book);
  state.status = 'reading';
  state.filter = '';
  $('#libFilter').value = '';
  location.hash = '';
  route();
  toast(`Added “${book.title}”`);
  openBook(book.id); // let them set their page straight away
}

/* ---------------- backup ---------------- */

$('#exportBtn').addEventListener('click', () => {
  const payload = { app: 'bookmark', version: 2, exportedAt: new Date().toISOString(), books };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bookmark-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${books.length} book${books.length === 1 ? '' : 's'}`);
});

$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.books);
    if (!Array.isArray(incoming)) throw new Error('bad format');

    // Merge: new books are added; existing ones keep whichever copy is newer.
    const byId = new Map(books.map(b => [b.id, b]));
    let added = 0, updated = 0;
    for (const b of incoming.map(normalize).filter(Boolean)) {
      const existing = byId.get(b.id);
      if (existing && b.updatedAt <= existing.updatedAt) continue;
      existing ? updated++ : added++;
      byId.set(b.id, b);
      outbox[b.id] = toRow(b);
    }
    books = [...byId.values()];
    changed();
    renderLibrary();
    $('#menuDialog').close();
    toast(`Imported ${added} new, ${updated} updated`);
  } catch {
    toast('That file isn’t a valid Bookmark backup');
  } finally {
    e.target.value = '';
  }
});

/* ---------------- toast ---------------- */

let toastTimer;
function toast(msg, actionLabel, onAction) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (actionLabel) {
    el.querySelector('button').addEventListener('click', () => {
      el.hidden = true;
      onAction();
    }, { once: true });
  }
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 5000 : 2500);
}

/* ---------------- boot ---------------- */

function boot() {
  const { supabaseUrl, supabaseKey } = CONFIG;
  if (!supabaseUrl || !supabaseKey || /YOUR[-_]/.test(supabaseUrl + supabaseKey)) {
    showScreen('setup');
    return;
  }
  if (!window.supabase?.createClient) {
    $('#setupMsg').textContent = 'The Supabase library failed to load. Check your connection and reload.';
    showScreen('setup');
    return;
  }
  sb = window.supabase.createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Fires once with the stored session (INITIAL_SESSION), then on every sign-in/out.
  // Supabase recommends not awaiting other Supabase calls inside this callback.
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => handleSession(session), 0));
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

boot();
