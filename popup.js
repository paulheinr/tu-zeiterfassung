"use strict";

const DEFAULTS = { start: "09:00", end: "17:23" };
const STATUS_TEXT = {
  fill: "wird eingetragen",
  vacation: "Urlaub/Krank",
  holiday: "wird als Feiertag markiert",
  existing: "schon erfasst",
  delete: "wird gelöscht",
  manual: "bitte selbst eintragen",
  future: "in der Zukunft",
  blocked: "Vormonat noch leer",
  off: "kein Arbeitstag",
};

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const today = new Date();
let year = today.getFullYear();
let month = today.getMonth() + 1;
let tabId = null;
let frameId = null;
let planRequest = 0;
let busy = false;

let basePlan = null; // Ergebnis von plan() ohne Markierungen
let vacation = new Set(); // markierte Urlaubstage (wird pro Monat gespeichert)
let toDelete = new Set(); // zum Löschen markierte Tage (bewusst nicht gespeichert)
let paint = null; // { kind, on, anchor, before } während mit gedrückter Maus gezogen wird
let notice = null; // { text, error } Ergebnis des letzten Durchlaufs
let confirmTimer = null;

const vacationKey = () => `vacation:${year}-${pad2(month)}`;

function saveVacation() {
  if (vacation.size) chrome.storage.local.set({ [vacationKey()]: [...vacation] });
  else chrome.storage.local.remove(vacationKey());
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function setBusy(on) {
  busy = on;
  for (const id of ["prev", "next", "start", "end", "fill"]) $(id).disabled = on;
  $("calendar").classList.toggle("loading", on);
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

// Aktion eines Tages inklusive der Markierungen im Kalender.
function actionOf(day) {
  if (day.action === "fill" && vacation.has(day.date)) return "vacation";
  if (day.action === "existing" && toDelete.has(day.date)) return "delete";
  return day.action;
}

// Welche Markierung ein Klick auf diesen Tag setzt.
function markKind(day) {
  if (day.action === "fill") return "vacation";
  if (day.action === "existing") return "delete";
  return null;
}

function updateCell(cell, day) {
  const action = actionOf(day);
  cell.className = `day ${action}`;
  cell.title = `${formatDay(day.date)}: ${STATUS_TEXT[action]}${day.note ? ` (${day.note})` : ""}`;
  cell.setAttribute("aria-pressed", String(action === "vacation" || action === "delete"));
}

function renderCalendar() {
  const grid = $("calendar");
  grid.replaceChildren();
  for (const wd of ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]) {
    const head = document.createElement("span");
    head.className = "wd";
    head.textContent = wd;
    grid.append(head);
  }
  const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) grid.append(document.createElement("span"));

  const byDate = new Map(basePlan.days.map((d) => [d.date, d]));
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let n = 1; n <= daysInMonth; n++) {
    const date = `${year}-${pad2(month)}-${pad2(n)}`;
    const day = byDate.get(date) || { date, action: "off", note: "" };
    const cell = document.createElement(markKind(day) ? "button" : "span");
    cell.textContent = n;
    if (markKind(day)) {
      cell.type = "button";
      cell.dataset.date = date;
      updateCell(cell, day);
    } else {
      cell.className = `day ${day.action}`;
      cell.title = `${formatDay(date)}: ${STATUS_TEXT[day.action]}${day.note ? ` (${day.note})` : ""}`;
    }
    grid.append(cell);
  }
}

function disarmConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  $("fill").classList.remove("confirm");
}

function renderSummary() {
  disarmConfirm();
  const actions = basePlan.days.map(actionOf);
  const count = (action) => actions.filter((a) => a === action).length;
  const fill = count("fill");
  const vac = count("vacation");
  const holiday = count("holiday");
  const del = count("delete");

  const lines = [];
  if (notice) lines.push(notice.text);
  if (basePlan.warning) lines.push(basePlan.warning);
  if (fill) lines.push(`${plural(fill, "Tag", "Tage")} mit ${$("start").value}–${$("end").value} eintragen`);
  if (vac) lines.push(`${plural(vac, "Tag", "Tage")} Urlaub/Krank eintragen`);
  if (holiday) lines.push(`${plural(holiday, "Feiertag", "Feiertage")} markieren`);
  if (del) lines.push(`${plural(del, "Tag", "Tage")} löschen`);
  if (!fill && !vac && !holiday && !del && !notice && !basePlan.warning) {
    lines.push(`Für ${basePlan.label} ist nichts mehr einzutragen.`);
  }
  const manual = basePlan.days.filter((d) => d.action === "manual");
  if (manual.length) lines.push(`${manual.map((d) => d.note).join(" und ")}: bitte selbst eintragen`);
  setStatus(lines.join("\n"), Boolean((notice && notice.error) || basePlan.warning));

  const write = fill + vac + holiday;
  $("fill").textContent = !del ? "Eintragen" : write ? "Eintragen und löschen" : `${plural(del, "Tag", "Tage")} löschen`;
  $("fill").disabled = busy || write + del === 0;
}

