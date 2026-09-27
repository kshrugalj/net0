// Interface between the mesh side (main.cpp) and the web side (web.cpp).
// The web servers run on their own FreeRTOS tasks, so these functions lock
// the shared state (pending reports, dedup buffer) before touching it.
#pragma once
#include <stdint.h>
#include "packet.h"

struct GpsFix {
  bool valid;
  float lat;
  float lon;
  uint16_t accuracy_m;
};

struct ReportInfo {
  uint16_t userId;
  uint8_t category;  // backend Category number, 0 = unknown
  uint8_t people;    // 0 = unknown
  const char *name;
  const char *location;
  const char *message;
  GpsFix gps;
};

// Floods a new report and keeps retrying it until ACKed. Returns its msg_id.
uint32_t nodeSendReport(const ReportInfo &r);

// Floods a follow-up from the phone (user_reply) about report replyTo (0 = none)
// and retries it until ACKed, like a report. Also added to the chat. Returns its msg_id.
uint32_t nodeSendReply(uint16_t userId, uint32_t replyTo, const char *text);

// Works for reports and replies. False if the msg_id is unknown (never sent
// here, or pushed out of the list).
bool nodeReportStatus(uint32_t msgId, bool &delivered, uint8_t &attempts);

// One line of a phone's conversation: a responder message or the phone's own reply.
struct ChatEntry {
  uint32_t seq;        // grows with every new line on this node (the page polls "after seq")
  uint32_t msgId;
  uint32_t replyTo;    // report msg_id it's about (0 = none / general alert)
  bool fromUser;       // true = the phone's reply, false = message from responders
  bool delivered;      // replies only: the gateway ACKed it
  char sender[SENDER_LEN];
  char text[MESSAGE_LEN];
};

// Copies the oldest line for userId (or for everyone) with seq > afterSeq. False if none.
bool nodeNextChat(uint16_t userId, uint32_t afterSeq, ChatEntry &out);

// Starts the HTTP (port 80) and, if a certificate is uploaded, HTTPS (443) servers.
void webBegin();
