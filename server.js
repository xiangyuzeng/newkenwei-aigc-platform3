/**
 * Kenwei AIGC - China Deploy Friendly Server
 *
 * Goals of this rebuild:
 *  - Run in Mainland China cloud servers (Tencent/Huawei) reliably
 *  - Use KIE.AI APIKey as the unified model gateway (Sora2 / Veo3.1 / Kling / image tools)
 *  - Keep same-origin browser calls (no hardcoded upstream domains in HTML)
 *  - Preserve existing "task history" (IndexedDB) and "my usage" (server-side logs)
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');

// ------------------------------
// Config
// ------------------------------

const IS_VERCEL = Boolean(process.env.VERCEL);

const PORT = Number(process.env.PORT || 3000);

// The project root at runtime. On Vercel, using process.cwd() is recommended for locating bundled files.
const ROOT_DIR = process.env.ROOT_DIR || process.cwd();

// Vercel serverless runtime has a read-only filesystem except for /tmp.
// Default to /tmp paths on Vercel so features like "/api/generations" and "/uploads/*" work during testing.
const DEFAULT_DATA_DIR = IS_VERCEL ? path.join('/tmp', 'kenwei-data') : path.join(ROOT_DIR, 'data');
const DEFAULT_UPLOADS_DIR = IS_VERCEL ? path.join('/tmp', 'kenwei-uploads') : path.join(ROOT_DIR, 'public', 'uploads');

const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const UPLOADS_DIR = process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR;

// KIE base: keep compatibility with the previous UPSTREAM_GATEWAY_BASE name.
const KIE_API_BASE = (process.env.KIE_API_BASE || process.env.UPSTREAM_GATEWAY_BASE || 'https://api.kie.ai').replace(/\/$/, '');

// Server-side timeouts (ms)
// Note: Vercel free tier has 10s limit, Pro has 60s. Video tasks start async and return immediately.
// The IMAGE_SYNC_MAX_WAIT_MS is for synchronous image generation which should complete quickly.
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || (IS_VERCEL ? 9_000 : 120_000));
const IMAGE_SYNC_MAX_WAIT_MS = Number(process.env.IMAGE_SYNC_MAX_WAIT_MS || (IS_VERCEL ? 50_000 : 180_000));
const IMAGE_SYNC_POLL_MS = Number(process.env.IMAGE_SYNC_POLL_MS || (IS_VERCEL ? 2_000 : 2_000));

// Upload limits
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024) // default 20MB
  }
});

// ------------------------------
// Utilities
// ------------------------------

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getBearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function sha256Short(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Fetch timeout')), ms);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(signal.reason));
  }
  return { signal: controller.signal, cancel: () => clearTimeout(timeout) };
}

async function fetchJson(url, options = {}) {
  const { signal: outerSignal } = options;
  const { signal, cancel } = withTimeout(outerSignal, FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: resp.ok, status: resp.status, json };
  } finally {
    cancel();
  }
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 4) return 'image/png';
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  // WEBP (RIFF....WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp';
  return 'image/png';
}

function extFromMime(mime) {
  if (!mime) return 'bin';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('webp')) return 'webp';
  return 'bin';
}

// ------------------------------
// In-memory usage logs (per APIKey hash)
// ------------------------------

const usageLogs = new Map(); // keyHash -> Array<log>

function pushUsageLog(apiKey, log) {
  if (!apiKey) return;
  const keyHash = sha256Short(apiKey);
  const arr = usageLogs.get(keyHash) || [];
  arr.unshift(log);
  // Keep last 2000 logs per key
  if (arr.length > 2000) arr.length = 2000;
  usageLogs.set(keyHash, arr);
}

// ------------------------------
// KIE helpers
// ------------------------------

async function kieUploadBuffer(apiKey, buffer, filename, mimeType) {
  if (!apiKey) throw new Error('Missing APIKey');
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty upload');

  const mime = mimeType || detectImageMime(buffer);
  const name = filename || `upload.${extFromMime(mime)}`;

  // Try a few common upload endpoints for resiliency.
  const candidates = [
    `${KIE_API_BASE}/api/v1/files/upload`,
    `${KIE_API_BASE}/api/v1/file/upload`,
    `${KIE_API_BASE}/api/v1/upload`,
  ];

  const blob = new Blob([buffer], { type: mime });
  for (const url of candidates) {
    try {
      const form = new FormData();
      form.append('file', blob, name);

      const { ok, status, json } = await fetchJson(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        body: form
      });

      if (!ok) continue;

      // Flexible extraction
      const data = json?.data ?? json;
      const fileUrl =
        data?.url ||
        data?.fileUrl ||
        data?.file_url ||
        data?.downloadUrl ||
        data?.download_url ||
        data?.resultUrl ||
        data?.result_url;

      if (fileUrl && typeof fileUrl === 'string') {
        return fileUrl;
      }
    } catch {
      // try next
    }
  }

  throw new Error('KIE file upload failed (unknown upload endpoint/response). You may need to set KIE_API_BASE or update upload endpoint candidates.');
}

function mapAspectRatio(sizeOrRatio) {
  const v = String(sizeOrRatio || '').trim();
  if (!v) return '16:9';
  if (v === '16:9' || v === '9:16' || v === '1:1' || v === '4:3' || v === '3:4') return v;
  // Some pages use 'Auto'
  if (v.toLowerCase() === 'auto') return 'Auto';
  // Fallback
  return '16:9';
}

function isVeoModel(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('veo');
}

function isSoraModel(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('sora');
}

function isKlingModel(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('kling');
}

function mapSoraMarketModel(model, isImageToVideo) {
  const m = String(model || '').toLowerCase();
  const kind = isImageToVideo ? 'image-to-video' : 'text-to-video';

  if (m === 'sora-2-pro' || m === 'sora_2_pro' || m.includes('pro')) return `sora-2-pro/${kind}`;
  if (m === 'sora-2-all' || m === 'sora_2_all' || m.includes('all')) return `sora-2-pro/${kind}`;
  return `sora-2/${kind}`;
}

async function kieCreateTask(apiKey, model, input) {
  const url = `${KIE_API_BASE}/api/v1/jobs/createTask`;
  const { ok, status, json } = await fetchJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ model, input })
  });
  if (!ok) {
    throw new Error(`KIE createTask failed (${status}): ${JSON.stringify(json)}`);
  }
  const taskId = json?.data?.taskId || json?.data?.task_id || json?.taskId || json?.task_id;
  if (!taskId) {
    throw new Error(`KIE createTask: missing taskId: ${JSON.stringify(json)}`);
  }
  return taskId;
}

async function kieRecordInfo(apiKey, taskId) {
  const url = `${KIE_API_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
  const { ok, status, json } = await fetchJson(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });
  if (!ok) {
    throw new Error(`KIE recordInfo failed (${status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function kieVeoGenerate(apiKey, body) {
  const url = `${KIE_API_BASE}/api/v1/veo/generate`;
  const { ok, status, json } = await fetchJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!ok) {
    throw new Error(`KIE Veo generate failed (${status}): ${JSON.stringify(json)}`);
  }
  const taskId = json?.data?.taskId || json?.data?.task_id || json?.taskId || json?.task_id;
  if (!taskId) throw new Error(`KIE Veo: missing taskId: ${JSON.stringify(json)}`);
  return taskId;
}

async function kieVeoRecordInfo(apiKey, taskId) {
  const url = `${KIE_API_BASE}/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`;
  const { ok, status, json } = await fetchJson(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });
  if (!ok) throw new Error(`KIE Veo record-info failed (${status}): ${JSON.stringify(json)}`);
  return json;
}

// --- Image generation (best-effort) ---
// The KIE docs expose dedicated endpoints for "GPT Image" and other image models.
// To keep this project resilient to endpoint naming differences, we try a few candidates.
async function kieImageGenerate(apiKey, body) {
  const candidates = [
    { gen: `${KIE_API_BASE}/api/v1/gpt-image/generate`, rec: `${KIE_API_BASE}/api/v1/gpt-image/record-info` },
    { gen: `${KIE_API_BASE}/api/v1/gpt-image/generate`, rec: `${KIE_API_BASE}/api/v1/gpt-image/recordInfo` },
    { gen: `${KIE_API_BASE}/api/v1/image/generate`, rec: `${KIE_API_BASE}/api/v1/image/record-info` },
    { gen: `${KIE_API_BASE}/api/v1/images/generate`, rec: `${KIE_API_BASE}/api/v1/images/record-info` },
  ];

  for (const c of candidates) {
    try {
      const { ok, status, json } = await fetchJson(c.gen, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!ok) continue;
      const taskId = json?.data?.taskId || json?.data?.task_id || json?.taskId || json?.task_id;
      if (taskId) return { taskId, recordBase: c.rec };
    } catch {
      // try next
    }
  }
  throw new Error('KIE image generate failed (unknown endpoint/response).');
}

async function kieImageRecordInfo(apiKey, recordBase, taskId) {
  const url = `${recordBase}?taskId=${encodeURIComponent(taskId)}`;
  const { ok, status, json } = await fetchJson(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  });
  if (!ok) throw new Error(`KIE image record-info failed (${status}): ${JSON.stringify(json)}`);
  return json;
}

async function waitForKieImageResult(apiKey, recordBase, taskId) {
  const start = Date.now();
  while (Date.now() - start < IMAGE_SYNC_MAX_WAIT_MS) {
    const json = await kieImageRecordInfo(apiKey, recordBase, taskId);
    const status = normalizeKieStatusToSimple(json);
    if (status === 'completed') {
      const data = json?.data ?? {};
      const response = data?.response ?? {};
      const urls = response?.resultUrls || response?.result_urls || [];
      if (Array.isArray(urls) && urls.length) return urls;
      const first = extractFirstResultUrl(json);
      if (first) return [first];
      return [];
    }
    if (status === 'failed') {
      const data = json?.data ?? {};
      throw new Error(data?.errorMessage || data?.message || json?.msg || 'image generation failed');
    }
    await new Promise(r => setTimeout(r, IMAGE_SYNC_POLL_MS));
  }
  throw new Error('Image generation timed out');
}

function normalizeKieStatusToSimple(json) {
  const data = json?.data ?? json;
  const successFlag = data?.successFlag;
  const stateRaw = data?.state ?? data?.status ?? data?.task_status ?? data?.taskStatus;
  const state = String(stateRaw || '').toLowerCase();

  if (successFlag === 1 || state === 'success' || state === 'succeed' || state === 'completed' || state === 'done') {
    return 'completed';
  }
  if (successFlag === 2 || successFlag === 3 || state === 'failed' || state === 'error' || state === 'fail') {
    return 'failed';
  }
  // default: still processing
  return 'processing';
}

function extractFirstResultUrl(json) {
  const data = json?.data ?? json;
  const response = data?.response ?? data?.result ?? {};
  const urls =
    response?.resultUrls ||
    response?.result_urls ||
    response?.urls ||
    data?.resultUrls ||
    data?.result_urls ||
    data?.urls ||
    [];

  if (Array.isArray(urls) && urls.length) return urls[0];

  // Some providers return nested task_result
  const taskResult = data?.task_result || data?.taskResult;
  const maybe = taskResult?.videos?.[0]?.url || taskResult?.images?.[0]?.url;
  if (maybe) return maybe;

  return data?.video_url || data?.url || null;
}

// ------------------------------
// App
// ------------------------------

ensureDirSync(DATA_DIR);
ensureDirSync(UPLOADS_DIR);

const app = express();
app.set('trust proxy', 1);
// ------------------------------
// Vercel rewrite compatibility
// ------------------------------
//
// Many Vercel Express deployments use a rewrite that routes every request to `/api`.
// Depending on the forwarding behavior, the request might arrive with a `/api` prefix
// (e.g. `/api/v1/...`) even though the browser requested `/v1/...`.
// This middleware makes routing tolerant by stripping `/api` ONLY for known non-API
// static + gateway prefixes.
//
// We intentionally DO NOT strip `/api/health` and `/api/proxy/*`.
const STRIP_API_PREFIXES = [
  '/v1', '/v1beta', '/sora', '/veo', '/kling',
  '/uploads', '/scripts', '/styles', '/images', '/assets',
  '/gemini', '/zhinengti', '/kling-video'
];

app.use((req, res, next) => {
  if (req.url && req.url.startsWith('/api/')) {
    const rest = req.url.slice(4); // remove leading '/api'
    const pathname = rest.split('?')[0] || '';
    if (
      pathname !== '/health' &&
      !pathname.startsWith('/proxy/') &&
      STRIP_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
    ) {
      req.url = rest || '/';
    }
  }
  next();
});

app.use(cookieParser());

// JSON payloads can be large because some pages send base64.
app.use(express.json({ limit: process.env.JSON_LIMIT || '50mb' }));

// ------------------------------
// Health
// ------------------------------

app.get(['/api/health','/health'], async (req, res) => {
  const health = {
    ok: true,
    time: new Date().toISOString(),
    kieBase: KIE_API_BASE,
    isVercel: IS_VERCEL,
    nodeVersion: process.version
  };

  // Optionally test KIE connectivity (if ?check=kie is passed)
  if (req.query.check === 'kie') {
    try {
      const testUrl = `${KIE_API_BASE}/api/v1/models`;
      const { signal, cancel } = withTimeout(null, 5000);
      const resp = await fetch(testUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal
      });
      cancel();
      health.kieReachable = resp.ok || resp.status === 401; // 401 means API is reachable but needs auth
      health.kieStatus = resp.status;
    } catch (err) {
      health.kieReachable = false;
      health.kieError = String(err.message || err);
    }
  }

  res.json(health);
});

// ------------------------------
// Local cloud-like storage (generation history)
// ------------------------------

const genFile = path.join(DATA_DIR, 'generations.json');
const statsFile = path.join(DATA_DIR, 'stats.json');

function loadGenerations() {
  return readJson(genFile, []);
}

function saveGenerations(list) {
  writeJson(genFile, list);
}

function loadStats() {
  return readJson(statsFile, { total: 0, byModel: {}, byDay: {} });
}

function saveStats(s) {
  writeJson(statsFile, s);
}

function incStats(model) {
  const day = new Date().toISOString().slice(0, 10);
  const s = loadStats();
  s.total = (s.total || 0) + 1;
  s.byModel = s.byModel || {};
  s.byDay = s.byDay || {};
  s.byModel[model] = (s.byModel[model] || 0) + 1;
  s.byDay[day] = (s.byDay[day] || 0) + 1;
  saveStats(s);
}

function saveBase64ToUploads(base64DataUrl) {
  // base64DataUrl: data:image/png;base64,....
  const m = /^data:([^;]+);base64,(.+)$/.exec(base64DataUrl || '');
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2];
  const buf = Buffer.from(b64, 'base64');
  const ext = extFromMime(mime);
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const outPath = path.join(UPLOADS_DIR, name);
  fs.writeFileSync(outPath, buf);
  return `/uploads/${name}`;
}

app.post('/api/generations', async (req, res) => {
  try {
    const { apiKey = '', prompt = '', model = '', sourceType = 'text', images = [] } = req.body || {};

    const list = loadGenerations();
    const id = crypto.randomBytes(10).toString('hex');
    const createdAt = Date.now();

    const savedImages = (Array.isArray(images) ? images : []).map((img) => {
      if (!img) return null;
      if (img.url) return { url: img.url };
      if (img.base64 && String(img.base64).startsWith('data:')) {
        const url = saveBase64ToUploads(img.base64);
        return url ? { url } : null;
      }
      if (typeof img === 'string') {
        if (img.startsWith('data:')) {
          const url = saveBase64ToUploads(img);
          return url ? { url } : null;
        }
        return { url: img };
      }
      return null;
    }).filter(Boolean);

    const record = { id, apiKeyHash: apiKey ? sha256Short(apiKey) : '', prompt, model, sourceType, images: savedImages, createdAt };
    list.unshift(record);
    saveGenerations(list);
    if (model) incStats(model);

    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/generations', (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
    const apiKey = String(req.query.apiKey || '');

    const list = loadGenerations();
    const filtered = apiKey ? list.filter(r => r.apiKeyHash === sha256Short(apiKey)) : list;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    res.json({
      generations: filtered.slice(start, end),
      total: filtered.length,
      page,
      pageSize
    });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.delete('/api/generations/:id', (req, res) => {
  try {
    const id = String(req.params.id);
    const apiKey = String(req.query.apiKey || '');
    const keyHash = apiKey ? sha256Short(apiKey) : '';

    const list = loadGenerations();
    const idx = list.findIndex(r => r.id === id && (!keyHash || r.apiKeyHash === keyHash));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    list.splice(idx, 1);
    saveGenerations(list);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const s = loadStats();
    res.json({ success: true, data: s });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ------------------------------
// "My Usage" compatibility endpoints
// ------------------------------

// token/info -> KIE credits (best-effort; endpoint may evolve)
app.get(['/api/proxy/token/info','/proxy/token/info'], async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ success: false, message: 'Missing Authorization Bearer APIKey' });

  const candidates = [
    `${KIE_API_BASE}/api/v1/chat/credit`,
    `${KIE_API_BASE}/api/v1/user/credits`,
    `${KIE_API_BASE}/api/v1/user/credit`,
  ];

  for (const url of candidates) {
    try {
      const { ok, status, json } = await fetchJson(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
      });
      if (!ok) continue;

      const data = json?.data ?? json;
      const credit =
        data?.credit ??
        data?.credits ??
        data?.balance ??
        data?.remaining ??
        data?.remain ??
        data?.quota ??
        null;

      const used = data?.used ?? data?.usedCredit ?? data?.used_credits ?? data?.used_quota ?? null;

      return res.json({ success: true, data: { credit, used } });
    } catch {
      // try next
    }
  }

  return res.status(502).json({ success: false, message: 'Unable to fetch credits from KIE (credit endpoint not reachable).' });
});

// log/self -> local proxy call logs (per APIKey)
app.get(['/api/proxy/log/self','/proxy/log/self'], (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ message: 'Missing Authorization Bearer APIKey' });
  const keyHash = sha256Short(apiKey);
  const p = Math.max(0, Number(req.query.p || 0));
  const size = Math.min(100, Math.max(1, Number(req.query.size || 20)));
  const arr = usageLogs.get(keyHash) || [];
  const start = p * size;
  const end = start + size;
  res.json({ data: arr.slice(start, end), total: arr.length });
});

// ------------------------------
// KIE Compatibility Layer
// ------------------------------

// 1) Sora/Veo unified video endpoint used by the existing frontend pages
app.post('/v1/videos', upload.any(), async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Authorization Bearer APIKey' });

  const model = String(req.body.model || '').trim();
  const prompt = String(req.body.prompt || '').trim();
  const seconds = String(req.body.seconds || '').trim();
  const size = String(req.body.size || '').trim();
  const resolution = String(req.body.resolution || '').trim();

  const hasFile = Array.isArray(req.files) && req.files.length > 0;

  try {
    // Veo
    if (isVeoModel(model)) {
      const aspectRatio = mapAspectRatio(size);
      const kieModel = model.toLowerCase().includes('fast') ? 'veo3_fast' : 'veo3';

      const taskId = await kieVeoGenerate(apiKey, {
        prompt,
        model: kieModel,
        aspectRatio,
        // KIE will infer generation type based on presence of imageUrls
        imageUrls: []
      });

      pushUsageLog(apiKey, { created_at: nowUnix(), model_name: `veo:${kieModel}`, prompt, image_count: 0, path: '/v1/videos', kind: 'create' });
      return res.json({ id: taskId, status: 'processing' });
    }

    // Sora2 (Market)
    if (isSoraModel(model)) {
      const marketModel = mapSoraMarketModel(model, hasFile);
      const aspect_ratio = mapAspectRatio(size);

      const input = {
        prompt,
        aspect_ratio,
      };
      if (seconds) input.duration = seconds;
      if (resolution) input.resolution = resolution;

      if (hasFile) {
        const f = req.files[0];
        const fileUrl = await kieUploadBuffer(apiKey, f.buffer, f.originalname, f.mimetype);
        input.image_urls = [fileUrl];
      }

      const taskId = await kieCreateTask(apiKey, marketModel, input);
      pushUsageLog(apiKey, { created_at: nowUnix(), model_name: marketModel, prompt, image_count: hasFile ? 1 : 0, path: '/v1/videos', kind: 'create' });
      return res.json({ task_id: taskId, id: taskId, status: 'processing' });
    }

    return res.status(400).json({ error: `Unsupported model: ${model || '(empty)'}` });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// Status polling used by Sora/Veo pages
app.get('/v1/videos/:taskId', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Authorization Bearer APIKey' });

  const taskId = String(req.params.taskId || '');

  try {
    // Veo tasks usually look like veo_task_xxx
    if (taskId.toLowerCase().startsWith('veo')) {
      const json = await kieVeoRecordInfo(apiKey, taskId);
      const data = json?.data ?? {};
      const sf = data?.successFlag;
      if (sf === 1) {
        const url = (data?.response?.resultUrls || [])[0] || null;
        return res.json({ status: 'completed', video_url: url, progress: 1 });
      }
      if (sf === 2 || sf === 3) {
        return res.json({ status: 'failed', message: data?.errorMessage || json?.msg || 'generation failed' });
      }
      return res.json({ status: 'processing', progress: 0 });
    }

    // Market tasks
    const json = await kieRecordInfo(apiKey, taskId);
    const status = normalizeKieStatusToSimple(json);
    const url = extractFirstResultUrl(json);
    const data = json?.data ?? {};
    const progress = typeof data?.progress === 'number' ? data.progress : undefined;

    if (status === 'completed') {
      return res.json({ status: 'completed', video_url: url, progress: 1 });
    }
    if (status === 'failed') {
      return res.json({ status: 'failed', message: data?.errorMessage || data?.message || json?.msg || 'generation failed' });
    }
    return res.json({ status: 'processing', progress: progress ?? 0 });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// Optional: content endpoint fallback (some pages may use it)
app.get('/v1/videos/:taskId/content', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).send('Missing Authorization');
  const taskId = String(req.params.taskId || '');

  try {
    // Reuse status endpoint logic
    const fakeReq = { ...req, params: { taskId } };
    // Call record directly to fetch url
    let url = null;
    if (taskId.toLowerCase().startsWith('veo')) {
      const json = await kieVeoRecordInfo(apiKey, taskId);
      url = (json?.data?.response?.resultUrls || [])[0] || null;
    } else {
      const json = await kieRecordInfo(apiKey, taskId);
      url = extractFirstResultUrl(json);
    }
    if (!url) return res.status(404).send('No content');
    // Redirect the browser to the real file URL
    return res.redirect(url);
  } catch (err) {
    return res.status(500).send(String(err?.message || err));
  }
});

// 2) Kling endpoints used by the existing frontend pages
app.post('/kling/v1/videos/text2video', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ message: 'Missing Authorization Bearer APIKey' });

  try {
    const body = req.body || {};
    const prompt = String(body.prompt || '').trim();
    const aspect_ratio = mapAspectRatio(body.aspect_ratio);
    const duration = String(body.duration || '5');

    // Map to Kling 2.6 by default (works for most cases)
    const model = 'kling-2.6/text-to-video';
    const input = { prompt, aspect_ratio, duration, sound: false };

    const taskId = await kieCreateTask(apiKey, model, input);
    pushUsageLog(apiKey, { created_at: nowUnix(), model_name: model, prompt, image_count: 0, path: '/kling/v1/videos/text2video', kind: 'create' });
    return res.json({ data: { task_id: taskId } });
  } catch (err) {
    return res.status(500).json({ message: String(err?.message || err) });
  }
});

app.get('/kling/v1/videos/text2video/:taskId', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ message: 'Missing Authorization Bearer APIKey' });
  const taskId = String(req.params.taskId || '');

  try {
    const json = await kieRecordInfo(apiKey, taskId);
    const status = normalizeKieStatusToSimple(json);
    const url = extractFirstResultUrl(json);
    const data = json?.data ?? {};

    if (status === 'completed') {
      return res.json({ data: { task_status: 'succeed', task_result: { videos: [{ url }] } } });
    }
    if (status === 'failed') {
      return res.json({ data: { task_status: 'failed', task_status_msg: data?.errorMessage || data?.message || json?.msg || 'failed' } });
    }
    return res.json({ data: { task_status: 'processing' } });
  } catch (err) {
    return res.status(500).json({ message: String(err?.message || err) });
  }
});

app.post('/kling/v1/videos/image2video', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ message: 'Missing Authorization Bearer APIKey' });

  try {
    const body = req.body || {};
    const prompt = String(body.prompt || '').trim();
    const duration = String(body.duration || '5');
    const aspect_ratio = '16:9';

    // body.image is base64 (no prefix)
    const b64 = String(body.image || '').trim();
    if (!b64) return res.status(400).json({ message: 'Missing image (base64)' });
    const buffer = Buffer.from(b64, 'base64');
    const mime = detectImageMime(buffer);
    const fileUrl = await kieUploadBuffer(apiKey, buffer, `kling-input.${extFromMime(mime)}`, mime);

    const model = 'kling-2.6/image-to-video';
    const input = { prompt, aspect_ratio, duration, sound: false, image_urls: [fileUrl] };

    const taskId = await kieCreateTask(apiKey, model, input);
    pushUsageLog(apiKey, { created_at: nowUnix(), model_name: model, prompt, image_count: 1, path: '/kling/v1/videos/image2video', kind: 'create' });
    return res.json({ data: { task_id: taskId } });
  } catch (err) {
    return res.status(500).json({ message: String(err?.message || err) });
  }
});

app.get('/kling/v1/videos/image2video/:taskId', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ message: 'Missing Authorization Bearer APIKey' });
  const taskId = String(req.params.taskId || '');

  try {
    const json = await kieRecordInfo(apiKey, taskId);
    const status = normalizeKieStatusToSimple(json);
    const url = extractFirstResultUrl(json);
    const data = json?.data ?? {};

    if (status === 'completed') {
      return res.json({ data: { task_status: 'succeed', task_result: { videos: [{ url }] } } });
    }
    if (status === 'failed') {
      return res.json({ data: { task_status: 'failed', task_status_msg: data?.errorMessage || data?.message || json?.msg || 'failed' } });
    }
    return res.json({ data: { task_status: 'processing' } });
  } catch (err) {
    return res.status(500).json({ message: String(err?.message || err) });
  }
});

// 3) Sora "characters" endpoint used by soracjjs.html
// Note: KIE's official character workflow is different. Here we keep this feature working locally.
const soraCharactersFile = path.join(DATA_DIR, 'sora-characters.json');
function loadSoraCharacters() {
  return readJson(soraCharactersFile, {}); // keyHash -> array
}
function saveSoraCharacters(obj) {
  writeJson(soraCharactersFile, obj);
}

app.post('/sora/v1/characters', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Authorization Bearer APIKey' });

  const { url, timestamps } = req.body || {};
  const note = String(req.body?.note || '').trim();

  const keyHash = sha256Short(apiKey);
  const all = loadSoraCharacters();
  const list = all[keyHash] || [];

  const id = `char_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const username = (note || 'character').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 20) || `character_${id.slice(-6)}`;

  const record = {
    id,
    username,
    profile_picture_url: '',
    source: { url, timestamps },
    createdAt: new Date().toISOString()
  };
  list.unshift(record);
  all[keyHash] = list;
  saveSoraCharacters(all);

  pushUsageLog(apiKey, { created_at: nowUnix(), model_name: 'sora:characters(local)', prompt: note || '(no note)', image_count: 0, path: '/sora/v1/characters', kind: 'create' });
  return res.json({ id: record.id, username: record.username, profile_picture_url: record.profile_picture_url });
});

// 4) Gemini-style /v1beta endpoint compatibility (used by multiple "gemini/*" pages)
// We support:
//  - Text-only prompt polishing: returns a Gemini-like JSON (candidates -> text)
//  - Image generation / image editing: uses KIE image endpoints (best-effort) and returns inline_data (base64)

function getApiKeyFromReq(req) {
  const bearer = getBearerToken(req);
  if (bearer) return bearer;
  // Some pages still pass ?key=... in the URL
  const q = String(req.query.key || '').trim();
  return q;
}

function extractGeminiTextAndInlineImages(body) {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const texts = [];
  const images = [];

  for (const c of contents) {
    const parts = Array.isArray(c?.parts) ? c.parts : [];
    for (const p of parts) {
      if (typeof p?.text === 'string' && p.text.trim()) texts.push(p.text.trim());
      const inline = p?.inline_data || (p?.inlineData ? { mime_type: p.inlineData.mimeType, data: p.inlineData.data } : null);
      if (inline?.data) {
        const mime = inline.mime_type || 'image/png';
        const data = inline.data;
        images.push({ mime, data });
      }
    }
  }
  return { prompt: texts.join('\n\n').trim(), images };
}

async function fetchBinaryAsBase64(url) {
  const { signal, cancel } = withTimeout(null, FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`Fetch file failed (${resp.status})`);
    const arrayBuffer = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const mime = resp.headers.get('content-type') || detectImageMime(buf);
    return { mime, b64: buf.toString('base64') };
  } finally {
    cancel();
  }
}

function simplePromptPolish(text) {
  if (!text) return '';
  // Keep it deterministic & China-friendly (no extra outbound calls)
  return [
    '请将以下提示词优化为更适合生成高质量视频/图片的描述（保持原意，补充细节）：',
    '',
    text,
    '',
    '优化要点：主体清晰、场景/光线/镜头语言、风格、分辨率/画幅、避免违规内容。',
  ].join('\n');
}

app.post(/^\/v1beta\/models\/(.+):generateContent$/, async (req, res) => {
  const apiKey = getApiKeyFromReq(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing APIKey (Authorization Bearer or ?key=...)' });

  const modelId = req.params?.[0] || '';
  const body = req.body || {};
  const { prompt, images } = extractGeminiTextAndInlineImages(body);

  const responseModalities = Array.isArray(body?.generationConfig?.responseModalities)
    ? body.generationConfig.responseModalities
    : [];
  const wantsImage = responseModalities.includes('IMAGE') || String(modelId).toLowerCase().includes('image');

  try {
    // Text-only: local polish (no outbound)
    if (!wantsImage && images.length === 0) {
      const polished = simplePromptPolish(prompt);
      pushUsageLog(apiKey, { created_at: nowUnix(), model_name: `local-prompt-polish:${modelId || 'text'}`, prompt, image_count: 0, path: `/v1beta/models/${modelId}:generateContent`, kind: 'text' });
      return res.json({
        candidates: [{
          content: { parts: [{ text: polished || prompt || '' }] }
        }]
      });
    }

    // Image generation/editing via KIE (best-effort)
    const n = Math.min(4, Math.max(1, Number(body?.generationConfig?.candidateCount || 1)));
    const filesUrl = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const buf = Buffer.from(String(img.data), 'base64');
      const mime = img.mime || detectImageMime(buf);
      const url = await kieUploadBuffer(apiKey, buf, `gemini-inline-${i}.${extFromMime(mime)}`, mime);
      filesUrl.push(url);
    }

    const { taskId, recordBase } = await kieImageGenerate(apiKey, {
      prompt: prompt || 'Generate an image',
      n,
      size: body?.generationConfig?.imageSize || '1024x1024',
      filesUrl
    });

    pushUsageLog(apiKey, { created_at: nowUnix(), model_name: `kie-image:${modelId || 'image'}`, prompt, image_count: filesUrl.length, path: `/v1beta/models/${modelId}:generateContent`, kind: 'image-create' });

    const urls = await waitForKieImageResult(apiKey, recordBase, taskId);
    const parts = [{ text: '✅ 生成完成' }];
    for (const u of urls.slice(0, n)) {
      const { mime, b64 } = await fetchBinaryAsBase64(u);
      parts.push({ inline_data: { mime_type: mime, data: b64 } });
    }

    return res.json({ candidates: [{ content: { parts } }] });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// 5) OpenAI-compatible chat proxy (best-effort)
// Existing chat pages stream SSE from /v1/chat/completions.
// We forward the request to KIE and pipe the stream back as-is.
app.post('/v1/chat/completions', async (req, res) => {
  const apiKey = getBearerToken(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Authorization Bearer APIKey' });

  const upstreamCandidates = [
    `${KIE_API_BASE}/v1/chat/completions`,
    `${KIE_API_BASE}/api/v1/chat/completions`,
  ];

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const bodyStr = JSON.stringify(req.body || {});

  for (const url of upstreamCandidates) {
    try {
      const { signal, cancel } = withTimeout(controller.signal, FETCH_TIMEOUT_MS);
      const upstreamResp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json'
        },
        body: bodyStr,
        signal
      });

      if (upstreamResp.status === 404) {
        cancel();
        continue;
      }

      // Forward status + headers
      res.status(upstreamResp.status);
      upstreamResp.headers.forEach((v, k) => {
        const key = k.toLowerCase();
        if (key === 'content-encoding') return; // avoid compression issues
        res.setHeader(k, v);
      });

      pushUsageLog(apiKey, { created_at: nowUnix(), model_name: String(req.body?.model || 'chat'), prompt: '(chat)', image_count: 0, path: '/v1/chat/completions', kind: 'chat' });

      if (!upstreamResp.body) {
        const text = await upstreamResp.text();
        cancel();
        return res.send(text);
      }

      const { Readable } = require('stream');
      Readable.fromWeb(upstreamResp.body).pipe(res);
      return;
    } catch (err) {
      // try next upstream candidate
      continue;
    }
  }

  return res.status(502).json({
    error: 'Chat endpoint is not available on this KIE base. If KIE provides OpenAI-compatible chat, set KIE_API_BASE to that host/path.'
  });
});

// ------------------------------
// Static assets
// ------------------------------

app.use(express.static(path.join(ROOT_DIR, 'public'), {
  // Disable aggressive caching to make China deployments easier to debug.
  etag: true,
  maxAge: process.env.STATIC_MAX_AGE || '1h'
}));

// Uploaded files (base64 images saved by /api/generations)
// On Vercel, UPLOADS_DIR defaults to /tmp, so we must serve it explicitly.
app.use('/uploads', express.static(UPLOADS_DIR, {
  etag: true,
  maxAge: process.env.UPLOADS_MAX_AGE || '1h'
}));

// ------------------------------
// Global Error Handler
// ------------------------------

// Handle 404 for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found', path: req.path });
});

// SPA-ish fallback: serve index for non-API routes
app.get('*', (req, res) => {
  // Don't serve index.html for obvious file requests that weren't found
  if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/)) {
    return res.status(404).send('File not found');
  }
  res.sendFile(path.join(ROOT_DIR, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[kenwei-aigc] Error:', err.message || err);
  
  // Handle multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 20MB.' });
  }
  
  // Handle JSON parse errors
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  
  // Generic error response
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ------------------------------
// Start / Export (Vercel compatible)
// ------------------------------

// When running on a VM (Tencent/Huawei/your laptop), start the HTTP server.
// When running on Vercel, the platform provides the HTTP server and calls the exported handler.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[kenwei-aigc] server listening on http://127.0.0.1:${PORT}`);
    console.log(`[kenwei-aigc] KIE_API_BASE=${KIE_API_BASE}`);
    if (IS_VERCEL) console.log('[kenwei-aigc] VERCEL=1 (serverless mode)');
  });
}

module.exports = app;