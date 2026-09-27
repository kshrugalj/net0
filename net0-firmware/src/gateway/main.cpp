// net0 gateway firmware. Never relays mesh traffic.
// Dedups packets (per msg_id + attempt), then:
//   - sends them to the backend over Bluetooth (binary, see backend_codec.h)
//   - prints one JSON line per packet over USB serial (for debugging)
// When the backend ACKs a report/user_reply, floods a PKT_ACK (a few times) so the origin node
// stops retrying. Retries of an already-ACKed report are ACKed here, without the backend.
// Responder messages from the backend are flooded as PKT_MESSAGE (a few times, no ACK).
#include "mesh.h"
#include "backend_codec.h"
#include "bluetooth.h"

#include <esp_coexist.h>

static uint32_t lastHeartbeat = 0;

// Radio watchdog. Sometimes the gateway's ESP-NOW goes deaf and mute (seen right
// after an ACK flood while BLE is busy) and only a reboot brings it back. Nodes
// heartbeat every 10 s, so if we've heard the mesh before and then hear nothing
// for this long, reboot. The backend reconnects over BLE by itself and nodes keep
// retrying unACKed reports, so nothing is lost.
#define MESH_SILENCE_MS 30000
static uint32_t lastMeshRx = 0;  // 0 = haven't heard any node since boot

