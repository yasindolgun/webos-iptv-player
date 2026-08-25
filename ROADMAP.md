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
- worker-based XMLTV loading and search indexing
- native webOS playback with desktop HLS, MPEG-TS, and DASH adapters
- LAN-only QR setup and M3U upload without a hosted relay
- playback resume, Continue Watching, Recently Watched, and Watchlist
- a Home section with playback shortcuts, refresh status, and account-aware data
- automatic next-episode and Watchlist playback queues with an Up Next countdown
- bounded native, HLS, DASH, and catch-up recovery paths for transient failures
- per-stream subtitle synchronization and remembered audio/subtitle selections
- remote, Magic Remote, accessibility, localization, and webOS 4 fallbacks
- a production-path benchmark at 50,000 items under CPU throttling

## Priority 1: Large-source ingestion

Move the remaining expensive playlist work off the UI thread while preserving
the tolerant production parser and current cache format.

- Run M3U decoding, parsing, and derived-index preparation in the existing
  classic app worker.
- Add progressive status for download, parse, merge, and cache phases without
  making progress reporting part of the parser's data model.
- Evaluate chunked decoding where the webOS 4 API surface permits it; retain a
  bounded buffered fallback for legacy engines and providers that cannot stream.
- Fetch playlist bytes as an `ArrayBuffer` and transfer ownership to the worker
  where supported; do not assume `ReadableStream` or `TextDecoderStream` exists
  on the Chromium 53 baseline.
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

## Priority 4: Default audio and subtitle language

Add global playback preferences while retaining more specific remembered picks.

- Add a preferred audio language setting.
- Extend subtitle preference to `Off`, `Forced`, or a preferred language; keep
  the online-subtitle search language separately configurable if needed.
- Normalize common two-letter, three-letter, manifest, and display-name forms
  before matching tracks.
- Resolve tracks in this order: remembered item/channel choice, global language
  preference, forced/default rendition, then provider or native default.
- Preserve an explicit per-item subtitle-off choice across reopens.
- Apply the same policy to native webOS, HLS, DASH, and VOD track discovery
  wherever the platform exposes selectable tracks.

Acceptance criteria:

- A remembered channel or VOD choice always overrides the global preference.
- Missing preferred tracks fall back without delaying playback or showing an
  error.
- Collapsed same-language native audio renditions remain selectable using the
  existing manifest metadata fallback.
- Settings migration preserves all existing per-item track choices.

## Priority 5: LAN backup and restore

Use the bundled LAN service to migrate user-owned data between TVs without a
cloud account.

- Export a versioned JSON archive through the authenticated, short-lived LAN
  setup session.
- Let the user choose favorites, channel/group customization, EPG mappings and
  offsets, Watchlist, appearance/playback preferences, Recently Watched, and
  resume history.
- Exclude Xtream passwords, credential-bearing stream URLs, subtitle-provider
  keys/tokens, transient LAN state, and caches by default.
- Validate schema, size, record shapes, and stable identifiers before import.
- Preview the included data groups and offer Merge or Replace explicitly.
- Make restore transactional where IndexedDB permits it and leave current data
  intact when validation or writing fails.

Acceptance criteria:

- An archive never contains secrets in the default export path.
- Unknown future fields are ignored safely; unsupported schema versions produce
  an actionable error before any mutation.
- Importing the same archive twice is idempotent under Merge.
- Export and import work from a phone browser on the same LAN and never require
  an external service.

## Priority 6: Episode completion history

Make finished episodes visible independently of resumable playback progress.

- Add a compact, account-scoped completion record rather than retaining a fake
  resume entry at the end of an episode.
- Show Watched and In Progress states in virtualized episode lists.
- Highlight the next unwatched episode when opening a series.
- Let users toggle an episode watched/unwatched and clear series history.
- Keep the existing Up Next countdown and automatic episode queue unchanged.

Acceptance criteria:

- Completing an episode clears resume progress and records completion in one
  logical operation.
- Replay from the beginning does not erase Watched until the user explicitly
  changes it or completes the episode again.
- Account switching never mixes episode history.
- Large seasons retain bounded DOM and storage behavior.

## Priority 7: Account status visibility

Make verified Xtream account state easier to see without exposing credentials or
turning startup into a blocking authentication check.

- Show expiry and connection usage in the account switcher or Home summary.
- Persist only the minimum verified status snapshot with a clear checked time.
- Distinguish expired, disabled, unreachable, and unlimited accounts.
- Refresh status on explicit account verification and normal catalog refresh,
  with stale data clearly labeled.

Acceptance criteria:

- Status is non-blocking and disappears cleanly for M3U-only users.
- Unix expiry values, unlimited accounts, and provider type inconsistencies are
  covered by unit tests.
- Passwords and full credential-bearing URLs never enter logs or rendered HTML.

## Priority 8: Guide preview feasibility

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
