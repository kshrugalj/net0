// Node web side: the report form + chat with responders, served two ways.
//   - HTTP  on port 80:  works on every phone (captive portal popup), no GPS.
//   - HTTPS on port 443: browsers only share GPS with secure pages. Needs
//     data/cert.pem + data/key.pem (scripts/make_cert.sh) uploaded with uploadfs.
// Both servers share the same handlers. They run on their own FreeRTOS tasks.
#include "node.h"
#include "packet.h"

#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_http_server.h>
#include <esp_https_server.h>
#include <esp_netif.h>
#include <esp_wifi.h>
#include <lwip/sockets.h>

// Address in the HTTPS link. Must be in the certificate (make_cert.sh uses 192.168.4.1).
#ifndef HTTPS_HOST
#define HTTPS_HOST "192.168.4.1"
#endif

static httpd_handle_t httpServer = nullptr;
static httpd_handle_t httpsServer = nullptr;

// ---------- small helpers ----------

// Decodes a form value in place: "+" -> space, "%41" -> "A".
static void urlDecode(char *s) {
  char *out = s;
  for (; *s; s++) {
    if (*s == '+') {
      *out++ = ' ';
    } else if (*s == '%' && isxdigit((uint8_t)s[1]) && isxdigit((uint8_t)s[2])) {
      char hex[3] = {s[1], s[2], 0};
      *out++ = (char)strtol(hex, nullptr, 16);
      s += 2;
    } else {
      *out++ = *s;
    }
  }
  *out = '\0';
}

static void trim(char *s) {
  char *start = s;
  while (isspace((uint8_t)*start)) start++;
  memmove(s, start, strlen(start) + 1);
  size_t n = strlen(s);
  while (n && isspace((uint8_t)s[n - 1])) s[--n] = '\0';
}

// Reads `key` from a query string or form body into out (decoded). "" if missing.
// Too-long values are cut to fit. Not httpd_query_key_value(): in IDF 5.5 it copies
// NOTHING when the value doesn't fit, which silently dropped the phone's
// full-precision lat/lon ("-84.39628601074219" > 16 bytes).
static void getParam(const char *src, const char *key, char *out, size_t outLen) {
  out[0] = '\0';  // stays empty if the key is missing
  size_t keyLen = strlen(key);
  for (const char *p = src; *p;) {
    const char *end = strchr(p, '&');
    if (!end) end = p + strlen(p);
    if ((size_t)(end - p) > keyLen && p[keyLen] == '=' && !strncmp(p, key, keyLen)) {
      const char *val = p + keyLen + 1;
      size_t n = min((size_t)(end - val), outLen - 1);
      memcpy(out, val, n);
      out[n] = '\0';
      break;
    }
    p = *end ? end + 1 : end;
  }
  urlDecode(out);
}

static void getQuery(httpd_req_t *req, const char *key, char *out, size_t outLen) {
  out[0] = '\0';
  char query[64];
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) getParam(query, key, out, outLen);
}

// Reads the POST body into buf (NUL-terminated). False if it's too big or the upload broke.
static bool readBody(httpd_req_t *req, char *buf, size_t bufLen) {
  if (req->content_len >= bufLen) return false;
  size_t got = 0;
  while (got < req->content_len) {
    int r = httpd_req_recv(req, buf + got, req->content_len - got);
    if (r <= 0) return false;
    got += r;
  }
  buf[got] = '\0';
  return true;
}

// Appends s to out as a JSON string literal. Control characters become spaces.
static void jsonString(String &out, const char *s) {
  out += '"';
  for (; *s; s++) {
    if (*s == '"' || *s == '\\') out += '\\';
    out += (uint8_t)*s < 0x20 ? ' ' : *s;
  }
  out += '"';
}

static esp_err_t sendJson(httpd_req_t *req, const char *status, const char *json) {
  httpd_resp_set_status(req, status);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_sendstr(req, json);
}

// IPv4 address of the phone making this request.
static uint32_t clientIp(httpd_req_t *req) {
  struct sockaddr_storage addr;
  socklen_t len = sizeof(addr);
  if (getpeername(httpd_req_to_sockfd(req), (struct sockaddr *)&addr, &len) != 0) return 0;
  if (addr.ss_family == AF_INET) return ((struct sockaddr_in *)&addr)->sin_addr.s_addr;
  if (addr.ss_family == AF_INET6) {  // IPv4 shown as ::ffff:a.b.c.d
    uint32_t ip;
    memcpy(&ip, &((struct sockaddr_in6 *)&addr)->sin6_addr.s6_addr[12], 4);
    return ip;
  }
  return 0;
}

