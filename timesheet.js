// Läuft im Seitenkontext (MAIN world) der App „My Time Tracking“ (tub.ui5Timesheet).
// Nutzt Controller und OData-Modell der laufenden App, also denselben Weg wie
// der Button „Enter manually“.
(() => {
  "use strict";

  const VERSION = "1.1.0";
  if (window.__tuZeit && window.__tuZeit.version === VERSION) return;

  const VIEW_NAME = "tub.ui5Timesheet.view.Main";
  const SATZA_ARRIVE = "01";
  const SATZA_LEAVE = "02";
  const AWART_VACATION = "0200"; // ganztägig, ohne Auswirkung auf den Saldo (Urlaub/Krankheit)
  const AWART_PUBLIC_HOLIDAY = "0500";
  const DAY_MS = 864e5;

  let state = { running: false, done: 0, total: 0 };

  const pad2 = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => d.toISOString().slice(0, 10);
  const localIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function monthLabel(year, month) {
    return new Date(year, month - 1, 1).toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  }

  function parseTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value || "");
    if (!m) return null;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    return minutes < 24 * 60 ? minutes : null;
  }

  function findController() {
    const core = window.sap && window.sap.ui && window.sap.ui.core;
    if (!core || !core.Element || !core.Element.registry) return null;
    const view = core.Element.registry.filter(
      (el) => el.isA && el.isA("sap.ui.core.mvc.View") && el.getViewName() === VIEW_NAME
    )[0];
    return view ? view.getController() : null;
  }

  // Ostersonntag nach der anonymen gregorianischen Osterformel (Meeus/Jones/Butcher).
  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
  }

  function berlinHolidays(year) {
    const easter = easterSunday(year).getTime();
    const fromEaster = (days) => isoDate(new Date(easter + days * DAY_MS));
    return new Map([
      [`${year}-01-01`, "Neujahr"],
      [`${year}-03-08`, "Internationaler Frauentag"],
      [fromEaster(-2), "Karfreitag"],
      [fromEaster(1), "Ostermontag"],
      [`${year}-05-01`, "Tag der Arbeit"],
      [fromEaster(39), "Christi Himmelfahrt"],
      [fromEaster(50), "Pfingstmontag"],
      [`${year}-10-03`, "Tag der Deutschen Einheit"],
      [`${year}-12-25`, "1. Weihnachtsfeiertag"],
      [`${year}-12-26`, "2. Weihnachtsfeiertag"],
    ]);
  }

  function read(model, path, urlParameters) {
    return new Promise((resolve, reject) =>
      model.read(path, { urlParameters: urlParameters || {}, success: resolve, error: reject })
    );
  }

  function errorText(err) {
    const body = err && (err.responseText || (err.response && err.response.body));
    if (body) {
      try {
        return JSON.parse(body).error.message.value;
      } catch (_) {
        const m = /<message[^>]*>([^<]*)<\/message>/.exec(body);
        if (m) return m[1];
      }
    }
    return (err && (err.message || err.statusText)) || "Unbekannter Fehler";
  }

  // Wie save() der App: Fehler stecken als 4xx/5xx in __batchResponses.
  function submit(model) {
    return new Promise((resolve, reject) =>
      model.submitChanges({
        success: (data) => {
          const failed = (data.__batchResponses || []).filter(
            (r) => r.response && /^[45]/.test(String(r.response.statusCode))
          );
          if (failed.length) reject(failed[0]);
          else resolve();
        },
        error: reject,
      })
    );
  }

  // Löscht einen Eintrag sofort, wie deleteEntry() der App.
  function removeEntity(model, path) {
    return new Promise((resolve, reject) => model.remove(path, { success: () => resolve(), error: reject }));
  }

  const timeOf = (d) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  // marks: { vacation: [ISO-Datum], delete: [ISO-Datum] } aus dem Kalender im Popup.
  async function plan(year, month, start, end, marks = {}) {
    const ctrl = findController();
    if (!ctrl) return null;

    const label = monthLabel(year, month);
    const startMin = parseTime(start);
    const endMin = parseTime(end);
    if (startMin === null || endMin === null) {
      return { ok: false, error: "Bitte Beginn und Ende als Uhrzeit angeben." };
    }
    if (endMin <= startMin) {
      return { ok: false, error: "Das Ende muss nach dem Beginn liegen." };
    }

    const model = ctrl.getGlobalModel();
    const pernr = await ctrl.getPernr();
    const orgeh = await ctrl.getSelectedOrgeh();
    const periodPath =
      "/" + model.createKey("PeriodSet", { Pernr: pernr, Orgeh: orgeh, Pabrj: String(year), Pabrp: pad2(month) });

    let period;
    try {
      period = await read(model, periodPath, { $expand: "ToPrevious" });
    } catch (err) {
      return { ok: false, error: `Für ${label} gibt es keine Zeiterfassung (${errorText(err)}).` };
    }
    if (period.Approved) {
      return { ok: false, error: `${label} ist bereits abgeschlossen.` };
    }
    // Wie in der App: Neue Einträge erst, wenn der Vormonat Einträge hat oder
    // abgeschlossen ist. Löschen bleibt möglich.
    const prev = period.ToPrevious;
    let warning = "";
    if (prev && !prev.EntrysExist && !prev.Approved) {
      const prevLabel = monthLabel(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
      warning = `Der Vormonat ist noch leer. Bitte zuerst ${prevLabel} ausfüllen.`;
    }

    const dayData = await read(model, periodPath + "/PeriodToDay", { $expand: "DayToEntry" });
    const holidays = berlinHolidays(year);
    const today = localIsoDate(new Date());
    const vacation = new Set(marks.vacation || []);
    const remove = new Set(marks.delete || []);

    const days = dayData.results
      .filter((d) => d.Sollz > 0 || d.DayToEntry.results.length || d.Awart)
      .map((d) => {
        const date = isoDate(d.Dats);
        const entries = d.DayToEntry.results.slice().sort((a, b) => a.Timestamp - b.Timestamp);
        const day = { date, action: "fill", note: "", path: "/" + model.getKey(d) };
        if (entries.length || d.Awart) {
          day.action = remove.has(date) ? "delete" : "existing";
          day.note = [entries.map((e) => timeOf(e.Timestamp)).join("–"), d.Atext].filter(Boolean).join(", ");
          day.entryPaths = entries.map((e) => "/" + model.getKey(e));
          day.hasAwart = Boolean(d.Awart);
        } else if (date > today) {
          day.action = "future";
        } else if (warning) {
          day.action = "blocked";
        } else if (date.endsWith("-12-24") || date.endsWith("-12-31")) {
          day.action = "manual";
          day.note = date.endsWith("-12-24") ? "Heiligabend" : "Silvester";
        } else if (holidays.has(date)) {
          day.action = "holiday";
          day.note = holidays.get(date);
        } else if (vacation.has(date)) {
          day.action = "vacation";
        }
        return day;
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return { ok: true, label, warning, days };
  }

  async function run(year, month, start, end, marks = {}) {
    if (state.running) return { ok: false, error: "Es wird bereits eingetragen." };

    const p = await plan(year, month, start, end, marks);
    if (!p || !p.ok) return p;

    const ctrl = findController();
    const model = ctrl.getGlobalModel();
    if (model.hasPendingChanges()) {
      return {
        ok: false,
        error: "In der Zeiterfassung gibt es ungespeicherte Änderungen. Bitte erst speichern oder verwerfen.",
      };
    }

    const [startH, startM] = start.split(":").map(Number);
    const [endH, endM] = end.split(":").map(Number);
    const setAwart = (day, awart) => async () => {
      model.setProperty(day.path + "/Awart", awart);
      if (!awart) model.setProperty(day.path + "/Reason", "");
      await submit(model);
    };
    // Das Backend erlaubt nur eine Änderung pro Speichern, also jede Änderung
    // einzeln absenden (wie die App).
    const stepsFor = (day, y, m, d) => {
      switch (day.action) {
        case "fill":
          return [
            async () => {
              await ctrl.addEntry(SATZA_ARRIVE, new Date(y, m - 1, d, startH, startM));
              await submit(model);
            },
            async () => {
              await ctrl.addEntry(SATZA_LEAVE, new Date(y, m - 1, d, endH, endM));
              await submit(model);
            },
          ];
        case "holiday":
          return [setAwart(day, AWART_PUBLIC_HOLIDAY)];
        case "vacation":
          return [setAwart(day, AWART_VACATION)];
        case "delete":
          return [
            ...day.entryPaths.map((path) => () => removeEntity(model, path)),
            ...(day.hasAwart ? [setAwart(day, "")] : []),
          ];
        default:
          return [];
      }
    };

    const todo = p.days.filter((d) => stepsFor(d).length);
    const counts = { written: 0, deleted: 0 };
    state = { running: true, done: 0, total: todo.length };

    try {
      for (const day of todo) {
        const [y, m, d] = day.date.split("-").map(Number);
        const steps = stepsFor(day, y, m, d);
        for (let i = 0; i < steps.length; i++) {
          try {
            await steps[i]();
          } catch (err) {
            model.resetChanges();
            const when = new Date(y, m - 1, d).toLocaleDateString("de-DE");
            const partial = i > 0 ? " Achtung: Dieser Tag wurde nur teilweise geändert." : "";
            return { ok: false, done: state.done, error: `Fehler am ${when}: ${errorText(err)}${partial}` };
          }
        }
        if (day.action === "delete") counts.deleted++;
        else counts.written++;
        state.done++;
      }
    } finally {
      state.running = false;
      model.refresh(true);
    }

    const parts = [];
    if (counts.written) parts.push(`${counts.written} ${counts.written === 1 ? "Tag" : "Tage"} eingetragen`);
    if (counts.deleted) parts.push(`${counts.deleted} ${counts.deleted === 1 ? "Tag" : "Tage"} gelöscht`);
    const message = `${p.label}: ${parts.join(", ") || "nichts geändert"}.`;
    if (window.sap.m && window.sap.m.MessageToast) window.sap.m.MessageToast.show(message);
    return { ok: true, done: state.done, message };
  }

  window.__tuZeit = {
    version: VERSION,
    plan,
    run,
    status: () => (findController() ? { ...state } : null),
    berlinHolidays: (year) => Object.fromEntries(berlinHolidays(year)),
  };
})();
