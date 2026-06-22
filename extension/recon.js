const BRIDGE = 'http://localhost:3458';

let comments = [];
let mentions = [];
let auditRunning = false;
let scanRunning = false;
let brands = [];
let activeBrand = null;      // active brand id (sent on every bridge request)
let activeBrandObj = null;   // full active brand object (terms, domain, name)
let scanStop = false;        // set by Stop scan
let analyzeRunning = false;  // true while an analyze run is in progress

function brandName() { return (activeBrandObj && activeBrandObj.name) || 'Brand'; }

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-log').addEventListener('click', handleLog);
  document.getElementById('input-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLog();
  });
  document.getElementById('btn-scan-mentions').addEventListener('click', onScanButton);
  document.getElementById('btn-reset-rescan').addEventListener('click', handleResetAndRescan);
  document.getElementById('mention-search').addEventListener('input', renderMentions);
  document.getElementById('btn-extract-comments').addEventListener('click', handleExtractComments);
  document.getElementById('btn-cleanup').addEventListener('click', handleCleanup);
  document.getElementById('btn-scan-overview').addEventListener('click', handleScanOverview);
  document.getElementById('btn-cleanup-citations').addEventListener('click', handleCleanupCitations);
  document.getElementById('brand-select').addEventListener('change', onBrandChange);
  document.getElementById('btn-add-brand').addEventListener('click', () => toggleAddBrandForm());
  document.getElementById('btn-add-brand-submit').addEventListener('click', handleAddBrand);
  document.getElementById('btn-add-brand-cancel').addEventListener('click', () => toggleAddBrandForm(false));
  document.getElementById('btn-download-backup').addEventListener('click', handleDownloadBackup);
  document.getElementById('btn-import-backup').addEventListener('click', handleImportClick);
  document.getElementById('import-file').addEventListener('change', handleImportFile);
  document.getElementById('btn-delete-brand').addEventListener('click', handleDeleteBrand);
  document.getElementById('btn-connect').addEventListener('click', () => document.getElementById('connect-bar').classList.remove('hidden'));
  document.getElementById('btn-close-connect').addEventListener('click', () => document.getElementById('connect-bar').classList.add('hidden'));
  document.getElementById('btn-check-selectors').addEventListener('click', handleCheckSelectors);
  document.getElementById('btn-close-selectors').addEventListener('click', () => document.getElementById('selector-panel').classList.add('hidden'));
  document.getElementById('btn-check-ai').addEventListener('click', handleCheckCommentsAi);
  document.getElementById('btn-help').addEventListener('click', () => document.getElementById('onboard-overlay').classList.remove('hidden'));
  document.getElementById('btn-onboard-done').addEventListener('click', () => {
    try { localStorage.setItem('rt_onboarded', '1'); } catch (e) {}
    document.getElementById('onboard-overlay').classList.add('hidden');
  });
  try { if (!localStorage.getItem('rt_onboarded')) document.getElementById('onboard-overlay').classList.remove('hidden'); } catch (e) {}
  document.getElementById('btn-copy-cmd').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('connect-cmd').textContent).then(() => {
      const b = document.getElementById('btn-copy-cmd');
      b.textContent = 'Copied!';
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });
  });

  await loadBrandsAndSelect();
  loadAllForBrand();
  checkBridge();
  setInterval(checkBridge, 15000);
});

// ── Bridge status ─────────────────────────────────────────────────────────────

let bridgeOnline = null;

async function checkBridge() {
  let online = false, claudeOk = true;
  try { const d = await (await fetch(`${BRIDGE}/ping`)).json(); online = !!(d && d.ok); claudeOk = d.claude !== false; }
  catch { online = false; }
  setBridgeStatus(online, claudeOk);
  // When the bridge comes up after being down, refresh the dashboard automatically.
  if (online && bridgeOnline === false) {
    await loadBrandsAndSelect();
    loadAllForBrand();
  }
  bridgeOnline = online;
}

function setBridgeStatus(online, claudeOk) {
  const dot = document.getElementById('bridge-status');
  const label = document.getElementById('bridge-label');
  const btnConn = document.getElementById('btn-connect');
  if (online) {
    dot.className = 'status-dot online';
    if (claudeOk) {
      label.style.color = 'var(--text2)';
      label.textContent = 'Bridge online';
    } else {
      // Bridge is up but the claude CLI isn't on PATH → Analyze + Log won't work.
      label.style.color = 'var(--danger)';
      label.textContent = 'Bridge online · Claude CLI not found';
    }
    btnConn.classList.add('hidden');
    document.getElementById('connect-bar').classList.add('hidden');
  } else {
    dot.className = 'status-dot offline';
    label.style.color = 'var(--text2)';
    label.textContent = 'Bridge offline';
    btnConn.classList.remove('hidden');
  }
}

// ── Brands ──────────────────────────────────────────────────────────────────

function loadAllForBrand() {
  loadComments();
  loadMentions();
  loadScanMeta();
  loadOverview();
  loadCitedThreads();
  loadAnalysis();
}

async function loadBrandsAndSelect() {
  try {
    brands = await (await fetch(`${BRIDGE}/brands`)).json();
  } catch (e) {
    brands = [];   // header status dot reflects offline; no duplicate message here
  }
  const sel = document.getElementById('brand-select');
  if (!brands.length) {
    sel.innerHTML = '<option value="">— No brands yet —</option>';
    activeBrand = null;
    activeBrandObj = null;
    toggleAddBrandForm(true);   // guide the operator to add their first brand
    return;
  }
  sel.innerHTML = brands.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  if (!activeBrand || !brands.find(b => b.id === activeBrand)) activeBrand = brands[0].id;
  sel.value = activeBrand;
  activeBrandObj = brands.find(b => b.id === activeBrand);
}

function onBrandChange() {
  const sel = document.getElementById('brand-select');
  // Block switching brands while a scan or analysis is running for the current
  // brand — the in-flight run writes to the active brand's folder.
  if (scanRunning || analyzeRunning) {
    sel.value = activeBrand;   // revert the dropdown
    setBrandStatus(`Stop the running ${scanRunning ? 'scan' : 'analysis'} before switching brands`, true);
    return;
  }
  activeBrand = sel.value;
  activeBrandObj = brands.find(b => b.id === activeBrand) || null;
  // reset transient state, then reload everything for the newly selected brand
  comments = [];
  mentions = [];
  overviewData = {};
  document.getElementById('mention-search').value = '';
  loadAllForBrand();
}

function toggleAddBrandForm(show) {
  const form = document.getElementById('add-brand-form');
  const open = show === undefined ? form.style.display === 'none' : show;
  form.style.display = open ? 'block' : 'none';
}

function setAddBrandStatus(msg, isErr, isOk) {
  const el = document.getElementById('add-brand-status');
  el.className = 'log-status' + (isErr ? ' error' : isOk ? ' ok' : '');
  el.innerHTML = msg;
}

