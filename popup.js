"use strict";

const DEFAULTS = { start: "09:00", end: "17:23" };
const ACTION_TEXT = {
  fill: "wird eingetragen",
  holiday: "wird als Feiertag markiert",
  existing: "schon erfasst",
  absence: "ganztägiges Ereignis",
  manual: "bitte selbst eintragen",
  future: "in der Zukunft",
};

const $ = (id) => document.getElementById(id);
const today = new Date();
let year = today.getFullYear();
let month = today.getMonth() + 1;
let tabId = null;
let frameId = null;
let planRequest = 0;
let busy = false;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function setBusy(on) {
  busy = on;
  for (const id of ["prev", "next", "start", "end", "fill"]) $(id).disabled = on;
}

function formatDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

async function injectIntoTab() {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files: ["timesheet.js"] });
}

// Ruft window.__tuZeit[fn] in dem Frame auf, in dem die Zeiterfassung läuft
// (im tuPort ist das ein iFrame von p.sap.tu-berlin.de).
async function callPage(fn, ...args) {
  if (frameId === null) await injectIntoTab();
  const target = frameId === null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  const results = await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    args: [fn, args],
    func: async (name, fnArgs) => {
      if (!window.__tuZeit) return null;
      try {
        return await window.__tuZeit[name](...fnArgs);
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    },
  });
  const hit = results.find((r) => r.result !== null && r.result !== undefined);
  if (!hit) return null;
  frameId = hit.frameId;
  return hit.result;
}

function renderPlan(p) {
  const list = $("dayList");
  list.replaceChildren();
  $("details").hidden = true;
  $("fill").disabled = true;

  if (p === null) {
    setStatus("Keine Zeiterfassung gefunden.\nBitte im tuPort „My Time Tracking“ öffnen.");
    return;
  }
  if (!p.ok) {
    setStatus(p.error, true);
    return;
  }

  const count = (action) => p.days.filter((d) => d.action === action).length;
  const fill = count("fill");
  const holiday = count("holiday");
  const lines = [];
  if (fill) lines.push(`${fill} ${fill === 1 ? "Tag" : "Tage"} mit ${$("start").value}–${$("end").value} eintragen`);
  if (holiday) lines.push(`${holiday} ${holiday === 1 ? "Feiertag" : "Feiertage"} markieren`);
  if (!fill && !holiday) lines.push(`Für ${p.label} ist nichts mehr einzutragen.`);
  const skipped = ["existing", "absence", "future"]
    .filter((action) => count(action))
    .map((action) => `${count(action)} ${ACTION_TEXT[action]}`);
  if (skipped.length) lines.push(`Übersprungen: ${skipped.join(", ")}`);
  const manual = p.days.filter((d) => d.action === "manual");
  if (manual.length) lines.push(`${manual.map((d) => d.note).join(" und ")}: bitte selbst eintragen`);
  setStatus(lines.join("\n"));

  for (const d of p.days) {
    const li = document.createElement("li");
    li.textContent = `${formatDay(d.date)}  ${ACTION_TEXT[d.action]}${d.note ? ` (${d.note})` : ""}`;
    list.append(li);
  }
  $("details").hidden = p.days.length === 0;
  $("fill").disabled = fill + holiday === 0;
}

async function refreshPlan() {
  $("monthLabel").textContent = new Date(year, month - 1, 1).toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  });
  const request = ++planRequest;
  setStatus("Lade …");
  $("fill").disabled = true;
  let p;
  try {
    p = await callPage("plan", year, month, $("start").value, $("end").value);
  } catch (_) {
    p = null; // Seite ohne Zugriff, also kein TU-Tab
  }
  if (request === planRequest) renderPlan(p);
}

async function showProgress() {
  const s = await callPage("status").catch(() => null);
  if (busy && s && s.running) setStatus(`Trage ein … ${s.done} von ${s.total} Tagen`);
  return s;
}

async function fill() {
  setBusy(true);
  setStatus("Trage ein …");
  const poll = setInterval(showProgress, 500);
  let result;
  try {
    result = await callPage("run", year, month, $("start").value, $("end").value);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  clearInterval(poll);
  setBusy(false);
  if (result && result.ok) {
    setStatus(`✓ ${result.message}`);
    $("fill").disabled = true;
  } else {
    setStatus((result && result.error) || "Die Zeiterfassung wurde nicht gefunden.", true);
  }
}

// Falls das Popup während des Eintragens geschlossen und wieder geöffnet wurde.
async function waitForRunningJob() {
  setBusy(true);
  for (;;) {
    const s = await showProgress();
    if (!s || !s.running) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  setBusy(false);
  await refreshPlan();
}

function shiftMonth(delta) {
  if (busy) return;
  month += delta;
  if (month < 1) {
    month = 12;
    year--;
  } else if (month > 12) {
    month = 1;
    year++;
  }
  refreshPlan();
}

async function init() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  $("start").value = stored.start || DEFAULTS.start;
  $("end").value = stored.end || DEFAULTS.end;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  try {
    const s = await callPage("status");
    if (s && s.running) {
      await waitForRunningJob();
      return;
    }
  } catch (_) {
    // Kein TU-Tab: Die Erweiterung darf hier nichts ausführen.
  }
  await refreshPlan();
}

$("prev").addEventListener("click", () => shiftMonth(-1));
$("next").addEventListener("click", () => shiftMonth(1));
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") shiftMonth(-1);
  if (e.key === "ArrowRight") shiftMonth(1);
});
for (const id of ["start", "end"]) {
  $(id).addEventListener("change", () => {
    chrome.storage.local.set({ start: $("start").value, end: $("end").value });
    refreshPlan();
  });
}
$("fill").addEventListener("click", fill);

init();
