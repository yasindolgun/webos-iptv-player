# Roadmap

This roadmap lists planned product and engineering work. It builds on the
existing vanilla TypeScript, native webOS playback, local-first storage, and
bundled LAN service architecture. Items are ordered by expected user impact and
implementation risk; they are not release promises or fixed calendar dates.

## Current foundation

The app already provides the foundations that a large-catalog TV client needs:

- M3U and multi-account Xtream sources, XMLTV, catch-up, and live DVR
- virtualized channel, group, EPG, search, catalog, and episode collections
- IndexedDB-backed user data and bounded, budgeted caches
- worker-based M3U decoding/parsing, XMLTV loading, and search indexing
- native webOS playback with desktop HLS, MPEG-TS, and DASH adapters
- LAN-only QR setup, M3U upload, and credential-free backup/restore
- playback resume, episode completion, Continue Watching, Recently Watched,
  and Watchlist
- a Home section with playback shortcuts, refresh status, and account-aware data
- automatic next-episode and Watchlist playback queues with an Up Next countdown
- bounded native, HLS, DASH, and catch-up recovery paths for transient failures
- per-stream subtitle sync, remembered track picks, and global language defaults
- non-blocking Xtream expiry and connection status with checked timestamps
- remote, Magic Remote, accessibility, localization, and webOS 4 fallbacks
- a production-path benchmark at 50,000 items under CPU throttling

## Engineering audit update — 2026-08-28

The project-wide type, compatibility, unit, integration, and browser gates were
reviewed together with the startup, worker, cache, and large-list lifecycles.
This pass completed the first M3U worker boundary and tightened several
independent reliability gaps:

- playlist bytes are transferred to the classic app worker for decoding and
  parsing, while Settings reports download, parse, merge, and cache phases
- an M3U worker request has a bounded timeout, so a silent worker cannot leave
  startup or refresh waiting forever; failures before ownership transfer use
  the production parser on the page as a compatibility fallback
- the player sidebar reuses already decoded channel logos across reopen cycles
  while preserving the one-logo-per-frame reveal budget
- Settings Cancel now uses the component's single delegated activation path,
  removing a render-time listener race in the legacy engine path
- bundled-service startup E2E coverage now waits for the actual reconciliation
  boundary and mocks every prerequisite endpoint instead of depending on host
  network-failure timing
- desktop and TV benchmark reloads follow the current Home → Live startup flow
  instead of waiting forever for the retired direct-to-Live launch behavior
- benchmark Xtream fixtures use the credential-scoped production cache key, so
  catalog measurements cannot silently fall through to empty network fixtures
- throttled worker-idle checks now allow scheduler jitter, and the isolated
  benchmark preview server shuts down cleanly after Windows runs

The remaining high-impact gaps found by the audit feed Priority 1 and 2 below:

- parsed channels still return to the page as one complete object graph before
  merge, indexing, and persistence, so the worker boundary does not yet bound
  peak memory for 100,000-200,000-item sources
- derived indexes are still prepared on the page, and the 200,000-item target
  has no staged 50,000/100,000/200,000 profile or device memory budget yet
- real webOS 4 validation remains required; the Chromium 53 project is a
  compatibility simulation, not an engine or memory emulator

The production M3U benchmark now separates input delivery, worker parse,
result clone/delivery, total round trip, and maximum page frame gap. It also
checks idle cleanup and the bounded timeout termination path. The first Chrome
151 baseline confirms that cloning the complete parsed object graph back to the
page costs substantially more than parsing it, making bounded result batches or
worker-owned persistence the next ingestion target.

## Large-source ingestion update — 2026-08-30

The first bounded-result milestone is complete. The M3U worker now returns
compact playlist metadata first and retains parsed channels behind a private
session. The page pulls at most 500 channels per request; each delivered slot is
cleared in the worker before the next batch, so no RPC response clones the full
parsed channel graph. The client rejects empty intermediate batches and partial
delivery instead of accepting a truncated source.

The production benchmark records and asserts the batch size and count alongside
the existing transfer, parse, delivery, frame-gap, idle-cleanup, and timeout
metrics. At 50,000 generated channels, the first 500-record full-suite run kept
the measured page frame gap at the prior baseline (33.3 ms vs. 33.4 ms).
Retaining the worker for the complete pull session then reduced an isolated
round trip from about 1.31 seconds to 0.91 seconds by removing per-batch idle
timer churn. Experiments at 1,000 and 5,000 records raised the measured frame
gap to roughly 67 and 100 ms without recovering the total time, so the smaller
responsive batch remains the measured default.