async function handleAddBrand() {
  const get = id => document.getElementById(id).value.trim();
  const name = get('brand-name');
  const description = get('brand-description');
  if (!name || !description) { setAddBrandStatus('Brand Name and Description / brand brain are required', true); return; }
  const payload = {
    name,
    url: get('brand-url'),
    productNames: get('brand-products'),
    excludeAuthors: get('brand-account'),
    terms: get('brand-terms'),
    description,
  };
  const btn = document.getElementById('btn-add-brand-submit');
  btn.disabled = true;
  setAddBrandStatus('<span class="spinner"></span>Building relevancy checker from the description…');
  try {
    const res = await fetch(`${BRIDGE}/brands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed');
    ['brand-name', 'brand-url', 'brand-products', 'brand-account', 'brand-terms', 'brand-description']
      .forEach(id => { document.getElementById(id).value = ''; });
    setAddBrandStatus(`Added ${esc(data.name)}${data.warning ? ' — ' + esc(data.warning) : ''}`, false, true);
    activeBrand = data.id;
    await loadBrandsAndSelect();
    loadAllForBrand();
    setTimeout(() => toggleAddBrandForm(false), 1200);
  } catch (e) {
    setAddBrandStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function setBrandStatus(msg, isErr, isOk) {
  const el = document.getElementById('brand-status');
  el.className = 'log-status' + (isErr ? ' error' : isOk ? ' ok' : '');
  el.innerHTML = msg;
}

// Save a JSON bundle to the user's downloads.
function downloadBundle(bundle, filename) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Fetch the brand's full bundle (this also refreshes the on-disk backup in the
// install folder) and download a timestamped copy. Returns the bundle.
async function fetchAndDownloadBackup(brandId) {
  const res = await fetch(`${BRIDGE}/brands/${brandId}/export`);
  const bundle = await res.json();
  if (!res.ok || bundle.error) throw new Error(bundle.error || 'Export failed');
  downloadBundle(bundle, `${brandId}-backup-${new Date().toISOString().slice(0, 10)}.json`);
  return bundle;
}

// Refresh the on-disk backup in the install folder (no download). Fire-and-forget.
async function silentBackup() {
  if (!activeBrand) return;
  try { await fetch(`${BRIDGE}/brands/${activeBrand}/backup`, { method: 'POST' }); } catch {}
}

function handleImportClick() {
  document.getElementById('import-file').click();
}

// Inline Merge / Overwrite / Cancel choice, shown when the brand already exists.
// Resolves to 'merge', 'overwrite', or null (cancel).
function askImportMode(name) {
  return new Promise(resolve => {
    const el = document.getElementById('brand-status');
    el.className = 'log-status';
    el.innerHTML = `"${esc(name)}" already exists — `
      + `<button class="btn btn-primary btn-sm" id="im-merge">Merge</button> `
      + `<button class="btn btn-ghost btn-sm" id="im-overwrite">Overwrite</button> `
      + `<button class="btn btn-ghost btn-sm" id="im-cancel">Cancel</button>`;
    const done = v => { resolve(v); };
    document.getElementById('im-merge').onclick = () => done('merge');
    document.getElementById('im-overwrite').onclick = () => done('overwrite');
    document.getElementById('im-cancel').onclick = () => done(null);
  });
}

async function handleImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let bundle;
    try { bundle = JSON.parse(text); } catch { throw new Error('Not a valid backup JSON file'); }
    if (!bundle.brand || !bundle.brand.id) throw new Error('Backup file is missing brand info');

    // Step 1: is this brand already present? If not, import wholesale.
    let mode = 'new';
    if (brands.some(b => b.id === bundle.brand.id)) {
      // Step 2: brand exists — ask Merge or Overwrite.
      mode = await askImportMode(bundle.brand.name);
      if (!mode) { setBrandStatus('Import cancelled'); return; }
      if (mode === 'overwrite' && !confirm(`Overwrite "${bundle.brand.name}"?\n\nThis CLEARS the brand's current data and replaces it with the backup. (Its current state is saved to the backups/ folder first.)`)) {
        setBrandStatus('Import cancelled'); return;
      }
    }

    setBrandStatus('<span class="spinner"></span>Importing…');
    const res = await fetch(`${BRIDGE}/brands/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundle, mode }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Import failed');
    activeBrand = data.imported;
    await loadBrandsAndSelect();
    loadAllForBrand();
    const verb = data.mode === 'merge' ? 'Merged into' : data.mode === 'overwrite' ? 'Overwrote' : 'Imported';
    setBrandStatus(`${verb} ${esc(data.name)} — ${data.files} data file(s)`, false, true);
  } catch (err) {
    setBrandStatus('Import failed: ' + err.message, true);
  } finally {
    e.target.value = '';   // reset so the same file can be re-selected
  }
}

async function handleDownloadBackup() {
  if (!activeBrand) { setBrandStatus('No brand selected', true); return; }
  const btn = document.getElementById('btn-download-backup');
  btn.disabled = true;
  setBrandStatus('<span class="spinner"></span>Backing up…');
  try {
    await fetchAndDownloadBackup(activeBrand);
    setBrandStatus('Saved to install folder + downloaded', false, true);
  } catch (e) {
    setBrandStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleDeleteBrand() {
  if (!activeBrand) { setBrandStatus('No brand selected', true); return; }
  const name = (activeBrandObj && activeBrandObj.name) || activeBrand;
  if (!confirm(`Delete "${name}"?\n\nAll its data will be downloaded as a backup FIRST, then the brand is removed. A copy is also kept in the install folder's backups/ folder.`)) return;
  const btn = document.getElementById('btn-delete-brand');
  btn.disabled = true;
  setBrandStatus('<span class="spinner"></span>Backing up before delete…');
  try {
    await fetchAndDownloadBackup(activeBrand);   // auto-download all data BEFORE deletion
    setBrandStatus('<span class="spinner"></span>Deleting…');
    const res = await fetch(`${BRIDGE}/brands/${activeBrand}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Delete failed');
    activeBrand = null;
    await loadBrandsAndSelect();
    loadAllForBrand();
    setBrandStatus(`Deleted ${esc(name)} — backup downloaded + kept at ${esc(data.backupKept || 'backups/')}`, false, true);
  } catch (e) {
    setBrandStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Data ──────────────────────────────────────────────────────────────────────

let lastScannedAt = null;
let mentionSortDir = 'desc';

async function loadScanMeta() {
  try {
    const res = await fetch(`${BRIDGE}/recon/scan-meta?brand=${activeBrand}`);
    const data = await res.json();
    lastScannedAt = data.last_scanned_at || null;
    updateLastScanLabel();
  } catch (e) {}
}

function updateLastScanLabel() {
  const el = document.getElementById('last-scan-label');
  if (!el) return;
  el.textContent = lastScannedAt
    ? `Last scan: ${new Date(lastScannedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : 'Never scanned';
}

async function loadComments() {
  try {
    const res = await fetch(`${BRIDGE}/recon/comments?brand=${activeBrand}`);
    comments = (await res.json()).map(c => ({
      ...c,
      audit_results: typeof c.audit_results === 'string' ? JSON.parse(c.audit_results) : c.audit_results,
      queries: typeof c.queries === 'string' ? JSON.parse(c.queries) : c.queries,
    }));
    renderAll();
  } catch (e) {
    // header status dot already shows offline; no duplicate message here
  }
}

function updateStats() {
  const total = comments.length;
  const audited = comments.filter(c => c.audit_results).length;
  let sbHits = 0;
  let lastAudit = null;
  for (const c of comments) {
    if (c.audit_results) {
      sbHits += c.audit_results.filter(r => r.smashBalloonInOverview).length;
      if (!lastAudit || c.last_audited_at > lastAudit) lastAudit = c.last_audited_at;
    }
  }
  document.getElementById('stat-comments').textContent = total;
  document.getElementById('stat-audited').textContent = audited;
  const overviewHits = Object.values(overviewData).filter(k => k.smashBalloonInOverview).length;
  document.getElementById('stat-sb-hits').textContent = sbHits + overviewHits;
  document.getElementById('stat-last-audit').textContent = lastAudit
    ? new Date(lastAudit).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';
  document.getElementById('stat-mentions').textContent = mentions.length || '—';
  document.getElementById('comment-count').textContent = total ? `${total} total` : '';
  document.getElementById('mention-count').textContent = mentions.length ? `${mentions.length} total` : '';
}

// ── Log ───────────────────────────────────────────────────────────────────────

async function handleLog() {
  const url = document.getElementById('input-url').value.trim();
  if (!url) return;
  if (!url.includes('reddit.com/r/')) { setLogStatus('Must be a Reddit comment URL', true); return; }

  const btn = document.getElementById('btn-log');
  btn.disabled = true;
  setLogStatus('<span class="spinner"></span>Fetching thread and generating queries…');

  try {
    // Scrape the thread in-browser (platform-agnostic — no server-side AppleScript)
    // and hand the post + comments to the bridge to build context + queries.
    const thread = await scrapeRedditThread(url);
    const res = await fetch(`${BRIDGE}/recon/log?brand=${activeBrand}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentUrl: url, thread }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed');
    document.getElementById('input-url').value = '';
    setLogStatus(`Logged — ${data.queries.length} queries generated`, false, true);
    comments.unshift(data);
    renderAll();
  } catch (e) {
    setLogStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function setLogStatus(msg, isErr, isOk) {
  const el = document.getElementById('log-status');
  el.className = 'log-status' + (isErr ? ' error' : isOk ? ' ok' : '');
  el.innerHTML = msg;
}

// ── Check logged comments for AI writing (batch over all logged comments) ───────
async function handleCheckCommentsAi() {
  if (!comments.length) { setLogStatus('No logged comments to check', true); return; }
  const btn = document.getElementById('btn-check-ai');
  btn.disabled = true; btn.textContent = 'Checking…';
  setLogStatus('<span class="spinner"></span>Checking logged comments for AI writing…');
  try {
    const res = await fetch(`${BRIDGE}/recon/comments/ai-check?brand=${activeBrand}`, { method: 'POST' });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || 'Check failed');
    await loadComments();   // reloads with ai_check on each record, re-renders cards
    setLogStatus(`Checked ${d.checked} comment${d.checked === 1 ? '' : 's'} — ${d.aiLike} read as AI-written`, false, true);
  } catch (e) {
    setLogStatus(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Check AI Writing';
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderAll() {
  updateStats();
  const list = document.getElementById('comment-list');
  if (!comments.length) {
    list.innerHTML = '<div class="empty-state">No comments logged yet. Paste a Reddit comment URL above.</div>';
    return;
  }
  list.innerHTML = '';
  for (const c of comments) {
    list.appendChild(buildCard(c));
  }
}

function buildCard(c) {
  const card = document.createElement('div');
  card.className = 'comment-card';
  card.dataset.id = c.id;

  const audited = !!c.audit_results;
  const dateStr = new Date(c.logged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const ai = c.ai_check;
  const aiBadge = ai ? (() => {
    const col = ai.verdict === 'ai' ? 'var(--danger)' : ai.verdict === 'mixed' ? '#f59e0b' : 'var(--success)';
    const lbl = ai.verdict === 'ai' ? 'AI?' : ai.verdict === 'mixed' ? 'Mixed' : 'Human';
    const tip = (ai.tells && ai.tells.length) ? ai.tells.join(', ') : 'no AI tells';
    return `<span title="AI score ${ai.score ?? '?'}/100 — ${esc(tip)}" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;border:1px solid ${col};color:${col}">${lbl}</span>`;
  })() : '';

  card.innerHTML = `
    <div class="comment-row">
      <span class="comment-sub">${esc(c.subreddit)}</span>
      <span class="comment-title">${esc(c.thread_title)}</span>
      <span class="comment-date">${dateStr}</span>
      ${aiBadge}
      <span class="comment-audit-badge ${audited ? 'badge-audited' : 'badge-pending'}">${audited ? 'Audited' : 'Pending'}</span>
      <span class="comment-chevron">▶</span>
    </div>
    <div class="comment-detail">${buildDetail(c)}</div>
  `;

  card.querySelector('.comment-row').addEventListener('click', () => {
    card.classList.toggle('open');
  });

  card.querySelector('.btn-delete')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this comment record?')) return;
    await fetch(`${BRIDGE}/recon/comment/${c.id}?brand=${activeBrand}`, { method: 'DELETE' });
    comments = comments.filter(x => x.id !== c.id);
    renderAll();
  });

  const auditBtn = card.querySelector('.btn-run-audit');
  if (auditBtn) {
    auditBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (auditRunning) return;
      await runAudit(c.id, card);
    });
  }

  return card;
}

function buildDetail(c) {
  const auditRows = c.audit_results
    ? c.audit_results.map(r => `
        <tr>
          <td>${esc(r.query)}</td>
          <td><span class="aio-badge aio-${r.aio}">${r.aio}</span></td>
          <td class="result-cell ${r.hasAIOverview ? 'hit' : ''}">
            <span class="result-dot ${r.hasAIOverview ? 'dot-yes' : 'dot-no'}"></span>${r.hasAIOverview ? 'Yes' : 'No'}
          </td>
          <td class="result-cell ${r.smashBalloonCited ? 'hit' : ''}">
            <span class="result-dot ${r.smashBalloonCited ? 'dot-yes' : 'dot-no'}"></span>${r.smashBalloonCited ? 'Cited' : '—'}
          </td>
          <td class="result-cell ${r.smashBalloonInOverview ? 'hit' : ''}">
            <span class="result-dot ${r.smashBalloonInOverview ? 'dot-yes' : 'dot-no'}"></span>${r.smashBalloonInOverview ? 'Yes' : '—'}
          </td>
          <td class="result-cell ${r.redditCited ? 'hit' : ''}">
            <span class="result-dot ${r.redditCited ? 'dot-yes' : 'dot-no'}"></span>${r.redditCited ? 'Yes' : '—'}
          </td>
        </tr>`)
    .join('')
    : c.queries.map(q => `
        <tr>
          <td>${esc(q.query)}</td>
          <td><span class="aio-badge aio-${q.aio}">${q.aio}</span></td>
          <td class="result-cell" colspan="4" style="color:#444">Not audited</td>
        </tr>`)
    .join('');

  const lastAuditStr = c.last_audited_at
    ? `Audited ${new Date(c.last_audited_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : '';

  return `
    ${c.comment_text ? `<div class="detail-comment-text">${esc(c.comment_text)}</div>` : ''}
    <div class="detail-meta">
      <a href="${esc(c.reddit_url)}" target="_blank">Open thread ↗</a>
      ${lastAuditStr ? `<span style="color:var(--text2);font-size:11px">${lastAuditStr}</span>` : ''}
    </div>
    <div class="detail-actions">
      <button class="btn btn-primary btn-sm btn-run-audit">Run Audit</button>
      <span class="audit-progress" id="audit-progress-${c.id}"></span>
      <button class="btn btn-ghost btn-sm btn-delete" style="margin-left:auto">Delete</button>
    </div>
    <table class="query-table">
      <thead>
        <tr>
          <th>Query</th>
          <th>AIO Score</th>
          <th>AI Overview</th>
          <th>Brand Cited</th>
          <th>In Overview</th>
          <th>Reddit Cited</th>
        </tr>
      </thead>
      <tbody id="query-tbody-${c.id}">${auditRows}</tbody>
    </table>
  `;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

async function runAudit(commentId, card) {
  auditRunning = true;
  const progressEl = card.querySelector(`#audit-progress-${commentId}`);
  const auditBtn = card.querySelector('.btn-run-audit');
  if (auditBtn) auditBtn.disabled = true;

  const setProgress = msg => { if (progressEl) progressEl.innerHTML = msg; };
  setProgress('<span class="spinner"></span>Starting…');

  try {
    const startRes = await fetch(`${BRIDGE}/recon/audit/start/${commentId}?brand=${activeBrand}`, { method: 'POST' });
    const { total, tasks } = await startRes.json();
    let succeeded = 0, failed = 0;

    for (let i = 0; i < total; i++) {
      const taskRes = await fetch(`${BRIDGE}/recon/audit/next-task?brand=${activeBrand}`);
      const task = await taskRes.json();
      if (!task) break;

      setProgress(`<span class="spinner"></span>${i + 1}/${total}: ${esc(task.query)}`);

      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(task.query)}&gl=us&hl=en&pws=0`;
      let tab = null;
      let result;
      try {
        tab = await chrome.tabs.create({ url: searchUrl, active: true });
        await waitForTabLoad(tab.id);
        await sleep(5000);

        // Unbounded manual CAPTCHA clear — wait until the operator solves it (poll
        // every 15s). No deadline. Closing the tab throws below → failed task.
        let waited = 0;
        while (true) {
          const [ck] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => /unusual traffic|not a robot|captcha|recaptcha/i.test(document.body.innerText),
          });
          if (!ck.result) break;
          await chrome.tabs.update(tab.id, { active: true });
          setProgress(`⚠️ CAPTCHA on ${i + 1}/${total} — solve it (waited ${waited}s)…`);
          waited += 15;
          await sleep(15000);
        }

        await sleep(500);
        const [scraped] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeGooglePage,
          args: [task, { terms: (activeBrandObj && activeBrandObj.terms) || [], domain: (activeBrandObj && activeBrandObj.domain) || '' }],
        });
        const r = scraped?.result || {};
        result = r.captcha ? { status: 'failed', error: 'captcha' } : { ...r, status: 'success' };
      } catch (err) {
        console.error('[recon audit] task error:', err.message);
        result = { status: 'failed', error: err.message };
      } finally {
        if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
      }

      // Always submit a terminal result so the queue advances honestly (no
      // retry-in-place, no false "complete" while tasks remain unaudited).
      try {
        const submitRes = await fetch(`${BRIDGE}/recon/audit/submit-result?brand=${activeBrand}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: task.id, result }),
        });
        const { allSuccess } = await submitRes.json();
        if (result.status === 'success') { succeeded++; updateQueryRow(commentId, task, result); }
        else failed++;
        if (allSuccess) {
          const fresh = await fetch(`${BRIDGE}/recon/comment/${commentId}?brand=${activeBrand}`);
          const updated = await fresh.json();
          const idx = comments.findIndex(c => c.id === commentId);
          if (idx !== -1) comments[idx] = updated;
          updateStats();
        }
      } catch (err) {
        console.error('[recon audit] submit failed:', err.message);
        failed++;
      }
      await sleep(3000 + Math.random() * 2000);
    }

    if (failed === 0) {
      setProgress('Audit complete');
      const badgeEl = card.querySelector('.comment-audit-badge');
      if (badgeEl) { badgeEl.className = 'comment-audit-badge badge-audited'; badgeEl.textContent = 'Audited'; }
    } else {
      setProgress(`Audited ${succeeded}/${total} — ${failed} failed (CAPTCHA or scrape error). Re-run to finish.`);
    }
  } catch (err) {
    setProgress(`Error: ${esc(err.message)}`);
  } finally {
    auditRunning = false;
    if (auditBtn) auditBtn.disabled = false;
  }
}

