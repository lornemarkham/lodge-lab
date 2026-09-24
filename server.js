// Lodge Lab — local learning instrument.
//
//   nvidia-smi ─┐
//               ├─→ this Node server (127.0.0.1:3000) → browser
//   Ollama ─────┘
//
// Node 24 built-ins only. No frameworks, no bundlers, no databases.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const OLLAMA = 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT_MS = 3000;
const NVSMI_TIMEOUT_MS = 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

// ---------------------------------------------------------------------------
// Ollama sources (all read-only GETs)
// ---------------------------------------------------------------------------

async function ollamaGet(route) {
  const res = await fetch(`${OLLAMA}${route}`, {
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// nvidia-smi sources (read-only query flags only)
// ---------------------------------------------------------------------------

const GPU_FIELDS = [
  'index',
  'name',
  'driver_version',
  'utilization.gpu',
  'utilization.memory',
  'memory.used',
  'memory.free',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'pstate',
  'clocks.sm',
  'clocks.mem',
  'clocks_event_reasons.active', // current name for clocks_throttle_reasons.active
];

// Bits of clocks_event_reasons.active (nvidia-smi --help-query-gpu).
const CLOCK_EVENT_BITS = [
  [0x1, 'gpu_idle'],
  [0x2, 'applications_clocks_setting'],
  [0x4, 'sw_power_cap'],
  [0x8, 'hw_slowdown'],
  [0x10, 'sync_boost'],
  [0x20, 'sw_thermal_slowdown'],
  [0x40, 'hw_thermal_slowdown'],
  [0x80, 'hw_power_brake_slowdown'],
  [0x100, 'display_clock_setting'],
];

function clockEventNames(hex) {
  const n = Number(hex); // "0x0000000000000004" → 4; "[N/A]" → NaN
  if (!Number.isFinite(n)) return null;
  return CLOCK_EVENT_BITS.filter(([bit]) => n & bit).map(([, name]) => name);
}

const PROC_FIELDS = ['gpu_uuid', 'pid', 'process_name', 'used_memory'];

function nvidiaSmi(args) {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', args, { timeout: NVSMI_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`nvidia-smi ${args[0]}: ${err.message} ${stderr || ''}`.trim()));
      resolve(stdout);
    });
  });
}

function parseCsv(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(',').map((c) => c.trim()));
}

function num(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : null; // "[N/A]" etc. become null, never 0
}

async function gpuQuery() {
  const out = await nvidiaSmi([
    `--query-gpu=${GPU_FIELDS.join(',')}`,
    '--format=csv,noheader,nounits',
  ]);
  return parseCsv(out).map((r) => ({
    index: num(r[0]),
    name: r[1],
    driver_version: r[2],
    utilization_gpu_pct: num(r[3]),
    utilization_memory_pct: num(r[4]),
    memory_used_mib: num(r[5]),
    memory_free_mib: num(r[6]),
    memory_total_mib: num(r[7]),
    temperature_c: num(r[8]),
    power_draw_w: num(r[9]),
    power_limit_w: num(r[10]),
    pstate: r[11] ?? null,
    clocks_sm_mhz: num(r[12]),
    clocks_mem_mhz: num(r[13]),
    clock_event_reasons_hex: r[14] ?? null,
    clock_event_reasons: clockEventNames(r[14]),
  }));
}

async function gpuProcesses() {
  const out = await nvidiaSmi([
    `--query-compute-apps=${PROC_FIELDS.join(',')}`,
    '--format=csv,noheader,nounits',
  ]);
  return parseCsv(out).map((r) => ({
    gpu_uuid: r[0],
    pid: num(r[1]),
    process_name: r[2],
    used_memory_mib: num(r[3]),
  }));
}

// ---------------------------------------------------------------------------
// GET /api/state — everything the page polls, with explicit per-source errors
// ---------------------------------------------------------------------------