This milestone bounds cross-thread result cloning, not total catalog residency.
The worker still constructs the complete parsed graph before delivery and the
page eventually hydrates every channel. Worker-owned IndexedDB persistence and
single-writer backpressure are covered by the later update below; staged device
memory budgets remain Priority 1 work.

## Derived-index update — 2026-08-30

Derived playlist indexes now run in the existing classic app worker during
startup and refresh. The page sends only 500-record compact document batches,
with an explicit rendering yield after every six batches. The worker builds
group, content-kind, playlist, and playlist-group membership plus stable and
legacy channel-key lookups. Membership arrays and open-addressed key tables are
returned as transferable `Uint32Array` buffers, so the final summary does not
clone large JavaScript maps or channel graphs back to the page.

The page resolves indexed channel lists lazily and caches only the scopes that
are actually opened. Synchronous customization edits and unavailable or failed
workers retain the production main-thread builder as a compatibility fallback.
The 50,000-item benchmark now records worker start, bounded-batch, finish, total,
and maximum frame-gap timing. In an isolated 4x CPU-throttled run, preparation
completed in 619.6 ms against the 635 ms baseline, while the maximum frame gap
was 16.7 ms and the final transferable-summary phase took 7.4 ms.

This moves initial derived-index preparation off the page, but does not yet move
the raw channel records into worker-owned storage. The later persistence update
moves the cache writer and adds explicit backpressure without changing that raw
channel residency boundary.

## Playlist persistence update — 2026-08-30

Playlist cache persistence now runs in the existing classic app worker after
source merge and catch-up enrichment. The page sends at most 500 final channel
records per request and waits for the worker to commit each IndexedDB batch
before sending the next one, so slow storage cannot grow an unbounded worker
queue. Only one scheduled playlist write drains at a time, with at most one
newer snapshot retained for coalescing.

The cache now stages versioned batch records behind a compact version 3
`combined` manifest. The worker publishes that manifest only after every batch
has been written and re-read successfully, so startup observes either the old
complete snapshot or the new one. Failed sessions remove their staging records;
orphan cleanup also runs at the next session. Existing inline version 2 caches
remain readable, and unavailable or failed workers retain the page writer as a
compatibility fallback.

This bounds page-to-worker persistence cloning and makes IndexedDB backpressure
explicit. Parsing still constructs the complete source graph in the worker,
and the page still hydrates the combined channel graph for merge and playback.
Chunked decoding, parse-to-persistence source staging, and the staged
50,000/100,000/200,000 memory profiles remain the next ingestion work.

## Priority 1: Large-source ingestion

M3U bytes are transferred to the existing classic app worker for decoding and
parsing, with download, parse, merge, and cache progress reported separately.
The request is bounded and retains a main-thread compatibility fallback when
the worker fails before taking ownership of the input buffer.
Move the remaining expensive playlist work off the UI thread while preserving
the tolerant production parser and current cache format.

- Keep the production-path M3U pipeline benchmark regression-gating worker
  round-trip duration and maximum page frame gap while retaining input transfer,
  parse, result clone/delivery, idle cleanup, and failure-timeout diagnostics.
- Evaluate chunked decoding where the webOS 4 API surface permits it; retain a
  bounded buffered fallback for legacy engines and providers that cannot stream.
- Avoid cloning multiple full playlist copies or a complete parsed object tree
  between the page and worker. Prefer bounded record batches or worker-owned
  persistence, and return only progress and compact index summaries to the page.
- Keep one IndexedDB writer active during ingestion so cache reads and competing
  transactions cannot create an unbounded write queue.
- Keep cancellation, stale-cache fallback, multi-source deduplication, and
  source-level error reporting intact.

Acceptance criteria:

- Cold-loading the benchmark playlist does not introduce a UI-thread task over
  the agreed regression threshold.
- Parsing produces byte-for-byte equivalent channel metadata for the existing
  M3U parser fixtures.
- Transferring the input buffer and persisting parsed output does not create a
  second full-feed memory peak on the page.
- Batch size is bounded and benchmarked; a slow IndexedDB write cannot cause
  parsed records to accumulate without limit in worker memory.
- Worker failure falls back safely or produces an actionable error; it never
  leaves the loading view stuck.
- `npm run benchmark:check`, the Chromium 53 simulation, and a real webOS 4
  device remain release gates.

## Priority 2: 200,000-item scale qualification

Treat 200,000 items as a measured source-size target, not a promise that every
full record remains resident in JavaScript memory.

- Add opt-in 50,000, 100,000, and 200,000-item benchmark profiles for channels,
  catalog entries, categories, programs, and episodes so nonlinear growth is
  visible before the largest run.