function updateQueryRow(commentId, task, result) {
  const tbody = document.getElementById(`query-tbody-${commentId}`);
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr');
  const taskIndex = parseInt(task.id.split('_').pop(), 10);
  const row = rows[taskIndex];
  if (!row) return;

  const dot = v => `<span class="result-dot ${v ? 'dot-yes' : 'dot-no'}"></span>`;
  row.cells[2].className = `result-cell ${result.hasAIOverview ? 'hit' : ''}`;
  row.cells[2].innerHTML = `${dot(result.hasAIOverview)}${result.hasAIOverview ? 'Yes' : 'No'}`;
  row.cells[3].className = `result-cell ${result.smashBalloonCited ? 'hit' : ''}`;
  row.cells[3].innerHTML = `${dot(result.smashBalloonCited)}${result.smashBalloonCited ? 'Cited' : '—'}`;
  row.cells[4].className = `result-cell ${result.smashBalloonInOverview ? 'hit' : ''}`;
  row.cells[4].innerHTML = `${dot(result.smashBalloonInOverview)}${result.smashBalloonInOverview ? 'Yes' : '—'}`;
  row.cells[5].className = `result-cell ${result.redditCited ? 'hit' : ''}`;
  row.cells[5].innerHTML = `${dot(result.redditCited)}${result.redditCited ? 'Yes' : '—'}`;
}

// ── Mentions ──────────────────────────────────────────────────────────────────

// ── Cited Threads ─────────────────────────────────────────────────────────────

async function loadCitedThreads() {
  try {
    const res = await fetch(`${BRIDGE}/recon/cited-threads?brand=${activeBrand}`);
    const threads = await res.json();
    renderCitedThreads(threads);
  } catch (e) {}
}