// ---------- user IDs ----------
// The page keeps its user ID in browser storage, which lasts while the Wi-Fi
// sign-in popup is open but is wiped the next time it opens. So the node also
// remembers "phone's Wi-Fi MAC -> user ID" in flash (NVS, survives reboots).
// A phone uses the same MAC every time it joins the same network name, so
// reconnecting to this node gets the same ID back. Another node has a different
// network name, so the phone shows up with a different MAC there -> new ID.
static Preferences userIds;  // NVS namespace "users"
static SemaphoreHandle_t userLock;

// MAC of the phone with this IP (from the AP's DHCP leases).
static bool clientMac(uint32_t ip, uint8_t mac[6]) {
  wifi_sta_list_t stations;
  if (esp_wifi_ap_get_sta_list(&stations) != ESP_OK) return false;

  esp_netif_pair_mac_ip_t pairs[sizeof(stations.sta) / sizeof(stations.sta[0])];
  for (int i = 0; i < stations.num; i++) memcpy(pairs[i].mac, stations.sta[i].mac, 6);
  if (esp_netif_dhcps_get_clients_by_mac(WiFi.AP.netif(), stations.num, pairs) != ESP_OK) return false;

  for (int i = 0; i < stations.num; i++) {
    if (pairs[i].ip.addr == ip) {
      memcpy(mac, pairs[i].mac, 6);
      return true;
    }
  }
  return false;
}

// Priority: the page's ID > the ID remembered for this MAC > a new random ID.
static uint16_t resolveUserId(httpd_req_t *req, uint16_t fromPage) {
  uint8_t mac[6];
  char key[13];  // MAC as hex = NVS key (max 15 chars)
  bool haveMac = clientMac(clientIp(req), mac);
  if (haveMac)
    snprintf(key, sizeof(key), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

  xSemaphoreTake(userLock, portMAX_DELAY);
  uint16_t remembered = haveMac && userIds.isKey(key) ? userIds.getUShort(key) : 0;
  uint16_t id = fromPage ? fromPage : remembered;
  if (!id) id = 1 + esp_random() % 65535;  // backend user_id is 1-65535
  if (haveMac && id != remembered) userIds.putUShort(key, id);
  xSemaphoreGive(userLock);
  return id;
}

static uint16_t parseUserId(const char *s) {
  long id = atol(s);
  return (id >= 1 && id <= 65535) ? id : 0;
}

// ---------- handlers ----------
static esp_err_t sendFile(httpd_req_t *req, const char *path, const char *type) {
  File f = LittleFS.open(path, "r");
  if (!f) {
    httpd_resp_set_status(req, "500 Internal Server Error");
    return httpd_resp_sendstr(req, "Web files missing. Run: pio run -e <board> -t uploadfs");
  }
  httpd_resp_set_type(req, type);
  char buf[1024];
  size_t n;
  while ((n = f.read((uint8_t *)buf, sizeof(buf))) > 0) {
    if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) break;
  }
  f.close();
  return httpd_resp_send_chunk(req, nullptr, 0);
}

static esp_err_t handleIndex(httpd_req_t *req) { return sendFile(req, "/index.html", "text/html"); }
static esp_err_t handleCss(httpd_req_t *req) { return sendFile(req, "/style.css", "text/css"); }
static esp_err_t handleJs(httpd_req_t *req) { return sendFile(req, "/app.js", "application/javascript"); }

// GET /whoami?id=<page's ID or 0> -> {"user_id":4821,"node":2,"https":"https://192.168.4.1/"}
static esp_err_t handleWhoami(httpd_req_t *req) {
  char idArg[8];
  getQuery(req, "id", idArg, sizeof(idArg));
  char json[96];
  snprintf(json, sizeof(json), "{\"user_id\":%u,\"node\":%d,\"https\":%s}", resolveUserId(req, parseUserId(idArg)),
           NODE_ID, httpsServer ? "\"https://" HTTPS_HOST "/\"" : "null");
  return sendJson(req, "200 OK", json);
}

// Backend Category numbers we accept (portal-end/backend/packets/serial_schema.py).
static bool validCategory(long c) {
  return c >= 0 && c <= 8;
}