- Record retained heap after forced GC, peak page heap, maximum frame gap,
  startup readiness, search latency, and IndexedDB footprint.
- Define separate budgets for low-memory webOS 4 hardware and desktop preview.
- Keep detailed records partitioned in IndexedDB, a compact navigation/search
  index in memory, and only the visible range plus bounded overscan as hydrated
  UI models. Use block prefetch rather than a cursor read for every D-pad step.
- Audit full-array copies, sorting, structured-clone payloads, logo lifetime,
  and cache serialization before changing the persistent schema.
- Promote the 200,000-item profile to a required gate only after it is stable on
  representative TV hardware and CI runtime is acceptable.

Acceptance criteria:

- Every large collection keeps a bounded DOM window and remains navigable by
  D-pad and pointer.
- No feature requires a fully hydrated 200,000-record object graph in page or
  worker memory; temporary `map`, `filter`, sort, and serialization copies are
  included in peak-heap review.
- Repeated open/close cycles show no sustained retained-heap growth.
- Search and navigation remain responsive while background cache work runs.
- The documented supported scale matches measured device results.

## Priority 3: Parental controls

Allow users to lock selected groups and channels without relying on unreliable
provider naming conventions.

- Add explicit Lock actions beside the existing channel and group customization
  controls; do not infer adult content from names.
- Store a salted PIN verifier, never the four-digit PIN itself.
- Hide titles, descriptions, logos, posters, and EPG metadata until unlocked.
- Apply the same lock policy to Home, Search, EPG, Recently Watched, reminders,
  channel-number entry, sidebar zapping, and direct playback routes.
- Support a session unlock and a deliberate reset flow for a forgotten PIN.
- Keep lock state in durable user data and exclude the verifier from normal
  diagnostics and logs.

Acceptance criteria:

- No navigation or playback route can bypass a locked item.
- Failed PIN entry does not reveal protected metadata or change focus context.
- M3U refreshes, Xtream refreshes, renames, and regroups retain locks through
  stable channel and group identities where possible.
- Remote, Magic Remote, and pointer entry all use the same prompt and policy.

## Priority 4: Guide preview feasibility

Prototype a small live preview in the EPG detail area, then keep it only if the
native video plane behaves reliably across supported TVs.

- Ship preview disabled by default as an explicit opt-in setting.
- Reuse the existing `PlayerPipeline`; do not create a second playback stack.
- Debounce tuning for 1–1.5 seconds after focus settles, cancel stale loads with
  a playback generation token, and serialize decoder cleanup before the next
  tune begins.
- Reuse one video element where device testing shows it is safer than repeated
  element creation, while preserving deterministic pipeline teardown.
- Suspend preview when the app is hidden or another player session starts.
- Preserve three-pane guide navigation and provide a setting to disable preview.
- Disable preview for the rest of the app session after a small bounded number
  of decoder or pipeline failures, leaving manual full-screen playback intact.
- Measure tune latency, decoder cleanup, memory, and repeated zap stability on
  real webOS 4, 6, and current-generation devices.

Acceptance criteria:

- Only one media pipeline owns playback at a time.
- Leaving the guide releases decoder and network resources deterministically.
- Rapid D-pad navigation cannot start an unbounded queue of stream loads.
- The preview never starts before focus has remained stable for the configured
  debounce interval.
- Version or reported-memory guesses never enable preview automatically; only
  the user setting and successful capability behavior control it.
- Devices that fail the feasibility gate retain the current information panel.

## Later candidates

- Audio-delay feasibility testing on real TVs. A user-controlled delay must not
  ship if it disables native decoding, HDR/Dolby passthrough, or stable A/V sync;
  the existing pipeline Resync action is not a substitute for a fixed offset.
- A dedicated on-screen keyboard only if real-device testing shows the native
  webOS keyboard is inadequate for remote-only source entry.
- More granular category visibility tools for very large Xtream catalogs,
  building on existing channel and group customization.

## Explicit non-goals

- Replacing vanilla TypeScript and `morph()` with React or Solid.
- Replacing the storage services with Dexie solely for API convenience.
- Replacing native webOS playback with Video.js on the TV.
- Adding a hosted Firebase, Supabase, or GitHub Pages pairing relay while the
  LAN setup flow meets the local-first product requirement.
- Replacing the existing bounded reconnect and stall-recovery paths with
  unbounded retries that can leave the user waiting on a dead stream.
- Treating resume entries as permanent watch history; completion data has a
  separate lifecycle and storage purpose.
- Claiming a catalog scale that has not passed the benchmark and real-device
  memory gates.