function renderCitedThreads(threads) {
  const list = document.getElementById('cited-list');
  const count = document.getElementById('cited-count');
  count.textContent = threads.length ? `${threads.length} threads` : '';

  if (!threads.length) {
    list.innerHTML = `<div class="empty-state">No cited threads yet — run audits on logged comments</div>`;
    return;
  }

  list.innerHTML = `
    <table class="query-table" style="width:100%">
      <thead><tr>
        <th>Thread</th>
        <th>Queries</th>
        <th>First Seen</th>
      </tr></thead>
      <tbody>
        ${threads.map(t => {
          const slug = t.url.split('/comments/')[1]?.split('/').slice(0,2).join('/') || t.url;
          const firstSeen = t.first_seen ? new Date(t.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
          return `
            <tr>
              <td style="padding:7px 10px">
                <a href="${esc(t.url)}" target="_blank" style="color:var(--accent);font-size:12px;text-decoration:none">${esc(slug)}</a>
              </td>
              <td style="padding:7px 10px">
                <div style="display:flex;flex-wrap:wrap;gap:4px">
                  ${t.queries.map(q => `<span style="font-size:10px;background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:2px 6px;color:var(--text2)">${esc(q.query)}</span>`).join('')}
                </div>
              </td>
              <td style="padding:7px 10px;font-size:11px;color:var(--text2);white-space:nowrap">${firstSeen}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ── General Overview ──────────────────────────────────────────────────────────

let overviewData = {};
let overviewRunning = false;

async function loadOverview() {
  try {
    const res = await fetch(`${BRIDGE}/recon/overview?brand=${activeBrand}`);
    overviewData = await res.json();
    renderOverview();
  } catch (e) {}
}

function renderOverview() {
  const list = document.getElementById('overview-list');
  const hitCount = document.getElementById('overview-hit-count');
  const keywords = Object.values(overviewData);
  const sbHits = keywords.filter(k => k.smashBalloonCited || k.smashBalloonInOverview).length;
  hitCount.textContent = keywords.length ? `${sbHits} ${brandName()} hits / ${keywords.length} checked` : '';

  if (!keywords.length) {
    list.innerHTML = `<div class="empty-state">No keywords scanned yet — click Scan Keywords</div>`;
    return;
  }

  const dot = v => `<span class="result-dot ${v ? 'dot-yes' : 'dot-no'}"></span>`;
  const rows = Object.entries(overviewData).map(([kw, d]) => {
    const checked = d.last_checked ? new Date(d.last_checked).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
    const firstSeen = d.sb_first_seen ? new Date(d.sb_first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    const brandDomain = (activeBrandObj && activeBrandObj.domain) || '';
    const sbLinks = brandDomain ? (d.citationLinks || []).filter(l => l.includes(brandDomain)) : [];

    const redditLinks = (d.citationLinks || []).filter(l => l.includes('reddit.com'));
    const expandable = redditLinks.length || sbLinks.length || d.smashBalloonInOverview;

    const detailRows = expandable ? `
      <tr id="overview-detail-${encodeURIComponent(kw)}" style="display:none">
        <td colspan="6" style="padding:8px 12px 10px 28px;background:var(--bg3);border-bottom:1px solid var(--border)">
          ${firstSeen ? `<div style="font-size:10px;color:var(--text2);margin-bottom:6px">First identified: ${firstSeen}</div>` : ''}
          ${redditLinks.length ? `<div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Reddit citations</div>${redditLinks.map(l => `<div style="font-size:11px;margin-bottom:3px"><a href="${esc(l)}" target="_blank" style="color:var(--accent);text-decoration:none">${esc(l)}</a></div>`).join('')}` : ''}
          ${sbLinks.length ? `<div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px">${esc(brandName())} citations</div>${sbLinks.map(l => `<div style="font-size:11px;margin-bottom:3px"><a href="${esc(l)}" target="_blank" style="color:var(--accent);text-decoration:none">${esc(l)}</a></div>`).join('')}` : ''}
          ${d.smashBalloonInOverview ? `<div style="font-size:11px;color:var(--success);margin-top:4px">▲ Mentioned in AI Overview text</div>` : ''}
        </td>
      </tr>` : '';

    return `
      <tr class="overview-row" data-kw="${esc(kw)}" style="cursor:${expandable ? 'pointer' : 'default'}">
        <td style="padding:7px 10px;font-size:12px;color:var(--text)">${esc(kw)}</td>
        <td style="padding:7px 10px;font-size:11px">${dot(d.hasAIOverview)}${d.hasAIOverview ? '<span style="color:var(--success)">Yes</span>' : '<span style="color:var(--text2)">No</span>'}</td>
        <td style="padding:7px 10px;font-size:11px">${dot(redditLinks.length)}${redditLinks.length ? `<span style="color:var(--success);font-weight:600">${redditLinks.length} link${redditLinks.length > 1 ? 's' : ''}</span>` : '<span style="color:var(--text2)">—</span>'}</td>
        <td style="padding:7px 10px;font-size:11px">${dot(d.smashBalloonCited)}${d.smashBalloonCited ? '<span style="color:var(--success);font-weight:600">Cited</span>' : '<span style="color:var(--text2)">—</span>'}</td>
        <td style="padding:7px 10px;font-size:11px">${dot(d.smashBalloonInOverview)}${d.smashBalloonInOverview ? '<span style="color:var(--success)">Yes</span>' : '<span style="color:var(--text2)">—</span>'}</td>
        <td style="padding:7px 10px;font-size:10px;color:var(--text2)">${checked}</td>
      </tr>
      ${detailRows}`;
  }).join('');

  list.innerHTML = `
    <table class="query-table" style="width:100%">
      <thead><tr>
        <th>Keyword</th>
        <th>AI Overview</th>
        <th>Reddit Cited</th>
        <th>Brand Cited</th>
        <th>In Overview</th>
        <th>Last Checked</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  list.querySelectorAll('.overview-row').forEach(row => {
    row.addEventListener('click', () => {
      const kw = row.getAttribute('data-kw');
      const detail = document.getElementById(`overview-detail-${encodeURIComponent(kw)}`);
      if (detail) detail.style.display = detail.style.display === 'none' ? '' : 'none';
    });
  });
}

async function handleScanOverview() {
  if (overviewRunning) return;
  overviewRunning = true;
  const btn = document.getElementById('btn-scan-overview');
  const status = document.getElementById('overview-status');
  btn.disabled = true;
  status.innerHTML = '<span class="spinner"></span>Starting scan…';

  try {
    const startRes = await fetch(`${BRIDGE}/recon/overview/start?brand=${activeBrand}`, { method: 'POST' });
    const { total } = await startRes.json();
    let scanned = 0, failed = 0;

    for (let i = 0; i < total; i++) {
      const taskRes = await fetch(`${BRIDGE}/recon/overview/next-task?brand=${activeBrand}`);
      const task = await taskRes.json();
      if (!task) break;

      status.innerHTML = `<span class="spinner"></span>${i + 1}/${total}: ${esc(task.keyword)}`;
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(task.keyword)}&gl=us&hl=en&pws=0`;
      let tab = null;
      let result;
      try {
        tab = await chrome.tabs.create({ url: searchUrl, active: false });
        await waitForTabLoad(tab.id);
        await sleep(4000);

        // Unbounded manual CAPTCHA clear — same as the mention scan (poll every 15s).
        let waited = 0;
        while (true) {
          const [ck] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => /unusual traffic|not a robot|captcha|recaptcha/i.test(document.body.innerText),
          });
          if (!ck.result) break;
          await chrome.tabs.update(tab.id, { active: true });
          status.innerHTML = `⚠️ CAPTCHA on ${i + 1}/${total} — solve it (waited ${waited}s)…`;
          waited += 15;
          await sleep(15000);
        }

        await sleep(500);
        const [scraped] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeGooglePage,
          args: [task, { terms: (activeBrandObj && activeBrandObj.terms) || [], domain: (activeBrandObj && activeBrandObj.domain) || '' }],
        });
        const r = scraped?.result || {};
        result = r.captcha ? { status: 'failed', error: 'captcha' } : { ...r, status: 'success' };
      } catch (err) {
        console.error('[overview] task error:', err.message);
        result = { status: 'failed', error: err.message };
      } finally {
        if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
      }

      // Always submit a terminal result so the queue advances honestly.
      try {
        await fetch(`${BRIDGE}/recon/overview/submit-result?brand=${activeBrand}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: task.id, result }),
        });
        if (result.status === 'success') {
          scanned++;
          overviewData[task.keyword] = {
            keyword: task.keyword,
            last_checked: new Date().toISOString(),
            hasAIOverview: result.hasAIOverview,
            smashBalloonCited: result.smashBalloonCited,
            smashBalloonInOverview: result.smashBalloonInOverview,
            citationLinks: result.citationLinks || [],
            aiText: result.aiText || '',
            sb_first_seen: result.smashBalloonCited ? (overviewData[task.keyword]?.sb_first_seen || new Date().toISOString()) : (overviewData[task.keyword]?.sb_first_seen || null),
          };
          renderOverview();
        } else {
          failed++;
        }
      } catch (err) {
        console.error('[overview] submit failed:', err.message);
        failed++;
      }
      await sleep(3000 + Math.random() * 2000);
    }
    const sbCount = Object.values(overviewData).filter(k => k.smashBalloonCited).length;
    status.textContent = failed === 0
      ? `Scan complete — ${scanned} keywords scanned, ${sbCount} ${brandName()} citations found`
      : `Scanned ${scanned}/${total} — ${failed} failed (CAPTCHA or scrape error). Re-run to finish. ${sbCount} ${brandName()} citations found`;
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    overviewRunning = false;
    btn.disabled = false;
  }
}

// ── Analysis Panel ────────────────────────────────────────────────────────────

async function loadAnalysis() {
  try {
    const status = await (await fetch(`${BRIDGE}/recon/mentions/analyze-status?brand=${activeBrand}`)).json();
    if (status.running) { pollAnalysis(); return; }
    const res = await fetch(`${BRIDGE}/recon/mentions/analysis?brand=${activeBrand}`);
    const data = await res.json();
    renderAnalysis(data);
  } catch (e) {}
}

