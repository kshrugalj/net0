// Shared mesh plumbing used by both node and gateway firmware:
// radio setup, receive queue, duplicate suppression, neighbor filter.
// Header-only on purpose: each env compiles exactly one main.cpp.
#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include "packet.h"

#ifndef NODE_ID
#error "NODE_ID must be set in platformio.ini build_flags"
#endif
#ifndef NEIGHBORS
#define NEIGHBORS "*"
#endif

static const uint8_t BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------- receive queue ----------
// The ESP-NOW callback runs on the Wi-Fi task. We only copy the packet into
// a FreeRTOS queue there and do the real work in loop().
struct RxItem {
  Packet pkt;
  int8_t rssi;
  uint8_t mac[6];  // radio address of the board that sent this copy
};
static QueueHandle_t rxQueue;

static void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(Packet)) return;
  RxItem item;
  memcpy(&item.pkt, data, sizeof(Packet));
  item.rssi = info->rx_ctrl->rssi;
  memcpy(item.mac, info->src_addr, 6);
  xQueueSend(rxQueue, &item, 0);  // never block inside the callback
}

// ---------- duplicate suppression (ring buffer of the last 64 copies) ----------
// Keyed on (msg_id, attempt): a retry of a report has the same msg_id but a new
// attempt number, so relays forward it again instead of dropping it as a duplicate.
static uint64_t seenKeys[64];
static uint8_t seenNext = 0;

static uint64_t seenKey(const Packet &p) {
  return ((uint64_t)p.msg_id << 8) | p.attempt;
}

static bool alreadySeen(const Packet &p) {
  uint64_t key = seenKey(p);
  for (uint64_t s : seenKeys)
    if (s == key) return true;
  return false;
}

static void markSeen(const Packet &p) {
  seenKeys[seenNext] = seenKey(p);
  seenNext = (seenNext + 1) % 64;
}

static uint32_t newMsgId() {
  uint32_t id;
  do id = esp_random(); while (id == 0);
  return id;
}

// ---------- neighbor filter (fakes a topology on one table) ----------
// NEIGHBORS is a comma list of node IDs ("0" = the gateway) or "*" for anyone.
static uint8_t neighbors[MAX_PATH];
static uint8_t neighborCount = 0;
static bool acceptAll = false;

static void parseNeighbors() {
  const char *s = NEIGHBORS;
  while (*s) {
    if (*s == '*') acceptAll = true;
    else if (neighborCount < MAX_PATH) neighbors[neighborCount++] = atoi(s);
    const char *comma = strchr(s, ',');
    if (!comma) break;
    s = comma + 1;
  }
  if (neighborCount == 0) acceptAll = true;
}

static bool isNeighbor(uint8_t id) {
  if (acceptAll) return true;
  for (uint8_t i = 0; i < neighborCount; i++)
    if (neighbors[i] == id) return true;
  return false;
}

// ---------- live neighbors (who we send to) ----------
// A broadcast gets no radio-level ACK, so a missed frame is simply lost. A
// unicast is ACKed by the receiver's radio and automatically resent if not.
// So instead of one broadcast we send one unicast copy to each neighbor we've
// heard recently. We learn a neighbor's MAC from any packet it sends us.
// If we don't know any live neighbor yet (just booted), we broadcast, which is
// also how the others discover us.
#define MAX_LIVE           8
#define NEIGHBOR_TIMEOUT_MS 35000  // ~3 missed heartbeats

struct LiveNeighbor {
  bool used;
  uint8_t id;
  uint8_t mac[6];
  uint32_t lastHeard;
};
static LiveNeighbor live[MAX_LIVE];
// learnNeighbor() runs in loop(); sendPacket() may also run on web server tasks.
static portMUX_TYPE liveLock = portMUX_INITIALIZER_UNLOCKED;

static void addPeer(const uint8_t *mac) {
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = 0;  // current channel
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}

