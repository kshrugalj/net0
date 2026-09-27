// Shared packet format for every net0 board.
// Any change to the over-the-air format happens HERE only (and tell Ishan).
#pragma once
#include <stdint.h>

#define NET0_MAGIC    0x4E30  // "N0" — anything else is dropped
#define NET0_VERSION  7       // v7: reports carry the sender name

// Packet types. Same numbers as the backend (portal-end/backend/packet_codec.py)
// so a type means the same thing on the mesh and over Bluetooth.
#define PKT_REPORT     1
#define PKT_USER_REPLY 2      // phone -> responders: follow-up text (retried until ACKed, like a report)
#define PKT_HEARTBEAT  3
#define PKT_ACK        4      // gateway -> origin node: "report ref_id was saved"
#define PKT_MESSAGE    5      // responders -> phone: text from the portal (gateway floods it)

#define TARGET_ALL    255     // message.target: every node
#define SENDER_LEN    32      // message sender name (backend SENDER_MAX), kept in location[]

#define GATEWAY_ID    0
#define DEFAULT_TTL   6
#define MAX_PATH      8
#define LOCATION_LEN  64
#define NAME_LEN      32      // reports: sender name (backend NAME_MAX)
#define MESSAGE_LEN   400

#define WIFI_CHANNEL  6       // AP and ESP-NOW must share one channel on every board
#define HEARTBEAT_MS  10000

// Report retries: resend until ACKed, waiting 3 s, 6 s, 12 s ... capped at 15 s.
#define RETRY_FIRST_MS 3000
#define RETRY_MAX_MS   15000
#define MAX_ATTEMPTS   255

// Messages have no ACK from the phone, so the gateway just floods each one a
// few times (same msg_id, attempt 0, 1, 2). Nodes keep only the first copy.
#define MESSAGE_SENDS    3
#define MESSAGE_RESEND_MS 1500

// ACKs are broadcast too, so one lost copy used to cost the node a full retry.
// The gateway now floods each ACK a few times, closer together than messages.
#define ACK_SENDS      3
#define ACK_RESEND_MS  400

// "packed" = no padding bytes between fields, so every board lays the bytes
// out identically and we can memcpy the struct straight onto the radio.
typedef struct __attribute__((packed)) {
  uint16_t magic;
  uint8_t  version;
  uint8_t  type;                  // PKT_* above
  uint32_t msg_id;                // random, never 0; same on every retry of a report
  uint8_t  attempt;               // 0 = first send, +1 per retry
  uint8_t  origin;                // node that created it
  uint8_t  last_hop;              // node that last transmitted it
  uint8_t  ttl;                   // hops left
  uint16_t user_id;               // report/user_reply: sender's user ID; message: recipient (0 = everyone)
  uint32_t ref_id;                // ack: msg_id acknowledged; user_reply/message: report msg_id it's about (0 = none)
  uint8_t  target;                // message: node that should show it (TARGET_ALL = every node)
  uint8_t  category;              // reports: backend Category (0 unknown, 1 medical, 2 trapped, 3 fire, 8 other)
  uint8_t  people;                // reports: people needing help (0 = unknown)
  uint8_t  has_gps;               // reports: 1 if lat/lon/accuracy_m are set
  float    lat;                   // degrees, from the phone's browser (HTTPS page only)
  float    lon;
  uint16_t accuracy_m;            // phone's estimate of how far off the fix may be
  uint8_t  path_len;
  uint8_t  path[MAX_PATH];        // node IDs visited, in order
  char     name[NAME_LEN];          // reports: name typed on the phone
  char     location[LOCATION_LEN];  // reports: typed location; message: sender name
  char     message[MESSAGE_LEN];    // report details / user_reply text / message text
} Packet;

// ESP-NOW v2 allows 1470 bytes per frame (v1 only 250).
static_assert(sizeof(Packet) <= 1470, "Packet too big for ESP-NOW v2");