async function runAnalysis(mode) {
  const panel = document.getElementById('analysis-panel');
  panel.innerHTML = `<div class="analysis-card"><div class="analysis-loading"><span class="spinner"></span> Starting analysis…</div></div>`;
  try {
    const res = await fetch(`${BRIDGE}/recon/mentions/analyze-batch?brand=${activeBrand}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ mode: mode || 'all' }) });
    const data = await res.json();
    if (!data.started) {
      panel.innerHTML = `<div class="analysis-card"><div style="color:var(--text2)">${esc(data.message || 'Nothing to analyze')}</div></div>`;
      return;
    }
    pollAnalysis();
  } catch (e) {
    panel.innerHTML = `<div class="analysis-card"><div style="color:var(--danger)">Analysis failed: ${esc(e.message)}</div></div>`;
  }
}

async function handleStopAnalysis() {
  const sb = document.getElementById('btn-stop-analyze');
  if (sb) { sb.textContent = 'Stopping…'; sb.disabled = true; }
  try { await fetch(`${BRIDGE}/recon/mentions/analyze-stop`, { method: 'POST' }); } catch {}
}

async function pollAnalysis() {
  const panel = document.getElementById('analysis-panel');
  analyzeRunning = true;
  document.getElementById('brand-select').disabled = true;
  const interval = setInterval(async () => {
    try {
      const s = await (await fetch(`${BRIDGE}/recon/mentions/analyze-status?brand=${activeBrand}`)).json();
      panel.innerHTML = `<div class="analysis-card"><div class="analysis-loading"><span class="spinner"></span> Analyzing… ${s.done}/${s.total}${s.error ? ` — error: ${esc(s.error)}` : ''} <button class="btn btn-ghost btn-sm" id="btn-stop-analyze">Stop</button></div></div>`;
      const stopBtn = document.getElementById('btn-stop-analyze');
      if (stopBtn) stopBtn.onclick = handleStopAnalysis;
      if (!s.running) {
        clearInterval(interval);
        analyzeRunning = false;
        document.getElementById('brand-select').disabled = false;
        const res = await fetch(`${BRIDGE}/recon/mentions/analysis?brand=${activeBrand}`);
        const data = await res.json();
        renderAnalysis(data);
        await loadMentions();
        const irr = mentions.filter(m => m.irrelevant).length;
        const stoppedNote = s.stopped ? 'Analysis stopped. ' : '';
        setMentionStatus(
          stoppedNote + (irr > 0
            ? `${irr} irrelevant thread${irr === 1 ? '' : 's'} found — click Clean Up to remove`
            : '0 irrelevant threads found'),
          false, true);
      }
    } catch (e) {
      clearInterval(interval);
      analyzeRunning = false;
      document.getElementById('brand-select').disabled = false;
    }
  }, 2000);
}

// "X% of positive show AI-writing traits, Y% of negative" summary line.
function aiWritingLine(aw) {
  if (!aw) return '';
  const pct = b => (b && b.total) ? Math.round((b.ai_like / b.total) * 100) : null;
  const parts = [];
  const pp = pct(aw.positive), pn = pct(aw.negative), pu = pct(aw.neutral);
  if (pp !== null) parts.push(`<span style="color:var(--success)">${pp}%</span> of positive`);
  if (pn !== null) parts.push(`<span style="color:var(--danger)">${pn}%</span> of negative`);
  if (pu !== null) parts.push(`${pu}% of neutral`);
  if (!parts.length) return '';
  return `<div style="font-size:12px;color:var(--text2);margin:4px 0 12px">
    🤖 AI-writing traits: ${parts.join(' · ')} mentions read as AI-written.
  </div>`;
}

function renderAnalysis(d) {
  const panel = document.getElementById('analysis-panel');
  if (!d || !Object.keys(d).length) {
    panel.innerHTML = `<div class="analysis-card analysis-empty">
      <span style="color:var(--text2)">No analysis yet</span>
      <button class="btn btn-primary btn-sm" id="btn-analyze-new">Analyze New</button>
      <button class="btn btn-ghost btn-sm" id="btn-analyze-all">Re-analyze</button>
    </div>`;
    panel.querySelector('#btn-analyze-new').addEventListener('click', () => runAnalysis('new'));
    panel.querySelector('#btn-analyze-all').addEventListener('click', () => runAnalysis('all'));
    return;
  }

  if (!d.sentiment) {
    panel.innerHTML = `<div class="analysis-card analysis-empty"><span style="color:var(--danger)">Analysis data malformed — re-analyze to fix.</span><button class="btn btn-primary btn-sm" id="btn-analyze-new">Analyze New</button><button class="btn btn-ghost btn-sm" id="btn-reanalyze">Re-analyze</button></div>`;
    panel.querySelector('#btn-analyze-new').addEventListener('click', () => runAnalysis('new'));
    panel.querySelector('#btn-reanalyze').addEventListener('click', () => runAnalysis('all'));
    return;
  }
  const total = d.sentiment.positive + d.sentiment.negative + d.sentiment.neutral;
  const posPct = Math.round(d.sentiment.positive / total * 100);
  const negPct = Math.round(d.sentiment.negative / total * 100);
  const neuPct = 100 - posPct - negPct;

  const genDate = d.generated_at ? new Date(d.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

  panel.innerHTML = `
    <div class="analysis-card">
      <div class="analysis-header">
        <span class="analysis-title">${esc(d.analysis_title || '')}</span>
        <div style="display:flex;align-items:center;gap:8px">
          ${genDate ? `<span style="font-size:11px;color:var(--text2)">Updated ${genDate}</span>` : ''}
          <button class="btn btn-ghost btn-sm" id="btn-analyze-new">Analyze New</button>
          <button class="btn btn-ghost btn-sm" id="btn-reanalyze">Re-analyze</button>
        </div>
      </div>

      <div class="analysis-sentiment-bar">
        <div class="sent-seg sent-pos" style="width:${posPct}%" title="${d.sentiment.positive} positive"></div>
        <div class="sent-seg sent-neu" style="width:${neuPct}%" title="${d.sentiment.neutral} neutral"></div>
        <div class="sent-seg sent-neg" style="width:${negPct}%" title="${d.sentiment.negative} negative"></div>
      </div>
      <div class="analysis-sentiment-labels">
        <span class="sent-label sent-label-pos">▲ ${posPct}% Positive</span>
        <span class="sent-label sent-label-neu">${neuPct}% Neutral</span>
        <span class="sent-label sent-label-neg">▼ ${negPct}% Negative</span>
      </div>

      ${aiWritingLine(d.ai_writing)}

      <div class="analysis-body">
        <div class="analysis-col">
          <div class="analysis-col-title">Use Cases</div>
          ${(d.use_cases||[]).map(u => {const maxUc=Math.max(...(d.use_cases||[{count:1}]).map(x=>x.count));return `
            <div class="cat-row">
              <div class="cat-label">${esc(u.name)}</div>
              <div class="cat-bar-wrap">
                <div class="cat-bar" style="width:${Math.round(u.count/maxUc*100)}%"></div>
              </div>
              <div class="cat-count">${u.count}</div>
            </div>`;}).join('')}
        </div>

        <div class="analysis-col">
          <div class="analysis-col-title">Positives</div>
          <div style="max-height:120px;overflow-y:auto">
            <ul class="signal-list signal-pos">
              ${(d.top_positives || []).map(p => `<li>${esc(p)}</li>`).join('')}
            </ul>
          </div>
          <div class="analysis-col-title" style="margin-top:14px">Complaints</div>
          <div style="max-height:120px;overflow-y:auto">
            <ul class="signal-list signal-neg">
              ${(d.top_complaints || []).map(c => `<li>${esc(c)}</li>`).join('')}
            </ul>
          </div>
        </div>

        <div class="analysis-col">
          <div class="analysis-col-title">Standout quotes</div>
          <div style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:0">
            ${(d.standout_quotes || []).map(q => {
              const isObj = typeof q === 'object';
              const text = isObj ? q.text : q;
              const score = isObj && q.score != null ? q.score : null;
              const sub = isObj ? q.subreddit : null;
              return `<blockquote class="analysis-quote">${esc(text)}${score != null ? `<div style="margin-top:4px;font-size:10px;color:var(--accent);font-style:normal">▲ ${score}${sub ? ` · ${esc(sub)}` : ''}</div>` : ''}</blockquote>`;
            }).join('')}
          </div>
          ${(d.per_product_sentiment || []).filter(p => p.positive+p.negative+p.neutral > 0).length ? `
          <div class="analysis-col-title" style="margin-top:14px">Per-product sentiment</div>
          ${(d.per_product_sentiment || []).filter(p => p.positive+p.negative+p.neutral > 0).map(p => {
            const tot = p.positive + p.negative + p.neutral;
            const pp = Math.round(p.positive/tot*100);
            const np = Math.round(p.negative/tot*100);
            return `<div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
                <span>${esc(p.product)}</span>
                <span style="color:var(--text2)">${tot} mentions</span>
              </div>
              <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;gap:1px">
                <div style="background:#4caf50;width:${pp}%"></div>
                <div style="background:#555570;flex:1"></div>
                <div style="background:#e84545;width:${np}%"></div>
              </div>
            </div>`;
          }).join('')}` : ''}
        </div>
      </div>

      ${(d.perception_shifts && d.perception_shifts.length) ? `
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">
        <div class="analysis-col-title" style="margin-bottom:10px">How perception has changed</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${d.perception_shifts.map(s => `
            <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;display:grid;grid-template-columns:140px 1fr 1fr;gap:12px;align-items:start">
              <div style="font-size:11px;font-weight:600;color:var(--text)">${esc(s.topic)}</div>
              <div>
                <div style="font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text2);margin-bottom:3px">Before</div>
                <div style="font-size:11px;color:var(--text2)">${esc(s.before)}</div>
              </div>
              <div>
                <div style="font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--accent);margin-bottom:3px">Now</div>
                <div style="font-size:11px;color:var(--text)">${esc(s.after)}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}

      <div class="analysis-body" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">
        <div class="analysis-col">
          <div class="analysis-col-title">Competitors mentioned</div>
          <div style="max-height:200px;overflow-y:auto">
            ${(d.competitors || []).map(c => `
              <div style="margin-bottom:10px">
                <div style="font-size:12px;color:var(--text)">${esc(c.name)} <span style="color:var(--text2);font-size:11px">×${c.count}</span></div>
                ${c.context ? `<div style="font-size:11px;color:var(--text2);margin-top:2px;line-height:1.4">${esc(c.context)}</div>` : ''}
              </div>`).join('')}
          </div>
        </div>

        <div class="analysis-col">
          <div class="analysis-col-title">Ecosystem plugins</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px">
            ${(d.ecosystem_plugins || []).map(p => `<span style="font-size:10px;background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:2px 7px;color:var(--text2)">${esc(p.name)}${p.count > 1 ? ` <span style="color:var(--accent)">×${p.count}</span>` : ''}</span>`).join('')}
          </div>
        </div>

        <div class="analysis-col">
          <div class="analysis-col-title">Intent breakdown</div>
          ${d.intent_breakdown ? Object.entries(d.intent_breakdown).map(([k, v]) => `
            <div class="cat-row">
              <div class="cat-label" style="font-size:11px">${esc(k.replace(/_/g,' '))}</div>
              <div class="cat-count">${v}</div>
            </div>`).join('') : ''}
        </div>
      </div>
    </div>`;

  panel.querySelector('#btn-analyze-new').addEventListener('click', () => runAnalysis('new'));
  panel.querySelector('#btn-reanalyze').addEventListener('click', () => runAnalysis('all'));
}

async function handleExtractComments() {
  if (!confirm('Re-scrape all existing thread URLs to populate per-comment records? Uses background tabs, ~15s per thread.')) return;
  const btn = document.getElementById('btn-extract-comments');
  btn.disabled = true;
  try {
    setMentionStatus('<span class="spinner"></span>Loading thread list…');
    const all = await fetch(`${BRIDGE}/recon/mentions?brand=${activeBrand}`).then(r => r.json());
    const urls = (all || []).map(m => m.url).filter(Boolean);
    if (!urls.length) { setMentionStatus('No threads to extract from', true); btn.disabled = false; return; }

    let saved = 0, skipped = 0, errored = 0, commentsAdded = 0, commentsUpdated = 0;
    for (let i = 0; i < urls.length; i++) {
      setMentionStatus(`<span class="spinner"></span>Extracting ${i + 1}/${urls.length} — ${commentsAdded} new comments, ${commentsUpdated} updated, ${errored} errored`);
      try {
        const thread = await scrapeRedditThread(urls[i]);
        const r = await fetch(`${BRIDGE}/recon/mentions/save-scraped?brand=${activeBrand}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urls[i], thread }),
        });
        const result = await r.json();
        if (result.saved) {
          saved++;
          commentsAdded += result.comments_added || 0;
          commentsUpdated += result.comments_updated || 0;
        } else {
          skipped++;
        }
      } catch (e) {
        console.log(`[extract-comments] ${i + 1}/${urls.length} ERROR url=${urls[i]} msg=${e.message}`);
        errored++;
      }
      if (i < urls.length - 1) await sleep(10000);
    }
    await loadMentions();
    setMentionStatus(`Done — ${commentsAdded} new comments, ${commentsUpdated} updated, ${skipped} skipped, ${errored} errored`, false, true);
  } catch (e) {
    setMentionStatus(`Error: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleCleanupCitations() {
  const btn = document.getElementById('btn-cleanup-citations');
  btn.disabled = true;
  btn.textContent = 'Cleaning…';
  try {
    let fixed = 0;
    for (const kw of Object.keys(overviewData)) {
      const links = overviewData[kw].citationLinks || [];
      const brandDomain = (activeBrandObj && activeBrandObj.domain) || '';
      const filtered = [...new Set(links.filter(l => (brandDomain && l.includes(brandDomain)) || l.includes('reddit.com')))];
      if (filtered.length !== links.length) {
        overviewData[kw].citationLinks = filtered;
        fixed++;
      }
    }
    await fetch(`${BRIDGE}/recon/overview/save?brand=${activeBrand}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overviewData) });
    renderOverview();
    btn.textContent = `Done (${fixed} fixed)`;
    setTimeout(() => { btn.textContent = 'Clean Citations'; }, 2000);
  } catch (e) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Clean Citations'; }, 2000);
  } finally {
    btn.disabled = false;
  }
}

