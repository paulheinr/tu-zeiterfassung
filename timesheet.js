// Läuft im Seitenkontext (MAIN world) der App „My Time Tracking“ (tub.ui5Timesheet).
// Nutzt Controller und OData-Modell der laufenden App, also denselben Weg wie
// der Button „Enter manually“.
(() => {
  "use strict";

  const VERSION = "1.0.1";
  if (window.__tuZeit && window.__tuZeit.version === VERSION) return;

  const VIEW_NAME = "tub.ui5Timesheet.view.Main";
  const SATZA_ARRIVE = "01";
  const SATZA_LEAVE = "02";
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

  async function plan(year, month, start, end) {
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
    const prev = period.ToPrevious;
    if (prev && !prev.EntrysExist && !prev.Approved) {
      const prevLabel = monthLabel(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
      return { ok: false, error: `Der Vormonat ist noch leer. Bitte zuerst ${prevLabel} ausfüllen.` };
    }

    const dayData = await read(model, periodPath + "/PeriodToDay", { $expand: "DayToEntry" });
    const holidays = berlinHolidays(year);
    const today = localIsoDate(new Date());

    const days = dayData.results
      .filter((d) => d.Sollz > 0)
      .map((d) => {
        const date = isoDate(d.Dats);
        const day = { date, action: "fill", note: "" };
        if (date > today) {
          day.action = "future";
        } else if (d.DayToEntry.results.length) {
          day.action = "existing";
        } else if (d.Awart) {
          day.action = "absence";
          day.note = d.Atext;
        } else if (date.endsWith("-12-24") || date.endsWith("-12-31")) {
          day.action = "manual";
          day.note = date.endsWith("-12-24") ? "Heiligabend" : "Silvester";
        } else if (holidays.has(date)) {
          day.action = "holiday";
          day.note = holidays.get(date);
          day.path = "/" + model.getKey(d);
        }
        return day;
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return { ok: true, label, days };
  }

  async function run(year, month, start, end) {
    if (state.running) return { ok: false, error: "Es wird bereits eingetragen." };

    const p = await plan(year, month, start, end);
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
    const todo = p.days.filter((d) => d.action === "fill" || d.action === "holiday");
    state = { running: true, done: 0, total: todo.length };

    try {
      for (const day of todo) {
        const [y, m, d] = day.date.split("-").map(Number);
        // Das Backend erlaubt nur eine Änderung pro Speichern, also jeden Eintrag
        // einzeln absenden (wie die App bei „Enter manually“).
        const steps =
          day.action === "fill"
            ? [
                () => ctrl.addEntry(SATZA_ARRIVE, new Date(y, m - 1, d, startH, startM)),
                () => ctrl.addEntry(SATZA_LEAVE, new Date(y, m - 1, d, endH, endM)),
              ]
            : [() => model.setProperty(day.path + "/Awart", AWART_PUBLIC_HOLIDAY)];
        for (let i = 0; i < steps.length; i++) {
          await steps[i]();
          try {
            await submit(model);
          } catch (err) {
            model.resetChanges();
            const when = new Date(y, m - 1, d).toLocaleDateString("de-DE");
            const partial = i > 0 ? " Achtung: Für diesen Tag wurde nur „Arrive“ gespeichert." : "";
            return { ok: false, done: state.done, error: `Fehler am ${when}: ${errorText(err)}${partial}` };
          }
        }
        state.done++;
      }
    } finally {
      state.running = false;
      model.refresh(true);
    }

    const message = `${p.label}: ${state.done} Tage eingetragen.`;
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