async function getState() {
  const errors = [];
  const take = async (source, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push({ source, message: e.message });
      return null;
    }
  };

  const [version, tags, ps, gpus, procs] = await Promise.all([
    take('ollama /api/version', () => ollamaGet('/api/version')),
    take('ollama /api/tags', () => ollamaGet('/api/tags')),
    take('ollama /api/ps', () => ollamaGet('/api/ps')),
    take('nvidia-smi --query-gpu', gpuQuery),
    take('nvidia-smi --query-compute-apps', gpuProcesses),
  ]);

  return {
    timestamp: new Date().toISOString(),
    ollama: {
      available: version !== null,
      version: version?.version ?? null,
      stored: tags?.models ?? null, // null = source failed, [] = truly none
      loaded: ps?.models ?? null,
    },
    gpu: {
      devices: gpus, // null = nvidia-smi failed
      processes: procs,
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// GPU sampler — while a generate stream is open, poll nvidia-smi every
// GPU_SAMPLE_MS and keep every sample. Nothing is interpolated: if nvidia-smi
// fails mid-run the sample is dropped and `failed` is incremented.
// ---------------------------------------------------------------------------

const GPU_SAMPLE_MS = 500;
const RUNNER_RE = /ollama|llama/i;

function startGpuSampler(t0) {
  const samples = [];
  let failed = 0;
  let running = true;
  let wake = null;
  const loop = (async () => {
    while (running) {
      const tick = performance.now();
      try {
        const [gpus, procs] = await Promise.all([gpuQuery(), gpuProcesses()]);
        const d = gpus[0];
        if (d) {
          samples.push({
            t_ms: round(tick - t0),
            utilization_gpu_pct: d.utilization_gpu_pct,
            power_draw_w: d.power_draw_w,
            memory_used_mib: d.memory_used_mib,
            temperature_c: d.temperature_c,
            pstate: d.pstate,
            clocks_sm_mhz: d.clocks_sm_mhz,
            clocks_mem_mhz: d.clocks_mem_mhz,
            clock_event_reasons_hex: d.clock_event_reasons_hex,
            runner_used_memory_mib: procs
              .filter((p) => RUNNER_RE.test(p.process_name))
              .reduce((a, p) => a + (p.used_memory_mib ?? 0), 0) || null,
          });
        }
      } catch {
        failed++;
      }
      const wait = GPU_SAMPLE_MS - (performance.now() - tick);
      if (wait > 0 && running) await new Promise((r) => { wake = r; setTimeout(r, wait); });
    }
  })();
  return {
    async stop() {
      running = false;
      wake?.(); // don't hold the stream open for the rest of an idle wait
      await loop;
      const col = (k) => samples.map((x) => x[k]).filter((v) => v != null);
      const max = (a) => (a.length ? Math.max(...a) : null);
      const min = (a) => (a.length ? Math.min(...a) : null);
      const mean = (a) => (a.length ? round(a.reduce((x, y) => x + y, 0) / a.length) : null);
      return {
        source: 'nvidia-smi --query-gpu / --query-compute-apps, sampled by Lodge server during the stream',
        interval_ms: GPU_SAMPLE_MS,
        count: samples.length,
        failed,
        utilization_gpu_pct_max: max(col('utilization_gpu_pct')),
        utilization_gpu_pct_mean: mean(col('utilization_gpu_pct')),
        power_draw_w_max: max(col('power_draw_w')),
        power_draw_w_mean: mean(col('power_draw_w')),
        memory_used_mib_max: max(col('memory_used_mib')),
        runner_used_memory_mib_max: max(col('runner_used_memory_mib')),
        temperature_c_max: max(col('temperature_c')),
        clocks_sm_mhz_min: min(col('clocks_sm_mhz')),
        clocks_sm_mhz_max: max(col('clocks_sm_mhz')),
        clocks_mem_mhz_min: min(col('clocks_mem_mhz')),
        clocks_mem_mhz_max: max(col('clocks_mem_mhz')),
        pstates: [...new Set(col('pstate'))],
        clock_event_reasons: [...new Set(col('clock_event_reasons_hex').flatMap((h) => clockEventNames(h) ?? []))],
        samples,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/generate — proxy Ollama's NDJSON stream unchanged, then append one
// clearly-labelled line of Lodge server-side timing, GPU samples taken during
// the stream, and an Ollama/NVIDIA snapshot taken right after it.
// ---------------------------------------------------------------------------

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleGenerate(req, res) {
  const body = await readJsonBody(req);
  if (!body.model || typeof body.prompt !== 'string') {
    return sendJson(res, 400, { error: 'model and prompt are required' });
  }

  const upstreamBody = {
    model: body.model,
    prompt: body.prompt,
    stream: true, // forced
    think: false, // first slice: no thinking tokens
  };
  if (body.options && typeof body.options === 'object') upstreamBody.options = body.options;
  const sample = body.sample !== false; // Mission 004 series O turns the in-stream sampler off

  const ac = new AbortController();
  req.on('close', () => ac.abort()); // browser navigated away / stop pressed

  const lodge = {
    // All times are Node process.hrtime-based ms on THIS server, not Ollama's.
    request_sent_at: new Date().toISOString(),
    upstream_headers_ms: null, // Ollama responded (headers) after this long
    first_chunk_ms: null, // first NDJSON line of any kind
    first_content_ms: null, // first line with non-empty "response" text
    stream_end_ms: null,
    sampler_enabled: sample,
    // /api/state requests served while this stream was open — anything > 0 is
    // another observer (a browser tab, curl) running nvidia-smi during the run.
    state_requests_during_stream: null,
  };

  const t0 = performance.now();
  const stateHits0 = stateHits;
  const sampler = sample ? startGpuSampler(t0) : { stop: async () => ({ disabled: true }) };
  let upstream;
  try {
    upstream = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(upstreamBody),
      signal: ac.signal,
    });
  } catch (e) {
    await sampler.stop();
    return sendJson(res, 502, { error: `Ollama unreachable: ${e.message}` });
  }
  lodge.upstream_headers_ms = round(performance.now() - t0);

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    await sampler.stop();
    return sendJson(res, upstream.status, { error: `Ollama HTTP ${upstream.status}: ${text}` });
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });

  const decoder = new TextDecoder();
  let buffer = '';
  // Ollama's reply to an empty-prompt (load-only) request has no trailing
  // newline; the lodge line must still start on its own line.
  let endsWithNewline = true;
  try {
    for await (const chunk of upstream.body) {
      const now = performance.now();
      if (lodge.first_chunk_ms === null) lodge.first_chunk_ms = round(now - t0);

      // Forward bytes exactly as received.
      res.write(chunk);
      if (chunk.length) endsWithNewline = chunk[chunk.length - 1] === 0x0a;

      // Inspect (do not modify) complete lines for the first content token.
      if (lodge.first_content_ms === null) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (typeof j.response === 'string' && j.response.length > 0) {
              lodge.first_content_ms = round(now - t0);
              break;
            }
          } catch {
            /* partial line; ignore */
          }
        }
      }
    }
    lodge.stream_end_ms = round(performance.now() - t0);
    lodge.state_requests_during_stream = stateHits - stateHits0;
    lodge.gpu = await sampler.stop();
    lodge.after = await snapshotAfter(body.model);
    res.write((endsWithNewline ? '' : '\n') + JSON.stringify({ lodge }) + '\n');
  } catch (e) {
    lodge.gpu = await sampler.stop();
    if (!ac.signal.aborted) {
      res.write(JSON.stringify({ lodge, error: `stream interrupted: ${e.message}` }) + '\n');
    }
  }
  res.end();
}

