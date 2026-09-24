# Lodge Lab

A local learning instrument for watching a model go through its real lifecycle
on this machine:

```
STORED → LOADED → INFERENCING → TOKENS → UNLOADED
```

It is not an application yet. It is one page that shows, with every number
traced to a real local source, what Ollama and the GPU are actually doing —
since Mission 003, lets you run the same prompt against two installed
models back-to-back and compare what was measured, and since Mission 004,
lets you repeat one fixed run N times to see how stable each number is.

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
    `think:false` forced. `options` are passed through; `sample:false` turns the
    in-stream GPU sampler off (Mission 004 series O). Ollama's NDJSON lines are forwarded byte-for-byte.
    One extra line `{"lodge": {...}}` is appended at the end containing:
    - the server-side timings described below;
    - `gpu`: every `nvidia-smi` sample the server took while the stream was
      open (one every 500 ms: utilization, power, memory.used, temperature,
      pstate, SM/memory clocks, `clocks_event_reasons.active` — the current
      name for throttle reasons — and the `used_memory` of
      `ollama`/`llama-server` compute processes),
      plus max/mean over those samples and a `failed` count. Nothing is
      interpolated — a failed sample is simply missing;
    - `after`: an `/api/ps` entry for the model and a `nvidia-smi` read taken
      immediately after the stream closed, each `null` if that source failed;
    - `state_requests_during_stream`: how many `/api/state` requests the server
      answered while the stream was open. Anything above 0 means another
      observer (a browser tab, curl) was running `nvidia-smi` during the run.
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
| GPU | utilization % | `nvidia-smi --query-gpu=utilization.gpu` — % of the last sample period a kernel was executing. **Lags by seconds on this card; see Mission 004** |
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
- **GPU utilization from `nvidia-smi` is coarse — and, as Mission 004 found,
  stale.** It is the fraction of the last sample period in which any kernel
  ran, sampled at 500 ms, but on this card it lags the real load by seconds:
  runs at ~317 W read 0 % for their whole duration. Prompt eval
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

The M003 figures (qwen3:8b 151 tok/s, qwen3:14b 89 tok/s) are **single runs
with the models' default random sampling**, so the two outputs had different
text. Mission 004 measured qwen3:8b's decode rate properly (below); the 14b
figure has not been re-measured.

## Mission 004: repeatability

Question: with model, prompt, options, context and output length held fixed,
how much do Lodge's numbers still move from run to run, and why?

The **Repeat** panel runs one model and one prompt N times with fixed options
`{temperature:0, seed:42, num_predict:400, num_ctx:4096}` (plus `think:false`),
a fixed 5 s pause after each stream, and the browser's 1 s poll paused. Every
run is a row; min / median / max / spread (= (max − min) ÷ median) sit under
the rows. **Download JSON** saves the whole series: settings, every run, every
GPU sample and the full response text. Three series:

| series | before each run | purpose |
|---|---|---|
| **W** | reset to zero runner, load once (empty prompt, recorded as `setup`), then N back-to-back runs | natural spread; prompt-cache effect |
| **C** | unload, then wait until `/api/ps` is empty **and** no runner process is left in `nvidia-smi` | load-time spread; whether VRAM is exact |
| **O** | same as W, with the server's in-stream GPU sampler off | whether Lodge's measuring changes the result |

**Runner-cold** means no Ollama runner on the GPU and nothing in `/api/ps`. It
is **not** disk-cold: the model file stays in the OS page cache (32 GB RAM).

Results (qwen3:8b Q4_K_M, RTX 5080, 2026-09-24, W N=10, C N=5, O N=10) are in
`experiments/m004/`. Headlines:

- **Decode rate is stable to about 1 %.** W 151.9–153.5 tok/s (median 153.1,
  spread 1.05 %), O 151.6–153.3 (1.08 %), C 151.2–152.3 (0.74 %).
- **Runner-cold load is stable too:** 1684–1710 ms (1.5 %), from page cache.
- **VRAM is exact.** Every run: Ollama `size_vram` 5319.8 MiB, runner 5666 MiB
  per NVIDIA (a 346 MiB gap).
- **"Warm" has two layers.** From run 2 of a warm series on, 98 of 99 prompt
  tokens come from the prefix cache: prompt eval drops from ~80 ms to 7.5 ms and
  time to first content from ~87 ms to 10–15 ms.
- **Greedy output is deterministic per cache state, not overall.** Every
  uncached run produced identical text (sha256 `e4277f5a…`), and every cached
  run produced identical text (`153ec0b6…`). The two differ from about character
  140 on.
- **Observer effect:** none measurable on tok/s. The sampler adds about 3 ms to
  time to first content on cached runs (W 13–15 ms vs O 10–12 ms).
