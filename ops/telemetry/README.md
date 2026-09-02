# Raspberry Pi telemetry server

This stack receives diagnostics from the TV application, stores them in Loki
for 30 days, and exposes the preconfigured `webOS IPTV Overview` dashboard in
Grafana.

## Raspberry Pi setup

Use 64-bit Raspberry Pi OS and reserve a stable LAN IP for the Pi in the router.
Install Docker Engine and the Compose plugin, then copy this directory to the Pi.

```bash
cd ops/telemetry
cp .env.example .env
nano .env
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4318/health
```

The health response must be `{"status":"ok"}`. Open Grafana at
`http://PI_ADDRESS:3000`, sign in as `admin` with the password from `.env`, and
open **Dashboards > IPTV > webOS IPTV Overview**.

In the TV application, open **Settings > General > Diagnostics**, enter the Pi
address without a port, enable diagnostics, and run **Test connection**. A
successful test is stored as `telemetry.connection.test`.

## Verification and maintenance

```bash
docker compose logs --tail=100 receiver
docker compose logs --tail=100 loki
docker compose restart
docker compose pull
docker compose up -d --build
```

Only ports 3000 and 4318 need to be reachable from the local network. Do not
forward either port on the router. Back up the `grafana-data` and `loki-data`
Docker volumes if the history must survive a disk failure.