// Immediately after the stream ends, read what Ollama and NVIDIA say the
// resident model looks like. Each source is independent; null = that source
// failed (see `errors`).
async function snapshotAfter(model) {
  const errors = [];
  const take = async (source, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push({ source, message: e.message });
      return null;
    }
  };
  const [ps, gpus, procs] = await Promise.all([
    take('ollama /api/ps', () => ollamaGet('/api/ps')),
    take('nvidia-smi --query-gpu', gpuQuery),
    take('nvidia-smi --query-compute-apps', gpuProcesses),
  ]);
  const m = ps?.models?.find((x) => x.name === model || x.model === model) ?? null;
  return {
    taken_at: new Date().toISOString(),
    ps_model: ps === null ? null : m, // null with no error = model not in /api/ps
    gpu: gpus?.[0] ?? null,
    runner_processes: procs === null ? null : procs.filter((p) => RUNNER_RE.test(p.process_name)),
    errors,
  };
}

// ---------------------------------------------------------------------------
// POST /api/unload — keep_alive:0 with an empty prompt asks Ollama to evict.
// ---------------------------------------------------------------------------

async function handleUnload(req, res) {
  const body = await readJsonBody(req);
  if (!body.model) return sendJson(res, 400, { error: 'model is required' });

  const t0 = performance.now();
  let upstream;
  try {
    upstream = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: body.model, keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return sendJson(res, 502, { error: `Ollama unreachable: ${e.message}` });
  }
  const text = await upstream.text();
  let ollama;
  try {
    ollama = JSON.parse(text);
  } catch {
    ollama = { raw: text };
  }
  sendJson(res, upstream.ok ? 200 : upstream.status, {
    ollama,
    lodge: { unload_request_ms: round(performance.now() - t0) },
  });
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function round(x) {
  return Math.round(x * 10) / 10;
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

let stateHits = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile(INDEX_HTML);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      stateHits++;
      return sendJson(res, 200, await getState());
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      return await handleGenerate(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/unload') {
      return await handleUnload(req, res);
    }
    sendJson(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Lodge Lab → http://${HOST}:${PORT}  (Ollama at ${OLLAMA})`);
});
