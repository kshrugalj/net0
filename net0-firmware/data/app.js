// net0 SOS page.
// 1. Pick type + people, add location/details. 2. POST /send; the node floods and
// retries until the gateway ACKs, we poll /status. 3. Chat: poll /messages, reply via /reply.
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch (e) {} };

// Backend Category numbers (portal-end/backend/packets/serial_schema.py).
const CATEGORY = { medical: 1, trapped: 2, fire: 3, other: 8 };
const LABELS = { medical: "Medical", fire: "Fire", trapped: "Trapped", other: "Other" };
const state = { emergency: null, people: 1 };

// ---------- user ID ----------
// localStorage + cookie; the Wi-Fi sign-in popup wipes both, so the node also
// remembers this phone (by MAC) and /whoami hands back the same ID.
// ?id= carries it from the http:// page to the https:// one (separate storage).
let userId = (() => {
  let id = new URLSearchParams(location.search).get("id") || ls("net0_user_id");
  if (!id) { const m = document.cookie.match(/(?:^|; )net0_user_id=(\d+)/); if (m) id = m[1]; }
  id = parseInt(id, 10);
  return id >= 1 && id <= 65535 ? id : 0;
})();

function saveId(id) {
  userId = id;
  ls("net0_user_id", id);
  document.cookie = `net0_user_id=${id}; max-age=31536000; path=/`;
  $("user-id").textContent = id;
}

async function syncUserId() {
  try {
    const data = await (await fetch(`/whoami?id=${userId}`)).json();
    saveId(data.user_id);
    if (data.node) $("node-status").textContent = `Connected to local node ${data.node}`;
    return data;
  } catch (e) {
    saveId(userId || 1 + Math.floor(Math.random() * 65535));  // node unreachable
    return {};
  }
}

