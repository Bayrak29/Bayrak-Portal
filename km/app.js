"use strict";
(function () {
  var API = "https://vzrvncxmleshwgtbvrtc.supabase.co/functions/v1/fahrt";
  var KM_MAX = 2000000;
  var SPRUNG = 3000;
  var SPEICHER_SCHLUESSEL = "km_token"; // getrennt vom Nachweis-Link (fz_token)

  var $ = function (id) { return document.getElementById(id); };
  var schritte = ["laden", "fehler", "anzeige"];
  function zeige(id) {
    schritte.forEach(function (s) { $(s).classList.toggle("versteckt", s !== id); });
    window.scrollTo(0, 0);
  }
  var nochmalAktion = null;
  function fehler(text) {
    $("fehler-text").textContent = text;
    zeige("fehler");
  }

  // ---- Token aus dem Link lesen und aus der Adresszeile entfernen ----
  var token = "";
  function tokenLesen() {
    var roh = (location.hash || "").replace(/^#/, "");
    if (/^[A-Za-z0-9_-]{40,64}$/.test(roh)) {
      token = roh;
      try { sessionStorage.setItem(SPEICHER_SCHLUESSEL, token); } catch (e) {}
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
      return true;
    }
    if (!token) { try { token = sessionStorage.getItem(SPEICHER_SCHLUESSEL) || ""; } catch (e) {} }
    return false;
  }
  tokenLesen();
  // Erneuter Scan bei offener Seite aendert nur den #-Teil -> sauber neu laden
  window.addEventListener("hashchange", function () {
    if (tokenLesen()) location.reload();
  });

  // Antwort: {ok, status, daten}; Netzfehler -> Error mit Klartext
  function anfrage(daten) {
    daten.token = token;
    return fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(daten),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, daten: j || {} };
      });
    }, function () {
      var e = new Error("Keine Internetverbindung. Bitte Empfang prüfen und nochmal versuchen.");
      e.netz = true;
      throw e;
    });
  }

  // ---- Formatierung ----
  function tausender(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  function teile(isoDatum) { // "2028-11-26" -> [2028, 11, 26]
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDatum || "");
    return m ? [m[1], m[2], m[3]] : null;
  }
  function datumText(isoDatum) {
    var t = teile(isoDatum);
    return t ? t[2] + "." + t[1] + "." + t[0] : "";
  }
  function monatText(isoDatum) {
    var t = teile(isoDatum);
    return t ? t[1] + "/" + t[0] : "";
  }
  function kurzDatum(isoZeit) { // Zeitstempel -> "27.11." (Ortszeit)
    var d = new Date(isoZeit);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  }

  // ---- Zustand ----
  var stand = null; // letzte Antwort von km_status
  var sendet = false;

  function statusAnzeigen(j) {
    stand = j;
    $("fz-kz").textContent = (j.fahrzeug && j.fahrzeug.kennzeichen) || "";
    $("fz-name").textContent = (j.fahrzeug && j.fahrzeug.bezeichnung) || "";
    $("wert-tuev").textContent = j.tuev ? monatText(j.tuev) : "nicht hinterlegt";
    var w = [];
    if (j.wartung_datum) w.push(datumText(j.wartung_datum));
    if (typeof j.wartung_km === "number") w.push(tausender(j.wartung_km) + " km");
    $("wert-wartung").textContent = w.length ? w.join(" oder ") : "nicht hinterlegt";
    if (typeof j.letzter_km === "number") {
      var am = j.letzter_km_am ? kurzDatum(j.letzter_km_am) : "";
      $("wert-stand").textContent = tausender(j.letzter_km) + " km" + (am ? " (" + am + ")" : "");
    } else {
      $("wert-stand").textContent = "noch keiner gemeldet";
    }
  }

  function meldungZeigen(text, mitNochmal) {
    $("meldung-text").textContent = text;
    $("knopf-nochmal").classList.toggle("versteckt", !mitNochmal);
    $("meldung").classList.remove("versteckt");
  }
  function meldungWeg() {
    $("meldung").classList.add("versteckt");
    $("rueckfrage").classList.add("versteckt");
    $("knopf-speichern").classList.remove("versteckt");
  }

  function statusLaden(danach) {
    return anfrage({ aktion: "km_status" }).then(function (a) {
      if (!a.ok) throw new Error(a.daten.fehler || ("Fehler " + a.status));
      statusAnzeigen(a.daten);
      if (danach) danach();
      zeige("anzeige");
    });
  }

  function start() {
    if (!token) {
      fehler("Bitte den NFC-Aufkleber oder QR-Code im Fahrzeug scannen.");
      return;
    }
    zeige("laden");
    statusLaden().catch(function (e) { fehler(e.message); });
  }

  // Eingabe lesen: Punkte/Leerzeichen/Apostrophe entfernen; Ergebnis Zahl oder Fehlertext
  function eingabeLesen() {
    var roh = ($("km").value || "").replace(/[\s.'’]/g, "");
    if (!roh) return { fehler: "Bitte den aktuellen KM-Stand eingeben." };
    if (/[,]/.test(roh)) return { fehler: "Bitte nur ganze Kilometer eingeben (ohne Komma)." };
    if (!/^\d+$/.test(roh)) return { fehler: "Bitte nur Ziffern eingeben." };
    var n = parseInt(roh, 10);
    if (!isFinite(n) || n > KM_MAX) return { fehler: "Bitte eine Zahl zwischen 0 und 2.000.000 eingeben." };
    return { km: n };
  }

  function sprungText(differenz, letzterAm) {
    var seit = letzterAm ? " vom " + kurzDatum(letzterAm) : "";
    return "Das sind " + tausender(differenz) + " km mehr als die letzte Meldung" + seit + ". Stimmt das?";
  }
  function ersteText(km) {
    return "Erster KM-Stand für dieses Fahrzeug: " + tausender(km) + " km – stimmt das?";
  }
  function rueckfrage(text, km) {
    $("rueckfrage-text").textContent = text;
    $("rueckfrage").dataset.km = String(km);
    $("rueckfrage").classList.remove("versteckt");
    $("knopf-speichern").classList.add("versteckt");
    $("meldung").classList.add("versteckt");
  }

  function senden(km, bestaetigt) {
    if (sendet) return;
    sendet = true;
    meldungWeg();
    $("erfolg").classList.add("versteckt");
    var knopf = $("knopf-speichern");
    knopf.disabled = true;
    knopf.textContent = "Wird gespeichert …";
    var daten = { aktion: "km_melden", km: km };
    if (bestaetigt) daten.bestaetigt = true;
    anfrage(daten).then(function (a) {
      var j = a.daten;
      if (a.ok && j.ok) {
        $("km").value = "";
        return statusLaden(function () {
          $("erfolg").textContent = "Gespeichert: " + tausender(km) + " km. Danke!";
          $("erfolg").classList.remove("versteckt");
        }).catch(function () {
          // Gespeichert ist es trotzdem - nur die Anzeige konnte nicht neu geladen werden
          $("erfolg").textContent = "Gespeichert: " + tausender(km) + " km. Danke!";
          $("erfolg").classList.remove("versteckt");
        });
      }
      if (a.status === 409 && j.art === "sprung") {
        rueckfrage(sprungText(j.differenz, j.letzter_km_am), km);
        return;
      }
      if (a.status === 409 && j.art === "erste") {
        rueckfrage(ersteText(km), km);
        return;
      }
      if (a.status === 409 && j.art === "kleiner") {
        meldungZeigen(j.fehler || "Kleiner als der letzte Stand. Wenn der Tacho stimmt, bitte im Büro melden.", false);
        // Anzeige "Letzter Stand" auf den Serverwert bringen
        statusLaden().catch(function () {});
        return;
      }
      if (a.status === 404) {
        fehler(j.fehler || "Dieser Link ist ungültig oder nicht mehr aktiv.");
        return;
      }
      if (a.status === 400 || a.status === 429) {
        meldungZeigen(j.fehler || "Eingabe ungültig.", false);
        return;
      }
      nochmalAktion = function () { senden(km, bestaetigt); };
      meldungZeigen(j.fehler || ("Speichern hat nicht geklappt (Fehler " + a.status + "). Bitte nochmal versuchen."), true);
    }).catch(function (e) {
      nochmalAktion = function () { senden(km, bestaetigt); };
      meldungZeigen(e.message || "Unbekannter Fehler.", true);
    }).then(function () {
      sendet = false;
      knopf.disabled = false;
      knopf.textContent = "Speichern";
    });
  }

  function speichernGeklickt() {
    meldungWeg();
    $("erfolg").classList.add("versteckt");
    var e = eingabeLesen();
    if (e.fehler) { meldungZeigen(e.fehler, false); return; }
    var km = e.km;
    $("km").value = String(km);
    // Vorabpruefung im Browser nur fuer den Sprung (spart einen Umweg). "Kleiner" und
    // "erster Stand" entscheidet der Server, weil die Anzeige veraltet sein kann
    // (z. B. Handkorrektur im Buero seit dem Laden der Seite).
    if (stand && typeof stand.letzter_km === "number" && km - stand.letzter_km > SPRUNG) {
      rueckfrage(sprungText(km - stand.letzter_km, stand.letzter_km_am), km);
      return;
    }
    senden(km, false);
  }

  $("fehler-neu").addEventListener("click", function () { start(); });
  $("knopf-speichern").addEventListener("click", speichernGeklickt);
  $("km").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); speichernGeklickt(); }
  });
  $("km").addEventListener("input", function () {
    $("meldung").classList.add("versteckt");
  });
  $("knopf-ja").addEventListener("click", function () {
    var km = parseInt($("rueckfrage").dataset.km || "", 10);
    if (!isFinite(km)) { meldungWeg(); return; }
    senden(km, true);
  });
  $("knopf-nein").addEventListener("click", function () {
    meldungWeg();
    $("km").focus();
    try { $("km").select(); } catch (e) {}
  });
  $("knopf-nochmal").addEventListener("click", function () {
    if (nochmalAktion) { var f = nochmalAktion; nochmalAktion = null; f(); }
  });

  start();
})();
