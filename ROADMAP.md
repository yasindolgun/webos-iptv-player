# Roadmap

This roadmap lists planned product and engineering work. It builds on the
existing vanilla TypeScript, native webOS playback, local-first storage, and
bundled LAN service architecture. Items are ordered by expected user impact and
implementation risk. Planned priorities are not release promises or fixed
calendar dates.

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

## Completed engineering milestones

### Engineering audit — 2026-08-28

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

The audit identified complete result-graph delivery, page-built derived indexes,
and missing staged device profiles as the highest-impact gaps. The first two
were addressed by the 2026-08-30 milestones below. Search catalog page
residency was addressed by the later milestone on the same date. Playlist raw-
record residency, chunked decoding, 50,000/100,000/200,000 memory budgets, and
real webOS 4 validation remain open; the Chromium 53 project is a compatibility
simulation, not an engine or memory emulator.

The production M3U benchmark now separates input delivery, worker parse,
result clone/delivery, total round trip, and maximum page frame gap. It also
checks idle cleanup and the bounded timeout termination path. The first Chrome
151 baseline confirms that cloning the complete parsed object graph back to the
page costs substantially more than parsing it, making bounded result batches or
worker-owned persistence the next ingestion target.

### Bounded result delivery — 2026-08-30

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

### Derived-index preparation — 2026-08-30

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

### Playlist persistence — 2026-08-30

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
The staged 50,000/100,000/200,000 memory profiles remain the next ingestion
work.

### Chunked playlist decoding — 2026-08-31

M3U parsing no longer creates one decoded string as large as the complete feed.
The production parser now preserves its line and directive state while the
worker decodes at most 64 KiB of input bytes at a time. UTF-8 multibyte
sequences, UTF-8 BOMs, both UTF-16 byte orders, CR/LF boundaries, metadata, and
the tolerant issue model remain intact across chunk boundaries.

The worker reports decode chunk size, count, encoding, and the largest decoded
text allocation. The 50,000-item production-path benchmark asserts that these
allocations remain bounded in addition to its existing transfer, parse,
result-delivery, frame-gap, idle-cleanup, and timeout checks. The main-thread
compatibility fallback uses the same chunked byte parser.

This removes the transient full-feed decoded-string peak in both worker and
fallback paths. The transferred input buffer and parsed channel graph still
coexist inside the worker, and the page still hydrates the combined graph;
the source-staging milestone below removes that worker graph overlap. Measured
device memory budgets remain open.

### Parse-to-persistence source staging — 2026-08-31

The M3U worker no longer retains the complete parsed source graph before result
delivery. Parsing pauses at each 500-channel boundary, waits for one temporary
IndexedDB batch to commit, and only then resumes decoding. Result pulls read and
delete at most six staged batches per transaction, deliver each RPC response at
the existing 500-record bound, and yield to rendering between those groups. Slow
storage cannot grow an unbounded write queue, delivery prefetch stays bounded at
3,000 records, and completed pulls leave no temporary source records behind.

The staging store is separate from the published playlist cache, so an
interrupted parse cannot replace or evict the previous complete snapshot.
Each parse-session start clears orphaned staging records. IndexedDB-unavailable
engines retain the bounded result-delivery protocol with the prior worker-memory
path as a compatibility fallback.

The production pipeline benchmark now asserts the staging mode, 500-record
write batch size and count, six-batch read prefetch, maximum parser-buffered
channel count, and IndexedDB write time. This removes full parsed-source
residency in the normal worker path; the page still hydrates source results for
cross-source merge and the final combined graph for playback. Staged device
heap budgets remain Priority 1 work.

### Direct Home resume — 2026-08-30

The existing Home Continue Watching action now starts its newest saved item
directly at the stored position instead of only opening the Movies or Series
browser. Xtream movies and episodes rebuild their playback URL from the active
account and saved container extension; M3U movies and episodes resolve the
current channel through their stable saved identity. Back returns to Home, and
an item whose configured source identity can no longer be resolved falls back
to its catalog section.

### Bounded Search catalog residency — 2026-08-30

