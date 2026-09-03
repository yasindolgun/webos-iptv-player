# Telemetry client lifecycle

Diagnostics are opt-in. Settings edits and Cancel do not change the running
client. Test connection sends one explicit test event even while diagnostics
are disabled, without saving the form or enabling background collection.

## Settings and addresses

Enablement and endpoint are saved together in the `iptv_telemetry_config`
localStorage record. The client and Settings use the same reader and validator.
Legacy `iptv_telemetry_enabled` / `iptv_telemetry_endpoint` records are read only
until a new record exists; malformed new records fail closed. A failed save
preserves the previous record and running configuration and keeps the form open.

Bare hosts use HTTP and port 4318. An explicit HTTP(S) scheme and numeric port
are preserved, including ports 80 and 443. Root paths become `/api/v1/events`;
an explicit non-root path is the complete receiver path, including any trailing
slash. For example, `host:9000` becomes `http://host:9000/api/v1/events`, while
`https://host:9000/a` retains `/a`. Bracketed IPv6 is accepted. Credentials,
queries, fragments, whitespace, backslashes, invalid ports, non-HTTP schemes,
and addresses longer than 500 characters are rejected. An enabled configuration
requires a nonempty valid address.

## Masking and delivery

Structured objects and serialized JSON use the same masking rules for password,
username, token, API key, URL, authorization, and cookie fields. Error names,
messages, and stacks are scrubbed too. Embedded complete JSON is parsed before
masking; incomplete JSON is omitted conservatively so escaped keys cannot bypass
masking. Deep or circular objects are truncated without calling their string
conversion. Arrays, objects, strings, and final messages have bounded output.
This masks recognized sensitive fields and URL/credential patterns; arbitrary
unlabelled secret text must still never be logged by callers.

At most 100 pending events and one 25-event request are retained in memory.
There is no durable outbox. Overflow drops the oldest pending records. Requests
use CORS-simple `text/plain;charset=UTF-8` XHR with a five-second timeout.
Successful batches leave the queue; network failures, timeout, HTTP 408/429,
and 5xx responses retry after at least ten seconds. Other HTTP failures drop the
rejected batch. New events cannot bypass the retry delay. A lost response can
cause duplicates if the server accepted the original request before the retry.

Disabling diagnostics or changing the endpoint drops pending events, aborts the
active request, and invalidates all old completions. Old callbacks cannot
restore records or block a new destination. Equivalent normalized settings
preserve the current queue. Aborting cannot retract data already accepted by a
receiver. The explicit connection test is independent of this queue.

## Foreground and shutdown

Only foreground time contributes to event-loop lag. Visibility changes cancel
and restart the heartbeat timer and reset its clock. Hidden time produces no
heartbeat or lag event; suspend/resume transitions are recorded. A foreground
delay of at least two seconds still produces `performance.event_loop_lag`.

The active-session marker exists only while diagnostics are enabled. It remains
through suspension and a persisted page hide. A previous marker without a local
close records `session.previous_unclean` with an unknown cause: it is not proof
of a crash. Disabling diagnostics clears it; enabling later starts monitoring.

After user-data persistence succeeds, explicit app exit appends `session.end`
and drains bounded batches, including an existing request, for at most one
second in the running event loop. Failed shutdown batches are not retried.
At the deadline remaining events are discarded and the request is aborted;
telemetry does not prevent exit. Repeated end calls share one shutdown promise.

A non-persisted page hide without explicit shutdown sends at most the newest
24 pending events plus `session.end`, further reduced to 60 KiB for Unicode
payloads. It first drops the older queue and aborts the active request, then
tries `sendBeacon`; rejection, failure, or an unavailable API uses one bounded
XHR. Nothing waits for this unload delivery. A beacon returning true means
browser queue acceptance, not server storage. The in-flight batch and older
pending events may be lost. An abrupt process kill can lose all pending data.

The local marker is cleared when close handling runs, independently of remote
delivery. Missing remote `session.end` therefore does not establish a crash,
and a cleared local marker does not establish delivery.

## P0-A validation — 2026-09-03

- Full Vitest suite: 139 files, 2,368 tests passed.
- Typecheck, lint, and production build passed, including the Chromium 53
  compatibility gate for the app and worker bundles.
- Targeted browser coverage: 88 tests passed across `e2e/telemetry.spec.ts`,
  `e2e/home.spec.ts`, and `e2e/settings.spec.ts` in both normal and Chromium 53
  simulation projects. The full browser suite was not run for P0-A.
- Production app bundle SHA-256:
  `8aae186d7308c585a4286bac9d1e1e9df31cd788557d6bd1a55cf91ca781449b`.
- The configured LAN receiver returned HTTP 200 for its liveness endpoint.
  A separate Chromium 151 probe loaded the current client compiled for Chrome
  53 and sent 28 synthetic events in three packets; every POST returned 204.
  Outgoing bodies excluded the synthetic secret and included the connection
  test, masking validation, session start, and session end events.
- The LAN probe ran from the receiver origin. A separate localhost-origin
  browser probe was blocked before receiving an HTTP response. This is not
  evidence of successful native-TV cross-origin delivery.

P0-A is complete for the client and settings scope. Physical webOS 4 validation
is not a completion requirement for this workstream. Native-TV visibility/timer
behavior, cross-origin POST and beacon delivery, reopen behavior, and close
latency have not been verified on webOS 4.
Dashboard query, storage-outage and deployment checks remain in P0-F; complete
cross-workstream regression and device qualification remain in P0-G.

The configured TV was reachable and reported SDK 11.2.0 / firmware 43.21.62.
It does not provide webOS 4 engine evidence. No TV installation or
firmware change was performed during this work.
