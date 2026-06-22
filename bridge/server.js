// Reddit Tracker — standalone, multi-brand bridge.
// Platform-agnostic (macOS + Windows): no AppleScript, no hardcoded paths, no
// cloud sync. Data lives in ../data relative to this file. Thread scraping is
// done by the Chrome extension (chrome.scripting) and POSTed here.
//
// Multi-brand: each brand has a registry entry in data/brands.json and its own
// data subfolder data/<brandId>/ holding the same per-brand JSON files. Every
// data endpoint resolves the active brand from `?brand=<id>` (GET) or the
// `brand` field (POST) and reads/writes that brand's folder. Search terms, the
// excluded marketing account, the relevance checker, the log-query prompt, and
// the overview keywords all come from the brand's registry entry.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Is the `claude` CLI on PATH? Analyze + Log Comment need it. Cross-platform.
function isClaudeAvailable() {
  try { execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const { runClaude } = require('./claude-runner');

const app = express();
const PORT = 3458;

// Brand/record id validator — blocks path traversal via `?brand=` or `:id`.
function validBrandId(id) { return typeof id === 'string' && /^[a-z0-9-]+$/.test(id); }

// (1) Reject foreign Host headers → defeats DNS-rebinding attacks from web pages.
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}` || host === `[::1]:${PORT}`) return next();
  return res.status(403).json({ error: 'forbidden host' });
});

// (2) CORS: only the extension (chrome-extension://) or non-browser clients (no
// Origin, e.g. curl). Any web page's Origin is rejected, so it can't read
// responses or fire preflighted POST/DELETE calls at the bridge.
app.use(cors({ origin: (origin, cb) => cb(null, !origin || /^chrome-extension:\/\//.test(origin)) }));

app.use(express.json({ limit: '10mb' }));

// (3) Validate any brand id in the query/body before it can build a file path.
app.use((req, res, next) => {
  const b = (req.query && req.query.brand) || (req.body && req.body.brand);
  if (b !== undefined && b !== null && b !== '' && !validBrandId(String(b))) {
    return res.status(400).json({ error: 'invalid brand id' });
  }
  next();
});

// (4) Validate `:id` route params (brand ids and numeric record ids both pass;
// `..`, `/`, etc. are rejected).
app.param('id', (req, res, next, value) => {
  if (!validBrandId(value)) return res.status(400).json({ error: 'invalid id' });
  next();
});

// ── Data dir (relative to this file → portable across machines/OSes) ──────────
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Brand registry ────────────────────────────────────────────────────────────

const BRANDS_PATH = path.join(DATA_DIR, 'brands.json');

function loadBrands() {
  try { return JSON.parse(fs.readFileSync(BRANDS_PATH, 'utf8')); }
  catch { return []; }
}
function saveBrands(b) { fs.writeFileSync(BRANDS_PATH, JSON.stringify(b, null, 2)); }
function getBrand(brandId) { return loadBrands().find(b => b.id === brandId) || null; }
function defaultBrandId() { const b = loadBrands(); return b.length ? b[0].id : ''; }

// Resolve the active brand id from the request (query for GET, body for POST).
// Falls back to the first registered brand so a missing param never 500s.
function resolveBrandId(req) {
  return (req.query && req.query.brand) || (req.body && req.body.brand) || defaultBrandId();
}

function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brand';
}
function domainFromUrl(url) {
  if (!url) return '';
  try { return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
  catch { return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}
// Search/match terms from the brand name only (distinctive). Product names are
// kept separate — they're too generic to use as Google search terms.
function deriveTerms(name) {
  const out = new Set();
  const n = String(name || '').toLowerCase().trim();
  if (n) { out.add(n); if (n.includes(' ')) out.add(n.replace(/\s+/g, '')); }
  return [...out].filter(Boolean);
}
function toList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── Per-brand data paths ───────────────────────────────────────────────────────

function bdir(brandId) {
  const d = path.join(DATA_DIR, brandId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function bpath(brandId, name) { return path.join(bdir(brandId), name); }      // write: ensures dir
function rpath(brandId, name) { return path.join(DATA_DIR, brandId, name); }   // read: no dir creation

function loadJson(brandId, name, fallback) {
  try { return JSON.parse(fs.readFileSync(rpath(brandId, name), 'utf8')); }
  catch { return fallback; }
}
function saveJson(brandId, name, data) {
  fs.writeFileSync(bpath(brandId, name), JSON.stringify(data, null, 2));
}

const loadReconComments = b => loadJson(b, 'recon_comments.json', []);
const saveReconComments = (b, c) => saveJson(b, 'recon_comments.json', c);
const loadReconMentions = b => loadJson(b, 'recon_mentions.json', []);
const saveReconMentions = (b, m) => saveJson(b, 'recon_mentions.json', m);
const loadReconCommentMentions = b => loadJson(b, 'recon_comment_mentions.json', []);
const saveReconCommentMentions = (b, m) => saveJson(b, 'recon_comment_mentions.json', m);
const loadOverviewData = b => loadJson(b, 'recon_general_overview.json', {});
const saveOverviewData = (b, d) => saveJson(b, 'recon_general_overview.json', d);
const loadScanMeta = b => loadJson(b, 'recon_scan_meta.json', {});
const saveScanMeta = (b, m) => saveJson(b, 'recon_scan_meta.json', m);

function logScan(brandId, line) {
  try { fs.appendFileSync(bpath(brandId, 'recon_scan.log'), `${new Date().toISOString()} ${line}\n`); } catch {}
}

// ── Backups (local save system — install-folder copy per brand, no cloud) ──────

const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

// One restorable snapshot: the brand registry entry + every JSON data file.
function buildBundle(brandId) {
  const brand = getBrand(brandId);
  const dir = path.join(DATA_DIR, brandId);
  const data = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) {
        try { data[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch {}
      }
    }
  } catch {}
  return { brand, data, exported_at: new Date().toISOString() };
}

// Write/refresh the on-disk backup at backups/<brandId>/backup.json.
function writeBackup(brandId, bundle) {
  const d = path.join(BACKUPS_DIR, brandId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'backup.json'), JSON.stringify(bundle, null, 2));
  return path.join('backups', brandId, 'backup.json');
}

// ── In-memory run state (single operator; each tagged with its brand) ──────────

const reconAudit = { tasks: [], commentId: null, brandId: null };
let overviewAudit = { tasks: [], brandId: null };
const analyzeState = { running: false, done: 0, total: 0, error: null, batchErrors: 0, brandId: null, stop: false, stopped: false };

// ── Seed + migrate ─────────────────────────────────────────────────────────────

// No brand is seeded — the tool is brand-agnostic. The operator adds their first
// brand via the dashboard's "Add brand" form, which builds the relevancy checker.

// ── Brand CRUD ─────────────────────────────────────────────────────────────────

app.get('/brands', (req, res) => res.json(loadBrands()));

// Build the relevance checker + search framing + overview keywords from the
// brand description/brand-brain in one Claude call.
function brandSetupPrompt(name, url, productNames, description) {
  return `You are setting up brand-mention tracking for a brand called "${name}"${url ? ` (${url})` : ''}.
${productNames.length ? `Its products: ${productNames.join(', ')}.` : ''}

Brand description / brand brain:
"""
${description}
"""

Produce JSON only — no markdown — with this exact shape:
{
  "relevanceRubric": "One tight paragraph that tells a checker how to decide whether a Reddit mention of the name \\"${name}\\" actually refers to THIS brand. State plainly what the brand/product IS and its category. Say that a mention is RELEVANT if it refers to this brand in ANY context or industry (the poster's niche does not matter), including negative/complaint/comparison mentions. Then list the most likely FALSE-POSITIVE contexts to flag as irrelevant — homonyms, common-word collisions, same-named bands/games/apps/usernames, or literal meanings of the words — inferred from the actual name and description.",
  "searchContext": "1-2 sentences: what the brand does and what its potential customers would be searching Google for. Used to generate search queries that lead to threads recommending it.",
  "overviewKeywords": ["20-40 Google search queries in this brand's space where you'd want to check whether Google's AI Overview mentions or cites the brand. Real queries a buyer would type. No brand names in them."]
}`;
}

app.post('/brands', async (req, res) => {
  const { name, url, productNames, excludeAuthors, description, terms } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Brand Name required' });
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description / brand brain required (used to build the relevancy checker)' });

  const id = slugify(name);
  const brands = loadBrands();
  if (brands.find(b => b.id === id)) return res.status(409).json({ error: `A brand "${name}" (${id}) already exists` });

  const products = toList(productNames);
  const excl = toList(excludeAuthors).map(a => a.replace(/^u\//i, '').toLowerCase());
  // Brand name (+ concatenated variant) is always searched; operator-supplied
  // terms are added on top. Each term is a separate Google query at scan time.
  const allTerms = [...new Set([...deriveTerms(name), ...toList(terms).map(s => s.toLowerCase())])];

  let relevanceRubric = '', searchContext = '', overviewKeywords = [], warning = null;
  try {
    const raw = await runClaude(brandSetupPrompt(name, url, products, description), { noTools: true });
    const j = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    relevanceRubric = String(j.relevanceRubric || '').trim();
    searchContext = String(j.searchContext || '').trim();
    overviewKeywords = Array.isArray(j.overviewKeywords) ? j.overviewKeywords.map(String).slice(0, 50) : [];
  } catch (e) {
    warning = `Relevancy checker auto-build failed (${e.message}); used the raw description as a fallback. You can re-add the brand to retry.`;
  }
  if (!relevanceRubric) relevanceRubric = `A mention is RELEVANT if it refers to ${name}${products.length ? ` or its products (${products.join(', ')})` : ''} in any context. About: ${String(description).slice(0, 500)}`;
  if (!searchContext) searchContext = String(description).slice(0, 300);

  const brand = {
    id, name: String(name).trim(),
    url: url || '', domain: domainFromUrl(url),
    productNames: products,
    excludeAuthors: excl,
    terms: allTerms,
    description: String(description),
    relevanceRubric, searchContext, overviewKeywords,
    createdAt: new Date().toISOString(),
  };
  brands.push(brand);
  saveBrands(brands);
  bdir(id);
  res.json({ ...brand, warning });
});

// Export a brand's full data as one restorable bundle, and refresh its on-disk
// backup in the install folder. Used by the Download Backup button and by Delete.
app.get('/brands/:id/export', (req, res) => {
  const brandId = req.params.id;
  if (!getBrand(brandId)) return res.status(404).json({ error: `Unknown brand "${brandId}"` });
  const bundle = buildBundle(brandId);
  try { bundle.backup_path = writeBackup(brandId, bundle); } catch {}
  res.json(bundle);
});

// Delete a brand. A final on-disk backup is written to backups/<brandId>/ FIRST,
// then the registry entry and the live data folder are removed. The backup is
// retained so the brand can be restored from the install folder.
app.delete('/brands/:id', (req, res) => {
  const brandId = req.params.id;
  const brands = loadBrands();
  const idx = brands.findIndex(b => b.id === brandId);
  if (idx === -1) return res.status(404).json({ error: `Unknown brand "${brandId}"` });

  let backupPath = null;
  try { backupPath = writeBackup(brandId, buildBundle(brandId)); } catch {}

  brands.splice(idx, 1);
  saveBrands(brands);
  try { fs.rmSync(path.join(DATA_DIR, brandId), { recursive: true, force: true }); } catch {}

  res.json({ ok: true, deleted: brandId, backupKept: backupPath });
});

// Refresh the on-disk backup only (no download). Called automatically after a
// scan or analyze completes.
app.post('/brands/:id/backup', (req, res) => {
  const brandId = req.params.id;
  if (!getBrand(brandId)) return res.status(404).json({ error: `Unknown brand "${brandId}"` });
  try {
    const backup_path = writeBackup(brandId, buildBundle(brandId));
    res.json({ ok: true, backup_path });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore a brand from a backup bundle (the JSON produced by export/Download
// Backup). Recreates the registry entry + all data files. Refuses if the brand
// already exists (delete it first) to avoid silently clobbering live data.
// Restore from a backup bundle. Body: { bundle, mode }.
//   - brand NOT present  → import wholesale (data + brand registry entry).
//   - brand present + mode 'merge'     → add only records the backup has that the
//                                          live data lacks (existing data wins).
//   - brand present + mode 'overwrite' → snapshot current data to backups/ first,
//                                          then clear and replace from the backup
//                                          (incl. the brand registry entry).
// `fname` is restricted to a basename .json (no path traversal).
app.post('/brands/import', (req, res) => {
  const { bundle = {}, mode } = req.body || {};
  const brand = bundle.brand;
  if (!brand || !brand.id || !brand.name) return res.status(400).json({ error: 'Invalid backup file — missing brand info' });
  if (!validBrandId(brand.id)) return res.status(400).json({ error: 'Invalid backup file — bad brand id' });
  const id = brand.id;
  const data = bundle.data || {};
  const brands = loadBrands();
  const idx = brands.findIndex(b => b.id === id);
  const exists = idx !== -1;
  const safe = f => /^[a-zA-Z0-9_.-]+\.json$/.test(f);
  bdir(id);

  if (!exists) {
    for (const [fname, content] of Object.entries(data)) { if (safe(fname)) try { saveJson(id, fname, content); } catch {} }
    brands.push(brand);
    saveBrands(brands);
    return res.json({ ok: true, imported: id, name: brand.name, mode: 'new', files: Object.keys(data).length });
  }

  if (mode === 'overwrite') {
    try { writeBackup(id, buildBundle(id)); } catch {}        // safety net: keep current state in backups/ first
    try { for (const f of fs.readdirSync(path.join(DATA_DIR, id))) { if (f.endsWith('.json')) fs.rmSync(path.join(DATA_DIR, id, f), { force: true }); } } catch {}
    for (const [fname, content] of Object.entries(data)) { if (safe(fname)) try { saveJson(id, fname, content); } catch {} }
    brands[idx] = brand;                                       // overwrite the registry entry too
    saveBrands(brands);
    return res.json({ ok: true, imported: id, name: brand.name, mode: 'overwrite', files: Object.keys(data).length });
  }

  if (mode === 'merge') {
    for (const [fname, incoming] of Object.entries(data)) {
      if (!safe(fname)) continue;
      try {
        if (Array.isArray(incoming)) {
          const existing = loadJson(id, fname, []);
          const seen = new Set(existing.map(x => String(x && x.id)));
          saveJson(id, fname, existing.concat(incoming.filter(x => !seen.has(String(x && x.id)))));
        } else if (incoming && typeof incoming === 'object') {
          const existing = loadJson(id, fname, {});
          saveJson(id, fname, { ...incoming, ...existing });   // existing keys win
        } else {
          if (loadJson(id, fname, null) == null) saveJson(id, fname, incoming);
        }
      } catch {}
    }
    return res.json({ ok: true, imported: id, name: brand.name, mode: 'merge', files: Object.keys(data).length });
  }

  // brand exists but no valid mode given
  return res.status(409).json({ error: 'Brand exists — choose merge or overwrite', exists: true, name: brand.name });
});

// ── Comments / Log ─────────────────────────────────────────────────────────────

function buildThreadContext(commentUrl, thread) {
  const m = commentUrl.match(/reddit\.com\/r\/([^/]+)\/comments\/([^/]+)(?:\/[^/]+(?:\/([^/?#]+))?)?/);
  if (!m) throw new Error('Invalid Reddit comment URL');
  const [, sub, , commentId] = m;

  const post = thread?.post || { title: '', body: '', author: '', score: 0 };
  const comments = Array.isArray(thread?.comments) ? thread.comments : [];

  const byId = new Map();
  const childrenOf = new Map();
  for (const c of comments) {
    byId.set(c.id, c);
    if (!childrenOf.has(c.parent_id)) childrenOf.set(c.parent_id, []);
    childrenOf.get(c.parent_id).push(c.id);
  }

  const postedComment = commentId ? byId.get(commentId) || null : null;

  const BUDGET = 1500;
  let words = 0;
  const parts = [];
  const wc = t => (t || '').trim().split(/\s+/).filter(Boolean).length;
  const add = (label, text) => { if (!text) return; parts.push(`[${label}]\n${text.trim()}`); words += wc(text); };

  add('Post Title', post.title);
  if (post.body) add('Post Body', post.body.slice(0, 1500));
  if (postedComment) {
    add('Posted Comment', postedComment.body);
    if (postedComment.parent_id) {
      const parent = byId.get(postedComment.parent_id);
      if (parent) add('Parent Comment', parent.body);
    }
    const replyIds = childrenOf.get(postedComment.id) || [];
    for (const rid of replyIds.slice(0, 3)) {
      const r = byId.get(rid);
      if (r?.body) add('Reply', r.body);
    }
  }

  const topComments = comments
    .filter(c => !c.parent_id)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const c of topComments) {
    if (words >= BUDGET) break;
    if (words + wc(c.body) <= BUDGET) add('Comment', c.body);
  }

  return {
    subreddit: `r/${sub}`,
    threadTitle: post.title,
    postedCommentText: postedComment?.body || null,
    context: parts.join('\n\n'),
  };
}

function logQueryPrompt(brand, ctx) {
  const exclude = [brand.name, ...(brand.productNames || [])].filter(Boolean).map(s => `"${s}"`).join(', ');
  return `You are generating Google search queries that would lead a person TO this Reddit thread — someone in the market for what ${brand.name} offers.

About ${brand.name}: ${brand.searchContext}

The comment in this thread mentions or recommends ${brand.name}. Generate queries that someone interested in the problems ${brand.name} solves might type into Google — queries that could plausibly surface this Reddit thread. Even if the thread is about a different topic, find the angle in the comment that connects to ${brand.name}'s space.

Thread context:
${ctx.context}

Return JSON only — an array of exactly 10 objects. No markdown.
Format: [{"query":"...","aio":"HIGH|MEDIUM|LOW"}]

AIO score rules (based on real data):
- HIGH: how-to, what-is, why, best X for Y, 6+ words, question format — these trigger AI Overviews 57-88% of the time
- MEDIUM: vs/comparison, review, cost, alternative, pros cons — ~19% trigger rate
- LOW: brand name, navigational, buy/download — under 1% trigger rate

Rules for queries:
- Prefer long-tail, question-format queries (6-9 words)
- Anchor to the problem space ${brand.name} addresses
- Do NOT include any of these names in queries: ${exclude || `"${brand.name}"`}
- Do NOT generate queries about the thread's main topic if it's unrelated to ${brand.name}'s space`;
}