// Append s to out as a JSON string literal (with escaping).
static void jsonString(String &out, const char *s) {
  out += '"';
  for (; *s; s++) {
    char c = *s;
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if ((uint8_t)c < 0x20) {
          char buf[7];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  out += '"';
}

static void printJson(const Packet &p, int rssi) {
  char id[9];
  snprintf(id, sizeof(id), "%08X", p.msg_id);

  String out;
  out.reserve(1024);
  out += "{\"type\":\"";
  out += typeName(p.type);
  out += "\",\"msg_id\":\"";
  out += id;
  out += "\",\"attempt\":";
  out += p.attempt;
  out += ",\"origin\":";
  out += p.origin;
  out += ",\"hops\":";
  out += p.path_len;  // transmissions so far (gateway not counted)
  out += ",\"rssi\":";
  out += rssi;
  out += ",\"path\":[";
  for (uint8_t i = 0; i < p.path_len; i++) {
    out += p.path[i];
    out += ',';
  }
  out += NODE_ID;  // gateway is the last stop
  out += ']';
  if (p.type == PKT_REPORT) {
    out += ",\"user_id\":";
    out += p.user_id;
    out += ",\"category\":";
    out += p.category;
    out += ",\"people\":";
    out += p.people;

    if (p.has_gps) {
      char gps[80];
      snprintf(gps, sizeof(gps), ",\"gps\":{\"lat\":%.6f,\"lon\":%.6f,\"accuracy_m\":%u}",
               p.lat, p.lon, p.accuracy_m);
      out += gps;
    }
    out += ",\"location\":";
    jsonString(out, p.location);
    out += ",\"message\":";
    jsonString(out, p.message);
  } else if (p.type == PKT_USER_REPLY) {
    char reply[24];
    snprintf(reply, sizeof(reply), "\"%08X\"", p.ref_id);
    out += ",\"user_id\":";
    out += p.user_id;
    out += ",\"reply_to\":";
    out += reply;
    out += ",\"text\":";
    jsonString(out, p.message);
  }
  out += '}';
  Serial.println(out);
}

// ---------- repeated floods (ACKs + responder messages) ----------
// Broadcasts have no radio-level retry, so the gateway floods each ACK ACK_SENDS
// times and each message MESSAGE_SENDS times (same msg_id, attempt 0, 1, 2 ...).
// Dedup is keyed on (msg_id, attempt), so relays forward every copy; the
// receiving node acts on the first one it hears.
#define MAX_OUTGOING 8

struct Outgoing {
  bool used;
  Packet pkt;
  uint8_t sends;      // total copies to send
  uint16_t gapMs;     // wait between copies
  uint32_t nextSend;
};
static Outgoing outgoing[MAX_OUTGOING];

static void flood(Packet &p) {
  markSeen(p);
  sendPacket(p);
  if (p.type == PKT_ACK)
    Serial.printf("[ack] flooding %08X attempt %u (acks %08X)\n", p.msg_id, p.attempt, p.ref_id);
  else
    Serial.printf("[msg] flooding %08X attempt %u -> node %u, user %u\n", p.msg_id, p.attempt, p.target, p.user_id);
}

// Send the first copy now and schedule the rest.
static void floodRepeated(Packet &p, uint8_t sends, uint16_t gapMs) {
  flood(p);
  if (sends <= 1) return;

  Outgoing *slot = &outgoing[0];  // reuse a free slot, else the one due soonest
  for (Outgoing &o : outgoing) {
    if (!o.used) { slot = &o; break; }
    if ((int32_t)(o.nextSend - slot->nextSend) < 0) slot = &o;
  }
  slot->used = true;
  slot->pkt = p;
  slot->sends = sends;
  slot->gapMs = gapMs;
  slot->nextSend = millis() + gapMs;
}

static void resendOutgoing() {
  uint32_t now = millis();
  for (Outgoing &o : outgoing) {
    if (!o.used || (int32_t)(now - o.nextSend) < 0) continue;
    o.pkt.attempt++;
    flood(o.pkt);
    o.nextSend = now + o.gapMs;
    if (o.pkt.attempt + 1 >= o.sends) o.used = false;
  }
}

// ---------- ACKs ----------
// Report/user_reply msg_ids the backend already saved. A retry of one of these
// means our ACK got lost, so we ACK it again right away instead of waiting on
// the Bluetooth round trip to the backend.
#define ACKED_LEN 32
static uint32_t acked[ACKED_LEN];
static uint8_t ackedNext = 0;

static bool wasAcked(uint32_t msgId) {
  for (uint32_t id : acked)
    if (id == msgId) return true;
  return false;
}

static void floodAck(uint32_t msgId) {
  Packet ack = newPacket(PKT_ACK);
  ack.ref_id = msgId;
  floodRepeated(ack, ACK_SENDS, ACK_RESEND_MS);
}

// Backend saved report/user_reply `msgId`: remember it and flood an ACK so its origin node stops retrying.
static void backendAcked(uint32_t msgId) {
  Serial.printf("[ack] backend saved %08X\n", msgId);
  if (!wasAcked(msgId)) {
    acked[ackedNext] = msgId;
    ackedNext = (ackedNext + 1) % ACKED_LEN;
  }
  floodAck(msgId);
}

// ---------- responder messages (backend -> phones) ----------
// Nobody ACKs a message; the phone's node keeps only the first copy.
static void startMessage(const uint8_t *frame) {
  Packet p = newPacket(PKT_MESSAGE);
  if (!bkDecodeMessage(frame, BK_MESSAGE_LEN, p)) return;
  Serial.printf("[msg] backend -> node %u user %u from \"%s\": %s\n", p.target, p.user_id, p.location, p.message);
  floodRepeated(p, MESSAGE_SENDS, MESSAGE_RESEND_MS);
}

static void handleRx(RxItem &item) {
  Packet &p = item.pkt;
  if (!isValid(p)) return;
  if (!isNeighbor(p.last_hop)) return;
  learnNeighbor(p.last_hop, item.mac);
  lastMeshRx = millis();
  if (p.type == PKT_ACK || p.type == PKT_MESSAGE) return;  // our own packets echoing back
  // Each retry (new attempt) is a new copy. If we already know the backend saved
  // it we re-ACK below; otherwise it goes to the backend, which dedups on msg_id.
  if (alreadySeen(p)) return;
  markSeen(p);
  printJson(p, item.rssi);

  // A retry of something the backend already saved: our ACK was lost, resend it now.
  if ((p.type == PKT_REPORT || p.type == PKT_USER_REPLY) && wasAcked(p.msg_id)) {
    Serial.printf("[ack] %08X attempt %u already saved, re-acking locally\n", p.msg_id, p.attempt);
    floodAck(p.msg_id);
    return;
  }

  // Old heartbeats are useless (the backend would think a node is alive now),
  // so only queue them while a laptop is connected. Reports always queue.
  if (p.type == PKT_HEARTBEAT && !bluetoothConnected()) return;

  static uint8_t payload[BK_MAX_PAYLOAD];
  size_t len = bkEncode(p, payload);
  if (!len) return;
  uint32_t trackId = p.type == PKT_HEARTBEAT ? 0 : p.msg_id;  // skip re-queuing retries
  if (queueForBackend(payload, len, trackId))
    Serial.printf("[ble] queued %s %08X (%u waiting)\n", typeName(p.type), p.msg_id, backendQueueDepth());
  else
    Serial.printf("[ble] queue full, dropped %08X (node will retry)\n", p.msg_id);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n[boot] net0 gateway %d\n", NODE_ID);
  initRadio(nullptr, true);  // modem sleep required alongside Bluetooth
  setupBluetooth();
  // Wi-Fi (ESP-NOW) and Bluetooth share one radio. By default Bluetooth gets a big
  // share and mesh packets arriving during its turn are lost. Our BLE frames are
  // small, so give ESP-NOW the priority.
  esp_err_t err = esp_coex_preference_set(ESP_COEX_PREFER_WIFI);
  Serial.printf("[boot] coex prefer Wi-Fi: %s\n", esp_err_to_name(err));
}

void loop() {
  RxItem item;
  while (xQueueReceive(rxQueue, &item, 0) == pdTRUE) handleRx(item);

  uint32_t ackedId;
  while (nextBackendAck(ackedId)) backendAcked(ackedId);

  static uint8_t frame[BK_MESSAGE_LEN];
  while (nextBackendMessage(frame)) startMessage(frame);
  resendOutgoing();

  if (lastMeshRx && millis() - lastMeshRx > MESH_SILENCE_MS) {
    Serial.printf("[wdt] no mesh packets for %d s, rebooting to reset the radio\n", MESH_SILENCE_MS / 1000);
    delay(100);
    ESP.restart();
  }

  // Gateway's own heartbeat: never sent to the backend (it rejects node ID 0;
  // the BLE connection itself tells it the gateway is alive). On the mesh it's a
  // 1-hop hello (ttl 1, nobody forwards it) so nearby nodes learn our MAC and
  // can unicast to us.
  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = millis();
    Packet hello = newPacket(PKT_HEARTBEAT);
    hello.ttl = 1;
    markSeen(hello);
    sendPacket(hello);
    Serial.printf("{\"type\":\"heartbeat\",\"msg_id\":\"00000000\",\"origin\":%d,\"hops\":0,\"rssi\":0,\"path\":[%d]}\n",
                  NODE_ID, NODE_ID);
  }
  delay(1);
}