async function handleCleanup() {
  const btn = document.getElementById('btn-cleanup');
  btn.disabled = true;
  setMentionStatus('<span class="spinner"></span>Cleaning up…');
  try {
    const res = await fetch(`${BRIDGE}/recon/mentions/cleanup?brand=${activeBrand}`, { method: 'POST' });
    const data = await res.json();
    await loadMentions();
    setMentionStatus(`Removed ${data.removed} irrelevant records`, false, true);
  } catch (e) {
    setMentionStatus(`Error: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadMentions() {
  try {
    const res = await fetch(`${BRIDGE}/recon/mentions?brand=${activeBrand}`);
    mentions = await res.json();
    renderMentions();
    updateStats();
  } catch (e) {}
}

async function handleResetAndRescan() {
  if (!confirm('Clear all existing mentions (auto-backup created) and re-run the Reddit scan from scratch?')) return;
  const btn = document.getElementById('btn-reset-rescan');
  btn.disabled = true;
  try {
    setMentionStatus('<span class="spinner"></span>Clearing mentions…');
    const r = await fetch(`${BRIDGE}/recon/mentions/clear?brand=${activeBrand}`, { method: 'POST' });
    const cleared = await r.json();
    setMentionStatus(`Cleared ${cleared.cleared} records — starting fresh scan…`);
    // Reset last-scanned so the full Google search runs without after: filter
    lastScannedAt = null;
    await fetch(`${BRIDGE}/recon/scan-meta?brand=${activeBrand}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_scanned_at: null }),
    });
    updateLastScanLabel();
    await loadMentions();
    await handleScanMentions();
  } catch (e) {
    setMentionStatus(`Error: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// The Scan Mentions button toggles: start a scan, or stop a running one.
function onScanButton() {
  if (scanRunning) { scanStop = true; setMentionStatus('<span class="spinner"></span>Stopping scan…'); return; }
  handleScanMentions();
}

async function handleScanMentions() {
  if (scanRunning) return;
  scanRunning = true;
  scanStop = false;
  const btn = document.getElementById('btn-scan-mentions');
  btn.textContent = 'Stop scan';
  document.getElementById('brand-select').disabled = true;

  const allUrls = new Set();
  const scanDate = new Date().toISOString().slice(0, 10);
  const afterFilter = lastScannedAt ? ` after:${lastScannedAt.slice(0, 10)}` : '';

  try {
    const queries = ((activeBrandObj && activeBrandObj.terms) || []).map(t => `"${t}"`);

    for (const query of queries) {
      if (scanStop) break;
      let page = 0;
      let hasMore = true;
      let nextUrl = null;

      while (hasMore) {
        if (scanStop) break;
        setMentionStatus(`<span class="spinner"></span>Scanning ${query} — page ${page + 1} (${allUrls.size} found so far)…`);

        const searchUrl = nextUrl || `https://www.google.com/search?q=site%3Areddit.com+${encodeURIComponent(query + afterFilter)}&num=10&start=0&gl=us&hl=en&pws=0`;
        const tab = await chrome.tabs.create({ url: searchUrl, active: false });
        await waitForTabLoad(tab.id);
        await sleep(3500);

        let captchaAttempt = 0;
        while (true) {
          const [ck] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => /unusual traffic|not a robot|captcha|recaptcha/i.test(document.body.innerText),
          });
          if (!ck.result) break;
          if (captchaAttempt === 0) { await chrome.tabs.update(tab.id, { active: true }); }
          setMentionStatus(`⚠️ CAPTCHA — solve it (waited ${captchaAttempt * 20}s)…`);
          captchaAttempt++;
          await sleep(20000);
        }

        const [scraped] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeRedditURLsFromGoogle,
          args: [(activeBrandObj && activeBrandObj.terms) || []],
        });
        await chrome.tabs.remove(tab.id).catch(() => {});

        const pageUrls = scraped?.result?.urls || [];
        nextUrl = scraped?.result?.nextUrl || null;
        hasMore = !!nextUrl && pageUrls.length > 0;
        console.log(`[recon-scan] ${query} page ${page + 1}: ${pageUrls.length} URLs, hasMore=${hasMore}, nextUrl=${nextUrl ? nextUrl.slice(0, 100) + '...' : 'none'}`);
        pageUrls.forEach(u => console.log(`[recon-scan]   url: ${u}`));

        let newOnPage = 0;
        for (const url of pageUrls) {
          if (!allUrls.has(url)) { allUrls.add(url); newOnPage++; }
        }

        if (!newOnPage) hasMore = false;
        if (!hasMore) {
          try {
            await fetch(`${BRIDGE}/recon/scan/end-dump?brand=${activeBrand}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query,
                url: scraped?.result?.pageUrl || '',
                body_text: scraped?.result?.bodyText || '',
              }),
            });
          } catch (e) { console.log(`[recon-scan] end-dump POST failed: ${e.message}`); }
        }
        page++;
        if (hasMore) await sleep(20000 + Math.random() * 10000);
      }
    }

    if (scanStop && !allUrls.size) { setMentionStatus('Scan stopped', false, true); return; }
    if (!allUrls.size) { setMentionStatus('No Reddit URLs found', true); return; }

    const urls = [...allUrls];
    console.log(`[recon-scan] total unique URLs to scrape: ${urls.length}`);
    let saved = 0, skipped = 0, errored = 0;
    for (let i = 0; i < urls.length; i++) {
      if (scanStop) break;
      setMentionStatus(`<span class="spinner"></span>Scraping ${i + 1}/${urls.length} — ${saved} saved, ${skipped} skipped, ${errored} errored`);
      try {
        const thread = await scrapeRedditThread(urls[i]);
        const commentCount = Array.isArray(thread.comments) ? thread.comments.length : 0;
        console.log(`[recon-scan] ${i + 1}/${urls.length} scraped url=${urls[i]} post.title="${thread.post?.title?.slice(0, 60)}" comments=${commentCount}`);
        const r = await fetch(`${BRIDGE}/recon/mentions/save-scraped?brand=${activeBrand}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urls[i], thread }),
        });
        const result = await r.json();
        console.log(`[recon-scan] ${i + 1}/${urls.length} save result:`, result);
        if (result.saved) saved++; else skipped++;
      } catch (e) {
        console.log(`[recon-scan] ${i + 1}/${urls.length} ERROR url=${urls[i]} msg=${e.message}`);
        errored++;
      }
      if (i < urls.length - 1) await sleep(10000);
    }

    if (scanStop) {
      // Stopped mid-scrape: keep what was saved, but DON'T advance the scan date
      // (so the next scan still covers everything).
      await loadMentions();
      silentBackup();
      setMentionStatus(`Stopped — ${saved} saved, ${skipped} no brand match, ${errored} errored (scan incomplete)`, false, true);
      return;
    }

    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    await fetch(`${BRIDGE}/recon/scan-meta?brand=${activeBrand}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_scanned_at: oneDayAgo }),
    });
    lastScannedAt = oneDayAgo;
    updateLastScanLabel();
    await loadMentions();
    silentBackup();   // auto-backup to install folder after a scan completes
    setMentionStatus(`Done — ${saved} saved, ${skipped} no brand match, ${errored} errored`, false, true);
  } catch (e) {
    setMentionStatus(`Error: ${e.message}`, true);
  } finally {
    scanRunning = false;
    btn.textContent = 'Scan Mentions';
    document.getElementById('brand-select').disabled = false;
  }
}

function setMentionStatus(msg, isErr, isOk) {
  const el = document.getElementById('mention-status');
  el.className = 'log-status' + (isErr ? ' error' : isOk ? ' ok' : '');
  el.innerHTML = msg;
}

function renderMentions() {
  const list = document.getElementById('mention-list');
  const q = (document.getElementById('mention-search')?.value || '').toLowerCase().trim();
  const filtered = q
    ? mentions.filter(m => [m.subreddit, m.title, m.mention_text, m.snippet].filter(Boolean).join(' ').toLowerCase().includes(q))
    : mentions;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">${q ? `No mentions match "${q}"` : 'No mentions yet. Click "Scan Mentions" to search Reddit.'}</div>`;
    return;
  }
  const sorted = [...filtered].sort((a, b) => {
    const da = a.posted_at || '';
    const db = b.posted_at || '';
    return mentionSortDir === 'desc' ? db.localeCompare(da) : da.localeCompare(db);
  });
  const arrow = mentionSortDir === 'desc' ? '↓' : '↑';
  list.innerHTML = `
    <table class="query-table" style="width:100%">
      <thead>
        <tr>
          <th>Subreddit</th>
          <th>Title</th>
          <th style="cursor:pointer;user-select:none" id="sort-posted-th">Posted ${arrow}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(m => `
          <tr>
            <td style="white-space:nowrap;color:var(--text2)">${esc(m.subreddit)}</td>
            <td><a href="${esc(m.url)}" target="_blank" style="color:var(--accent)">${esc(m.title)}</a>
              ${(m.mention_text || m.snippet) ? `<div style="font-size:11px;color:var(--text2);margin-top:2px">${esc((m.mention_text || m.snippet).slice(0, 160))}…</div>` : ''}</td>
            <td style="white-space:nowrap;color:var(--text2);font-size:11px">${m.posted_at ? new Date(m.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
            <td><button class="btn btn-ghost btn-sm btn-del-mention" data-id="${m.id}">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  list.querySelector('#sort-posted-th').addEventListener('click', () => {
    mentionSortDir = mentionSortDir === 'desc' ? 'asc' : 'desc';
    renderMentions();
  });

  list.querySelectorAll('.btn-del-mention').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await fetch(`${BRIDGE}/recon/mention/${id}?brand=${activeBrand}`, { method: 'DELETE' });
      mentions = mentions.filter(m => String(m.id) !== id);
      renderMentions();
      updateStats();
    });
  });
}

