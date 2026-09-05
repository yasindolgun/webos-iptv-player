# Raspberry Pi telemetry server

This stack receives opt-in diagnostics from the TV application, stores them in
Loki for 30 days, and exposes the provisioned `webOS IPTV Overview` dashboard
in Grafana. It is a LAN-only operational aid; do not expose its ports to the
internet.

## Raspberry Pi setup

Use 64-bit Raspberry Pi OS and reserve a stable LAN IP for the Pi in the router.
Install Docker Engine and the Compose plugin, then copy this directory to the Pi.

```bash
cd ops/telemetry
cp .env.example .env
nano .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:4318/health
curl -fsS http://127.0.0.1:4318/ready
```

`/health` is only a process liveness check. It returns 200 even when Loki is
unavailable. `/ready` checks Loki and returns 503 after a failed storage write;
that failure remains visible until a later event is stored successfully. A 200
from `/ready` means the receiver can reach Loki and has no unresolved write
failure, but is not proof that a particular TV event was delivered.

Open Grafana at `http://PI_ADDRESS:3000`, sign in as `admin` with the password
from `.env`, and open **Dashboards > IPTV > webOS IPTV Overview**. These API
checks confirm that the file-provisioned data source and dashboard loaded:

```bash
set -a
. ./.env
set +a
curl -fsS -u "admin:${GRAFANA_ADMIN_PASSWORD}" \
  http://127.0.0.1:3000/api/datasources/uid/iptv-loki/health
curl -fsS -u "admin:${GRAFANA_ADMIN_PASSWORD}" \
  http://127.0.0.1:3000/api/dashboards/uid/webos-iptv-overview
```

In the TV application, open **Settings > General > Diagnostics**, enter the Pi
address without a port, enable diagnostics, and run **Test connection**. A
successful test receives 204 only after Loki accepts
`telemetry.connection.test`. Confirm that event appears in **Latest IPTV
events** before treating the end-to-end path as verified.

## Receiver contract

The ingest endpoint is `POST /api/v1/events`. It accepts a JSON version 1
envelope as `text/plain;charset=UTF-8`, at most 256 KiB and 100 events. Each
event requires a positive numeric millisecond timestamp, a known level, and the
string fields emitted by the client. The receiver sanitizes label values and
bounds strings again before writing them to Loki.

- 204 means Loki accepted the complete batch.
- 400 means malformed JSON, envelope, or event schema. The client drops it.
- 413 means the body exceeded the configured limit. The client drops it.
- 422 means Loki permanently rejected the translated batch. The client drops
  it, and readiness records the failed write for investigation.
- 503 means Loki was unavailable or rejected the write. The client retries a
  bounded in-memory batch after at least ten seconds. Loki 429 and 5xx
  responses, timeouts, and network failures use this path.

The client has no durable outbox. A lost response can cause a duplicate, and a
TV process exit can lose a pending event. Receiver status codes deliberately
separate permanent payload failures from retryable storage failures.

## Dashboard metric meanings

- **Errors** counts error-level event records, not deduplicated root causes.
- **Playback stall incidents** counts `playback.stall.detected`, emitted once
  when an uninterrupted watchdog incident begins.
- **Stall reload attempts** counts `playback.stall.reload`. One incident can
  have several attempts before recovery or exhaustion.
- **Foreground UI lag events** counts foreground heartbeat delays of at least
  two seconds. It excludes time while the app is suspended and is neither a
  duration nor proof of a rendered-frame freeze.
- **Latest IPTV events** is the underlying event stream for investigation.

These counters are signals, not unique user-visible failures. Use the event
time, device, session, and nearby log records when correlating an incident.

## Failure and persistence checks

To demonstrate the liveness/readiness split, stop Loki temporarily. This is a
planned availability test; do not run it during an active investigation.

```bash
docker compose stop loki
curl -i http://127.0.0.1:4318/health
curl -i http://127.0.0.1:4318/ready
docker compose start loki
```

While Loki is stopped, liveness remains 200, readiness is 503, and an ingest
returns 503 with `Retry-After: 10`. After Loki is ready, run **Test connection**
again; a successful write clears the remembered ingest failure and `/ready`
returns 200.

The named `loki-data` and `grafana-data` volumes survive `docker compose down`
and ordinary restarts. To verify restart persistence, note a synthetic test
event's exact time in Grafana, run `docker compose restart`, wait for `/ready`,
and confirm the same event is still visible. A 30-day Loki retention period is
configured. Monitor free space separately:

```bash
df -h
docker system df
docker compose logs --tail=100 receiver
docker compose logs --tail=100 loki
```

If Loki rejects a write because storage is full or unavailable, the receiver
returns 503, logs the upstream failure, and exposes it through `/ready`; it does
not falsely acknowledge the batch. Recover disk space according to local
operations policy, then use **Test connection** to prove writes work again.

For maintenance:

```bash
docker compose logs --tail=100 receiver
docker compose logs --tail=100 loki
docker compose restart
docker compose pull
docker compose up -d --build
```

Only ports 3000 and 4318 need to be reachable from the local network. Do not
forward either port on the router. Back up the named volumes if history must
survive a disk failure. `docker compose down -v` permanently removes that
history and should be reserved for an intentional empty-volume qualification.