function renderPlan(p) {
  basePlan = null;
  $("calendarBox").hidden = true;
  $("fill").disabled = true;
  disarmConfirm();

  if (p === null) {
    setStatus("Keine Zeiterfassung gefunden.\nBitte im tuPort „My Time Tracking“ öffnen.");
    return;
  }
  if (!p.ok) {
    setStatus(p.error, true);
    return;
  }
  basePlan = p;
  renderCalendar();
  $("calendarBox").hidden = false;
  renderSummary();
}

async function refreshPlan() {
  $("monthLabel").textContent = new Date(year, month - 1, 1).toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  });
  const request = ++planRequest;
  const key = vacationKey();
  setStatus("Lade …");
  $("fill").disabled = true;
  $("calendar").classList.add("loading");
  const [stored, p] = await Promise.all([
    chrome.storage.local.get({ [key]: [] }),
    callPage("plan", year, month, $("start").value, $("end").value).catch(() => null), // kein TU-Tab
  ]);
  if (request !== planRequest) return;
  $("calendar").classList.remove("loading");
  vacation = new Set(stored[key]);
  toDelete = new Set();
  renderPlan(p);
}

// Kalender: Klicken oder Ziehen setzt bzw. entfernt Markierungen.
function setMark(cell, kind, on) {
  const day = basePlan && basePlan.days.find((d) => d.date === cell.dataset.date);
  if (!day || markKind(day) !== kind) return;
  const set = kind === "vacation" ? vacation : toDelete;
  if (on) set.add(day.date);
  else set.delete(day.date);
  updateCell(cell, day);
  renderSummary();
}

function startMark(cell) {
  const day = basePlan && basePlan.days.find((d) => d.date === cell.dataset.date);
  if (!day || busy) return;
  const kind = markKind(day);
  const set = kind === "vacation" ? vacation : toDelete;
  const before = new Set(set);
  const on = !set.has(day.date);
  setMark(cell, kind, on);
  return { kind, on, anchor: day.date, before };
}

// Beim Ziehen genau die Tage zwischen Start- und aktuellem Tag markieren, alle
// anderen behalten ihren Zustand vom Beginn des Ziehens. Einzelne Zellen
// abzuhaken reicht nicht, weil der Browser bei schnellen Bewegungen Zellen überspringt.
function paintRange(cell) {
  const [from, to] = [paint.anchor, cell.dataset.date].sort();
  for (const c of $("calendar").querySelectorAll("button.day")) {
    const date = c.dataset.date;
    setMark(c, paint.kind, date >= from && date <= to ? paint.on : paint.before.has(date));
  }
}

$("calendar").addEventListener("pointerdown", (e) => {
  const cell = e.target.closest("button.day");
  if (!cell || e.button !== 0) return;
  e.preventDefault();
  paint = startMark(cell) || null;
});
$("calendar").addEventListener("pointerover", (e) => {
  const cell = paint && e.target.closest("button.day");
  if (cell) paintRange(cell);
});
document.addEventListener("pointerup", () => {
  if (paint && paint.kind === "vacation") saveVacation();
  paint = null;
});
$("calendar").addEventListener("click", (e) => {
  // Nur Tastatur (Enter/Leertaste); Mausklicks laufen über pointerdown.
  const cell = e.target.closest("button.day");
  if (!cell || e.detail !== 0) return;
  const mark = startMark(cell);
  if (mark && mark.kind === "vacation") saveVacation();
});

async function showProgress() {
  const s = await callPage("status").catch(() => null);
  if (busy && s && s.running) setStatus(`Bitte warten … ${s.done} von ${s.total} Tagen`);
  return s;
}

async function execute() {
  // Löschen erst nach einem zweiten Klick ausführen.
  if (toDelete.size && !confirmTimer) {
    $("fill").textContent = `Wirklich ${plural(toDelete.size, "Tag", "Tage")} löschen?`;
    $("fill").classList.add("confirm");
    confirmTimer = setTimeout(renderSummary, 4000);
    return;
  }
  disarmConfirm();
  setBusy(true);
  $("fill").textContent = "Läuft …";
  setStatus("Bitte warten …");
  const poll = setInterval(showProgress, 500);
  let result;
  try {
    const marks = { vacation: [...vacation], delete: [...toDelete] };
    result = await callPage("run", year, month, $("start").value, $("end").value, marks);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  clearInterval(poll);
  if (result && result.ok) {
    vacation.clear();
    saveVacation();
    notice = { text: `✓ ${result.message}`, error: false };
  } else {
    notice = { text: (result && result.error) || "Die Zeiterfassung wurde nicht gefunden.", error: true };
  }
  setBusy(false);
  await refreshPlan();
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
  notice = null;
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
    notice = null;
    refreshPlan();
  });
}
$("fill").addEventListener("click", execute);

init();
