"use strict";
// Stempeluhr MTU – Stempelseite (GitHub Pages /Bayrak-Portal/stempeluhr/). Schnittstelle: supabase\API.md, Kap. 1.
// Grundsaetze: keine PIN im Speicher des Handys (nur im Arbeitsspeicher, solange die Seite offen ist),
// keine Ausgaben in die Konsole, Chip-Code sofort aus der Adresszeile, credentials "omit".
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

  var $ = function (id) { return document.getElementById(id); };
  var BILDSCHIRME = ["s-laden", "s-start", "s-ok", "s-pin", "s-wer", "s-anmelden", "s-neu", "s-offline", "s-fehler"];
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

  // ---------- Bedienung sperren waehrend einer Anfrage ----------
  var beschaeftigt = false;
  function sperren(an) {
    beschaeftigt = an;
    document.body.classList.toggle("sendet", an);
    Array.prototype.forEach.call(document.querySelectorAll("button"), function (b) { b.disabled = an; });
  }

  function feldFehler(id, text) {
    var el = $(id);
    el.textContent = text || "";
    el.classList.toggle("versteckt", !text);
  }

  function uhrzeitJetzt(iso) {
    return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- Aktueller Vorgang (ein Chip-Code) ----------
  var v = null; // { p, m, vorgang, handyzeit, ticket, bis, timer, person, startcodePflicht, unsicher, versuche }
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
    if (aktuell !== "s-pin" && aktuell !== "s-wer" && aktuell !== "s-anmelden" && aktuell !== "s-neu" &&
        aktuell !== "s-fehler") return false;
    zeigeFehler({ art: "neu_chip", text: "Zeit abgelaufen. Bitte das Handy noch einmal an den Chip halten." });
    return true;
  }

  function zeigeFehler(f, wiederholen) {
    if (f.art !== "netz" && f.art !== "eingabe") vorgangEnde();
    nochmal = wiederholen || null;
    $("fehler-titel").textContent = f.art === "neu_chip" ? "Bitte noch einmal" :
      f.art === "netz" ? "Keine Verbindung" : "Das hat nicht geklappt";
    $("fehler-text").textContent = f.art === "netz"
      ? "Keine Verbindung zum Server. Bitte prüfe dein Internet und tippe auf „Nochmal versuchen“."
      : f.text;
    $("fehler-nochmal").classList.toggle("versteckt", !wiederholen);
    zeige("s-fehler");
  }

  function zeigeOk(j) {
    vorgangEnde();
    vorgangAusSchlange();
    if (j.geraet) geraetSetzen(j.geraet);
    var schon = !!j.schon;
    $("ok-symbol").textContent = schon ? "i" : "✓";
    $("ok-symbol").className = schon ? "haken blau" : "haken";
    $("ok-titel").textContent = L.fertigTitel(j);
    var name = j.name || j.vorname || "";
    $("ok-text").textContent = schon ? "Du musst nichts weiter tun." + (name ? " Hallo " + name + "!" : "")
      : (name ? "Hallo " + name + "!" : "");
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
      var f = L.fehlerAuswerten(e.status, e.j);
      // Anfrage kam evtl. an (nur die Antwort fehlt) -> Code evtl. reserviert, erst nach Ablauf nachreichen
      if (f.art === "netz") { offlineSpeichern(true, !!g); return; }
      if (vorgangInSchlange()) {
        f = { art: f.art, code: f.code, text: f.text + " Dein gespeicherter Stempel bleibt im Handy und wird später gesendet." };
      }
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
      v.ticket = j.ticket;
      ablaufSetzen(j.gueltig_sek);
      schlangeReservierung(j.gueltig_sek);
      var art = L.artText(j.naechstes);
      $("pin-hallo").textContent = "Hallo " + (j.name || j.vorname || "");
      $("pin-als").textContent = "Als Nächstes: " + art;
      $("pin-los").textContent = art;
      $("pin").value = "";
      feldFehler("pin-fehler", "");
      var n = geraet() ? schlangeBereit().length : 0;
      $("pin-schlange").textContent = n ? "Mit deiner PIN wird auch " + L.anzahlText(n) + " gesendet." : "";
      $("pin-schlange").classList.toggle("versteckt", !n);
      zeige("s-pin");
      $("pin").focus();
      return;
    }
    if (j.schritt === "anmelden" && L.tokenOk(j.ticket)) {
      v.ticket = j.ticket;
      v.startcodePflicht = j.startcode_pflicht !== false;
      ablaufSetzen(j.gueltig_sek);
      schlangeReservierung(j.gueltig_sek);
      namenZeigen(Array.isArray(j.namen) ? j.namen : []);
      zeige("s-wer");
      return;
    }
    zeigeFehler({ art: "ende", text: "Unerwartete Antwort vom Server. Bitte noch einmal an den Chip halten." });
  }

  /** Antwort ging im Funkloch verloren, Ticket ist aber schon verbraucht -> gleiche Vorgangsnummer erneut "tippen". */
  function ergebnisNachholen(pin) {
    v.versuche = (v.versuche || 0) + 1;
    if (v.versuche > 2) {
      zeigeFehler({ art: "neu_chip", text: "Bitte das Handy noch einmal an den Chip halten." });
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
        if (!geraet()) {
          $("ok-text").textContent = "Beim nächsten Mal bitte noch einmal Namen und PIN eingeben.";
        }
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
      var f = L.fehlerAuswerten(e.status, e.j);
      zeigeFehler(f, f.art === "netz" ? function () { ergebnisNachholen(pin); } : null);
    });
  }

  // ---------- 2. stempeln (bekanntes Handy) ----------
  function pinLos() {
    if (beschaeftigt || ablaufPruefen()) return;
    var pin = $("pin").value.trim();
    if (!L.pinFormatOk(pin)) { feldFehler("pin-fehler", "Bitte deine 4-stellige PIN eingeben."); return; }
    feldFehler("pin-fehler", "");
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
          feldFehler("pin-fehler", "PIN falsch. Bitte noch einmal.");
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
    if (!g) { zeigeFehler({ art: "neu_chip", text: "Bitte das Handy noch einmal an den Chip halten." }); return; }
    sperren(true);
    mitWiederholung({ aktion: "stempeln", ticket: v.ticket, geraet: g, pin: pin }, 2).then(function (e) {
      sperren(false);
      if (e.status === 200) { pinMerken(pin); zeigeOk(e.j); return; }
      var f = L.fehlerAuswerten(e.status, e.j);
      if (f.art === "netz") {
        v.unsicher = true;
        zeigeFehler(f, function () { zeige("s-pin"); stempeln(pin); });
        return;
      }
      if (f.code === "verbraucht" && (v.unsicher || e.wiederholt)) { ergebnisNachholen(pin); return; }
      if (f.art === "eingabe") {
        $("pin").value = "";
        feldFehler("pin-fehler", f.text);
        zeige("s-pin");
        return;
      }
      if (f.art === "geraet") geraetLoeschen();
      zeigeFehler(f);
    });
  }

  // ---------- 3. Wer bist du? ----------
  function namenZeigen(namen) {
    var liste = $("wer-liste");
    liste.textContent = "";
    namen.forEach(function (n) {
      if (!n || typeof n.id !== "string" || typeof n.kurzname !== "string") return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "knopf zweit name";
      b.textContent = n.kurzname;
      b.setAttribute("data-suche", n.kurzname.toLowerCase());
      b.addEventListener("click", function () { nameGewaehlt(n); });
      liste.appendChild(b);
    });
    var anzahl = liste.children.length;
    $("wer-leer").classList.toggle("versteckt", anzahl > 0);
    $("wer-suche").value = "";
    $("wer-suche").classList.toggle("versteckt", anzahl <= 10);
  }

  function nameGewaehlt(n) {
    if (beschaeftigt || ablaufPruefen()) return;
    v.person = { id: n.id, kurzname: n.kurzname, pinNeu: !!n.pin_neu };
    $("an-name").textContent = n.kurzname;
    $("an-neu-teil").classList.toggle("versteckt", !v.person.pinNeu);
    $("an-startcode-teil").classList.toggle("versteckt", !(v.person.pinNeu && v.startcodePflicht));
    $("an-pin2-teil").classList.toggle("versteckt", !v.person.pinNeu);
    $("an-alt-teil").classList.toggle("versteckt", v.person.pinNeu);
    $("an-pin").value = "";
    $("an-pin2").value = "";
    $("an-startcode").value = "";
    feldFehler("an-fehler", "");
    zeige("s-anmelden");
  }

  function anLos() {
    if (beschaeftigt || ablaufPruefen()) return;
    var p = v.person;
    var pin = $("an-pin").value.trim();
    var pin2 = $("an-pin2").value.trim();
    var sc = $("an-startcode").value.trim();
    if (!L.pinFormatOk(pin)) { feldFehler("an-fehler", "Bitte eine 4-stellige PIN eingeben."); return; }
    var daten = { aktion: "anmelden", ticket: v.ticket, person_id: p.id, pin: pin };
    if (p.pinNeu) {
      if (pin !== pin2) { feldFehler("an-fehler", "Die beiden PINs sind verschieden. Bitte noch einmal."); return; }
      if (!L.pinErlaubt(pin)) {
        feldFehler("an-fehler", "Diese PIN ist zu einfach (z. B. 1234 oder 1111). Bitte eine andere wählen.");
        return;
      }
      if (v.startcodePflicht && !L.startcodeOk(sc)) {
        feldFehler("an-fehler", "Bitte den 6-stelligen Startcode aus dem Büro eingeben.");
        return;
      }
      daten.pin2 = pin2;
      if (v.startcodePflicht) daten.startcode = sc;
    }
    var g = geraet();
    if (g) daten.geraet = g;
    feldFehler("an-fehler", "");
    sperren(true);
    senden(daten).then(function (e) {
      sperren(false);
      if (e.status === 200) { nachAnmeldung(e.j, pin); return; }
      var f = L.fehlerAuswerten(e.status, e.j);
      if (f.art === "netz") {
        v.unsicher = true;
        zeigeFehler(f, function () { zeige("s-anmelden"); anLos(); });
        return;
      }
      if (f.code === "verbraucht" && v.unsicher) { ergebnisNachholen(null); return; }
      if (f.art === "eingabe") {
        $("an-pin").value = "";
        $("an-pin2").value = "";
        if (f.code === "startcode_falsch") $("an-startcode").value = "";
        feldFehler("an-fehler", f.text);
        zeige("s-anmelden");
        return;
      }
      zeigeFehler(f);
    });
  }

  function nachAnmeldung(j, pin) {
    zeigeOk(j); // speichert das neue Geraete-Token
    pinMerken(pin);
    // Offline-Stempel von vor der Anmeldung jetzt mitsenden
    if (geraet() && schlangeBereit().length) nachreichenAlles(pin);
  }

  // ---------- 4. Ich bin neu ----------
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
    var tel = $("neu-telefon").value.trim();
    var pin = $("neu-pin").value.trim();
    var pin2 = $("neu-pin2").value.trim();
    var fehlt = !vorname || !nachname ? "Bitte Vor- und Nachnamen eingeben (je 2–40 Buchstaben)." :
      !L.telefonNormalisieren(tel) ? "Bitte eine gültige Handynummer eingeben (z. B. 0171 1234567 oder +49 171 1234567)." :
      !neuArt ? "Bitte Vollzeit oder Minijob wählen." :
      !$("neu-whatsapp").checked ? "Bitte das Häkchen für die WhatsApp-Infos setzen – ohne geht die Anmeldung nicht." :
      !L.pinFormatOk(pin) ? "Bitte eine 4-stellige PIN festlegen." :
      pin !== pin2 ? "Die beiden PINs sind verschieden. Bitte noch einmal." :
      !L.pinErlaubt(pin) ? "Diese PIN ist zu einfach (z. B. 1234 oder 1111). Bitte eine andere wählen." : "";
    if (fehlt) { feldFehler("neu-fehler", fehlt); return; }
    feldFehler("neu-fehler", "");
    var daten = {
      aktion: "registrieren", ticket: v.ticket, vorname: vorname, nachname: nachname, art: neuArt,
      pin: pin, pin2: pin2, telefon: tel,
      whatsapp_ok: $("neu-whatsapp").checked === true // Pflicht-Haekchen (oben geprueft), Server will genau true
    };
    var g = geraet();
    if (g) daten.geraet = g;
    sperren(true);
    senden(daten).then(function (e) {
      sperren(false);
      if (e.status === 200) { nachAnmeldung(e.j, pin); return; }
      var f = L.fehlerAuswerten(e.status, e.j);
      if (f.art === "netz") {
        v.unsicher = true;
        zeigeFehler(f, function () { zeige("s-neu"); neuLos(); });
        return;
      }
      if (f.code === "verbraucht" && v.unsicher) { ergebnisNachholen(null); return; }
      if (f.art === "eingabe") {
        if (f.code === "pin_ungleich" || f.code === "pin_einfach") { $("neu-pin").value = ""; $("neu-pin2").value = ""; }
        feldFehler("neu-fehler", f.text);
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
      zeigeFehler({
        art: "ende",
        text: "Kein Internet – und die Seite darf im Handy nichts speichern (privater Modus?). " +
          "Der Stempel konnte nicht gespeichert werden. Bitte mit Internet noch einmal an den Chip halten."
      });
      return;
    }
    $("offline-titel").textContent = "Kein Internet – Stempel " + uhrzeitJetzt(v.handyzeit) + " gespeichert";
    $("offline-ohne-anmeldung").classList.toggle("versteckt", !!geraet());
    var ab = L.schlangeNaechsterVersuch(schlange().filter(function (x) { return x.vorgang === v.vorgang; }), Date.now());
    $("offline-warten").textContent = ab
      ? "Die Verbindung ist mitten im Senden abgebrochen. Darum wird dieser Stempel frühestens ab " + uhrzeitJetzt(ab) +
        " Uhr gesendet. Hast du vorher wieder Internet, tippe auf „Nochmal versuchen“."
      : "";
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
        var f = L.fehlerAuswerten(e.status, e.j);
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
      return { summe: summe, fehler: { art: "netz", code: "server", text: "" } };
    });
    return sendetSchlange;
  }

  function schlangeMelden(r) {
    var t = r.summe ? L.nachreichenText(r.summe) : "";
    if (r.fehler) {
      var rest = schlange().length;
      var warum = r.fehler.code === "pin_falsch" ? "PIN falsch – " :
        r.fehler.art === "netz" ? "Noch keine Verbindung – " : r.fehler.text + " ";
      if (rest) t = (t ? t + " " : "") + warum + L.anzahlText(rest) + " noch nicht gesendet.";
    }
    var info = $("schlange-info");
    info.textContent = t;
    info.classList.toggle("versteckt", !t);
    schlangeAnzeigen();
  }

  /** Karte „gespeicherte Stempel senden – PIN“ nur auf Start/Ergebnis/Fehler und nur mit Netz + angemeldetem Handy. */
  function schlangeAnzeigen() {
    var alle = schlange();
    var jetzt = Date.now();
    var teil = L.schlangeBereit(alle, jetzt);
    var n = teil.bereit.length;
    var zeigen = n > 0 && !!geraet() && !!MIT_SCHLANGE[aktuell] && navigator.onLine !== false && !sendetSchlange;
    $("schlange-titel").textContent = n ? L.anzahlText(n) + " senden" : "";
    $("s-schlange").classList.toggle("versteckt", !zeigen);
    // Eintraege nach Funkloch beim "tippen": erst nach Ablauf der Reservierung sendbar
    var w = teil.warten.length;
    var wZeigen = w > 0 && !!geraet() && !!MIT_SCHLANGE[aktuell];
    $("schlange-warten").textContent = wZeigen
      ? L.anzahlText(w) + " im Handy " + (w === 1 ? "wird" : "werden") + " frühestens ab " +
        uhrzeitJetzt(L.schlangeNaechsterVersuch(alle, jetzt)) + " Uhr gesendet – bitte die Seite dann (noch einmal) öffnen."
      : "";
    $("schlange-warten").classList.toggle("versteckt", !wZeigen);
    if (alle.length > 0 && !geraet() && aktuell === "s-start") {
      var info = $("schlange-info");
      if (!info.textContent) {
        info.textContent = L.anzahlText(alle.length) + " im Handy. " +
          (alle.length === 1 ? "Er wird" : "Sie werden") + " gesendet, sobald du dich am Chip angemeldet hast.";
        info.classList.remove("versteckt");
      }
    }
  }

  function schlangeLos() {
    if (beschaeftigt) return;
    var pin = $("schlange-pin").value.trim();
    if (!L.pinFormatOk(pin)) { feldFehler("schlange-fehler", "Bitte deine 4-stellige PIN eingeben."); return; }
    feldFehler("schlange-fehler", "");
    sperren(true);
    nachreichenAlles(pin).then(function (r) {
      sperren(false);
      $("schlange-pin").value = "";
      if (!r.fehler) pinMerken(pin);
      else if (r.fehler.code === "pin_falsch") feldFehler("schlange-fehler", "PIN falsch. Bitte noch einmal.");
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
    var info = $("schlange-info");
    info.textContent = (a.zuAlt.length === 1 ? "1 gespeicherter Stempel war" : a.zuAlt.length + " gespeicherte Stempel waren") +
      " älter als 3 Tage und konnte" + (a.zuAlt.length === 1 ? "" : "n") +
      " nicht mehr gesendet werden. Bitte im Büro melden.";
    info.classList.remove("versteckt");
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

  // B2: PIN/Startcode verdeckt. Normal per CSS (-webkit-text-security, Feld bleibt type=text -> kein Angebot
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
      var z = el.value.replace(/[^0-9]/g, "");
      if (z !== el.value) el.value = z;
    });
    if (los) el.addEventListener("keydown", function (ev) { if (ev.key === "Enter") los(); });
  }
  ziffernFeld("pin", pinLos);
  ziffernFeld("an-startcode");
  ziffernFeld("an-pin");
  ziffernFeld("an-pin2", anLos);
  ziffernFeld("neu-pin");
  ziffernFeld("neu-pin2");
  ziffernFeld("schlange-pin", schlangeLos);

  $("pin-los").addEventListener("click", pinLos);
  $("an-los").addEventListener("click", anLos);
  $("an-zurueck").addEventListener("click", function () { if (!ablaufPruefen()) zeige("s-wer"); });
  $("wer-neu").addEventListener("click", function () {
    if (ablaufPruefen()) return;
    feldFehler("neu-fehler", "");
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
  $("wer-suche").addEventListener("input", function () {
    var s = this.value.trim().toLowerCase();
    Array.prototype.forEach.call($("wer-liste").children, function (b) {
      b.classList.toggle("versteckt", !!s && b.getAttribute("data-suche").indexOf(s) < 0);
    });
  });

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