// POST /send  (form fields: name, category, people, location, message, id, lat, lon, acc)
static esp_err_t handleSend(httpd_req_t *req) {
  char body[2048];
  if (!readBody(req, body, sizeof(body))) return sendJson(req, "400 Bad Request", "{\"error\":\"Report too long or upload failed\"}");

  char name[NAME_LEN * 3], location[LOCATION_LEN * 3], message[MESSAGE_LEN * 3], idArg[8], lat[16], lon[16], acc[8];
  char categoryArg[4], peopleArg[6];
  getParam(body, "category", categoryArg, sizeof(categoryArg));
  getParam(body, "people", peopleArg, sizeof(peopleArg));
  getParam(body, "name", name, sizeof(name));
  getParam(body, "location", location, sizeof(location));
  getParam(body, "message", message, sizeof(message));
  getParam(body, "id", idArg, sizeof(idArg));
  getParam(body, "lat", lat, sizeof(lat));
  getParam(body, "lon", lon, sizeof(lon));
  getParam(body, "acc", acc, sizeof(acc));
  trim(name);
  trim(location);
  trim(message);
  long category = atol(categoryArg);
  long people = atol(peopleArg);
  if (!validCategory(category)) category = 0;
  people = constrain(people, 0L, 255L);
  // An emergency type alone is a valid SOS; otherwise we need some text.
  if (!category && !message[0]) return sendJson(req, "400 Bad Request", "{\"error\":\"Pick an emergency type\"}");

  GpsFix gps = {};
  if (lat[0] && lon[0]) {
    gps.lat = atof(lat);
    gps.lon = atof(lon);
    gps.accuracy_m = min(atol(acc), 65535L);
    gps.valid = fabsf(gps.lat) <= 90 && fabsf(gps.lon) <= 180 && !(gps.lat == 0 && gps.lon == 0);
  }

  uint16_t userId = resolveUserId(req, parseUserId(idArg));
  uint32_t msgId = nodeSendReport({userId, (uint8_t)category, (uint8_t)people, name, location, message, gps});
  Serial.printf("[web] report %08X from user %u (%s), category %ld, %ld people, ", msgId, userId, name, category, people);
  if (gps.valid)
    Serial.printf("GPS %.6f, %.6f (+/-%u m)\n", gps.lat, gps.lon, gps.accuracy_m);
  else
    Serial.printf("no GPS (lat='%s' lon='%s')\n", lat, lon);

  char json[80];
  snprintf(json, sizeof(json), "{\"msg_id\":\"%08X\",\"user_id\":%u,\"gps\":%s}", msgId, userId,
           gps.valid ? "true" : "false");
  return sendJson(req, "200 OK", json);
}

// POST /reply  (form fields: id, reply_to = report msg_id in hex, text)
// A follow-up from the phone to responders (user_reply packet), retried until ACKed.
static esp_err_t handleReply(httpd_req_t *req) {
  char body[1536];
  if (!readBody(req, body, sizeof(body))) return sendJson(req, "400 Bad Request", "{\"error\":\"Message too long or upload failed\"}");

  char idArg[8], replyArg[12], text[MESSAGE_LEN * 3];
  getParam(body, "id", idArg, sizeof(idArg));
  getParam(body, "reply_to", replyArg, sizeof(replyArg));
  getParam(body, "text", text, sizeof(text));
  trim(text);
  if (!text[0]) return sendJson(req, "400 Bad Request", "{\"error\":\"Type a message first\"}");

  uint16_t userId = resolveUserId(req, parseUserId(idArg));
  uint32_t replyTo = strtoul(replyArg, nullptr, 16);
  uint32_t msgId = nodeSendReply(userId, replyTo, text);
  Serial.printf("[web] reply %08X from user %u about %08X: %s\n", msgId, userId, replyTo, text);

  char json[48];
  snprintf(json, sizeof(json), "{\"msg_id\":\"%08X\",\"user_id\":%u}", msgId, userId);
  return sendJson(req, "200 OK", json);
}

// GET /messages?id=4821&after=0 -> {"messages":[{"seq":1,"from":"responder","sender":"Portal",
//   "text":"Help is 10 min away","delivered":false,"msg_id":"1A2B3C4D"}, ...]}
// Lines for this user (and for everyone) newer than `after`, oldest first.
static esp_err_t handleMessages(httpd_req_t *req) {
  char idArg[8], afterArg[12];
  getQuery(req, "id", idArg, sizeof(idArg));
  getQuery(req, "after", afterArg, sizeof(afterArg));
  uint16_t userId = parseUserId(idArg);
  uint32_t seq = strtoul(afterArg, nullptr, 10);

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_sendstr_chunk(req, "{\"messages\":[");
  ChatEntry e;
  String line;
  bool first = true;
  while (userId && nodeNextChat(userId, seq, e)) {  // one line at a time: ChatEntry is ~450 B
    seq = e.seq;
    char head[96];
    snprintf(head, sizeof(head), "%s{\"seq\":%u,\"msg_id\":\"%08X\",\"from\":\"%s\",\"delivered\":%s,\"sender\":",
             first ? "" : ",", e.seq, e.msgId, e.fromUser ? "you" : "responder", e.delivered ? "true" : "false");
    line = head;
    jsonString(line, e.sender);
    line += ",\"text\":";
    jsonString(line, e.text);
    line += '}';
    if (httpd_resp_sendstr_chunk(req, line.c_str()) != ESP_OK) return ESP_FAIL;
    first = false;
  }
  httpd_resp_sendstr_chunk(req, "]}");
  return httpd_resp_sendstr_chunk(req, nullptr);
}

