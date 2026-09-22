# Lodge Lab

A local learning instrument for watching a model go through its real lifecycle
on this machine:

```
STORED → LOADED → INFERENCING → TOKENS → UNLOADED
```

It is not an application yet. It is one page that shows, with every number
traced to a real local source, what Ollama and the GPU are actually doing —
and, since Mission 003, lets you run the same prompt against two installed
models back-to-back and compare what was measured.

## Run

Requires Node 24, Ollama running on `127.0.0.1:11434`, and `nvidia-smi`.

```
npm start
# → http://127.0.0.1:3000
```

Nothing is installed at runtime. There are no runtime dependencies. The
`supabase` devDependency is unrelated to this slice and is not used by it.

## Architecture

```
nvidia-smi ─┐
             ├─→ server.js (Node built-ins, 127.0.0.1:3000) → public/index.html
Ollama ──────┘
```

- `server.js` — `node:http` server. Four routes, no framework.
  - `GET /` serves `public/index.html`.
  - `GET /api/state` queries Ollama (`/api/version`, `/api/tags`, `/api/ps`)
    and `nvidia-smi` (`--query-gpu`, `--query-compute-apps`) in parallel and
    returns them side by side. A failed source becomes `null` plus an entry in
    `errors`; the others still return.
  - `POST /api/generate` proxies Ollama `/api/generate` with `stream:true` and
    `think:false` forced. Ollama's NDJSON lines are forwarded byte-for-byte.
    One extra line `{"lodge": {...}}` is appended at the end containing:
    - the server-side timings described below;
    - `gpu`: every `nvidia-smi` sample the server took while the stream was
      open (one every 500 ms: utilization, power, memory.used, temperature,
      and the `used_memory` of `ollama`/`llama-server` compute processes),
      plus max/mean over those samples and a `failed` count. Nothing is
      interpolated — a failed sample is simply missing;
    - `after`: an `/api/ps` entry for the model and a `nvidia-smi` read taken
      immediately after the stream closed, each `null` if that source failed.
  - `POST /api/unload` sends `{model, keep_alive: 0}` to Ollama `/api/generate`.
- `public/index.html` — plain HTML/CSS/JS. Polls `/api/state` every 1 s.
  Streams generations with `fetch` + `ReadableStream`. The **Experiment**
  panel runs the same prompt against model A then model B using the same
  `/api/generate` route, optionally calling `/api/unload` for every resident
  model first and waiting for `/api/ps` to report empty (a cold load).

## Where each number comes from

Every value on the page has a source label next to it. Summary:

| Panel | Value | Source |
|---|---|---|
| Stored | name, disk size, quantization, params | Ollama `/api/tags` → `models[].size`, `details.*` |
| Stored | **native context** | `/api/tags` → `details.context_length` — what the GGUF *can* do (40960 for qwen3:8b) |
| Loaded | loaded / not loaded | Ollama `/api/ps` → `models[]` empty or not |
| Loaded | **VRAM (Ollama)** | `/api/ps` → `size_vram` — Ollama's own accounting |
| Loaded | total footprint | `/api/ps` → `size` |
| Loaded | **effective context** | `/api/ps` → `context_length` — what *this load* was given (4096 by default here) |
| Loaded | keep-alive expiry | `/api/ps` → `expires_at` |
| GPU | utilization % | `nvidia-smi --query-gpu=utilization.gpu` — % of the last sample period a kernel was executing |
| GPU | **VRAM used (NVIDIA)** | `--query-gpu=memory.used` — the whole device, all processes, including the desktop |
| GPU | free / total, temp, power | `memory.free`, `memory.total`, `temperature.gpu`, `power.draw`, `power.limit` |
| GPU | compute processes | `nvidia-smi --query-compute-apps=pid,process_name,used_memory` — `llama-server` is Ollama's runner |
| Inference | load duration, prompt/eval counts and durations, total, done_reason | Ollama's final `done:true` line, unmodified |
| Inference | tokens/sec | derived: `eval_count ÷ eval_duration` |
| Inference | context usage | derived: `prompt_eval_count + eval_count` vs `/api/ps context_length`. This request only; not a KV-cache readout |
| Inference | time to first content (server) | Lodge `server.js`: upstream request start → first NDJSON line with non-empty `response` |
| Inference | time to first content (browser) | Lodge page: `fetch()` start → first `response` text rendered |
| Lifecycle | INFERENCING / TOKENS | **client-observed**: this browser has an open generate stream. Not a GPU measurement |
| Lifecycle | LOADED / STORED / UNLOADED | measured from `/api/ps` (UNLOADED = a non-empty → empty transition seen this session) |