// ── Reddit thread DOM extractor (injected into tab) ──────────────────────────
// Must be a named function with no closures.
function extractRedditThreadDOM() {
  function txt(el) { return el ? (el.innerText || el.textContent || '').trim() : ''; }
  function intAttr(el) {
    if (!el) return 0;
    var t = el.getAttribute('title');
    var n = t ? parseInt(t, 10) : NaN;
    if (!isNaN(n)) return n;
    var c = (el.textContent || '').replace(/[^0-9-]/g, '');
    return c ? parseInt(c, 10) : 0;
  }
  var postEl = document.querySelector('#siteTable .thing.link') || document.querySelector('.thing.link');
  var post = { title: '', body: '', author: '', score: 0 };
  if (postEl) {
    post.title = txt(postEl.querySelector('a.title'));
    post.body = txt(postEl.querySelector('.expando .usertext-body .md'));
    post.author = txt(postEl.querySelector('.tagline .author'));
    post.score = intAttr(postEl.querySelector('.score.unvoted'));
  }
  var comments = [];
  function harvest(commentEl, parentId) {
    var fullname = commentEl.getAttribute('data-fullname') || '';
    var id = fullname.replace(/^t1_/, '');
    if (id) {
      var entry = commentEl.querySelector(':scope > .entry');
      if (entry) {
        var body = txt(entry.querySelector('.usertext-body .md'));
        var author = txt(entry.querySelector('.tagline .author'));
        var score = intAttr(entry.querySelector('.score.unvoted'));
        if (body) comments.push({ id: id, parent_id: parentId, body: body, author: author, score: score });
      }
    }
    var childRoot = commentEl.querySelector(':scope > .child > .sitetable');
    if (childRoot) {
      childRoot.querySelectorAll(':scope > .comment').forEach(function(child) {
        harvest(child, id || parentId);
      });
    }
  }
  document.querySelectorAll('.commentarea > .sitetable > .comment').forEach(function(c) {
    harvest(c, null);
  });
  return { post: post, comments: comments };
}

async function scrapeRedditThread(url) {
  const threadMatch = url.match(/reddit\.com\/((?:r|user)\/[^/]+\/comments\/[a-z0-9]+)/i);
  if (!threadMatch) throw new Error('Invalid Reddit URL: ' + url);
  const threadUrl = `https://old.reddit.com/${threadMatch[1]}/`;
  const tab = await chrome.tabs.create({ url: threadUrl, active: false });
  try {
    await waitForTabLoad(tab.id);
    let payload = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      let r;
      try {
        [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractRedditThreadDOM,
        });
      } catch (e) { continue; }
      if (r?.result?.post?.title) { payload = r.result; break; }
    }
    if (!payload) throw new Error('Thread did not render in time: ' + url);
    return payload;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function scrapeRedditURLsFromGoogle(terms) {
  terms = (terms || []).map(function(t) { return String(t).toLowerCase(); });
  var bodyText = document.body.innerText || '';
  var pageUrl = location.href;
  var noResults = /did not match any documents|No results found/i.test(bodyText);
  var quotesDropped = /without quotes/i.test(bodyText);
  if (noResults || quotesDropped) return { urls: [], hasMore: false, bodyText: bodyText, pageUrl: pageUrl };

  var seen = new Set();
  var urls = [];
  document.querySelectorAll('a[href]').forEach(function(a) {
    var href = a.href;
    if (!href || !href.includes('reddit.com')) return;
    if (href.includes('google.com')) return;
    if (!href.includes('/comments/')) return;
    var container = a.closest('[data-sokoban-container], .g, [jscontroller]') || a.parentElement;
    var text = (container ? container.innerText : '').toLowerCase();
    if (!terms.some(function(t) { return text.includes(t); })) return;
    var clean = href.split('?')[0].split('#')[0].replace(/\/$/, '');
    if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
  });
  var nextUrl = null;
  document.querySelectorAll('a').forEach(function(a) {
    if (a.id === 'pnnext' || a.getAttribute('aria-label') === 'Next page') {
      if (!nextUrl) nextUrl = a.href;
    }
  });
  return { urls: urls, hasMore: !!nextUrl, nextUrl: nextUrl, bodyText: bodyText, pageUrl: pageUrl };
}

// ── Google scraper (injected into tab) ───────────────────────────────────────
// Must be a named function with no closures — copied from standalone.js

async function scrapeGooglePage(task, brandMatch) {
  var brandDomain = (brandMatch && brandMatch.domain) || '';
  var brandTerms = ((brandMatch && brandMatch.terms) || []).map(function(t) { return String(t).toLowerCase(); });
  var brandInText = function(s) { var l = (s || '').toLowerCase(); return brandTerms.some(function(t) { return t && l.includes(t); }); };
  try {
    var expanded = false;
    document.querySelectorAll('button, [role="button"]').forEach(function(btn) {
      if (/show more|more sources|see more/i.test(btn.innerText)) { btn.click(); expanded = true; }
    });
    if (expanded) await new Promise(r => setTimeout(r, 1500));
  } catch (_) {}

  var fullText = document.body.innerText || '';
  if (/unusual traffic|not a robot|captcha|recaptcha/i.test(fullText)) return { captcha: true };

  var hasAIOverview = /AI Overview|AI-powered overview/i.test(fullText);
  var aiText = '';
  var citationLinks = [];

  if (hasAIOverview) {
    var overviewHeading = null;
    var allHeadings = document.querySelectorAll('[role="heading"], h1, h2, h3');
    for (var hi = 0; hi < allHeadings.length; hi++) {
      if (/AI Overview/i.test(allHeadings[hi].innerText)) { overviewHeading = allHeadings[hi]; break; }
    }
    if (overviewHeading) {
      var candidate = overviewHeading.parentElement;
      while (candidate && candidate !== document.body) {
        var links = candidate.querySelectorAll('a[href]');
        var text = candidate.innerText || '';
        if (links.length > 0 && text.length > 100 && text.length < 8000) break;
        candidate = candidate.parentElement;
      }
      if (candidate && candidate !== document.body) {
        aiText = candidate.innerText.substring(0, 2000);
        candidate.querySelectorAll('a[href]').forEach(function(a) {
          if (a.href && ((brandDomain && a.href.includes(brandDomain)) || a.href.includes('reddit.com')))
            citationLinks.push(a.href);
        });
      }
    }
    if (!aiText) {
      var idx = fullText.indexOf('AI Overview');
      if (idx !== -1) aiText = fullText.substring(idx, idx + 2000);
    }
  }

  var redditCitations = citationLinks.filter(function(h) { return h.includes('reddit.com'); });
  var sbCitations = brandDomain ? citationLinks.filter(function(h) { return h.includes(brandDomain); }) : [];

  // Field names kept as smashBalloon* for dashboard compatibility — they now mean
  // "active brand cited / on page / in overview", matched via the passed brand terms+domain.
  return {
    captcha: false,
    hasAIOverview: hasAIOverview,
    aiText: aiText.substring(0, 800),
    citationLinks: citationLinks,
    redditCitations: redditCitations,
    redditCited: redditCitations.length > 0,
    smashBalloonCitations: sbCitations,
    smashBalloonCited: sbCitations.length > 0,
    smashBalloonOnPage: brandInText(fullText),
    smashBalloonInOverview: brandInText(aiText),
  };
}

// ── Selector health check ──────────────────────────────────────────────────────
// Verifies the scrapers still match Google's and Reddit's live markup. Runs the
// real selectors against live pages and reports which still work. OS-agnostic:
// all checks run in-browser via chrome.scripting (no AppleScript).

// Injected: validate the Google reddit-link-finding selectors on a site:reddit SERP.
function checkSerpSelectors() {
  var bodyText = document.body.innerText || '';
  var captcha = /unusual traffic|not a robot|captcha|recaptcha/i.test(bodyText);
  var links = [];
  document.querySelectorAll('a[href]').forEach(function(a) {
    var h = a.href || '';
    if (h.indexOf('reddit.com') !== -1 && h.indexOf('/comments/') !== -1 && h.indexOf('google.com') === -1) {
      links.push(h.split('?')[0].split('#')[0]);
    }
  });
  return {
    captcha: captcha,
    redditLinks: links.length,
    sampleUrls: links.slice(0, 3),
    containers: document.querySelectorAll('[data-sokoban-container], .g, [jscontroller]').length,
    nextPage: document.querySelectorAll('a#pnnext, a[aria-label="Next page"]').length,
  };
}

