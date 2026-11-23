"use strict";
// Stempeluhr MTU – Stempelseite (GitHub Pages /Bayrak-Portal/stempeluhr/). Schnittstelle: supabase\API.md, Kap. 1.
// Grundsaetze: keine PIN im Speicher des Handys (nur im Arbeitsspeicher, solange die Seite offen ist),
// keine Ausgaben in die Konsole, Chip-Code sofort aus der Adresszeile, credentials "omit".
// 24.11.2026: Unbekanntes Handy -> zwei Knoepfe „Mit Handynummer anmelden“ / „Ich bin neu“ (keine Namensliste, kein
// Startcode mehr). Sprache per Flagge oben rechts (de, tr, ro, ru, fa, prs; fa/prs rechts-nach-links), alle Texte
// aus texte.js; Fehler werden nur nach `code` uebersetzt.
(function () {
  // B5: nie eingebettet (iframe) laufen – Schutz gegen Clickjacking (GitHub Pages kann kein frame-ancestors senden).
  // Nichts anzeigen, nichts senden, keinen Chip-Code lesen.
  var eingebettet;
  try { eingebettet = window.top !== window.self; } catch (e) { eingebettet = true; }
  if (eingebettet) {
    try { document.body.textContent = ""; } catch (e) { /* egal */ }
    return;
  }
  var L = window.StzLogik;
  var API = "https://vzrvncxmleshwgtbvrtc.supabase.co/functions/v1/stempel";
  var ZEITLIMIT_MS = 8000; // API 1.6: > 8 s = wie Netzfehler
  var PIN_MERKEN_MS = 10 * 60 * 1000; // nur fuer automatisches Nachsenden, solange die Seite offen ist
  var NACHSENDEN_ALLE_MS = 30 * 1000; // Bauplan 6.3
  var K_GERAET = "stz_geraet";
  var K_SCHLANGE = "stz_warteschlange";
  var K_NEU_CODE = "stz_neuer_code"; // nur sessionStorage, nur fuer den Neuladen nach erneutem Dranhalten
  var K_SPRACHE_WAHL = "stz_sprache_wahl"; // Flagge von Hand (Vorrang 1)
  var K_SPRACHE_PERSON = "stz_sprache_person"; // Sprache der erkannten Person aus der Server-Antwort (Vorrang 2)

  var $ = function (id) { return document.getElementById(id); };
  var BILDSCHIRME = ["s-laden", "s-start", "s-ok", "s-pin", "s-wer", "s-telefon", "s-neu", "s-offline", "s-fehler",
    "s-sprache"];
  var MIT_SCHLANGE = { "s-start": 1, "s-ok": 1, "s-fehler": 1 };
  var aktuell = "s-laden";

  function zeige(id) {
    aktuell = id;
    BILDSCHIRME.forEach(function (s) { $(s).classList.toggle("versteckt", s !== id); });
    schlangeAnzeigen();
    window.scrollTo(0, 0);
  }

  // ---------- Speicher im Handy ----------
  var speicherOk = (function () {
    try {
      localStorage.setItem("stz_probe", "1");
      localStorage.removeItem("stz_probe");
      return true;
    } catch (e) { return false; }
  })();
  var notSpeicher = {}; // privater Modus: nur solange die Seite offen ist
  function lies(k) {
    if (!speicherOk) return Object.prototype.hasOwnProperty.call(notSpeicher, k) ? notSpeicher[k] : null;
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function schreib(k, v) {
    if (!speicherOk) {
      if (v === null) delete notSpeicher[k]; else notSpeicher[k] = v;
      return true;
    }
    try {
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
      return true;
    } catch (e) { return false; }
  }
  function geraet() { var t = lies(K_GERAET); return L.tokenOk(t) ? t : null; }
  function geraetSetzen(t) { if (L.tokenOk(t)) schreib(K_GERAET, t); }
  function geraetLoeschen() { schreib(K_GERAET, null); }
  function schlange() { return L.schlangeLesen(lies(K_SCHLANGE)); }
  function schlangeSpeichern(l) { return schreib(K_SCHLANGE, l.length ? JSON.stringify(l) : null); }
  /** Eintraege, die jetzt gesendet werden duerfen (nach Funkloch bei "tippen" erst nach Ablauf der Reservierung). */
  function schlangeBereit() { return L.schlangeBereit(schlange(), Date.now()).bereit; }
  function vorgangInSchlange() {
    return !!v && schlange().some(function (e) { return e.vorgang === v.vorgang; });
  }
  /** Aktueller Vorgang ist doch noch online erledigt -> nicht mehr nachreichen. */
  function vorgangAusSchlange() {
    if (!vorgangInSchlange()) return;
    schlangeSpeichern(schlange().filter(function (e) { return e.vorgang !== v.vorgang; }));
  }

  var pinSpeicher = null; // { pin, bis } – nur Arbeitsspeicher
  function pinMerken(pin) { pinSpeicher = { pin: pin, bis: Date.now() + PIN_MERKEN_MS }; }
  function pinGemerkt() {
    if (pinSpeicher && Date.now() < pinSpeicher.bis) return pinSpeicher.pin;
    pinSpeicher = null;
    return null;
  }

  // ---------- Sprache (E13: Flagge von Hand > Person > Handy-Sprache > Deutsch) ----------
  var sprache = "de";
  function T(k, w) { return L.t(sprache, k, w); }
  var dyn = {}; // id -> Funktion, die den Text in der aktuellen Sprache liefert (wird beim Sprachwechsel neu gerufen)

  /** Text eines Elements setzen und merken, damit er beim Sprachwechsel neu gebaut wird. fn = null -> leer. */
  function textSetzen(id, fn) {
    if (!fn) { delete dyn[id]; $(id).textContent = ""; return; }
    dyn[id] = fn;
    $(id).textContent = fn();
  }
  function handySprachen() {
    try {
      if (navigator.languages && navigator.languages.length) return Array.prototype.slice.call(navigator.languages);
      return [navigator.language];
    } catch (e) { return []; }
  }
  function sprachWahl() { var s = lies(K_SPRACHE_WAHL); return L.spracheOk(s) ? s : null; }
  function sprachPerson() { var s = lies(K_SPRACHE_PERSON); return L.spracheOk(s) ? s : null; }

  function alle(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function sprachAnwenden(code) {
    sprache = L.spracheOk(code) ? code : "de";
    var info = L.sprachInfo(sprache);
    var html = document.documentElement;
    if (html) {
      html.setAttribute("lang", info.lang);
      html.setAttribute("dir", info.dir); // fa/prs: rechts-nach-links; Flagge bleibt per CSS oben rechts
    }
    // feste Texte (ohne texte.js bleibt das Deutsch aus index.html stehen)
    alle("[data-t]").forEach(function (el) {
      var x = L.textRoh(sprache, el.getAttribute("data-t"));
      if (x !== null) el.textContent = x;
    });
    alle("[data-t-ph]").forEach(function (el) {
      var x = L.textRoh(sprache, el.getAttribute("data-t-ph"));
      // Beispielnummer links-nach-rechts isolieren (LRI … PDI), damit sie in fa/prs nicht vertauscht erscheint
      if (x !== null) el.setAttribute("placeholder", x.replace(/(\+?[0-9][0-9 ]*[0-9])/g, "⁦$1⁩"));
    });
    alle("[data-t-aria]").forEach(function (el) {
      var x = L.textRoh(sprache, el.getAttribute("data-t-aria"));
      if (x !== null) el.setAttribute("aria-label", x);
    });
    $("sprache-flagge").textContent = info.flagge;
    $("sprache-name").textContent = info.name;
    $("ds-massgeblich").classList.toggle("versteckt", sprache === "de");
    try { document.title = T("titel"); } catch (e) { /* egal */ }
    Object.keys(dyn).forEach(function (id) { $(id).textContent = dyn[id](); });
    schlangeAnzeigen();
  }

  function spracheBestimmen() {
    sprachAnwenden(L.spracheErmitteln(sprachWahl(), sprachPerson(), handySprachen()));
  }

  /** Antwort mit `sprache` (tippen/anmelden_telefon/registrieren): merken; anwenden, wenn keine Handwahl. */
  function personSprache(j) {
    if (!j || !L.spracheOk(j.sprache)) return;
    schreib(K_SPRACHE_PERSON, j.sprache);
    if (!sprachWahl() && j.sprache !== sprache) sprachAnwenden(j.sprache);
  }

  // ---------- Server ----------
  /** Liefert immer {status, j}; status 0 = kein Netz / Zeitueberschreitung. Wirft nie. */
  function senden(daten) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var uhr;
    var zeitAus = new Promise(function (ok) {
      uhr = setTimeout(function () {
        if (ctrl) ctrl.abort();
        ok({ status: 0, j: {} });
      }, ZEITLIMIT_MS);
    });
    var anfrage = fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(daten),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "cors",
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { status: r.status, j: j && typeof j === "object" ? j : {} };
      });
    }, function () { return { status: 0, j: {} }; });
    return Promise.race([anfrage, zeitAus]).then(function (e) { clearTimeout(uhr); return e; });
  }

  /** Wiederholt bei Funkloch/5xx mit DENSELBEN Daten (gleiche Vorgangsnummer bzw. gleiches Ticket). */
  function mitWiederholung(daten, versuche) {
    var n = 0;
    function los() {
      n++;
      return senden(daten).then(function (e) {
        if ((e.status === 0 || e.status >= 500) && n < versuche && navigator.onLine !== false) {
          return new Promise(function (w) { setTimeout(w, 1500); }).then(los);
        }
        e.wiederholt = n > 1;
        return e;
      });
    }
    return los();
  }

  function fehlerAus(e) { return L.fehlerAuswerten(e.status, e.j, sprache); }

  // ---------- Bedienung sperren waehrend einer Anfrage ----------
  var beschaeftigt = false;
  function sperren(an) {
    beschaeftigt = an;
    document.body.classList.toggle("sendet", an);
    Array.prototype.forEach.call(document.querySelectorAll("button"), function (b) { b.disabled = an; });
  }

  /** Fehlerzeile unter einem Formular: fn liefert den Text (in der aktuellen Sprache), null = ausblenden. */
  function feldFehler(id, fn) {
    textSetzen(id, fn);
    $(id).classList.toggle("versteckt", !fn);
  }
  function feldFehlerT(id, schluessel) { feldFehler(id, function () { return T(schluessel); }); }
  function feldFehlerF(id, f) { feldFehler(id, function () { return L.fehlerText(f, sprache); }); }

  /** Uhrzeit immer mit westlichen Ziffern (de-DE), auch auf persischen/arabischen Handys. */
  function uhrzeitJetzt(iso) {
    return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- Aktueller Vorgang (ein Chip-Code) ----------
  var v = null; // { p, m, vorgang, handyzeit, ticket, bis, timer, unsicher, versuche }
  var nochmal = null;

  function vorgangEnde() {
    if (v && v.timer) clearTimeout(v.timer);
    if (v) { v.ticket = null; v.bis = 0; v.timer = null; }
  }

  function ablaufSetzen(sek) {
    if (v.timer) clearTimeout(v.timer);
    var ms = Math.max(5, Number(sek) || 120) * 1000;
    v.bis = Date.now() + ms;
    v.timer = setTimeout(ablaufPruefen, ms + 200);
  }

  /** true = Zeit vorbei (Meldung wird gezeigt). Auch nach dem Aufwachen (iPhone haelt Timer an). */
  function ablaufPruefen() {
    if (!v || !v.ticket || beschaeftigt) return false;
    if (Date.now() <= v.bis) return false;
    if (aktuell !== "s-pin" && aktuell !== "s-wer" && aktuell !== "s-telefon" && aktuell !== "s-neu" &&
        aktuell !== "s-fehler") return false;
    zeigeFehler({ art: "neu_chip", code: "abgelaufen", rest: null, server: "" });
    return true;
  }

  function zeigeFehler(f, wiederholen) {
    if (f.art !== "netz" && f.art !== "eingabe") vorgangEnde();
    nochmal = wiederholen || null;
    textSetzen("fehler-titel", function () {
      return T(f.art === "neu_chip" ? "titel_nochmal" : f.art === "netz" ? "titel_netz" : "titel_fehler");
    });
    textSetzen("fehler-text", function () { return L.fehlerText(f, sprache); });
    $("fehler-nochmal").classList.toggle("versteckt", !wiederholen);
    zeige("s-fehler");
  }

  function zeigeOk(j) {
    vorgangEnde();
    vorgangAusSchlange();
    if (j.geraet) geraetSetzen(j.geraet);
    personSprache(j);
    var schon = !!j.schon;
    $("ok-symbol").textContent = schon ? "i" : "✓";
    $("ok-symbol").className = schon ? "haken blau" : "haken";
    textSetzen("ok-titel", function () { return L.fertigTitel(j, sprache); });
    var name = j.name || j.vorname || "";
    textSetzen("ok-text", function () {
      var hallo = name ? T("hallo_ausruf", { name: name }) : "";
      return schon ? T("nichts_weiter") + (hallo ? " " + hallo : "") : hallo;
    });
    $("ok-wartet").classList.toggle("versteckt", !j.wartet);
    zeige("s-ok");
  }

  // ---------- 1. tippen ----------
  function tippen() {
    zeige("s-laden");
    if (navigator.onLine === false) { offlineSpeichern(false); return; } // nichts gesendet -> nichts reserviert
    var daten = { aktion: "tippen", p: v.p, m: v.m, vorgang: v.vorgang };
    var g = geraet();
    if (g) daten.geraet = g;
    sperren(true);
    mitWiederholung(daten, 2).then(function (e) {
      sperren(false);
      if (e.status === 200) { tippenAntwort(e.j); return; }
      var f = fehlerAus(e);
      // Anfrage kam evtl. an (nur die Antwort fehlt) -> Code evtl. reserviert, erst nach Ablauf nachreichen
      if (f.art === "netz") { offlineSpeichern(true, !!g); return; }
      if (vorgangInSchlange()) f.zusatz = "bleibt_im_handy";
      zeigeFehler(f);
    });
  }

  /** Erneutes "tippen" eines gespeicherten Vorgangs lieferte ein Ticket: Reservierung laeuft ab jetzt neu. */
  function schlangeReservierung(gueltigSek) {
    if (!vorgangInSchlange()) return;
    var r = L.reservierungMitTicket(Date.now(), gueltigSek);
    schlangeSpeichern(L.schlangeHinzu(schlange(), {
      p: v.p, m: v.m, vorgang: v.vorgang, handyzeit: v.handyzeit, ab: r.ab, rbis: r.rbis
    }));
  }

  function tippenAntwort(j) {
    if (j.schritt === "fertig") { zeigeOk(j); return; }
    if (j.schritt === "pin" && L.tokenOk(j.ticket)) {
      personSprache(j);
      v.ticket = j.ticket;
      ablaufSetzen(j.gueltig_sek);
      schlangeReservierung(j.gueltig_sek);
      var name = j.name || j.vorname || "";
      var naechstes = j.naechstes;
      textSetzen("pin-hallo", function () { return T("hallo", { name: name }); });
      textSetzen("pin-als", function () { return T("als_naechstes", { art: L.artText(naechstes, sprache) }); });
      textSetzen("pin-los", function () { return L.artText(naechstes, sprache); });
      $("pin").value = "";
      feldFehler("pin-fehler", null);
      var n = geraet() ? schlangeBereit().length : 0;
      feldFehler("pin-schlange", n ? function () { return T("pin_schlange", { anzahl: L.anzahlText(n, sprache) }); } : null);
      zeige("s-pin");
      $("pin").focus();
      return;
    }
    if (j.schritt === "anmelden" && L.tokenOk(j.ticket)) {
      // Seit 24.11.2026: keine Namensliste (Feld "namen" wird ignoriert), genau zwei Knoepfe
      v.ticket = j.ticket;
      ablaufSetzen(j.gueltig_sek);
      schlangeReservierung(j.gueltig_sek);
      zeige("s-wer");
      return;
    }
    zeigeFehler({ art: "ende", schluessel: "unerwartet" });
  }

  /** Antwort ging im Funkloch verloren, Ticket ist aber schon verbraucht -> gleiche Vorgangsnummer erneut "tippen". */
  function ergebnisNachholen(pin) {
    v.versuche = (v.versuche || 0) + 1;
    if (v.versuche > 2) {
      zeigeFehler({ art: "neu_chip", schluessel: "chip_nochmal" });
      return;
    }
    var daten = { aktion: "tippen", p: v.p, m: v.m, vorgang: v.vorgang };
    var g = geraet();
    if (g) daten.geraet = g;
    sperren(true);
    mitWiederholung(daten, 2).then(function (e) {
      sperren(false);
      if (e.status === 200 && e.j.schritt === "fertig") {
        zeigeOk(e.j);
        if (!geraet()) textSetzen("ok-text", function () { return T("naechstes_mal"); });
        return;
      }
      if (e.status === 200 && e.j.schritt === "pin" && pin && L.tokenOk(e.j.ticket)) {
        v.ticket = e.j.ticket;
        ablaufSetzen(e.j.gueltig_sek);
        schlangeReservierung(e.j.gueltig_sek);
        stempeln(pin);
        return;
      }
      if (e.status === 200) { tippenAntwort(e.j); return; }
      var f = fehlerAus(e);
      zeigeFehler(f, f.art === "netz" ? function () { ergebnisNachholen(pin); } : null);
    });
  }

  // ---------- 2. stempeln (bekanntes Handy) ----------
  function pinLos() {
    if (beschaeftigt || ablaufPruefen()) return;
    var pin = L.ziffernWestlich($("pin").value.trim());
    if (!L.pinFormatOk(pin)) { feldFehlerT("pin-fehler", "pin_eingeben"); return; }
    feldFehler("pin-fehler", null);
    // API 1.5: gespeicherte Offline-Stempel ZUERST senden (gleiche PIN), dann den aktuellen.
    // Bewusst so (Pruefung A1, 18.11.2026): reine Offline-Stempel (z. B. Kommen 7:00 ohne Netz) muessen VOR dem
    // aktuellen ankommen, sonst wird der aktuelle zum Kommen. Nachgeholte Tipps, die schon einen spaeteren Stempel
    // haben (Gehen 16:00 verloren, jetzt 16:06), erkennt der Server am noch laufenden Ticket dieses Tipps -> Pruefliste.
    var vorher = geraet() && schlangeBereit().length ? nachreichenAlles(pin) : Promise.resolve(null);
    sperren(true);
    vorher.then(function (r) {
      sperren(false);
      if (r && r.fehler && r.fehler.art !== "netz") {
        if (r.fehler.code === "pin_falsch") {
          $("pin").value = "";
          feldFehlerT("pin-fehler", "pin_falsch_nochmal");
          return;
        }
        zeigeFehler(r.fehler);
        return;
      }
      stempeln(pin);
    });
  }

  function stempeln(pin) {
    if (ablaufPruefen()) return;
    var g = geraet();
    if (!g) { zeigeFehler({ art: "neu_chip", schluessel: "chip_nochmal" }); return; }
    sperren(true);
    mitWiederholung({ aktion: "stempeln", ticket: v.ticket, geraet: g, pin: pin }, 2).then(function (e) {
      sperren(false);
      if (e.status === 200) { pinMerken(pin); zeigeOk(e.j); return; }
      var f = fehlerAus(e);
      if (f.art === "netz") {
        v.unsicher = true;
        zeigeFehler(f, function () { zeige("s-pin"); stempeln(pin); });
        return;
      }
      if (f.code === "verbraucht" && (v.unsicher || e.wiederholt)) { ergebnisNachholen(pin); return; }
      if (f.art === "eingabe") {
        $("pin").value = "";
        feldFehlerF("pin-fehler", f);
        zeige("s-pin");
        return;
      }
      if (f.art === "geraet") geraetLoeschen();
      zeigeFehler(f);
    });
  }

  // ---------- 3. Mit Handynummer anmelden ----------
  function telefonLos() {
    if (beschaeftigt || ablaufPruefen()) return;
    var nummer = L.ziffernWestlich($("tel-nummer").value.trim());
    var pin = L.ziffernWestlich($("tel-pin").value.trim());
    if (!L.telefonNormalisieren(nummer)) { feldFehlerT("tel-fehler", "f_telefon_ungueltig"); return; }
    if (!L.pinFormatOk(pin)) { feldFehlerT("tel-fehler", "pin_eingeben"); return; }
    feldFehler("tel-fehler", null);
    var daten = { aktion: "anmelden_telefon", ticket: v.ticket, telefon: nummer, pin: pin };
    var g = geraet();
    if (g) daten.geraet = g;
    sperren(true);
    senden(daten).then(function (e) {
      sperren(false);
      if (e.status === 200) { nachAnmeldung(e.j, pin); return; }
      var f = fehlerAus(e);
      if (f.art === "netz") {
        v.unsicher = true;
        zeigeFehler(f, function () { zeige("s-telefon"); telefonLos(); });
        return;
      }
      if (f.code === "verbraucht" && v.unsicher) { ergebnisNachholen(null); return; }
      if (f.art === "eingabe") {
        $("tel-pin").value = "";
        feldFehlerF("tel-fehler", f);
        zeige("s-telefon");
        return;
      }
      zeigeFehler(f);
    });
  }

  function nachAnmeldung(j, pin) {
    zeigeOk(j); // speichert das neue Geraete-Token und die Sprache der Person
    pinMerken(pin);
    // Offline-Stempel von vor der Anmeldung jetzt mitsenden
    if (geraet() && schlangeBereit().length) nachreichenAlles(pin);
  }

  // ---------- 4. Ich bin neu (auch: schon in der Liste, noch nie mit Nummer -> bisherige PIN) ----------
  var neuArt = null;
  function artWaehlen(a) {
    neuArt = a;
    $("neu-vz").setAttribute("aria-pressed", a === "vz" ? "true" : "false");
    $("neu-mj").setAttribute("aria-pressed", a === "mj" ? "true" : "false");
  }

  function neuLos() {
    if (beschaeftigt || ablaufPruefen()) return;
    var vorname = L.nameBereinigen($("neu-vorname").value);
    var nachname = L.nameBereinigen($("neu-nachname").value);
    var tel = L.ziffernWestlich($("neu-telefon").value.trim());
    var pin = L.ziffernWestlich($("neu-pin").value.trim());
    var pin2 = L.ziffernWestlich($("neu-pin2").value.trim());
    var fehlt = !vorname || !nachname ? "f_name" :
      !L.telefonNormalisieren(tel) ? "f_telefon_ungueltig" :
      !neuArt ? "f_art" :
      !$("neu-whatsapp").checked ? "e_whatsapp" :
      !L.pinFormatOk(pin) ? "e_pin_festlegen" :
      pin !== pin2 ? "f_pin_ungleich" :
      !L.pinErlaubt(pin) ? "f_pin_einfach" : "";
    if (fehlt) { feldFehlerT("neu-fehler", fehlt); return; }
    feldFehler("neu-fehler", null);
    var daten = {
      aktion: "registrieren", ticket: v.ticket, vorname: vorname, nachname: nachname, art: neuArt,
      pin: pin, pin2: pin2, telefon: tel,
      whatsapp_ok: $("neu-whatsapp").checked === true // Pflicht-Haekchen (oben geprueft), Server will genau true
    };
    // Sprache nur mitschicken, wenn der Mitarbeiter sie SELBST per Flagge gewaehlt hat (nicht nur Handy-Sprache)
    // -> Stammliste (nur wenn dort noch keine steht)
    if (sprachWahl()) daten.sprache = sprachWahl();
    var g = geraet();
    if (g) daten.geraet = g;
    sperren(true);
    senden(daten).then(function (e) {
      sperren(false);
      if (e.status === 200) { nachAnmeldung(e.j, pin); return; }
      var f = fehlerAus(e);
      if (f.art === "netz") {
        v.unsicher = true;
        zeigeFehler(f, function () { zeige("s-neu"); neuLos(); });
        return;
      }
      if (f.code === "verbraucht" && v.unsicher) { ergebnisNachholen(null); return; }
      if (f.art === "eingabe") {
        if (f.code === "pin_ungleich" || f.code === "pin_einfach") { $("neu-pin").value = ""; $("neu-pin2").value = ""; }
        feldFehlerF("neu-fehler", f);
        zeige("s-neu");
        return;
      }
      zeigeFehler(f);
    });
  }

  // ---------- 5. Offline ----------
  /**
   * vielleichtReserviert: "tippen" wurde gesendet, nur die Antwort fehlt -> der Code kann beim Server schon reserviert
   * sein (2 Min. bekanntes Handy, 10 Min. Anmeldung). Dann erst nach Ablauf nachreichen (API 1.5).
   */
  function offlineSpeichern(vielleichtReserviert, mitGeraet) {
    vorgangEnde();
    var e = { p: v.p, m: v.m, vorgang: v.vorgang, handyzeit: v.handyzeit };
    if (vielleichtReserviert) {
      var r = L.reservierungNachNetzfehler(Date.now(), mitGeraet);
      e.ab = r.ab;
      e.rbis = r.rbis;
    }
    var ok = schlangeSpeichern(L.schlangeHinzu(schlange(), e));
    if (!ok || !speicherOk) {
      zeigeFehler({ art: "ende", schluessel: "offline_privat" });
      return;
    }
    var zeit = uhrzeitJetzt(v.handyzeit);
    textSetzen("offline-titel", function () { return T("offline_titel", { zeit: zeit }); });
    $("offline-ohne-anmeldung").classList.toggle("versteckt", !!geraet());
    var ab = L.schlangeNaechsterVersuch(schlange().filter(function (x) { return x.vorgang === v.vorgang; }), Date.now());
    var abZeit = ab ? uhrzeitJetzt(ab) : "";
    textSetzen("offline-warten", ab ? function () { return T("offline_warten", { zeit: abZeit }); } : null);
    $("offline-warten").classList.toggle("versteckt", !ab);
    zeige("s-offline");
  }

  // ---------- 6. Nachreichen ----------
  var sendetSchlange = null; // laufendes Promise

  /** Sendet die ganze Warteschlange (je 20). Ergebnis: {summe, fehler?}. Wirft nie. */
  function nachreichenAlles(pin) {
    if (sendetSchlange) return sendetSchlange;
    var g = geraet();
    if (!g) return Promise.resolve({ summe: null });
    var summe = { gesendet: 0, pruefen: 0, verbraucht: 0, abgewiesen: 0, spaeter: 0 };
    var groesse = L.NACHREICHEN_JE_ANFRAGE;
    var runden = 0;
    function runde() {
      // nur Eintraege, deren moegliche Reservierung abgelaufen ist; Notbremse gegen Endlosschleife
      var liste = schlangeBereit();
      if (!liste.length || ++runden > 10) return Promise.resolve({ summe: summe });
      var stueck = L.schlangeStueck(liste, groesse);
      return mitWiederholung({ aktion: "nachreichen", geraet: g, pin: pin, eintraege: stueck }, 2).then(function (e) {
        if (e.status === 200) {
          var r = L.schlangeNachErgebnis(schlange(), stueck, e.j.ergebnisse, Date.now());
          schlangeSpeichern(r.rest);
          Object.keys(summe).forEach(function (k) { summe[k] += r.zaehler[k] || 0; });
          return runde();
        }
        if (e.status === 413 && groesse > 1) { groesse = Math.max(1, Math.floor(groesse / 2)); return runde(); }
        var f = fehlerAus(e);
        if (f.art === "geraet") geraetLoeschen();
        if (f.code === "pin_falsch" || f.code === "gesperrt") pinSpeicher = null;
        return { summe: summe, fehler: f };
      });
    }
    sendetSchlange = runde().then(function (r) {
      sendetSchlange = null;
      schlangeMelden(r);
      return r;
    }, function () {
      sendetSchlange = null;
      return { summe: summe, fehler: { art: "netz", code: "server", server: "" } };
    });
    return sendetSchlange;
  }

  function schlangeMelden(r) {
    var rest = schlange().length;
    textSetzen("schlange-info", function () {
      var t = r.summe ? L.nachreichenText(r.summe, sprache) : "";
      if (r.fehler && rest) {
        var warum = r.fehler.code === "pin_falsch" ? T("melden_pin") :
          r.fehler.art === "netz" ? T("melden_netz") : L.fehlerText(r.fehler, sprache);
        t = (t ? t + " " : "") + warum + " " + T("noch_nicht_gesendet", { anzahl: L.anzahlText(rest, sprache) });
      }
      return t;
    });
    $("schlange-info").classList.toggle("versteckt", !$("schlange-info").textContent);
    schlangeAnzeigen();
  }

  /** Karte „gespeicherte Stempel senden – PIN“ nur auf Start/Ergebnis/Fehler und nur mit Netz + angemeldetem Handy. */
  function schlangeAnzeigen() {
    if (!L) return;
    var alleE = schlange();
    var jetzt = Date.now();
    var teil = L.schlangeBereit(alleE, jetzt);
    var n = teil.bereit.length;
    var zeigen = n > 0 && !!geraet() && !!MIT_SCHLANGE[aktuell] && navigator.onLine !== false && !sendetSchlange;
    $("schlange-titel").textContent = n ? T("schlange_titel", { anzahl: L.anzahlText(n, sprache) }) : "";
    $("s-schlange").classList.toggle("versteckt", !zeigen);
    // Eintraege nach Funkloch beim "tippen": erst nach Ablauf der Reservierung sendbar
    var w = teil.warten.length;
    var wZeigen = w > 0 && !!geraet() && !!MIT_SCHLANGE[aktuell];
    $("schlange-warten").textContent = wZeigen
      ? T(w === 1 ? "warten_1" : "warten_n", {
        anzahl: L.anzahlText(w, sprache), zeit: uhrzeitJetzt(L.schlangeNaechsterVersuch(alleE, jetzt))
      })
      : "";
    $("schlange-warten").classList.toggle("versteckt", !wZeigen);
    if (alleE.length > 0 && !geraet() && aktuell === "s-start") {
      var info = $("schlange-info");
      if (!info.textContent || dyn["schlange-info"] && dyn["schlange-info"].ohneAnmeldung) {
        var anz = alleE.length;
        var fn = function () { return T(anz === 1 ? "info_ohne_1" : "info_ohne_n", { anzahl: L.anzahlText(anz, sprache) }); };
        fn.ohneAnmeldung = true;
        textSetzen("schlange-info", fn);
        info.classList.remove("versteckt");
      }
    }
  }

  function schlangeLos() {
    if (beschaeftigt) return;
    var pin = L.ziffernWestlich($("schlange-pin").value.trim());
    if (!L.pinFormatOk(pin)) { feldFehlerT("schlange-fehler", "pin_eingeben"); return; }
    feldFehler("schlange-fehler", null);
    sperren(true);
    nachreichenAlles(pin).then(function (r) {
      sperren(false);
      $("schlange-pin").value = "";
      if (!r.fehler) pinMerken(pin);
      else if (r.fehler.code === "pin_falsch") feldFehlerT("schlange-fehler", "pin_falsch_nochmal");
      schlangeAnzeigen();
    });
  }

  /** Automatisch: beim Oeffnen, bei „online“, alle 30 s – aber nur, wenn die PIN gerade bekannt ist. */
  function automatischNachreichen() {
    if (beschaeftigt || navigator.onLine === false || !geraet() || !schlangeBereit().length) { schlangeAnzeigen(); return; }
    var pin = pinGemerkt();
    if (pin) nachreichenAlles(pin);
    else schlangeAnzeigen();
  }

  function zuAltePruefen() {
    var a = L.schlangeAussortieren(schlange(), Date.now());
    if (!a.zuAlt.length) return;
    schlangeSpeichern(a.behalten);
    var n = a.zuAlt.length;
    textSetzen("schlange-info", function () { return n === 1 ? T("zu_alt_1") : T("zu_alt_n", { n: n }); });
    $("schlange-info").classList.remove("versteckt");
  }

  // ---------- Start ----------
  function codeHolen() {
    var c = L.codeAusHash(location.hash || "");
    var handyzeit = new Date().toISOString();
    if (location.hash) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* egal */ } }
    if (c) return { p: c.p, m: c.m, handyzeit: handyzeit };
    // nach erneutem Dranhalten bei offener Seite (hashchange -> neu laden)
    try {
      var roh = sessionStorage.getItem(K_NEU_CODE);
      sessionStorage.removeItem(K_NEU_CODE);
      var s = roh ? JSON.parse(roh) : null;
      var c2 = s ? L.codeAusHash("p=" + s.p + "&m=" + s.m) : null;
      if (c2 && typeof s.handyzeit === "string" && Date.now() - Date.parse(s.handyzeit) < 60000) {
        return { p: c2.p, m: c2.m, handyzeit: s.handyzeit };
      }
    } catch (e) { /* egal */ }
    return null;
  }

  window.addEventListener("hashchange", function () {
    var c = L.codeAusHash(location.hash || "");
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* egal */ }
    if (!c) return;
    try {
      sessionStorage.setItem(K_NEU_CODE, JSON.stringify({ p: c.p, m: c.m, handyzeit: new Date().toISOString() }));
    } catch (e) { /* ohne sessionStorage: Code geht verloren, Nutzer haelt erneut dran */ }
    location.reload();
  });

  // B2: PIN verdeckt. Normal per CSS (-webkit-text-security, Feld bleibt type=text -> kein Angebot
  // "Passwort speichern"). Browser ohne text-security: type=password, Zifferntastatur bleibt (inputmode),
  // autocomplete one-time-code -> Passwort-Manager speichern/fuellen es nicht.
  var textSecurity = !(window.CSS && typeof window.CSS.supports === "function") ||
    window.CSS.supports("-webkit-text-security", "disc");
  function ziffernFeld(id, los) {
    var el = $(id);
    if (!textSecurity) {
      el.setAttribute("autocomplete", "one-time-code");
      el.setAttribute("inputmode", "numeric");
      el.type = "password";
    }
    el.addEventListener("input", function () {
      // persische/arabische Ziffern erst umsetzen, dann alles ausser 0-9 entfernen
      var z = L.ziffernWestlich(el.value).replace(/[^0-9]/g, "");
      if (z !== el.value) el.value = z;
    });
    if (los) el.addEventListener("keydown", function (ev) { if (ev.key === "Enter") los(); });
  }
  ziffernFeld("pin", pinLos);
  ziffernFeld("tel-pin", telefonLos);
  ziffernFeld("neu-pin");
  ziffernFeld("neu-pin2");
  ziffernFeld("schlange-pin", schlangeLos);

  $("pin-los").addEventListener("click", pinLos);
  $("wer-telefon").addEventListener("click", function () {
    if (ablaufPruefen()) return;
    feldFehler("tel-fehler", null);
    $("tel-pin").value = "";
    zeige("s-telefon");
  });
  $("tel-los").addEventListener("click", telefonLos);
  $("tel-zurueck").addEventListener("click", function () { if (!ablaufPruefen()) zeige("s-wer"); });
  $("wer-neu").addEventListener("click", function () {
    if (ablaufPruefen()) return;
    feldFehler("neu-fehler", null);
    zeige("s-neu");
  });
  $("neu-zurueck").addEventListener("click", function () { if (!ablaufPruefen()) zeige("s-wer"); });
  $("neu-vz").addEventListener("click", function () { artWaehlen("vz"); });
  $("neu-mj").addEventListener("click", function () { artWaehlen("mj"); });
  $("neu-los").addEventListener("click", neuLos);
  $("schlange-los").addEventListener("click", schlangeLos);
  // Nach Funkloch: denselben Vorgang (gleiche vorgang) noch einmal "tippen" -> neues Ticket statt Warten
  $("offline-nochmal").addEventListener("click", function () {
    if (beschaeftigt || !v) return;
    tippen();
  });
  $("fehler-nochmal").addEventListener("click", function () {
    var f = nochmal;
    nochmal = null;
    if (f) f();
  });

  // Flagge oben rechts: Sprache waehlen. Die Wahl merkt sich nur dieses Handy (nicht die Stammliste).
  var vorSprachwahl = null;
  $("sprache-knopf").addEventListener("click", function () {
    if (beschaeftigt) return;
    if (aktuell !== "s-sprache") vorSprachwahl = aktuell;
    zeige("s-sprache");
  });
  L.SPRACHEN.forEach(function (code) {
    $("sprache-" + code).addEventListener("click", function () {
      schreib(K_SPRACHE_WAHL, code);
      sprachAnwenden(code);
      zeige(vorSprachwahl || "s-start");
    });
  });
  $("sprache-zurueck").addEventListener("click", function () { zeige(vorSprachwahl || "s-start"); });

  window.addEventListener("online", automatischNachreichen);
  window.addEventListener("offline", schlangeAnzeigen);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (!ablaufPruefen()) automatischNachreichen();
  });
  setInterval(automatischNachreichen, NACHSENDEN_ALLE_MS);

  // Offline-Huelle (nur Bereich /Bayrak-Portal/stempeluhr/). Kein Background Sync: Nachsenden braucht die PIN,
  // und die liegt nie im Speicher – darum sendet die Seite nur, wenn sie offen ist (iPhone kann es ohnehin nicht).
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(function () { /* Seite geht auch ohne */ });
  }

  function start() {
    spracheBestimmen();
    $("privat-hinweis").classList.toggle("versteckt", speicherOk);
    zuAltePruefen();
    var c = codeHolen();
    if (!c) {
      zeige("s-start");
      automatischNachreichen();
      return;
    }
    v = { p: c.p, m: c.m, handyzeit: c.handyzeit, vorgang: L.neueVorgangsId(window.crypto) };
    tippen();
  }

  start();
})();