// GET /status?id=A83F29C1 -> {"delivered":true,"attempts":2}   (reports and replies)
static esp_err_t handleStatus(httpd_req_t *req) {
  char idArg[12];
  getQuery(req, "id", idArg, sizeof(idArg));
  bool delivered;
  uint8_t attempts;
  if (!nodeReportStatus(strtoul(idArg, nullptr, 16), delivered, attempts))
    return sendJson(req, "404 Not Found", "{\"error\":\"unknown report\"}");
  char json[48];
  snprintf(json, sizeof(json), "{\"delivered\":%s,\"attempts\":%u}", delivered ? "true" : "false", attempts);
  return sendJson(req, "200 OK", json);
}

// Captive portal: any unknown URL (incl. phone OS connectivity checks) goes to the form.
static esp_err_t redirectToForm(httpd_req_t *req, httpd_err_code_t) {
  httpd_resp_set_status(req, "302 Found");
  httpd_resp_set_hdr(req, "Location", httpd_get_global_user_ctx(req->handle) ? "https://" HTTPS_HOST "/" : "http://192.168.4.1/");
  return httpd_resp_send(req, nullptr, 0);
}

static void addRoutes(httpd_handle_t server) {
  const httpd_uri_t routes[] = {
      {"/", HTTP_GET, handleIndex, nullptr},
      {"/style.css", HTTP_GET, handleCss, nullptr},
      {"/app.js", HTTP_GET, handleJs, nullptr},
      {"/whoami", HTTP_GET, handleWhoami, nullptr},
      {"/send", HTTP_POST, handleSend, nullptr},
      {"/status", HTTP_GET, handleStatus, nullptr},
      {"/reply", HTTP_POST, handleReply, nullptr},
      {"/messages", HTTP_GET, handleMessages, nullptr},
  };
  for (const httpd_uri_t &r : routes) httpd_register_uri_handler(server, &r);
  httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, redirectToForm);
}

// ---------- startup ----------
// PEM files must be NUL-terminated and the length must include the NUL.
static uint8_t *loadPem(const char *path, size_t &len) {
  File f = LittleFS.open(path, "r");
  if (!f) return nullptr;
  len = f.size() + 1;
  uint8_t *buf = (uint8_t *)malloc(len);
  if (buf) {
    f.read(buf, len - 1);
    buf[len - 1] = '\0';
  }
  f.close();
  return buf;
}

static int secureMarker = 1;  // global_user_ctx != null marks the HTTPS server (for redirects)

void webBegin() {
  if (!LittleFS.begin(true)) Serial.println("[web] LittleFS mount failed");
  if (!LittleFS.exists("/index.html")) Serial.println("[web] WARNING: web files missing, run -t uploadfs");
  userIds.begin("users", false);
  userLock = xSemaphoreCreateMutex();

  // Plain HTTP on port 80 (captive portal + fallback without GPS).
  httpd_config_t http = HTTPD_DEFAULT_CONFIG();
  http.server_port = 80;
  http.ctrl_port = 32768;
  http.stack_size = 8192;
  http.max_uri_handlers = 12;
  http.lru_purge_enable = true;  // phones open many connections; drop idle ones
  if (httpd_start(&httpServer, &http) == ESP_OK) addRoutes(httpServer);
  else Serial.println("[web] HTTP server failed to start");

  // HTTPS on port 443, only if a certificate was uploaded.
  size_t certLen = 0, keyLen = 0;
  uint8_t *cert = loadPem("/cert.pem", certLen);
  uint8_t *key = loadPem("/key.pem", keyLen);
  if (!cert || !key) {
    Serial.println("[web] no cert.pem/key.pem: HTTPS (and GPS) off. Run scripts/make_cert.sh + uploadfs");
    free(cert);
    free(key);
  } else {
    httpd_ssl_config_t https = HTTPD_SSL_CONFIG_DEFAULT();
    https.servercert = cert;
    https.servercert_len = certLen;
    https.prvtkey_pem = key;
    https.prvtkey_len = keyLen;
    https.httpd.ctrl_port = 32769;  // each server needs its own control port
    https.httpd.stack_size = 12288;
    https.httpd.max_uri_handlers = 12;
    https.httpd.max_open_sockets = 3;  // each TLS connection uses ~25 KB of RAM
    https.httpd.lru_purge_enable = true;
    https.httpd.global_user_ctx = &secureMarker;
    if (httpd_ssl_start(&httpsServer, &https) == ESP_OK) {
      addRoutes(httpsServer);
      Serial.println("[web] HTTPS up at https://" HTTPS_HOST "/");
    } else {
      Serial.println("[web] HTTPS server failed to start (bad cert/key?)");
      httpsServer = nullptr;
    }
  }
  Serial.printf("[web] HTTP up at http://192.168.4.1/ (free heap %u)\n", ESP.getFreeHeap());
}
