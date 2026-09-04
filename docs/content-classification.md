# Playlist content classification

P0-B uses `channelContentKind` for M3U parsing, startup normalization,
playlist indexes, and catalog cache recovery. Xtream membership filtering is
a pure predicate. Startup normalization copies a record only when its resolved
kind changes; it never writes through the cache input object.

## Decision order

| Evidence | Result |
| --- | --- |
| Restricted source group / `other` kind | Keep `other` |
| Player API live record with `contentKindSource: xtream-live` | Live, including nonstandard direct-source URLs |
| Explicit `/live/`, `/movie/`, or `/series/` route | Use the route's kind |
| Nested standard route, e.g. `/service/series/u/p/ch1` | Use the route's kind |
| Recognized season/episode name, outside a movie group | Series |
| VOD file extension, or `extension` / `output` / `output_format` query parameter | Series in a series group; otherwise movie |
| Explicit `24/7` or `24-7` title in a series group, without stronger VOD evidence | Live |
| Series group with an extensionless, HLS, or transport-stream URL | Keep series; absence of VOD evidence does not prove live playback |
| Other group metadata | Retain the inferred group kind; unrecognized groups retain the existing live default |

Root routes must start at the path root. Nested routes must end in the
standard route plus three resource segments; an incidental `live` directory
or a route embedded in query text does not qualify. The original source name
and group take precedence over user renames and regrouping. Container and
title hints are classification evidence, not measurements of the media.
No manifest request or playback probe is added.

Examples: `Alpha Part 1` at `http://host/a.m3u8` in `Series` stays in
Series. `Alpha 24/7` at `http://host/play/ch1` is live, but the same title at
`http://host/a?extension=mp4` stays in Series. An explicit live route wins
over an episode-like title. A Player API live result wins even when its
direct source uses a VOD-looking route.

## Source and cache boundaries

M3U sources keep all content kinds. Xtream's flattened playlist contributes
only live entries; Movies and Series retain their separate API catalogs.
Duplicates still merge by URL. A shared Player API live record carries its
authoritative marker into the merged channel independently of source order.
The marker survives cache persistence and partial-refresh restoration.
Names, groups, and source ordering otherwise retain the existing merge rules.

Valid shared memberships, channel keys, and M3U saved-item keys are unchanged
across refresh and cache restart. Legacy non-live Xtream memberships are still
compacted; a remaining M3U record keeps its kind. This deliberate membership
repair can change the source-list portion of an old M3U saved-item key, as in
the existing compaction behavior. Previously persisted records whose kind was
already overwritten without provenance cannot reliably reconstruct the lost
source decision; refreshing that source applies the new parser rules.

Home availability and resume resolution use the playlist kind indexes.
The Live source browser retains its existing all-entry M3U inventory and
stable channel indices. Series uses the same resolved series entries,
including a flat tile for names without recognized season/episode syntax.
Unified Search puts only resolved live entries in its channel results and
keeps M3U series entries in its series results. It scopes channels before
ranking and limiting in both worker and local fallback paths. The shared
channel-search API used by other views retains the full source inventory.

## Regression coverage

- The classifier matrix covers ambiguous HLS/extensionless entries,
  continuous titles, episode names, query containers, nested routes,
  source authority, restricted groups, and input immutability.
- Playlist tests cover fresh load, cached restart, refresh, shared source
  order, legacy membership compaction, and stable saved-item identities.
- Search tests cover scoped limits and equivalent results after worker and
  recovery failures, without narrowing shared channel search.
- The browser lifecycle test exercises worker parsing, durable cache restart,
  source refresh, Home availability, Live visibility, and Series/Search
  agreement in both browser projects.

These checks do not qualify a physical TV or close the separate P0-G and
webOS 4 cold-start gates.

Validation on 2026-09-04: typecheck, lint, the full unit suite (2,398 tests in
139 files), and the production build with the Chromium 53 bundle gate passed.
Added colocated parser/cache regressions then passed with their module suites
(40 tests). The 58 tests in `content-classification`, `m3u-catalog`, `search`, `home`, and
`xtream-compatibility` passed across both browser projects. This is targeted
browser coverage; the full integration suite remains part of P0-G.
The Windows preview process needed explicit shutdown after the last browser
test; the test runner then completed with exit code 0 and 58 passes.