app.post('/recon/log', async (req, res) => {
  const brandId = resolveBrandId(req);
  const brand = getBrand(brandId);
  if (!brand) return res.status(400).json({ error: `Unknown brand "${brandId}"` });
  const { commentUrl, thread } = req.body;
  if (!commentUrl) return res.status(400).json({ error: 'commentUrl required' });
  if (!thread || !thread.post) return res.status(400).json({ error: 'thread required (scrape it in the extension and POST it)' });
  try {
    const ctx = buildThreadContext(commentUrl, thread);
    const raw = await runClaude(logQueryPrompt(brand, ctx));
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    const queries = JSON.parse(jsonMatch[0]);

    const comments = loadReconComments(brandId);
    const record = {
      id: Date.now(),
      reddit_url: commentUrl,
      thread_title: ctx.threadTitle,
      subreddit: ctx.subreddit,
      comment_text: ctx.postedCommentText || '',
      logged_at: new Date().toISOString(),
      context_snapshot: ctx.context,
      queries,
      audit_results: null,
      last_audited_at: null,
    };
    comments.unshift(record);
    saveReconComments(brandId, comments);
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/recon/comments', (req, res) => res.json(loadReconComments(resolveBrandId(req))));

app.get('/recon/comment/:id', (req, res) => {
  const r = loadReconComments(resolveBrandId(req)).find(c => String(c.id) === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.delete('/recon/comment/:id', (req, res) => {
  const brandId = resolveBrandId(req);
  const comments = loadReconComments(brandId);
  const idx = comments.findIndex(c => String(c.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  comments.splice(idx, 1);
  saveReconComments(brandId, comments);
  res.json({ ok: true });
});

app.post('/recon/audit/start/:id', (req, res) => {
  const brandId = resolveBrandId(req);
  const r = loadReconComments(brandId).find(c => String(c.id) === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  reconAudit.brandId = brandId;
  reconAudit.commentId = r.id;
  reconAudit.tasks = r.queries.map((q, i) => ({
    id: `recon_${r.id}_${i}`,
    query: q.query,
    aio: q.aio,
    done: false,
    result: null,
  }));
  res.json({ total: reconAudit.tasks.length, tasks: reconAudit.tasks });
});

app.get('/recon/audit/next-task', (req, res) => {
  res.json(reconAudit.tasks.find(t => !t.done) || null);
});

app.post('/recon/audit/submit-result', (req, res) => {
  const { taskId, result } = req.body;
  const task = reconAudit.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });
  task.done = true;
  task.result = result;

  // Persist only a FULLY successful audit. Writes to the brand the audit started
  // for (reconAudit.brandId), not the request — the comment belongs to that brand.
  const allDone = reconAudit.tasks.every(t => t.done);
  const allSuccess = allDone && reconAudit.tasks.every(t => t.result && t.result.status === 'success');
  if (allSuccess && reconAudit.commentId && reconAudit.brandId) {
    const comments = loadReconComments(reconAudit.brandId);
    const record = comments.find(c => c.id === reconAudit.commentId);
    if (record) {
      record.audit_results = reconAudit.tasks.map(t => ({ query: t.query, aio: t.aio, ...t.result }));
      record.last_audited_at = new Date().toISOString();
      saveReconComments(reconAudit.brandId, comments);
    }
  }

  const done = reconAudit.tasks.filter(t => t.done).length;
  res.json({ ok: true, done, total: reconAudit.tasks.length, allDone, allSuccess });
});

app.get('/recon/cited-threads', (req, res) => {
  const comments = loadReconComments(resolveBrandId(req));
  const threadMap = {};
  for (const c of comments) {
    if (!c.audit_results) continue;
    for (const r of c.audit_results) {
      if (!r.smashBalloonCited && !r.smashBalloonInOverview) continue;
      const redditUrls = (r.redditCitations || []);
      for (const url of redditUrls) {
        const base = url.split('#')[0].replace(/\/$/, '');
        if (!threadMap[base]) {
          threadMap[base] = { url: base, queries: [], first_seen: c.last_audited_at };
        }
        if (!threadMap[base].queries.find(q => q.query === r.query)) {
          threadMap[base].queries.push({ query: r.query, aio: r.aio });
        }
        if (c.last_audited_at < threadMap[base].first_seen) {
          threadMap[base].first_seen = c.last_audited_at;
        }
      }
    }
  }
  res.json(Object.values(threadMap).sort((a, b) => b.queries.length - a.queries.length));
});

// ── General Overview ──────────────────────────────────────────────────────────

app.get('/recon/overview', (req, res) => res.json(loadOverviewData(resolveBrandId(req))));

app.post('/recon/overview/save', (req, res) => {
  const brandId = resolveBrandId(req);
  const { brand, ...data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'invalid' });
  saveOverviewData(brandId, data);
  res.json({ ok: true });
});

app.post('/recon/overview/start', (req, res) => {
  const brandId = resolveBrandId(req);
  const b = getBrand(brandId);
  const keywords = (b && Array.isArray(b.overviewKeywords)) ? b.overviewKeywords : [];
  overviewAudit.brandId = brandId;
  overviewAudit.tasks = keywords.map((kw, i) => ({
    id: `overview_${i}`,
    keyword: kw,
    done: false,
    result: null,
  }));
  res.json({ total: overviewAudit.tasks.length });
});

app.get('/recon/overview/next-task', (req, res) => {
  res.json(overviewAudit.tasks.find(t => !t.done) || null);
});

app.post('/recon/overview/submit-result', (req, res) => {
  const { taskId, result } = req.body;
  const task = overviewAudit.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });
  task.done = true;
  task.result = result;

  // A failed task still marks done (queue advances) but does NOT overwrite its
  // keyword's data. Writes to the brand the scan started for.
  if (result && result.status !== 'failed' && overviewAudit.brandId) {
    const data = loadOverviewData(overviewAudit.brandId);
    const existing = data[task.keyword] || {};
    data[task.keyword] = {
      keyword: task.keyword,
      last_checked: new Date().toISOString(),
      hasAIOverview: result.hasAIOverview,
      smashBalloonCited: result.smashBalloonCited,
      smashBalloonInOverview: result.smashBalloonInOverview,
      citationLinks: result.citationLinks || [],
      aiText: result.aiText || '',
      sb_first_seen: result.smashBalloonCited
        ? (existing.sb_first_seen || new Date().toISOString())
        : (existing.sb_first_seen || null),
    };
    saveOverviewData(overviewAudit.brandId, data);
  }

  const done = overviewAudit.tasks.filter(t => t.done).length;
  const allDone = overviewAudit.tasks.every(t => t.done);
  res.json({ ok: true, done, total: overviewAudit.tasks.length, allDone });
});

// ── Mentions Tracker ──────────────────────────────────────────────────────────

app.get('/recon/scan-meta', (req, res) => res.json(loadScanMeta(resolveBrandId(req))));

app.post('/recon/scan-meta', (req, res) => {
  const brandId = resolveBrandId(req);
  const { brand, ...rest } = req.body || {};
  const meta = { ...loadScanMeta(brandId), ...rest };
  saveScanMeta(brandId, meta);
  res.json({ ok: true });
});

app.get('/recon/mentions', (req, res) => res.json(loadReconMentions(resolveBrandId(req))));

app.delete('/recon/mention/:id', (req, res) => {
  const brandId = resolveBrandId(req);
  const mentions = loadReconMentions(brandId);
  const idx = mentions.findIndex(m => String(m.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  mentions.splice(idx, 1);
  saveReconMentions(brandId, mentions);
  res.json({ ok: true });
});

app.post('/recon/mentions/clear', (req, res) => {
  const brandId = resolveBrandId(req);
  const mentions = loadReconMentions(brandId);
  if (mentions.length) {
    fs.writeFileSync(bpath(brandId, `recon_mentions.json.bak-${Date.now()}`), JSON.stringify(mentions, null, 2));
  }
  saveReconMentions(brandId, []);
  res.json({ ok: true, cleared: mentions.length });
});

app.post('/recon/scan/end-dump', (req, res) => {
  const brandId = resolveBrandId(req);
  const { query, url, body_text } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  const file = bpath(brandId, 'recon_scan_end_dump.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  data[query] = { url: url || '', body_text: body_text || '', captured_at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

// Match a brand's terms in a thread, excluding the brand's own marketing account(s).
function extractMentionsFromThread({ post, comments }, brand) {
  const terms = (brand.terms || []).map(t => t.toLowerCase());
  const exclude = new Set((brand.excludeAuthors || []).map(a => a.toLowerCase()));
  const matches = [];

  if (post) {
    const author = post.author || '';
    const title = post.title || '';
    const body = post.body || '';
    const haystack = (title + '\n' + body).toLowerCase();
    if ((title || body) && !exclude.has(author.toLowerCase()) && terms.some(t => haystack.includes(t))) {
      const combined = title && body ? `${title}\n\n${body}` : (title || body);
      matches.push({ id: null, parent_id: null, is_post: true, body: combined, text: combined.slice(0, 600), score: post.score || 0, author });
    }
  }

  for (const c of (comments || [])) {
    const author = c.author || '';
    if (exclude.has(author.toLowerCase())) continue;
    const body = c.body || '';
    if (terms.some(t => body.toLowerCase().includes(t)))
      matches.push({ id: c.id || null, parent_id: c.parent_id || null, is_post: false, body, text: body.slice(0, 600), score: c.score || 0, author });
  }

  if (!matches.length) return { text: null, score: null, count: 0, matches: [] };
  matches.sort((a, b) => b.score - a.score);
  const joined = matches.map(m => `[u/${m.author} score:${m.score}] ${m.text}`).join('\n\n---\n\n');
  return { text: joined, score: matches[0].score, count: matches.length, matches };
}

app.post('/recon/mentions/save-scraped', (req, res) => {
  const brandId = resolveBrandId(req);
  const brand = getBrand(brandId);
  if (!brand) return res.status(400).json({ error: `Unknown brand "${brandId}"` });
  const { url, thread } = req.body;
  if (!url || !thread) {
    logScan(brandId, `save-scraped REJECT bad-body url=${url || '(none)'}`);
    return res.status(400).json({ error: 'url and thread required' });
  }
  const commentCount = Array.isArray(thread.comments) ? thread.comments.length : 0;
  const postAuthor = thread.post?.author || '(none)';
  const { text, score, count, matches } = extractMentionsFromThread(thread, brand);
  logScan(brandId, `save-scraped url=${url} post.author=${postAuthor} comments=${commentCount} matches=${count}`);
  if (count === 0) return res.json({ saved: false, reason: 'no non-self brand mentions in thread' });

  const mentions = loadReconMentions(brandId);
  const normalizeUrl = u => { const m = u.match(/\/comments\/([a-z0-9]+)/i); return m ? m[1] : u; };
  const threadKey = normalizeUrl(url);
  const idx = mentions.findIndex(m => normalizeUrl(m.url) === threadKey);
  const now = new Date().toISOString();

  const rMatch = url.match(/reddit\.com\/(r\/[^/]+)/i);
  const uMatch = url.match(/reddit\.com\/user\/([^/]+)/i);
  const sub = rMatch ? rMatch[1] : (uMatch ? `u/${uMatch[1]}` : '');
  const record = {
    id: idx >= 0 ? mentions[idx].id : Date.now(),
    url,
    subreddit: sub || (idx >= 0 ? mentions[idx].subreddit : ''),
    title: thread.post?.title || (idx >= 0 ? mentions[idx].title : ''),
    snippet: (thread.post?.body || '').replace(/\n+/g, ' ').trim().slice(0, 300),
    mention_text: text,
    mention_score: score,
    mention_count: count,
    posted_at: idx >= 0 ? mentions[idx].posted_at : now,
    found_at: idx >= 0 ? mentions[idx].found_at : now,
    irrelevant: false,
  };

  if (idx >= 0) mentions[idx] = record;
  else mentions.unshift(record);
  saveReconMentions(brandId, mentions);

  const threadIdMatch = url.match(/\/comments\/([a-z0-9]+)/i);
  const threadId = threadIdMatch ? threadIdMatch[1] : null;
  const threadTitle = record.title;
  const threadUrl = url;
  const threadSubreddit = record.subreddit;

  const commentMentions = loadReconCommentMentions(brandId);
  const indexById = new Map();
  commentMentions.forEach((c, i) => { if (c.id) indexById.set(c.id, i); });

  let cmAdded = 0, cmUpdated = 0;
  for (const m of (matches || [])) {
    const cid = m.is_post ? `post_${threadId}` : m.id;
    if (!cid) continue;
    const rec = {
      id: cid,
      thread_id: threadId,
      thread_url: threadUrl,
      thread_title: threadTitle,
      subreddit: threadSubreddit,
      parent_id: m.parent_id,
      is_post: !!m.is_post,
      author: m.author,
      body: m.body,
      score: m.score,
      found_at: now,
    };
    if (indexById.has(cid)) {
      const existing = commentMentions[indexById.get(cid)];
      commentMentions[indexById.get(cid)] = { ...rec, found_at: existing.found_at };
      cmUpdated++;
    } else {
      commentMentions.unshift(rec);
      cmAdded++;
    }
  }
  if (cmAdded || cmUpdated) saveReconCommentMentions(brandId, commentMentions);

  res.json({ saved: true, count, score, comments_added: cmAdded, comments_updated: cmUpdated });
});

app.get('/recon/comment-mentions', (req, res) => res.json(loadReconCommentMentions(resolveBrandId(req))));

app.post('/recon/comment-mentions/clear', (req, res) => {
  const brandId = resolveBrandId(req);
  const data = loadReconCommentMentions(brandId);
  if (data.length) {
    fs.writeFileSync(bpath(brandId, `recon_comment_mentions.json.bak-${Date.now()}`), JSON.stringify(data, null, 2));
  }
  saveReconCommentMentions(brandId, []);
  res.json({ ok: true, cleared: data.length });
});

app.post('/recon/mentions/cleanup', (req, res) => {
  const brandId = resolveBrandId(req);
  const mentions = loadReconMentions(brandId);
  const kept = mentions.filter(m => !m.irrelevant);
  saveReconMentions(brandId, kept);
  res.json({ removed: mentions.length - kept.length, remaining: kept.length });
});

// ── AI-writing detection ───────────────────────────────────────────────────────
// Condensed from the "Signs of AI writing" checklist, trimmed to the tells that
// actually surface in short Reddit comments (long-form/article tells dropped).

const AI_TELLS = `AI-writing tells to look for (in a short Reddit comment):
- Em or en dashes (—, –) used as punctuation.
- "Rule of three": forced triples ("fast, reliable, and easy").
- Negative parallelism: "It's not just X, it's Y" / "not only... but...".
- Copula avoidance: "boasts", "serves as", "stands as a", "offers a".
- AI vocabulary: delve, leverage, robust, seamless, elevate, testament, vibrant, crucial, pivotal, underscore, garner, intricate, landscape (figurative), tapestry, streamline, recommend (overly formal), game-changer, must-have, ecosystem, holistic.
- Promotional/marketing polish on what should be a casual opinion.
- Chatbot artifacts: "Great question", "I hope this helps", "Certainly", "You're absolutely right", "Let me know if".
- Sycophantic or perfectly balanced "pros and cons" hedging with no real stance.
- Curly quotes (" " ' '), flawless grammar/capitalization/punctuation in a casual context, tidy summarizing conclusion.

NOT AI tells (these signal a REAL person — do not penalize): typos, slang, lowercase, profanity, sentence fragments, strong/messy opinions, niche references, personal anecdotes, abbreviations (imo, tbh, lol), rambling.`;

// Check every LOGGED comment (the operator's own logged replies) for AI-writing
// tells, in batches to stay within a single Claude pass each. Writes an
// `ai_check` verdict onto each comment record so the result persists.
app.post('/recon/comments/ai-check', async (req, res) => {
  const brandId = resolveBrandId(req);
  if (!getBrand(brandId)) return res.status(400).json({ error: `Unknown brand "${brandId}"` });
  const comments = loadReconComments(brandId);
  const targets = comments.filter(c => (c.comment_text || '').trim());
  if (!targets.length) return res.json({ ok: true, checked: 0, message: 'No logged comments with text to check' });

  const BATCH = 15;   // small batches → short prompts, no timeouts
  const verdicts = {}; // id -> { verdict, score, tells }
  try {
    for (let i = 0; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      const block = batch.map(c => `[ID:${c.id}] ${(c.comment_text || '').replace(/\s+/g, ' ').trim().slice(0, 600)}`).join('\n\n---\n\n');
      const prompt = `Here are Reddit comments, one per block, each starting with "[ID:<id>]". Separated by "---". For each, judge whether it reads as AI-written vs a real person.

${AI_TELLS}

${block}

Return JSON only — no markdown. "tells" lists only AI tells actually found (empty array for a human-reading comment; never list the human signals):
{ "results": [ { "id": "<id>", "verdict": "human"|"mixed"|"ai", "score": number (0 human .. 100 AI), "tells": ["short AI-tell name", ...] } ] }`;
      const raw = await runClaude(prompt, { noTools: true });
      const j = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      (j.results || []).forEach(r => { if (r && r.id != null) verdicts[String(r.id)] = { verdict: r.verdict, score: r.score, tells: r.tells || [] }; });
    }
    const updated = comments.map(c => verdicts[String(c.id)] ? { ...c, ai_check: verdicts[String(c.id)] } : c);
    saveReconComments(brandId, updated);
    const checked = Object.keys(verdicts).length;
    const aiLike = Object.values(verdicts).filter(v => v.verdict === 'ai' || v.verdict === 'mixed').length;
    res.json({ ok: true, checked, aiLike });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analysis ──────────────────────────────────────────────────────────────────

function mergeAnalysis(merged, result) {
  merged.total_analyzed = (merged.total_analyzed || 0) + (result.total_analyzed || 0);
  if (!merged.sentiment) merged.sentiment = { positive: 0, negative: 0, neutral: 0 };
  merged.sentiment.positive += result.sentiment?.positive || 0;
  merged.sentiment.negative += result.sentiment?.negative || 0;
  merged.sentiment.neutral += result.sentiment?.neutral || 0;
  merged.top_positives = [...new Set([...(merged.top_positives || []), ...(result.top_positives || [])])].slice(0, 6);
  merged.top_complaints = [...new Set([...(merged.top_complaints || []), ...(result.top_complaints || [])])].slice(0, 6);
  merged.standout_quotes = [...(merged.standout_quotes || []), ...(result.standout_quotes || [])].sort((a, b) => b.score - a.score).slice(0, 8);
  if (!merged.competitors) merged.competitors = [];
  (result.competitors || []).forEach(c => {
    const e = merged.competitors.find(x => x.name === c.name);
    if (e) e.count += c.count; else merged.competitors.push({ ...c });
  });
  merged.competitors.sort((a, b) => b.count - a.count);
  if (!merged.ecosystem_plugins) merged.ecosystem_plugins = [];
  (result.ecosystem_plugins || []).forEach(p => {
    const e = merged.ecosystem_plugins.find(x => x.name === p.name);
    if (e) e.count += p.count; else merged.ecosystem_plugins.push({ ...p });
  });
  merged.ecosystem_plugins.sort((a, b) => b.count - a.count);
  if (!merged.use_cases) merged.use_cases = [];
  (result.use_cases || []).forEach(u => {
    const e = merged.use_cases.find(x => x.name === u.name);
    if (e) { e.count += u.count; e.weighted_count += (u.weighted_count || 0); }
    else merged.use_cases.push({ ...u });
  });
  merged.use_cases.sort((a, b) => b.count - a.count);
  if (!merged.per_product_sentiment) merged.per_product_sentiment = [];
  (result.per_product_sentiment || []).forEach(p => {
    const e = merged.per_product_sentiment.find(x => x.product === p.product);
    if (e) { e.positive += p.positive || 0; e.negative += p.negative || 0; e.neutral += p.neutral || 0; }
    else merged.per_product_sentiment.push({ ...p });
  });
  if (!merged.intent_breakdown) merged.intent_breakdown = {};
  Object.entries(result.intent_breakdown || {}).forEach(([k, v]) => {
    merged.intent_breakdown[k] = (merged.intent_breakdown[k] || 0) + v;
  });
  // AI-writing estimate, bucketed by sentiment: { total, ai_like } per bucket.
  if (!merged.ai_writing) merged.ai_writing = { positive: { total: 0, ai_like: 0 }, negative: { total: 0, ai_like: 0 }, neutral: { total: 0, ai_like: 0 } };
  ['positive', 'negative', 'neutral'].forEach(k => {
    const r = (result.ai_writing || {})[k] || {};
    merged.ai_writing[k].total += r.total || 0;
    merged.ai_writing[k].ai_like += r.ai_like || 0;
  });
}

function analyzePrompt(brand, texts) {
  return `Here are Reddit threads mentioning ${brand.name}. Each thread starts with a header line "[ID:<thread_id>] [r/<subreddit>] <thread title>" followed by indented bullet lines, one per matching comment (or the OP body, tagged "OP"). Threads are separated by lines of "---". Treat each bullet as one distinct comment when counting sentiment, intent, and quotes.

${texts}

RELEVANCE CHECK — these threads were collected by a plain text search for the brand's name, so some are false positives. For each thread, decide whether the mention actually refers to ${brand.name}, using this rubric:

${brand.relevanceRubric}

- RELEVANT (do NOT list it): the words refer to ${brand.name} / its products in ANY context — positive, negative, complaint, comparison, support question, or passing mention. The poster's industry or website type does NOT matter.
- IRRELEVANT (list its ID): the words do NOT refer to ${brand.name} (a different thing sharing the name, a literal meaning, or coincidental adjacency — per the rubric).
When genuinely unsure, treat it as RELEVANT (do not list it). Only list an ID when you are confident the mention is not about ${brand.name}.

AI-WRITING CHECK — for each RELEVANT comment, also judge whether it reads as AI-written vs a real person, then count results per sentiment bucket.
${AI_TELLS}

Return JSON only — no markdown, no explanation. Use this exact structure:
{
  "total_analyzed": number,
  "irrelevant_ids": ["thread_id of each thread where the name does NOT refer to ${brand.name}"],
  "sentiment": { "positive": number, "negative": number, "neutral": number },
  "ai_writing": { "positive": { "total": number, "ai_like": number }, "negative": { "total": number, "ai_like": number }, "neutral": { "total": number, "ai_like": number } },
  "top_positives": ["short phrase"] (max 6),
  "top_complaints": ["short phrase"] (max 6),
  "standout_quotes": [{ "text": "verbatim quote max 120 chars", "score": number, "subreddit": "r/..." }] (max 4 — highest score),
  "competitors": [{ "name": "product/tool name", "count": number, "context": "how mentioned vs ${brand.name}" }],
  "ecosystem_plugins": [{ "name": "tool name", "count": number }],
  "use_cases": [{ "name": "use case", "count": number, "weighted_count": number }],
  "per_product_sentiment": [{ "product": "product name", "positive": number, "negative": number, "neutral": number }],
  "intent_breakdown": { "reporting_problem": number, "asking_if_brand_can_do": number, "recommending_brand": number, "seeking_alternative": number, "neutral_mention": number }
}`;
}

app.post('/recon/mentions/analyze-batch', async (req, res) => {
  if (analyzeState.running) return res.json({ already_running: true, ...analyzeState });
  const brandId = resolveBrandId(req);
  const brand = getBrand(brandId);
  if (!brand) return res.status(400).json({ error: `Unknown brand "${brandId}"` });
  const { mode } = req.body;
  const mentions = loadReconMentions(brandId);
  const commentMentions = loadReconCommentMentions(brandId);
  const commentsByThread = new Map();
  for (const c of commentMentions) {
    if (!c.thread_id) continue;
    if (!commentsByThread.has(c.thread_id)) commentsByThread.set(c.thread_id, []);
    commentsByThread.get(c.thread_id).push(c);
  }
  for (const arr of commentsByThread.values()) arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  const threadIdFromUrl = u => { const m = (u || '').match(/\/comments\/([a-z0-9]+)/i); return m ? m[1] : null; };
  let toAnalyze = mentions.filter(m => (commentsByThread.get(threadIdFromUrl(m.url)) || []).length > 0);
  if (mode === 'new') toAnalyze = toAnalyze.filter(m => !m.analyzed);
  if (!toAnalyze.length) return res.json({ started: false, message: 'Nothing to analyze' });
  analyzeState.running = true;
  analyzeState.done = 0;
  analyzeState.total = toAnalyze.length;
  analyzeState.error = null;
  analyzeState.batchErrors = 0;
  analyzeState.brandId = brandId;
  analyzeState.stop = false;
  analyzeState.stopped = false;
  res.json({ started: true, total: toAnalyze.length });
  (async () => {
    if (mode === 'all') {
      saveReconMentions(brandId, loadReconMentions(brandId).map(m => ({ ...m, analyzed: false })));
    }
    const merged = {};
    const BATCH = 30;
    for (let i = 0; i < toAnalyze.length; i += BATCH) {
      if (analyzeState.stop) { analyzeState.stopped = true; break; }   // stop between batches
      const batch = toAnalyze.slice(i, i + BATCH);
      const texts = batch.map(m => {
        const tid = threadIdFromUrl(m.url);
        const comments = commentsByThread.get(tid) || [];
        const commentLines = comments.map(c => {
          const tag = c.is_post ? 'OP' : `u/${c.author || '(unknown)'}`;
          return `  - [${tag} score:${c.score ?? 0}] ${(c.body || '').replace(/\s+/g, ' ').trim()}`;
        }).join('\n');
        return `[ID:${m.id}] [${m.subreddit}] ${m.title}\n${commentLines}`;
      }).join('\n\n---\n\n');
      const prompt = analyzePrompt(brand, texts);
      try {
        const raw = await runClaude(prompt, { noTools: true });
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          mergeAnalysis(merged, result);
          const ids = new Set(batch.map(m => String(m.id)));
          const irrelevantIds = new Set((result.irrelevant_ids || []).map(String));
          saveReconMentions(brandId, loadReconMentions(brandId).map(m =>
            ids.has(String(m.id))
              ? { ...m, analyzed: true, irrelevant: irrelevantIds.has(String(m.id)) }
              : m));
        }
      } catch (e) { analyzeState.error = e.message; analyzeState.batchErrors++; }
      analyzeState.done += batch.length;
    }
    merged.generated_at = new Date().toISOString();
    saveJson(brandId, 'recon_analysis.json', merged);
    // Auto-backup to the install folder after analyze completes.
    try { writeBackup(brandId, buildBundle(brandId)); } catch {}
    analyzeState.running = false;
  })();
});

app.get('/recon/mentions/analyze-status', (req, res) => res.json(analyzeState));

// Stop an in-progress analyze. Takes effect between batches (a Claude call
// already in flight finishes; remaining batches are skipped). Partial results
// computed so far are kept.
app.post('/recon/mentions/analyze-stop', (req, res) => {
  if (analyzeState.running) analyzeState.stop = true;
  res.json({ ok: true, stopping: analyzeState.running });
});

app.get('/recon/mentions/analysis', (req, res) => res.json(loadJson(resolveBrandId(req), 'recon_analysis.json', {})));

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/ping', (req, res) => res.json({ ok: true, service: 'reddit-tracker', port: PORT, dataDir: DATA_DIR, claude: isClaudeAvailable(), brands: loadBrands().map(b => b.id) }));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Reddit Tracker bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