Search no longer loads or retains the complete Xtream movie and series object
graphs on the page. The shared app worker migrates the existing credential-
scoped full-catalog cache into 500-record IndexedDB blocks and retains only a
compact stable-ID/title index. Ranked queries return compact documents; Search
hydrates the current virtual rail window on demand and caps its detailed record
cache at 100 items. A selection that has not been prefetched is hydrated before
opening its detail view.

The block manifest is published only after every block write succeeds, fresh
manifests reopen without loading the legacy full-catalog record, stale manifests
remain a failure fallback, and movie/series failures stay independent. Account
switches supersede the previous worker session, while deactivation cancels a
still-running catalog load. Unit coverage includes 50,000-result bounded
hydration, block-spanning reads, fresh-manifest reuse, partial provider failure,
account switching, cancellation, and repeated Search opens.

Provider JSON decoding still creates one transient full catalog array inside
the worker during a cold refresh, and the legacy full-catalog cache remains the
Movies/Series browse source. Removing that transient peak belongs to large-
source ingestion; staged heap budgets and real-device qualification remain open.

### Staged scale profiles — 2026-08-31

The production-path benchmark now exposes named, opt-in 50,000, 100,000, and
200,000-item profiles for both desktop Chromium and the TV runner. Every profile
uses the same channels, catalog entries, categories, programs, episodes, Search,
navigation, cold-load, and reopen-cycle workload, so scale changes do not
silently reduce coverage. Named runs write separate reports and cannot replace
the required 50,000-item regression baseline.

Reports identify the selected profile and include both the serialized cache
payload total and the browser's origin-usage estimate for the seeded IndexedDB
fixture. Existing startup readiness, maximum frame-gap, search latency, forced-
GC retained heap, final page heap, and TV renderer RSS measurements remain in
the same report. The larger profiles are still opt-in until their runtime and
real-device memory budgets have been established.

A Windows follow-up made the staged launcher independent of direct `.cmd`
process spawning and kept the raw XMLTV fixture inside the production parser's
date-retention window at every named scale. The 100,000-item desktop profile now
completes the full workload with bounded DOM windows and no retained-heap growth
across its reopen cycles. The 200,000-item workload kept the page alive and
loaded all 200,000 channels, but did not finalize its report inside a measured
30-minute test budget. It now reports timestamped stage transitions and has a
45-minute opt-in ceiling; a complete 200,000-item report and device budgets
remain open.

### Player information and Live-list clarity — 2026-09-01

The normal player OSD now keeps primary playback context concise, while an
explicit Playback details view exposes resolution, codecs, declared bitrate,
frame rate, buffer range, and active pipeline with their provenance. Audio,
subtitle, sync, navigation, and transport controls retain the existing remote
grammar, and the diagnostics view does not create a second media pipeline or a
sustained high-frequency probe.

Visible Live rows now show locally derived EPG progress on a bounded one-minute
refresh while the view is active. Catch-up-capable channels use the shared
inline replay SVG, separately from channel-health state, without changing the
fixed virtual-row geometry or auto-tuning focused rows.

### Playback and parse-session hardening — 2026-09-01

Live playback now retries the current stream through a bounded recovery path
before surfacing failure, rather than cascading into unrelated channels. VOD
can retry without an incorrect MIME hint, and app suspension preserves resume
state while releasing playback resources.

Concurrent M3U parses now isolate their source-staging records and enforce the
configured channel limit across emitted batches. A failed or superseded parse
cannot consume another session's staged output or exceed the limit through
batch boundaries.

## Planned priorities

### Priority 0: webOS 4 cold-start validation

Treat real webOS 4 startup as an immediate compatibility gate, independently
of later 200,000-item scale qualification. The Chromium 53 simulation checks
the declared browser surface and legacy fallbacks, but it does not reproduce
the target TV's V8 heap, IndexedDB implementation, worker scheduling, or native
media pipeline.

- Cold-install and cold-start the exact release build on representative webOS 4
  hardware with empty state, a medium provider-shaped playlist, and the staged
  large-source profiles that fit the device budget.
