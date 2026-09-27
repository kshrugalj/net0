// Converts our over-the-air Packet into the binary layout the backend's
// portal-end/backend/packet_codec.py decodes (packed, little-endian).
// Plain C++ (no Arduino) so it can be tested on a laptop.
//
// Fields our mesh packet doesn't carry yet are sent as "unknown" defaults.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "packet.h"

// Must match serial_schema.py / packet_codec.py.
// Packet type numbers are shared with the mesh (PKT_* in packet.h).
#define BK_MAX_HOPS       8
#define BK_NAME_MAX       32
#define BK_PHONE_MAX      20
#define BK_LOCATION_MAX   120
#define BK_REPORT_MSG_MAX 500
#define BK_SENDER_MAX     32
#define BK_REPLY_MSG_MAX  400
#define BK_ROLE_ACCESS    2   // our nodes are access + relay
#define BK_BATTERY_UNKNOWN 255

#define BK_MAX_PAYLOAD 1024   // report is 705 bytes, user_reply 422

// Downlink message (backend -> gateway): [type][target_node][user_id u16][reply_to u32][sender 32][text 400]
#define BK_MESSAGE_LEN (8 + BK_SENDER_MAX + BK_REPLY_MSG_MAX)

// Little writer: appends fixed-width little-endian fields to a buffer.
struct BkWriter {
  uint8_t *buf;
  size_t len;

  void u8(uint8_t v) { buf[len++] = v; }
  void u16(uint16_t v) { u8(v & 0xFF); u8(v >> 8); }
  void u32(uint32_t v) { u16(v & 0xFFFF); u16(v >> 16); }
  void f32(float v) { uint32_t bits; memcpy(&bits, &v, 4); u32(bits); }
  void zeros(size_t n) { memset(buf + len, 0, n); len += n; }
  // null-padded fixed-size C string (always leaves room for '\0')
  void str(const char *s, size_t size) {
    size_t n = strnlen(s, size - 1);
    memcpy(buf + len, s, n);
    memset(buf + len + n, 0, size - n);
    len += size;
  }
  // path_len + path[8]. The gateway is NOT appended: the backend
  // only accepts node IDs 1-254 and gateway is 0.
  void path(const Packet &p) {
    uint8_t n = p.path_len > BK_MAX_HOPS ? BK_MAX_HOPS : p.path_len;
    u8(n);
    for (uint8_t i = 0; i < BK_MAX_HOPS; i++) u8(i < n ? p.path[i] : 0);
  }
};

// Backend requires user_id >= 1. Nodes fill it in (see node/main.cpp); if it's
// missing (0), fall back to one derived from the msg_id.
static inline uint16_t bkUserId(const Packet &p) {
  if (p.user_id) return p.user_id;
  uint16_t id = p.msg_id & 0xFFFF;
  return id ? id : 1;
}

// Returns payload length (without the 2-byte frame header).
static inline size_t bkEncodeReport(const Packet &p, uint8_t *out) {
  BkWriter w{out, 0};
  w.u8(PKT_REPORT);
  w.u32(p.msg_id);
  w.u8(p.attempt);
  w.u8(p.origin);
  w.path(p);
  w.u16(bkUserId(p));
  w.u8(p.category);
  w.u8(0);            // severity: unknown (left empty; the dashboard AI decides it later)
  w.u8(p.people);
  w.u8(0);            // needs: none
  w.u8(p.has_gps ? 1 : 0);
  w.f32(p.has_gps ? p.lat : 0);
  w.f32(p.has_gps ? p.lon : 0);
  w.u16(p.has_gps ? p.accuracy_m : 0);
  w.str(p.name, BK_NAME_MAX);
  w.str("", BK_PHONE_MAX);
  w.str(p.location, BK_LOCATION_MAX);
  w.str(p.message, BK_REPORT_MSG_MAX);
  return w.len;
}

static inline size_t bkEncodeUserReply(const Packet &p, uint8_t *out) {
  BkWriter w{out, 0};
  w.u8(PKT_USER_REPLY);
  w.u32(p.msg_id);
  w.u8(p.attempt);
  w.u8(p.origin);
  w.path(p);
  w.u16(bkUserId(p));
  w.u32(p.ref_id);    // reply_to: the report this follows up on
  w.str(p.message, BK_REPLY_MSG_MAX);
  return w.len;
}

static inline size_t bkEncodeHeartbeat(const Packet &p, uint8_t *out) {
  BkWriter w{out, 0};
  w.u8(PKT_HEARTBEAT);
  w.u8(p.origin);     // node
  w.u8(BK_ROLE_ACCESS);
  w.u8(0);            // clients: not reported yet
  w.path(p);
  w.u32(0);           // uptime_s: not reported yet
  w.u16(0);           // tx
  w.u16(0);           // rx
  w.u8(BK_BATTERY_UNKNOWN);
  w.u8(0);            // neighbor_count
  return w.len;
}

// Downlink message from the backend -> mesh PKT_MESSAGE fields (target, user_id,
// ref_id, sender in location[], text in message[]). False if the frame is too short.
static inline bool bkDecodeMessage(const uint8_t *f, size_t len, Packet &p) {
  if (len < BK_MESSAGE_LEN || f[0] != PKT_MESSAGE) return false;
  p.target = f[1];
  p.user_id = f[2] | (f[3] << 8);
  p.ref_id = f[4] | (f[5] << 8) | (f[6] << 16) | ((uint32_t)f[7] << 24);
  size_t n = strnlen((const char *)f + 8, BK_SENDER_MAX);
  if (n >= SENDER_LEN) n = SENDER_LEN - 1;
  memcpy(p.location, f + 8, n);
  p.location[n] = '\0';
  n = strnlen((const char *)f + 8 + BK_SENDER_MAX, BK_REPLY_MSG_MAX);
  if (n >= MESSAGE_LEN) n = MESSAGE_LEN - 1;
  memcpy(p.message, f + 8 + BK_SENDER_MAX, n);
  p.message[n] = '\0';
  return true;
}

// Returns payload length, or 0 if this packet type isn't sent to the backend.
static inline size_t bkEncode(const Packet &p, uint8_t *out) {
  if (p.type == PKT_REPORT) return bkEncodeReport(p, out);
  if (p.type == PKT_USER_REPLY) return bkEncodeUserReply(p, out);
  if (p.type == PKT_HEARTBEAT) return bkEncodeHeartbeat(p, out);
  return 0;
}
