# TU Zeiterfassung – Monat ausfüllen

Eine kleine Browser-Erweiterung für Brave, Chrome und Edge. Sie trägt in „My Time Tracking“ der TU Berlin für alle Arbeitstage eines Monats Kommen und Gehen ein. Von Hand müsste man dafür an jedem Tag „Enter manually“ benutzen.

## Installation

1. Den Ordner `tu-zeiterfassung` an einen festen Ort legen, zum Beispiel in den Home-Ordner. Der Browser lädt die Erweiterung immer von dort; der Ordner darf also nicht gelöscht werden.
2. `brave://extensions` öffnen (in Chrome: `chrome://extensions`).
3. Oben rechts den **Entwicklermodus** einschalten.
4. Auf **Entpackte Erweiterung laden** klicken und den Ordner `tu-zeiterfassung` auswählen.
5. Optional die Erweiterung über das Puzzle-Symbol in der Symbolleiste anheften.

## Bedienung

1. Im tuPort **My Time Tracking** öffnen.
2. Auf das rote Uhr-Symbol der Erweiterung klicken.
3. Mit ‹ › oder den Pfeiltasten ← → den Monat wählen und Beginn und Ende einstellen. Standard ist 09:00–17:23; geänderte Zeiten merkt sich die Erweiterung.
4. Im Kalender bei Bedarf Tage markieren:
   - **Urlaub:** einen leeren Arbeitstag anklicken (blau). Mit gedrückter Maus über mehrere Tage ziehen markiert einen ganzen Block. Die Markierungen bleiben erhalten, wenn sich das Popup schließt.
   - **Löschen:** einen schon erfassten Tag (grün) anklicken. Er wird rot durchgestrichen. Gelöscht werden dann alle Zeiteinträge und das ganztägige Ereignis dieses Tages.
   - Ein zweiter Klick nimmt die Markierung wieder weg. Fährt man mit der Maus über einen Tag, sieht man, was dort erfasst ist.
5. Der Text unter dem Kalender fasst zusammen, was passieren wird.
6. **Eintragen** klicken. Wenn Tage gelöscht werden, kommt eine Rückfrage; dafür den Button ein zweites Mal klicken. Danach aktualisiert sich die Zeiterfassung von selbst.

## Was eingetragen wird

- **Arbeitstage:** Das sind alle Tage mit Sollzeit laut deinem Arbeitszeitmodell in SAP. Teilzeit mit weniger Arbeitstagen wird also berücksichtigt. Eingetragen werden „Arrive“ zum Beginn und „Leave“ zum Ende. Die Pause zieht SAP selbst ab.
- **Urlaubstage** aus dem Kalender werden als ganztägiges Ereignis „Full-day absence not affecting balance“ eingetragen. Das ist in SAP derselbe Typ wie Krankheit; Krankheitstage also einfach auch als Urlaub markieren.
- **Berliner Feiertage** auf Arbeitstagen werden als ganztägiges Ereignis „Public holiday“ markiert.
- **Übersprungen werden:**
  - Tage, an denen schon etwas erfasst ist
  - Tage in der Zukunft
  - der 24.12. und 31.12.; diese bitte selbst eintragen

Abweichende Zeiten und andere Abwesenheiten (z. B. Gleittage) am besten **vorher** in der Zeiterfassung eintragen. Danach füllt die Erweiterung nur noch die übrigen Tage.

## Grenzen

- Wie in der App selbst kann man in einem Monat nur etwas eintragen, wenn der Vormonat Einträge hat oder abgeschlossen ist. Mehrere offene Monate also der Reihe nach ausfüllen. Löschen geht trotzdem.
- Den **Monatsabschluss** macht die Erweiterung nicht. Den bitte wie gewohnt selbst durchführen, nachdem du alles geprüft hast.
- Die Erweiterung läuft nur auf `*.sap.tu-berlin.de` und schickt keine Daten woandershin. Sie benutzt die angemeldete Sitzung der Zeiterfassung, wie wenn man selbst klickt.
- Ändert die TU die App „My Time Tracking“, muss die Erweiterung eventuell angepasst werden.
