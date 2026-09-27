# net0 — HackGT 13 (Social Good)

Off-grid emergency reporting. A phone joins a nearby ESP32's Wi-Fi, submits a distress report, and the report hops across ESP32s over ESP-NOW until it reaches a gateway plugged into a laptop. The laptop saves the report and shows it in an AI responder dashboard.

```
Phone → Node (Wi-Fi AP + web form) → other Node(s) relaying → Gateway ESP32 → Bluetooth (BLE) → FastAPI → SQLite → AI → React dashboard
```

**Core principle:** prove the delivery path first, then make the data useful, then make the dashboard impressive. Everything local must keep working when the internet / cloud AI is down.

## Team
- **Aadi:** access and relay node firmware (this repo's `src/node/`)
- **Ishan:** gateway firmware (`src/gateway/`) + backend (FastAPI, SQLite, API routes)
- Two other teammates own the React dashboard and the AI extraction

## How to work with me
- I'm a first-year CS student, so explain new concepts briefly (what it is, why we use it) before or alongside the code.
- Keep answers short. It's a 36-hour hackathon: working > perfect.
- If there's a clearly better alternative to what I asked for, say so in one or two lines, then do what I asked unless I switch.
- Don't overbuild: no general-purpose routing protocol, no LoRa, no GPS hardware, no sensors, no displays.
- **Only edit files inside `net0-firmware/`.** Teammates are working on everything else (`portal-end/` backend, Debug Lab, dashboard). Read their code to match formats, but if something there needs changing, tell me what instead of editing it.

## Hardware
- 6 × ESP32 DevKit boards (classic ESP32 / WROOM-32 → `board = esp32dev`)
- Built-in 2.4 GHz radio only. No extra hardware.

## Firmware decisions (locked)
- **Toolchain:** PlatformIO with the **pioarduino** platform (Arduino-ESP32 core 3.x):
  `platform = https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip`
  The official `platform = espressif32` ships core 2.x = ESP-NOW v1 only. **Don't use it.**
- **Transport:** ESP-NOW **v2** (payload up to 1470 bytes; v1 max is 250). Print `esp_now_get_version()` at boot and warn if < 2.
- **Routing:** **flooding**. Every node re-sends a packet it hasn't seen before, exactly once.
  - **Unicast to live neighbors** (`mesh.h` `sendPacket`): a broadcast gets no radio ACK, so each copy is sent as a unicast to every neighbor heard in the last 35 s (MAC learned from any packet it sent us, `learnNeighbor`), skipping neighbors already in the packet's `path`. The radio ACKs and auto-retries unicasts. With no live neighbor known (just booted) it broadcasts (`FF:FF:FF:FF:FF:FF`), which is how others discover it.
  - The gateway sends a 1-hop hello (heartbeat, ttl 1, origin 0) every 10 s so nodes learn its MAC; nodes don't forward or log it.
  - Loop protection:
  - **Duplicate suppression:** a random 32-bit `msg_id` per message; each node keeps a ring buffer of the last 64 IDs.
  - **TTL:** decremented each hop; drop the packet when it reaches ≤ 1.
  - **Jitter:** random 10–60 ms delay before rebroadcasting to avoid collisions.
- **Separate firmware** for nodes vs. gateway, in one PlatformIO project:
  - `src/node/`: **every node is BOTH access and relay** (no role flag). Each runs a Wi-Fi AP `NET0-<id>`, a captive-portal DNS, and floods/relays packets. `main.cpp` = mesh + retries, `web.cpp` = web servers (ESP-IDF `esp_http_server` on :80 and `esp_https_server` on :443), `node.h` = the locked interface between them (web servers run on their own tasks). Web files in `data/` (`index.html`, `style.css`, `app.js`, plus `cert.pem`/`key.pem`) live on LittleFS.
  - `src/gateway/`: never relays mesh traffic; only transmits ACKs for reports the backend saved (and responder messages). Dedups, then queues each packet for the backend and a background task sends it over **BLE** (queue of 16; a frame is removed only after it's sent; reports always queue, retries of an already-queued report are skipped, heartbeats only queue while a laptop is connected) (`bluetooth.cpp`, encoded by `backend_codec.h`) and also prints a JSON debug line over USB serial. Uses `huge_app.csv` partitions (Wi-Fi + BLE is too big for the default). **Radio watchdog:** its ESP-NOW can go deaf after an ACK flood while BLE is busy (only a reboot fixes it), so if it has heard the mesh since boot and then hears nothing for 30 s it calls `ESP.restart()`.
  - `include/packet.h`: **shared** packet struct + constants. Any packet format change happens here only.
- **Per-board config** lives in `platformio.ini` `build_flags`, one `[env:...]` per physical board. Don't hardcode per-board values in `.cpp` files.
- **Wi-Fi channel:** fixed at 6 on every board (the AP and ESP-NOW must share one channel). `WiFi.setSleep(false)` on nodes; the gateway must use `setSleep(true)` because BLE is on (ESP32 aborts otherwise). Wi-Fi and BLE share the gateway's radio, so it sets `esp_coex_preference_set(ESP_COEX_PREFER_WIFI)` to give ESP-NOW priority.
- **ESP-NOW receive callback:** only copy the packet into a FreeRTOS queue. Process it in `loop()`. Never do slow work (Serial, delays, sends) inside the callback.
- **Callback signature (core 3.x):** `void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len)`. RSSI comes from `info->rx_ctrl->rssi`.

## Packet (`include/packet.h`, packed struct, version 7)
| Field | Type | Notes |
|---|---|---|
| magic | uint16 | `0x4E30`, drop anything else |
| version | uint8 | `7` (every board must run the same version) |
| type | uint8 | `1` = report, `2` = user_reply, `3` = heartbeat, `4` = ack, `5` = message. **Same numbers as the backend's `packet_codec.py`.** |
| msg_id | uint32 | random, never 0. **Same on every retry of a report / user_reply / message** |
| attempt | uint8 | 0 = first send, +1 per retry |
| origin | uint8 | node that created it |
| last_hop | uint8 | node that last transmitted it |
| ttl | uint8 | default 6 |
| user_id | uint16 | report/user_reply: sender's user ID (0 = unknown); message: recipient (0 = everyone on the node) |
| ref_id | uint32 | ack: the `msg_id` being acknowledged; user_reply/message: the report `msg_id` it's about (0 = none) |
| target | uint8 | message: node that should show it (`255` = every node) |
| category | uint8 | reports: backend `Category` (0 unknown, 1 medical, 2 trapped, 3 fire, 8 other), picked on the phone |
| people | uint8 | reports: people needing help (0 = unknown) |
| has_gps, lat, lon, accuracy_m | uint8, float, float, uint16 | reports: phone GPS fix (HTTPS page only) |
| path_len, path[8] | uint8 | node IDs the packet passed through, in order |
| name | char[32] | report: name typed on the phone (saved as the user's name in the backend) |
| location | char[64] | report: user-typed location; message: sender name (≤ 31 chars) |
| message | char[400] | report details / user_reply text / message text |

Nodes send a heartbeat every 10 s (used for the node-status panel on the dashboard).

## Delivery: retries + ACKs
- The origin node keeps each report in a pending list (8 slots) and resends it with the **same `msg_id`** and `attempt + 1` until it hears an ACK: waits 3 s, 6 s, 12 s … capped at 15 s, up to 255 attempts.
- Dedup (relays and gateway) is keyed on **(msg_id, attempt)**, so a retry is forwarded again instead of being dropped as a duplicate.
- The gateway forwards every attempt to the backend (except retries it already knows were saved, see below). The backend dedups on `msg_id` (unique in SQL) and ACKs every copy over BLE.
- The gateway floods a `PKT_ACK` (`ref_id` = report msg_id) 3 times, 400 ms apart (same ack msg_id, attempt 0/1/2), since a single broadcast is easily lost. The origin node marks the report delivered and stops retrying.
- The gateway remembers the last 32 msg_ids the backend ACKed. If a retry of one of those arrives (our ACK was lost), it re-floods the ACK itself instead of sending the copy to the backend again. The phone polls `GET /status?id=<hex msg_id>` to show "Delivered".
- **user_reply** (phone → responders) uses the exact same pending list, retries and ACK as a report.
- Heartbeats are not retried.

## Messages (responders ↔ phone)
- **Portal → phone:** backend `POST /api/messages/send` writes a message frame to the gateway over BLE (440 B, may arrive split over several writes; the gateway reassembles). The gateway floods it as `PKT_MESSAGE` 3 times (same `msg_id`, attempt 0/1/2, 1.5 s apart) since nothing ACKs it. The node whose ID is `target` (or every node if 255) keeps it in a 16-line chat log (RAM, shared by all phones on that node) and stops forwarding it if it was only for itself.
- **Phone → portal:** the page's chat box posts `POST /reply` (`id`, `reply_to` = report msg_id hex, `text`). The node floods a `PKT_USER_REPLY`, retried until the gateway floods back an ACK, and adds it to the chat log too. The gateway encodes it for the backend (type 2, 422 B), which saves it in the `messages` table (`direction = uplink`).
- The page polls `GET /messages?id=<user_id>&after=0` every 3 s: lines for that user or for everyone, oldest first, with `from` = `responder`/`you` and `delivered` for the phone's own lines. New responder messages vibrate the phone.
- The chat log is lost if the node reboots (the portal DB keeps the real history).

## User ID
Goal: the same phone keeps the same `user_id` (1–65535) whenever possible.
1. `data/app.js` keeps the ID in localStorage + a cookie, so it holds while the page is open.
2. The phone's Wi-Fi sign-in popup (captive portal) wipes that storage each time it reopens, so the node also remembers **phone Wi-Fi MAC → user_id** in flash (NVS namespace `users`, survives reboots). On load the page calls `GET /whoami?id=<stored or 0>`; `/send` does the same resolution.
3. Priority: the page's stored ID > the ID remembered for this MAC > a new random ID.
- Phones use a fixed private MAC per network name, so reconnecting to the **same node** gets the same ID. A **different node** (different network name) sees a different MAC → new ID, unless the browser kept its storage. This is accepted.

## Phone page (`data/`)
Design from the team's initial user portal (was `user-end/node-esp/data/web-portal/`, commit e33013a). Flow: pick emergency type (Medical / Fire / Trapped / Other → `category`) and people count, optional location text + GPS, details (required for "Other"), then SEND → `POST /send`. The confirmation screen polls `/status` and flips from "SOS SENT" (amber) to "SOS DELIVERED" (green) on the gateway's ACK. Below it, a "Messages with responders" chat (see Messages) — also shown on the form screen once any message arrives. "Send a new report" goes back to the form keeping type/people/location. `/whoami` also returns the node ID for the "Connected to local node N" badge.

## HTTPS + GPS
Browsers only share location with secure (`https://`) pages.
- Port 80 serves the form over HTTP (captive portal popup; works everywhere, no GPS). The page links to `https://192.168.4.1/?id=<user_id>`.
- Port 443 serves the same form over HTTPS if `data/cert.pem` + `data/key.pem` exist. `scripts/make_cert.sh` makes a **self-signed** ECDSA P-256 cert (SAN `IP:192.168.4.1`), so phones show a "not private" warning the user must tap through. The key is gitignored; each teammate generates their own.
- On the HTTPS page, `app.js` uses `navigator.geolocation.watchPosition` (high accuracy) and sends `lat`, `lon`, `acc` with the report. Phone GPS works offline but the first fix can be slow or fail indoors.
- **The phone's Wi-Fi sign-in popup (captive portal) can't do GPS**: it never shows the location permission prompt, so the request hangs (confirmed on iPhone). `app.js` detects the popup (iPhone: no `Safari/` in the user agent; Android: `; wv)`) and tells the user to leave it (iPhone: Cancel → "Use Without Internet") and open `https://192.168.4.1` in Safari/Chrome. A 10 s watchdog shows the same help if location never answers. Reports can still be sent from the popup without GPS.
- To avoid the warning: point a real domain you own at nothing, get a Let's Encrypt cert for it via DNS challenge, put it in `data/`, and set `-D HTTPS_HOST=\"that.domain\"` (the captive DNS already answers every name with 192.168.4.1).

## Board map / demo topology
Every board sits on one table, so they can all hear each other directly. The `NEIGHBORS` build flag fakes a topology by accepting packets only from the listed `last_hop` IDs (`0` = the gateway, `*` = accept from anyone). ACKs travel gateway → nodes, so list links in both directions. This forces real multi-hop delivery and makes the failover demo possible.

Current setup: 6 boards. `node4`/`node5 → node3 → node1`/`node2 → gateway`. node3 has two routes, so unplugging node1 or node2 shows failover. Every node is access + relay (phones can join any `NET0-<id>`). Set every `NEIGHBORS` to `*` to let everyone hear everyone.

| Env | NODE_ID | Role | NEIGHBORS |
|---|---|---|---|
| gateway | 0 | Gateway on laptop | 1,2 |
| node1 | 1 | Access + relay | 0,3 |
| node2 | 2 | Access + relay | 0,3 |
| node3 | 3 | Access + relay | 1,2,4,5 |
| node4 | 4 | Access + relay | 3 |
| node5 | 5 | Access + relay | 3 |

## Gateway → backend contract (BLE)
The backend (`portal-end/backend/packets/esp_manager.py`, Ishan) scans for BLE service `7b2f3a91-8c64-4f2e-a7d1-91c8e7b5d421`, device `Gateway-Node`, and subscribes to notifications on characteristic `a12b3c45-6789-4def-8123-456789abcdef`. The gateway keeps advertising while connected, so up to 3 laptops can connect at once (otherwise the first connection hides it from everyone else). These UUIDs are BLE identifiers, unrelated to the mesh `NODE_ID`.
- **Uplink (gateway → backend):** notifications carrying frames `[uint16 len][payload]`, split into MTU-sized chunks. Payload layouts are defined by `portal-end/backend/packets/packet_codec.py` (report = type 1, 705 B; user_reply = type 2, 422 B; heartbeat = type 3, 23 B). `src/gateway/backend_codec.h` must match it.
- **Downlink (backend → gateway):** writes to the same characteristic, `[uint16 len][payload]` frames, reassembled across writes: acks (type 4, 8 B) → mesh `PKT_ACK`; messages (type 5, 440 B: target, user_id, reply_to, sender[32], text[400]) → mesh `PKT_MESSAGE`.
- Fields our mesh packet doesn't carry yet (name, phone, severity, needs, clients, uptime, tx/rx, neighbors) are sent as unknown/0. Severity stays 0 (unknown) on purpose: the dashboard AI will decide it later. `user_id` comes from the phone (falls back to one derived from `msg_id` if 0). The gateway (ID 0) is **not** added to `path` because the backend only accepts node IDs 1–254.
- USB serial (115200) still prints one JSON line per packet for debugging:
```json
{"type":"report","msg_id":"A83F29C1","origin":2,"hops":2,"rssi":-48,"path":[2,1,0],"location":"Klaus, Floor 3","message":"Two people trapped, one injured"}
```
Coordinate with Ishan before changing either format.

## Commands
```bash
pio run -e node2                          # build one board
pio run -e node2 -t upload                # flash firmware (hold BOOT if stuck at "Connecting...")
pio run -e node2 -t uploadfs              # flash web files in data/ (nodes only; redo when data/ changes)
./scripts/make_cert.sh                    # once: HTTPS cert for GPS (then uploadfs to every node)
pio device monitor -b 115200              # serial monitor
pio run                                   # build every env (do this before committing)
```
When more than one board is plugged in, add `--upload-port <port>` (list ports with `pio device list`).

## Build order (36 h plan)
1. ✅ Decide transport (ESP-NOW v2 + flooding) and packet format
2. Two boards: node2 → gateway directly (`NEIGHBORS="*"`). Phone submits → JSON on serial
3. Add node1 + neighbor filters → report travels 2 → 1 → 0
4. Add node3 → unplug node1 → report reroutes 2 → 3 → 0 (**failover demo**)
5. Heartbeats → node status on the dashboard
6. ✅ End-to-end ACK + retries (see "Delivery"). Stretch: gateway posting to the API over Wi-Fi instead of serial

## Demo success = 
Phone with no internet submits report → it visibly crosses ≥1 relay → backend saves the raw report → dashboard shows it → AI structures it → a second report reroutes after a relay is unplugged → the dashboard still works with cloud AI offline.