// Injected: validate the AI-Overview detection + citation-block selectors.
function checkAioSelectors() {
  var bodyText = document.body.innerText || '';
  var captcha = /unusual traffic|not a robot|captcha|recaptcha/i.test(bodyText);
  var aioText = /AI Overview|AI-powered overview/i.test(bodyText);
  var heading = null;
  var hs = document.querySelectorAll('[role="heading"], h1, h2, h3');
  for (var i = 0; i < hs.length; i++) { if (/AI Overview/i.test(hs[i].innerText)) { heading = hs[i]; break; } }
  var citationLinks = 0, blockChars = 0;
  if (heading) {
    var cand = heading.parentElement;
    while (cand && cand !== document.body) {
      var l = cand.querySelectorAll('a[href]');
      var txt = cand.innerText || '';
      if (l.length > 0 && txt.length > 100 && txt.length < 8000) break;
      cand = cand.parentElement;
    }
    if (cand && cand !== document.body) {
      blockChars = (cand.innerText || '').length;
      citationLinks = cand.querySelectorAll('a[href]').length;
    }
  }
  return { captcha: captcha, aioText: aioText, headingFound: !!heading, citationLinks: citationLinks, blockChars: blockChars };
}

// Injected: validate the old.reddit thread DOM selectors.
function checkThreadSelectors() {
  var postEl = document.querySelector('#siteTable .thing.link') || document.querySelector('.thing.link');
  var titleEl = postEl && postEl.querySelector('a.title');
  var post = {
    found: !!postEl,
    title: !!(titleEl && titleEl.innerText.trim()),
    body: !!(postEl && postEl.querySelector('.expando .usertext-body .md')),
    author: !!(postEl && postEl.querySelector('.tagline .author')),
    score: !!(postEl && postEl.querySelector('.score.unvoted')),
  };
  var comments = document.querySelectorAll('.commentarea > .sitetable > .comment');
  var withId = 0, withBody = 0, withAuthor = 0;
  for (var i = 0; i < comments.length; i++) {
    if (comments[i].getAttribute('data-fullname')) withId++;
    var entry = comments[i].querySelector(':scope > .entry');
    if (entry) {
      if (entry.querySelector('.usertext-body .md')) withBody++;
      if (entry.querySelector('.tagline .author')) withAuthor++;
    }
  }
  return { post: post, comments: comments.length, withId: withId, withBody: withBody, withAuthor: withAuthor };
}

// Open a tab, wait for load, do a bounded CAPTCHA wait, run a check, close it.
async function runSelectorCheck(url, func, setMsg) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabLoad(tab.id);
    await sleep(2500);
    for (let i = 0; i < 15; i++) {   // bounded ~45s captcha wait (diagnostic, won't hang)
      let ck;
      try {
        [ck] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => /unusual traffic|not a robot|captcha|recaptcha/i.test(document.body.innerText),
        });
      } catch (e) { break; }
      if (!ck.result) break;
      if (i === 0) await chrome.tabs.update(tab.id, { active: true });
      if (setMsg) setMsg(`⚠️ CAPTCHA — solve it to continue the check (${i * 3}s)…`);
      await sleep(3000);
    }
    await sleep(400);
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func });
    return r && r.result;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function handleCheckSelectors() {
  const btn = document.getElementById('btn-check-selectors');
  const panel = document.getElementById('selector-panel');
  const out = document.getElementById('selector-results');
  btn.disabled = true; btn.textContent = 'Checking…';
  panel.classList.remove('hidden');
  const setMsg = m => { out.innerHTML = `<div style="color:var(--text2);padding:6px">${esc(m)}</div>`; };
  setMsg('Opening Google & Reddit in background tabs…');
  const sections = [];
  try {
    setMsg('Checking Google reddit-link finding…');
    const serp = await runSelectorCheck('https://www.google.com/search?q=' + encodeURIComponent('site:reddit.com wordpress') + '&num=10&gl=us&hl=en&pws=0', checkSerpSelectors, setMsg);

    setMsg('Checking Google AI Overview detection…');
    const aio = await runSelectorCheck('https://www.google.com/search?q=' + encodeURIComponent('how can i make money on tiktok') + '&gl=us&hl=en&pws=0', checkAioSelectors, setMsg);

    setMsg('Checking Reddit thread scraping…');
    let threadUrl = serp && serp.sampleUrls && serp.sampleUrls[0];
    let thread = null, normUrl = null;
    if (threadUrl) {
      const m = threadUrl.match(/reddit\.com\/((?:r|user)\/[^/]+\/comments\/[a-z0-9]+)/i);
      normUrl = m ? `https://old.reddit.com/${m[1]}/` : threadUrl.replace(/^https?:\/\/(www\.|new\.)?reddit\.com/, 'https://old.reddit.com');
      thread = await runSelectorCheck(normUrl, checkThreadSelectors, setMsg);
    }

    sections.push(buildSerpSection(serp));
    sections.push(buildAioSection(aio));
    sections.push(buildThreadSection(thread, normUrl));
    renderSelectorResults(sections);
  } catch (e) {
    out.innerHTML = `<div style="color:var(--danger);padding:6px">Check failed: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Check Selectors';
  }
}

function buildSerpSection(s) {
  const rows = [];
  if (!s) return { title: 'Google → Reddit link finding', rows: [{ status: 'unverified', name: 'Google SERP', note: "couldn't load the search page" }] };
  if (s.captcha) return { title: 'Google → Reddit link finding', rows: [{ status: 'unverified', name: 'CAPTCHA', note: 'Google blocked the check — solve it and re-run' }] };
  rows.push({ status: s.redditLinks > 0 ? 'ok' : 'stale', name: 'Reddit thread links', note: s.redditLinks > 0 ? `found ${s.redditLinks} /comments/ links` : '0 links on a site:reddit.com search — link finding is broken' });
  rows.push({ status: s.containers > 0 ? 'ok' : 'warn', name: 'Result containers', note: s.containers > 0 ? `${s.containers} matched` : 'container selector matched 0 (used for term filtering)' });
  rows.push({ status: s.nextPage > 0 ? 'ok' : 'unverified', name: 'Next-page link', note: s.nextPage > 0 ? 'found' : 'not found (may be the last page)' });
  return { title: 'Google → Reddit link finding', rows };
}

function buildAioSection(a) {
  const rows = [];
  if (!a) return { title: 'Google → AI Overview', rows: [{ status: 'unverified', name: 'Google SERP', note: "couldn't load the search page" }] };
  if (a.captcha) return { title: 'Google → AI Overview', rows: [{ status: 'unverified', name: 'CAPTCHA', note: 'Google blocked the check — solve it and re-run' }] };
  if (!a.aioText) {
    rows.push({ status: 'absent', name: 'AI Overview', note: 'no AI Overview on this query right now (intermittent — can’t verify the block selector)' });
  } else if (a.headingFound) {
    rows.push({ status: 'ok', name: 'AI Overview block', note: `detected and located (${a.blockChars} chars)` });
    rows.push({ status: a.citationLinks > 0 ? 'ok' : 'unverified', name: 'Citation links', note: a.citationLinks > 0 ? `${a.citationLinks} links in the block` : 'block found but 0 links (this overview may have no citations)' });
  } else {
    rows.push({ status: 'stale', name: 'AI Overview block', note: '"AI Overview" text is on the page but the heading/block selector found nothing — selector is stale' });
  }
  return { title: 'Google → AI Overview', rows };
}

function buildThreadSection(t, url) {
  if (!url) return { title: 'Reddit thread scraping', rows: [{ status: 'unverified', name: 'Thread', note: 'no thread URL from the SERP check to test against' }] };
  if (!t) return { title: 'Reddit thread scraping', rows: [{ status: 'unverified', name: 'Thread', note: "couldn't load " + url }] };
  const rows = [];
  rows.push({ status: t.post.found ? 'ok' : 'stale', name: 'Post container', note: t.post.found ? 'matched .thing.link' : '.thing.link found nothing — post selector stale' });
  rows.push({ status: t.post.title ? 'ok' : 'stale', name: 'Post title', note: t.post.title ? 'a.title OK' : 'a.title empty/missing' });
  rows.push({ status: t.post.author ? 'ok' : 'warn', name: 'Post author', note: t.post.author ? 'OK' : 'not found' });
  rows.push({ status: t.post.score ? 'ok' : 'warn', name: 'Post score', note: t.post.score ? 'OK' : 'not found' });
  rows.push({ status: t.comments > 0 ? 'ok' : 'warn', name: 'Comments', note: t.comments > 0 ? `${t.comments} parsed (${t.withBody} with body, ${t.withAuthor} with author)` : '0 comments (thread may have none, or .comment selector broke)' });
  return { title: `Reddit thread scraping (${url})`, rows };
}

function renderSelectorResults(sections) {
  const ICON = { ok: '✓', stale: '✗', warn: '⚠', unverified: '?', absent: '–' };
  const COLOR = { ok: '#4ade80', stale: '#ef4444', warn: '#f59e0b', unverified: '#94a3b8', absent: '#64748b' };
  const out = document.getElementById('selector-results');
  out.innerHTML = sections.map(sec => `
    <div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);margin-bottom:4px">${esc(sec.title)}</div>
      ${sec.rows.map(r => `
        <div style="display:flex;gap:8px;align-items:baseline;padding:2px 0">
          <span style="color:${COLOR[r.status] || '#888'};font-weight:700;width:14px;flex-shrink:0;text-align:center">${ICON[r.status] || '?'}</span>
          <div><span style="font-size:12px;color:var(--text)">${esc(r.name)}</span> <span style="font-size:11px;color:var(--text2)">${esc(r.note)}</span></div>
        </div>`).join('')}
    </div>`).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    });
  });
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