- Capture phase timings, renderer RSS, page heap, worker failures, persistence
  diagnostics, and the last loading-state transition through the existing TV
  benchmark and diagnostic tooling.
- Repeat startup from a populated cache and after an upgrade so clean installs
  and legacy migration paths are both covered.
- Keep the documented minimum-version claim aligned with measured results; a
  simulation-only pass is not sufficient evidence for release qualification.

Acceptance criteria:

- Empty, medium-source, cached, and upgraded starts all leave the loading view
  or surface an actionable error within the bounded startup timeout.
- Repeated cold starts do not show sustained renderer-memory growth or corrupt
  the previous complete playlist snapshot after an interrupted refresh.
- The recorded device, firmware, app version, bundle hash, source scale, and
  budgets are sufficient to reproduce the result.

### Priority 1: 200,000-item scale qualification

Treat 200,000 items as a measured source-size target, not a promise that every
full record remains resident in JavaScript memory.

- Keep the named opt-in 50,000, 100,000, and 200,000-item desktop and TV
  profiles regression-gated for channels, catalog entries, categories,
  programs, and episodes so nonlinear growth is visible before the largest run.
- Record retained heap after forced GC, peak page heap, maximum frame gap,
  startup readiness, search latency, and IndexedDB footprint.
- Define separate budgets for low-memory webOS 4 hardware and desktop preview.
- Keep detailed records partitioned in IndexedDB, a compact navigation/search
  index in memory, and only the visible range plus bounded overscan as hydrated
  UI models. Use block prefetch rather than a cursor read for every D-pad step.
- Keep the completed worker-owned Search title index and bounded visible-record
  hydration regression-gated as catalog scale increases.
- Include Search index construction, query result hydration, account switching,
  cancellation, and repeated open/close cycles in the catalog heap profiles.
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
- Opening Search never fetches or retains a complete VOD and series object
  graph on the page, including duplicate name arrays used only for indexing.
- Search and navigation remain responsive while background cache work runs.
- The documented supported scale matches measured device results.

### Priority 2: Cohesive 10-foot product experience

Evolve the existing Home, catalog, player, and live-TV surfaces into one calm,
content-first TV experience. This is a presentation and interaction pass over
capabilities the app already owns, not a replacement navigation model or a new
playback stack.

Product principles:

- Keep live TV fast: Live remains the first Home focus, channel changes stay
  explicit, and the compact sidebar remains the primary zapping surface.
- Keep media facts honest: show only data observed from playback, declared by a
  manifest, parsed from a container, supplied by a provider, or derived locally;
  never present those sources as equally authoritative.
- Keep discovery local-first: build Home and catalog rails from Continue
  Watching, Recently Watched, Watchlist, reminders, favorites, and EPG data
  already available on the device. Do not require a recommendation backend.
- Preserve the current remote grammar, spatial navigation, pointer activation,
  and view transitions while improving visual hierarchy.

Metadata provenance:

- Treat actual media-element dimensions as observed playback data.
- Label manifest bandwidth, frame rate, codecs, resolution, and dynamic range as
  declared stream data rather than measured network throughput.
- Treat MP4/MKV header results as parsed container data and omit fields the
  header does not establish; missing HDR data must not be labelled as BT.709.
- Treat catalog ratings, genres, runtimes, and capability labels as provider
  claims unless corroborated locally. Provider claims must never upgrade a
  stream badge shown by the player.
- Keep EPG progress, live-edge distance, resume state, and completion state as
  locally derived data with explicit time boundaries.

Milestone 1 — Home content hub:

- Replace the shortcut-dominant grid with a content-first layout while keeping
  Live as the first and fastest action.
- Keep the direct context-aware Resume action, then add bounded rails for
  Recently Watched, Watchlist, and upcoming reminders when their data exists.
- Keep Live, Movies, Series, and Guide entry points prominent; gracefully omit
  Xtream-only sections for an M3U-only setup.
- Retain account status, refresh state, and last-refresh time without competing
  with the primary content action.