### Two VRAM numbers, on purpose

Ollama's `size_vram` and NVIDIA's `memory.used` are different measurements of
different things and are shown separately:

- Ollama reports what *it* allocated for the model weights + KV cache.
- NVIDIA reports the device total (every process, plus the desktop) and, per
  process, what `llama-server` holds — which includes the CUDA context and
  scratch buffers Ollama does not count.

Measured on 2026-09-20 with qwen3:8b: Ollama `size_vram` = 5.20 GiB (5320 MiB);
`llama-server` per NVIDIA = 5666 MiB; device delta over idle = 5674 MiB.
The ~350 MiB gap is real overhead, not a bug.

### Two context numbers, on purpose

- `native context` (40960) is the model file's capability.
- `effective context` (4096) is what Ollama actually configured for this load.
  It is the number that matters for "how much fits".

### Time to first content: a caveat

Ollama does not send HTTP headers until the model is loaded and the first
token is ready. So "time to first content" as measured here covers load +
prompt eval + first token, and headers-arrival ≈ first-content. There is no
earlier signal on the wire to measure.

## Experiment: same prompt, two models

The Experiment panel is deliberately small: pick A and B from the installed
models, keep or edit the prompt, choose cold or warm, press Run. A runs to
completion, then B. Both responses are shown in full; a table underneath puts
the measurements side by side with a `B ÷ A` ratio for numeric rows.

Every row is tagged with exactly one *kind*:

| kind | meaning |
|---|---|
| `Ollama` | reported by Ollama: `/api/tags`, `/api/ps`, or the final `done:true` line of the stream |
| `NVIDIA` | reported by `nvidia-smi`, sampled by `server.js` every 500 ms while the stream was open (max / mean over the samples, sample count shown) |
| `Lodge` | wall-clock measured by this server or this browser |
| `derived` | arithmetic on the rows above (tok/s, prompt eval rate, context usage, the ratio column) |

There is no quality score. The two responses are there to be read.

Things to know when reading a comparison:

- **Cold means "not in Ollama's memory"**, not "not in the OS page cache". The
  first-ever load of a model reads from NVMe; a repeat cold load reads from
  RAM. Both are real `load_duration` values — they just measure different
  things. Run the experiment twice if you want the second kind.
- **GPU utilization from `nvidia-smi` is coarse.** It is the fraction of the
  last sample period in which any kernel ran, sampled at 500 ms. Prompt eval
  and generation both keep it near 100 % on this card; the *mean* includes the
  load phase, when it is near 0 %. Power draw is the more graded signal.
- **Runner VRAM (NVIDIA) vs VRAM allocated (Ollama)** differ for the reason
  described above: CUDA context and scratch buffers are counted by NVIDIA and
  not by Ollama.
- **"Warm" only means "no unload was requested".** If A and B do not both
  fit in VRAM (qwen3:8b + qwen3:14b do not, on 16 GB), Ollama evicts one to
  load the other, and `load_duration` for the "warm" run includes that
  eviction. Measured 2026-09-22: warm-with-the-other-resident loads were
  2.4–2.8 s versus 1.7–2.0 s for a true cold load.
- **Peak runner VRAM during the stream** sums every `ollama`/`llama-server`
  process nvidia-smi reports, so the first samples of a run can still include
  the previous model's runner while Ollama is tearing it down. The
  **runner VRAM after run** row is read once the stream has closed and is the
  cleaner per-model number.
- Two models of the same family and quantization share a tokenizer, so
  `prompt tokens` should be identical across A and B. If it is not, the
  models differ in more than size.

## Offline-first

Everything talks to `127.0.0.1`. The server binds to `127.0.0.1` only. No
external requests, no CDN assets, no telemetry. If Ollama or `nvidia-smi` is
missing, the page says which one failed and keeps showing the rest.