// Call for every valid packet from an accepted neighbor (before dedup: a
// duplicate still proves the neighbor is alive).
static void learnNeighbor(uint8_t id, const uint8_t *mac) {
  uint32_t now = millis();
  LiveNeighbor *slot = nullptr;
  bool isNew = false;
  uint8_t oldMac[6];

  portENTER_CRITICAL(&liveLock);
  for (LiveNeighbor &n : live)
    if (n.used && n.id == id) { slot = &n; break; }
  if (!slot) {  // new: take a free slot, else the one heard from longest ago
    isNew = true;
    slot = &live[0];
    for (LiveNeighbor &n : live) {
      if (!n.used) { slot = &n; break; }
      if ((int32_t)(n.lastHeard - slot->lastHeard) < 0) slot = &n;
    }
  }
  bool hadMac = slot->used;
  memcpy(oldMac, slot->mac, 6);
  bool macChanged = hadMac && memcmp(slot->mac, mac, 6) != 0;
  slot->used = true;
  slot->id = id;
  memcpy(slot->mac, mac, 6);
  slot->lastHeard = now;
  portEXIT_CRITICAL(&liveLock);

  if (isNew || macChanged) {
    if (hadMac) esp_now_del_peer(oldMac);  // evicted slot, or the board was swapped
    addPeer(mac);
    Serial.printf("[nbr] node %u at %02X:%02X:%02X:%02X:%02X:%02X\n",
                  id, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  }
}

// ---------- packet checks ----------
static bool isValid(Packet &p) {
  if (p.magic != NET0_MAGIC || p.version != NET0_VERSION) return false;
  if (p.msg_id == 0 || p.path_len > MAX_PATH) return false;
  if (p.type < PKT_REPORT || p.type > PKT_MESSAGE) return false;
  p.location[LOCATION_LEN - 1] = '\0';  // never trust strings off the air
  p.message[MESSAGE_LEN - 1] = '\0';
  return true;
}

static const char *typeName(uint8_t type) {
  switch (type) {
    case PKT_REPORT: return "report";
    case PKT_USER_REPLY: return "user_reply";
    case PKT_ACK: return "ack";
    case PKT_MESSAGE: return "message";
    default: return "heartbeat";
  }
}

// Build a fresh packet originating at this board.
static Packet newPacket(uint8_t type) {
  Packet p = {};
  p.magic = NET0_MAGIC;
  p.version = NET0_VERSION;
  p.type = type;
  p.msg_id = newMsgId();
  p.origin = NODE_ID;
  p.last_hop = NODE_ID;
  p.ttl = DEFAULT_TTL;
  p.path[0] = NODE_ID;
  p.path_len = 1;
  return p;
}

// ---------- radio ----------
static void sendTo(const uint8_t *mac, const Packet &p) {
  esp_err_t err = esp_now_send(mac, (const uint8_t *)&p, sizeof(Packet));
  if (err == ESP_ERR_ESPNOW_NO_MEM) {  // radio's send queue is full: give it a moment
    delay(2);
    err = esp_now_send(mac, (const uint8_t *)&p, sizeof(Packet));
  }
  if (err != ESP_OK) Serial.printf("[tx] esp_now_send failed: %s\n", esp_err_to_name(err));
}

static bool inPath(const Packet &p, uint8_t id) {
  for (uint8_t i = 0; i < p.path_len; i++)
    if (p.path[i] == id) return true;
  return false;
}

// Unicast to every live neighbor that hasn't already had this packet (in its
// path). Broadcast only if we know no live neighbor at all.
static void sendPacket(const Packet &p) {
  uint8_t macs[MAX_LIVE][6];
  uint8_t alive = 0, count = 0;
  uint32_t now = millis();

  portENTER_CRITICAL(&liveLock);
  for (LiveNeighbor &n : live) {
    if (!n.used || now - n.lastHeard > NEIGHBOR_TIMEOUT_MS) continue;
    alive++;
    if (!inPath(p, n.id)) memcpy(macs[count++], n.mac, 6);
  }
  portEXIT_CRITICAL(&liveLock);

  if (alive == 0) {
    sendTo(BROADCAST_MAC, p);
    return;
  }
  for (uint8_t i = 0; i < count; i++) sendTo(macs[i], p);
}

// modemSleep must be true when Bluetooth is also running (the ESP32 aborts
// otherwise). It doesn't hurt ESP-NOW receive: with no AP connection the
// radio stays awake and time-shares between Wi-Fi and BLE.
static void initRadio(const char *apName, bool modemSleep = false) {
  if (apName) {
    // Node: Wi-Fi AP for phones + ESP-NOW on the same radio/channel.
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(apName, nullptr, WIFI_CHANNEL);  // open network, no password
  } else {
    // Gateway: no AP, ESP-NOW only.
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  }
  WiFi.setSleep(modemSleep);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[boot] ESP-NOW init failed, restarting");
    delay(1000);
    ESP.restart();
  }

  uint32_t ver = 0;
  esp_now_get_version(&ver);
  Serial.printf("[boot] ESP-NOW version %u\n", ver);
  if (ver < 2) Serial.println("[boot] WARNING: ESP-NOW v1 (250 B max). Use the pioarduino platform!");

  rxQueue = xQueueCreate(24, sizeof(RxItem));  // deep enough for a burst while loop() is busy forwarding
  esp_now_register_recv_cb(onRecv);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BROADCAST_MAC, 6);
  peer.channel = 0;  // 0 = "whatever channel we're on" (6)
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  esp_now_add_peer(&peer);

  parseNeighbors();
  Serial.printf("[boot] node %d, channel %d, neighbors \"%s\", MAC %s\n",
                NODE_ID, WIFI_CHANNEL, NEIGHBORS, WiFi.macAddress().c_str());
}