- Add per-rail focus memory and stable keyed items. Hydrate only bounded visible
  ranges and do not make Home fetch or retain a complete catalog.

Milestone 2 — VOD detail hierarchy:

- Turn the current joined metadata line into restrained, structured labels for
  values that are actually present, without inventing capabilities from titles
  or poster artwork.
- Use one context-aware primary Play or Resume action and a quieter Watchlist
  action. Avoid parallel primary buttons for mutually exclusive start modes.
- Extend the existing hero scrim language to detail backdrops where the provider
  supplies a safe image URL, with a deterministic poster or theme fallback.
- Keep cast and crew text usable when structured portraits or identifiers are
  absent; external enrichment must remain optional rather than gate the detail
  page.

Design constraints:

- Keep focused-card scaling around 1.03–1.04 and combine it with an outline or
  subtle shadow that does not shift neighboring layout.
- Size primary TV text for viewing distance and respect the existing user font
  scale. Reserve very small text for nonessential diagnostics only.
- Use shared inline SVG for functional icons and uncommon symbols; normal
  localized Unicode text remains supported.
- Use the selected theme accent instead of extracting dominant poster colors at
  runtime, avoiding CORS, CPU, and inconsistent-palette costs.
- Every translucent or blurred surface keeps an opaque legacy fallback in the
  appropriate generated or hand-written legacy stylesheet.
- Continue rendering through `html` and `morph()` with stable keys, delegated
  listeners, bounded collections, and no untrusted raw markup.

Acceptance criteria:

- Home remains useful and fully navigable with M3U-only, Xtream-only, mixed,
  empty, partially cached, and temporarily unavailable data.
- Opening Home does not trigger a full-catalog fetch, unbounded DOM rail, or
  visible focus jump while asynchronous sections arrive.
- Player remote and Magic Remote behavior stays compatible with the documented
  mapping across live, DVR, catch-up, and VOD playback.
- No badge or diagnostics field implies stronger evidence than its data source
  provides; unknown values are omitted instead of guessed.
- Focus memory, readable geometry, modern fallback inertness, and webOS 4
  fallback layout are covered in both Playwright projects.
- The final OSD, Home, detail, and live-list layouts pass real-TV checks for
  readability, animation cost, native-video contrast, and repeated navigation.

### Priority 3: Parental controls

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

### Priority 4: Guide preview feasibility

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

## Explicit platform constraints

- Native webOS HLS exposes at most one audio track per distinct `LANGUAGE` on
  affected firmware. Same-language renditions collapse before the HTML5 track
  list is created and cannot be selected safely without replacing the native
  playback path.
- M3U `http-user-agent` and `http-referrer` values cannot be applied as
  arbitrary per-stream headers by the native `<video>` pipeline. Desktop MSE
  behavior must not be presented as native-TV header support.
- DRM license negotiation is not implemented. A DASH manifest with a
  DRM-specific `ContentProtection` scheme is rejected through the normal
  bounded playback fallback rather than being advertised as playable.

## Later candidates

- Audio-delay feasibility testing on real TVs. A user-controlled delay must not
  ship if it disables native decoding, HDR/Dolby passthrough, or stable A/V sync;
  the existing pipeline Resync action is not a substitute for a fixed offset.
- A dedicated on-screen keyboard only if real-device testing shows the native
  webOS keyboard is inadequate for remote-only source entry.
- More granular category visibility tools for very large Xtream catalogs,
  building on existing channel and group customization.
- Provider-backed trick-play thumbnails and intro markers only where the source
  supplies a trustworthy frame index or timestamp metadata; do not extract
  frames or analyze complete media streams on the TV.
- Multi-view feasibility only after real-device decoder, native-video-plane,
  teardown, thermal, and bandwidth tests. Do not promise simultaneous playback
  as a baseline webOS 4+ capability.

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
- Adding app-level audio normalization that intercepts native decoding or
  compromises HDR/Dolby passthrough and stable A/V sync.
- Claiming a catalog scale that has not passed the benchmark and real-device
  memory gates.
