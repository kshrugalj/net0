// net0 node firmware. Every node is BOTH an access node and a relay:
// - Access: Wi-Fi AP "NET0-<id>" + captive portal + report form (web.cpp)
// - Relay: rebroadcasts every new packet exactly once (flooding)
// Reports and user replies are resent (same msg_id, attempt+1) until the gateway
// floods back an ACK. Responder messages for this node go into a small chat log
// that the phone page polls.
#include "mesh.h"
#include "node.h"

#include <DNSServer.h>
static DNSServer dns;

// The web servers call into this file from their own tasks; loop() runs on
// another. This lock guards pending[], chat[] and the dedup buffer.
static SemaphoreHandle_t lock;

static uint32_t lastHeartbeat = 0;

// ---------- reports + replies waiting for an ACK ----------
#define MAX_PENDING 8

struct Pending {
  bool used;
  bool delivered;
  Packet pkt;
  uint32_t nextSend;  // millis() when the next retry is due
  uint32_t interval;  // current wait between retries (doubles each time)
};
static Pending pending[MAX_PENDING];
static uint8_t pendingNext = 0;

static Pending *findPending(uint32_t msgId) {
  for (Pending &e : pending)
    if (e.used && e.pkt.msg_id == msgId) return &e;
  return nullptr;
}

// Take a free (or already delivered) slot; if all are busy, reuse the oldest.
static Pending &takeSlot() {
  for (Pending &e : pending)
    if (!e.used || e.delivered) return e;
  Pending &e = pending[pendingNext];
  Serial.printf("[retry] queue full, giving up on %08X\n", e.pkt.msg_id);
  pendingNext = (pendingNext + 1) % MAX_PENDING;
  return e;
}

static void transmit(Packet &p) {
  markSeen(p);  // so we ignore our own echo
  sendPacket(p);
  Serial.printf("[tx] %s id=%08X attempt=%u\n", typeName(p.type), p.msg_id, p.attempt);
}

// Puts a new packet in the pending list, sends it once and returns it.
static Packet &sendWithRetries(Packet p) {
  Pending &e = takeSlot();
  e.used = true;
  e.delivered = false;
  e.pkt = p;
  e.interval = RETRY_FIRST_MS;
  e.nextSend = millis() + e.interval;
  transmit(e.pkt);
  return e.pkt;
}

uint32_t nodeSendReport(const ReportInfo &r) {
  Packet p = newPacket(PKT_REPORT);
  p.user_id = r.userId;
  p.category = r.category;
  p.people = r.people;
  p.has_gps = r.gps.valid;
  p.lat = r.gps.lat;
  p.lon = r.gps.lon;
  p.accuracy_m = r.gps.accuracy_m;
  strlcpy(p.name, r.name, NAME_LEN);
  strlcpy(p.location, r.location, LOCATION_LEN);
  strlcpy(p.message, r.message, MESSAGE_LEN);

  xSemaphoreTake(lock, portMAX_DELAY);
  uint32_t id = sendWithRetries(p).msg_id;
  xSemaphoreGive(lock);
  return id;
}

// ---------- chat log (responder messages + the phone's replies) ----------
// Ring buffer shared by every phone on this node; each line is tagged with its
// user. 16 lines x ~450 B = ~7 KB of RAM.
#define CHAT_LEN 16

struct ChatSlot {
  bool used;
  uint16_t userId;  // 0 = for everyone on this node
  ChatEntry e;
};
static ChatSlot chat[CHAT_LEN];
static uint8_t chatNext = 0;
static uint32_t chatSeq = 0;

static ChatSlot *findChat(uint32_t msgId, bool fromUser) {
  for (ChatSlot &c : chat)
    if (c.used && c.e.msgId == msgId && c.e.fromUser == fromUser) return &c;
  return nullptr;
}

static void addChat(uint16_t userId, uint32_t msgId, uint32_t replyTo, bool fromUser, const char *sender,
                    const char *text) {
  ChatSlot &c = chat[chatNext];
  chatNext = (chatNext + 1) % CHAT_LEN;
  c.used = true;
  c.userId = userId;
  c.e.seq = ++chatSeq;
  c.e.msgId = msgId;
  c.e.replyTo = replyTo;
  c.e.fromUser = fromUser;
  c.e.delivered = false;
  strlcpy(c.e.sender, sender, SENDER_LEN);
  strlcpy(c.e.text, text, MESSAGE_LEN);
}

uint32_t nodeSendReply(uint16_t userId, uint32_t replyTo, const char *text) {
  Packet p = newPacket(PKT_USER_REPLY);
  p.user_id = userId;
  p.ref_id = replyTo;
  strlcpy(p.message, text, MESSAGE_LEN);

  xSemaphoreTake(lock, portMAX_DELAY);
  uint32_t id = sendWithRetries(p).msg_id;
  addChat(userId, id, replyTo, true, "You", text);
  xSemaphoreGive(lock);
  return id;
}

bool nodeNextChat(uint16_t userId, uint32_t afterSeq, ChatEntry &out) {
  xSemaphoreTake(lock, portMAX_DELAY);
  const ChatSlot *best = nullptr;
  for (const ChatSlot &c : chat) {
    if (!c.used || c.e.seq <= afterSeq) continue;
    if (c.userId != userId && c.userId != 0) continue;
    if (!best || c.e.seq < best->e.seq) best = &c;
  }
  if (best) out = best->e;
  xSemaphoreGive(lock);
  return best != nullptr;
}