// ---------- GPS ----------
// Only https:// pages get location; on http:// we link to the node's https page.
// Sign-in popups can't ask for permission at all (the request never answers),
// so detect them and tell the user to open their real browser instead.
const gps = $("gps");
let fix = null;
const ua = navigator.userAgent;
const isIphone = /iPhone|iPad|iPod/.test(ua);
// iPhone popup has no "Safari/" in its UA; Android's popup is a WebView ("; wv)").
const inSignInPopup = (isIphone && !/Safari\//.test(ua)) || /; wv\)/.test(ua);

function showOpenBrowserHelp() {
  const steps = isIphone
    ? "tap Cancel (top right) → \"Use Without Internet\", then open Safari"
    : "close this window (stay connected), then open Chrome";
  gps.className = "gps";
  gps.textContent = `\u{1F4CD} GPS doesn't work in this sign-in window. To add it: ${steps} and go to ` +
    `https://192.168.4.1 (tap "Show details" → "visit this website" if warned). ` +
    `You can still send your SOS here without GPS.`;
}

function startGps() {
  if (!navigator.geolocation) {
    gps.textContent = "GPS not supported on this browser. Describe where you are.";
    return;
  }
  gps.textContent = "Getting GPS location... (allow location access)";
  let answered = false;
  navigator.geolocation.watchPosition(
    (pos) => {
      answered = true;
      fix = pos.coords;
      gps.textContent = `\u{1F4CD} GPS location found (within ${Math.round(fix.accuracy)} m)`;
      gps.className = "gps ok";
    },
    (err) => {
      answered = true;
      if (!fix) gps.textContent = err.code === err.PERMISSION_DENIED
        ? (isIphone
            ? "Location blocked. Turn on Settings → Privacy → Location Services → Safari Websites, then reload. Or describe where you are."
            : "Location blocked. Allow location for this site in the browser, then reload. Or describe where you are.")
        : "No GPS fix yet (try near a window). Describe where you are.";
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 }
  );
  // No prompt and no answer after 10 s: this browser can't do location.
  setTimeout(() => { if (!answered) showOpenBrowserHelp(); }, 10000);
}

syncUserId().then((info) => {
  pollChat();
  if (inSignInPopup && info.https) showOpenBrowserHelp();
  else if (window.isSecureContext) startGps();
  else if (info.https) {
    gps.textContent = "";
    const a = document.createElement("a");
    a.href = `${info.https}?id=${userId}`;
    a.textContent = "\u{1F4CD} Share my GPS location (opens secure page)";
    gps.appendChild(a);
  } else gps.textContent = "GPS not available on this node. Describe where you are.";
});

// ---------- request screen ----------
const opts = [...document.querySelectorAll(".opt")];
const details = $("details");
const showMsg = (id, text) => { $(id).textContent = text; $(id).classList.toggle("on", !!text); };
const counter = (input, id) => input.addEventListener("input", () => { $(id).textContent = input.value.length; });

function selectEmergency(type) {
  state.emergency = type;
  opts.forEach((b) => {
    const on = b.dataset.emergency === type;
    b.classList.toggle("sel", on);
    b.setAttribute("aria-pressed", on);
  });
  // "Other" needs a description; for the rest details are a bonus.
  $("details-label").textContent = type === "other" ? "Describe the issue" : "Details (optional)";
  if (type === "other") details.focus();
  $("emergency-selection").classList.remove("bad");
  showMsg("emergency-message", "");
}

function changePeople(d) {
  state.people = Math.min(255, Math.max(1, state.people + d));
  $("people-count").textContent = state.people;
}

opts.forEach((b) => b.addEventListener("click", () => selectEmergency(b.dataset.emergency)));
$("decrement-people").addEventListener("click", () => changePeople(-1));
$("increment-people").addEventListener("click", () => changePeople(1));
counter(details, "details-count");

// ---------- sending ----------
let pollingFor = null;  // msg_id we're waiting on

function setDeliveryStatus(text, ok) {
  $("delivery-status").textContent = text;
  $("delivery-status").className = ok ? "st" : "st waiting";
  $("confirmation-mark").textContent = ok ? "✓" : "…";
  $("confirmation-mark").className = ok ? "mark" : "mark pending";
  $("confirmation-header").textContent = ok ? "SOS DELIVERED" : "SOS SENT";
  $("confirmation-text").textContent = ok
    ? "Responders have received your emergency request."
    : "Your request is on its way through the local emergency network.";
}

// The node keeps resending until the gateway ACKs, even if this page closes.
async function waitForDelivery(msgId) {
  pollingFor = msgId;
  for (let i = 0; i < 60 && pollingFor === msgId; i++) {  // ~2 minutes
    await sleep(2000);
    try {
      const data = await (await fetch(`/status?id=${msgId}`)).json();
      if (pollingFor !== msgId) return;
      if (data.delivered) return setDeliveryStatus("Delivered to responders.", true);
      setDeliveryStatus(`Transmitting through the local emergency network... (attempt ${data.attempts})`, false);
    } catch (e) {}  // lost Wi-Fi for a moment; keep trying
  }
  if (pollingFor === msgId)
    setDeliveryStatus("Not confirmed yet. The node will keep retrying on its own, even if you close this page.", false);
}

function setRow(id, text) {
  $(`confirmation-${id}-row`).hidden = !text;
  $(`confirmation-${id}`).textContent = text;
}

function showConfirmation(msgId, sentWithGps) {
  $("confirmation-emergency").textContent = LABELS[state.emergency];
  $("confirmation-people").textContent = state.people;
  setRow("location", [$("location").value.trim(), sentWithGps ? "GPS location shared" : ""].filter(Boolean).join(" · "));
  setRow("issue", details.value.trim());
  setReportId(msgId);
  setDeliveryStatus("Transmitting through the local emergency network...", false);
  showScreen(true);
}

function showScreen(confirming) {
  $("request-screen").classList.toggle("active", !confirming);
  $("confirmation-screen").classList.toggle("active", confirming);
  $("new-report-block").hidden = !confirming;
  updateChatVisibility();
  scrollTo(0, 0);
}

// POST a form; throws with the node's error text on failure. Button shows SENDING... meanwhile.
async function post(url, body, button, errId) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "SENDING...";
  showMsg(errId, "");
  try {
    const res = await fetch(url, { method: "POST", body: new URLSearchParams(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Send failed");
    saveId(data.user_id);
    return data;
  } catch (err) {
    showMsg(errId, `Could not send: ${err.message}. Try again.`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// Remembered so the next report (or a reload) doesn't ask again.
const civilianName = $("civilian-name");
civilianName.value = ls("net0_name") || "";
civilianName.addEventListener("input", () => civilianName.setCustomValidity(""));

$("send-sos").addEventListener("click", async () => {
  civilianName.setCustomValidity(civilianName.value.trim() ? "" : "Please enter your name.");
  if (!civilianName.reportValidity()) return;
  if (!state.emergency) {
    $("emergency-selection").classList.add("bad");
    return showMsg("emergency-message", "Please select an emergency type first.");
  }
  if (state.emergency === "other" && !details.value.trim()) {
    showMsg("emergency-message", "Please describe the issue.");
    return details.focus();
  }
  ls("net0_name", civilianName.value.trim());
  const body = {
    id: userId,
    name: civilianName.value.trim(),
    category: CATEGORY[state.emergency],
    people: state.people,
    location: $("location").value.trim(),
    message: details.value.trim(),
  };
  if (fix) Object.assign(body, { lat: fix.latitude, lon: fix.longitude, acc: Math.round(fix.accuracy) });
  const data = await post("/send", body, $("send-sos"), "emergency-message");
  if (data) {
    showConfirmation(data.msg_id, data.gps);
    waitForDelivery(data.msg_id);
  }
});

// Back to the form, keeping type/people/location; small updates go through chat.
$("send-update").addEventListener("click", () => {
  pollingFor = null;
  details.value = "";
  $("details-count").textContent = "0";
  showScreen(false);
});

// ---------- messages with responders ----------
// The node keeps the last 16 lines per node; we poll /messages for our user ID
// and redraw. Replies are about our latest report (reply_to).
let reportId = ls("net0_report_id") || "";  // hex msg_id of our latest SOS
let chatLines = [];
const shownSeqs = new Set();
let firstChatLoad = true;

function setReportId(id) {
  reportId = id;
  $("report-id").textContent = id;
  ls("net0_report_id", id);
}
if (reportId) $("report-id").textContent = reportId;

function updateChatVisibility() {
  // Always on the confirmation screen; on the form only once there's something to read.
  $("chat").hidden = !($("confirmation-screen").classList.contains("active") || chatLines.length);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function renderChat() {
  const log = $("chat-log");
  log.querySelectorAll(".bub").forEach((b) => b.remove());
  $("chat-empty").hidden = chatLines.length > 0;
  let gotNew = false;
  for (const m of chatLines) {
    const mine = m.from === "you";
    const b = el("div", mine ? "bub out" : "bub in");
    b.append(el("span", "who", mine ? "You" : m.sender || "Responders"), m.text);
    if (mine) b.append(el("span", m.delivered ? "bs ok" : "bs", m.delivered ? "✓ Delivered to responders" : "Sending through the network..."));
    else if (!shownSeqs.has(m.seq) && !firstChatLoad) { b.classList.add("new"); gotNew = true; }
    shownSeqs.add(m.seq);
    log.appendChild(b);
  }
  firstChatLoad = false;
  updateChatVisibility();
  if (gotNew) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    $("chat").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

let chatBusy = false;
async function pollChat() {
  if (!userId || chatBusy) return;
  chatBusy = true;
  try {
    // after=0: fetch the whole (small) log so "Delivered" ticks update too.
    chatLines = (await (await fetch(`/messages?id=${userId}&after=0`)).json()).messages || [];
    renderChat();
  } catch (e) {}  // lost Wi-Fi for a moment; try next time
  chatBusy = false;
}
setInterval(pollChat, 3000);

const chatText = $("chat-text");
counter(chatText, "chat-count");

$("chat-send").addEventListener("click", async () => {
  const text = chatText.value.trim();
  if (!text) {
    showMsg("chat-error", "Type a message first.");
    return chatText.focus();
  }
  if (await post("/reply", { id: userId, reply_to: reportId || "0", text }, $("chat-send"), "chat-error")) {
    chatText.value = "";
    $("chat-count").textContent = "0";
    await pollChat();
  }
});