- **GPU state:** P1 throughout, SM 2902–2917 MHz while decoding, ~310–319 W of a
  360 W limit, no clock-event (throttle) reasons in any sample, 53 → 60 °C
  with no effect on tok/s.
- **Unexplained:** on cached runs 2 and 3 of both W and O (never later, never
  in C), Ollama's `total_duration` contains about 20 ms that is not load,
  prompt eval or eval, and time to first content rises by the same amount.

`experiments/m004/pilot/` holds the harness pilot (W N=2, O N=1) that was run
before the real series. An earlier pilot, which exposed a missing newline
before the lodge line after a load-only request, was overwritten and not kept.

## Mission 005: quantization, Q4_K_M vs Q8_0

Question: on this card, what does Q8_0 cost and buy over Q4_K_M for the same
model, measured with the M004 harness and judged against M004's noise floor?

Artifacts (exact metadata in `experiments/m005/models.json`):

| | `qwen3:8b` (= `qwen3:8b-q4_K_M`) | `qwen3:8b-q8_0` |
|---|---|---|
| weights blob | `sha256:a3de86cd1c13…` | `sha256:d87f4a5a2f1a…` |
| GGUF file_type | 15 (Q4_K_M) | 7 (Q8_0) |
| size on disk | 5,225,388,164 B | 8,851,089,538 B |
| parameters | 8,190,735,360 | 8,190,735,360 |
| template / params / license layers | identical | identical |

Only the weights differ, so the chat template and default sampling are the same.

The **Q** series in the Repeat panel runs model A and model B in n pairs, in
A B B A order so neither model always goes first. **Every run starts
runner-cold and prompt-uncached**: unload, then wait until `/api/ps` is empty
and no runner is left in `nvidia-smi`. Everything else matches M004: the prompt,
`{temperature:0, seed:42, num_predict:400, num_ctx:4096}`, the 5 s gap, the
500 ms sampler and the paused browser poll. Before the runs, each model is
loaded once with an empty prompt to prime the page cache. These priming loads
are recorded in `setup.priming` and are not runs. Under the per-run rows, an
**A | B** table gives median [min – max] for each model, with B − A and B ÷ A
of the medians. `utilization.gpu` is left out of that table (see M004).

Results (2026-09-24, 10 pairs = 20 runs, `experiments/m005/lodge-m005-Q.json`):

| | Q4_K_M | Q8_0 | Q8 vs Q4 |
|---|---|---|---|
| VRAM, Ollama `size_vram` | 5319.8 MiB | 8480.8 MiB | +3161 MiB (×1.59) |
| of which weights / KV / compute (runner log) | 4643 / 576 / 100 | 7804 / 576 / 100 | all in the weights |
| runner VRAM (NVIDIA) | 5666 MiB | 8828 MiB | +3162 MiB |
| device free at peak (16303 MiB card) | 10145 MiB | 6983 MiB | |
| runner-cold load | 1635 ms [1612–1656] | 1885 ms [1867–1902] | +250 ms (×1.15) |
| time to first content (server) | 1709 ms [1689–1730] | 1950 ms [1928–1966] | +241 ms (×1.14) |
| prompt eval, 99 tokens | 69.7 ms [64.3–70.9] | 57.3 ms [54.9–61.7] | −12 ms (×0.82) |
| decode rate | 151.8 tok/s [150.9–152.3] | 98.9 tok/s [98.7–99.0] | ×0.652 |
| total duration | 4342 ms [4318–4359] | 5991 ms [5973–6006] | ×1.38 |
| power, decode phase (median of per-run sample means) | 263 W [257–274] | 232 W [229–237] | −12 % |
| energy per generated token (derived, coarse) | 1.73 J | 2.34 J | ×1.35 |
| output | 1 hash in 10 runs (`e4277f5a…`) | 1 hash in 10 runs (`97ac5ec3…`) | differ from character 111 |

- Every difference in the table is well outside M004's noise floor. The
  decode-rate ranges do not overlap at all.
- Decode is memory-bandwidth bound: 1.59× the weight bytes gives 1.53× the
  decode time. Q8_0 draws *less* power while decoding.
- Q4_K_M's uncached output is byte-identical to M004's uncached output.
- The two "power mean, decode phase" and "energy per generated token" rows
  were added to the page after the run. They are computed from the raw
  `samples` in the JSON, so the file's saved `comparison` block does not
  include them.
- The harness pilot (1 pair, `experiments/m005/pilot/`) saw two one-off slow
  events that did not recur in the real series: Q8_0's first-ever prompt eval
  took 2954 ms, and the Q4_K_M load right after Q8_0's first load took 3.4 s.

## Offline-first

Everything talks to `127.0.0.1`. The server binds to `127.0.0.1` only. No
external requests, no CDN assets, no telemetry. If Ollama or `nvidia-smi` is
missing, the page says which one failed and keeps showing the rest.