bool nodeReportStatus(uint32_t msgId, bool &delivered, uint8_t &attempts) {
  xSemaphoreTake(lock, portMAX_DELAY);
  Pending *e = findPending(msgId);
  if (e) {
    delivered = e->delivered;
    attempts = e->pkt.attempt + 1;
  }
  xSemaphoreGive(lock);
  return e != nullptr;
}

// Resend every unACKed report whose timer is up. Backoff: 3 s, 6 s, 12 s, 15 s ...
static void retryPending() {
  uint32_t now = millis();
  for (Pending &e : pending) {
    if (!e.used || e.delivered || (int32_t)(now - e.nextSend) < 0) continue;
    if (e.pkt.attempt >= MAX_ATTEMPTS) {
      Serial.printf("[retry] %08X: out of attempts\n", e.pkt.msg_id);
      e.used = false;
      continue;
    }
    // Same msg_id so the backend can dedup; fresh path/ttl for the new trip.
    e.pkt.attempt++;
    e.pkt.last_hop = NODE_ID;
    e.pkt.ttl = DEFAULT_TTL;
    e.pkt.path_len = 1;
    e.pkt.path[0] = NODE_ID;
    transmit(e.pkt);
    e.interval = min<uint32_t>(e.interval * 2, RETRY_MAX_MS);
    e.nextSend = now + e.interval + random(0, 500);  // jitter so nodes don't retry in sync
  }
}

// ---------- mesh receive ----------
// Runs under the lock. Returns true if the (updated) packet should be forwarded;
// loop() does that after releasing the lock so the web servers aren't blocked.
static bool handleRx(RxItem &item) {
  Packet &p = item.pkt;
  if (!isValid(p)) return false;
  if (p.last_hop == NODE_ID) return false;
  if (!isNeighbor(p.last_hop)) return false;  // filter BEFORE dedup, or a non-neighbor copy would "use up" the id
  learnNeighbor(p.last_hop, item.mac);
  if (p.type == PKT_HEARTBEAT && p.origin == GATEWAY_ID) return false;  // gateway hello: only there to learn its MAC
  if (p.origin == NODE_ID) return false;
  if (alreadySeen(p)) return false;
  markSeen(p);

  Serial.printf("[rx] %s id=%08X attempt=%u origin=%u from=%u ttl=%u rssi=%d\n",
                typeName(p.type), p.msg_id, p.attempt, p.origin, p.last_hop, p.ttl, item.rssi);

  // An ACK for one of OUR reports/replies: stop retrying. No need to forward it further.
  if (p.type == PKT_ACK) {
    Pending *e = findPending(p.ref_id);
    if (e) {
      if (!e->delivered) Serial.printf("[ack] %08X delivered after %u attempt(s)\n", p.ref_id, e->pkt.attempt + 1);
      e->delivered = true;
      if (ChatSlot *c = findChat(p.ref_id, true)) c->e.delivered = true;
      return false;
    }
  }

  // A responder message for phones on this node: keep it for the page to show.
  // The gateway sends each message a few times; only the first copy is kept.
  if (p.type == PKT_MESSAGE && (p.target == NODE_ID || p.target == TARGET_ALL)) {
    if (!findChat(p.msg_id, false)) {
      addChat(p.user_id, p.msg_id, p.ref_id, false, p.location, p.message);
      Serial.printf("[msg] %08X for user %u from \"%s\": %s\n", p.msg_id, p.user_id, p.location, p.message);
    }
    if (p.target == NODE_ID) return false;  // it was only for us: no need to pass it on
  }

  if (p.ttl <= 1) {
    Serial.println("[rx] ttl expired, not forwarding");
    return false;
  }
  p.ttl--;
  p.last_hop = NODE_ID;
  if (p.path_len < MAX_PATH) p.path[p.path_len++] = NODE_ID;
  return true;
}

// Called WITHOUT the lock: the jitter wait doesn't touch shared state.
static void forward(const Packet &p) {
  delay(random(10, 61));  // jitter so neighbors don't all transmit at once
  sendPacket(p);
  Serial.printf("[fwd] %s id=%08X ttl=%u\n", typeName(p.type), p.msg_id, p.ttl);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n[boot] net0 node %d (access + relay)\n", NODE_ID);
  lock = xSemaphoreCreateMutex();

  char apName[16];
  snprintf(apName, sizeof(apName), "NET0-%d", NODE_ID);
  initRadio(apName);
  Serial.printf("[boot] AP \"%s\" up at %s\n", apName, WiFi.softAPIP().toString().c_str());

  dns.start(53, "*", WiFi.softAPIP());  // answer every DNS lookup with our IP (captive portal)
  webBegin();
}

void loop() {
  dns.processNextRequest();

  // One packet at a time, so the lock is released during each forward's jitter wait.
  static RxItem item;  // ~500 B, keep it off the loop task's stack
  while (xQueueReceive(rxQueue, &item, 0) == pdTRUE) {
    xSemaphoreTake(lock, portMAX_DELAY);
    bool fwd = handleRx(item);
    xSemaphoreGive(lock);
    if (fwd) forward(item.pkt);
  }

  xSemaphoreTake(lock, portMAX_DELAY);
  retryPending();
  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = millis();
    Packet hb = newPacket(PKT_HEARTBEAT);
    transmit(hb);
  }
  xSemaphoreGive(lock);

  delay(1);
}
