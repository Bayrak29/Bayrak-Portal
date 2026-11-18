"use strict";
// Stempeluhr MTU – reine Logik ohne Bildschirm (testbar mit Deno: webseite\tests\logik_test.js).
// Regeln 1:1 wie in supabase\functions\_shared\werkzeuge.ts, damit die Seite Eingabefehler schon VOR dem
// Senden erkennt (jedes Ticket erlaubt nur 3 Anfragen). Entscheidend bleibt immer der Server.
(function (g) {
  var SCHLANGE_MAX = 50; // Bauplan 6.2
  var NACHREICHEN_JE_ANFRAGE = 20; // API 1.5
  var ZU_ALT_MS = 72 * 3600 * 1000; // Server weist aelter als 72 Std. ab (M1)
  // Reservierung nach "tippen" (API 1.1/1.5): bekanntes Handy 2 Min., Anmeldung 10 Min. Ging die Antwort im Funkloch
  // verloren, ist der Code evtl. schon reserviert -> erst nach Ablauf nachreichen, sonst "benutzt" und weg.
  var RESERVIERUNG_PIN_MS = 120 * 1000;
  var RESERVIERUNG_ANMELDEN_MS = 600 * 1000;
  var SICHERHEIT_MS = 30 * 1000; // Laufzeit der Anfrage + Wiederholung
  var MAX_WARTEN_MS = RESERVIERUNG_ANMELDEN_MS + 2 * SICHERHEIT_MS; // mehr kann nie legitim sein (Uhr verstellt)

  var HEX32 = /^[0-9A-Fa-f]{32}$/;
  var HEX16 = /^[0-9A-Fa-f]{16}$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var TOKEN = /^[A-Za-z0-9_-]{43}$/;

  /** "#p=…&m=…" -> {p, m} oder null. Nur genau 32/16 Hex-Zeichen werden angenommen. */
  function codeAusHash(hash) {
    if (typeof hash !== "string" || hash.length > 200) return null;
    var roh = hash.replace(/^#/, "");
    var p = null, m = null;
    roh.split("&").forEach(function (teil) {
      var i = teil.indexOf("=");
      if (i < 0) return;
      var k = teil.slice(0, i), v = teil.slice(i + 1);
      if (k === "p") p = v;
      else if (k === "m") m = v;
    });
    if (!p || !m || !HEX32.test(p) || !HEX16.test(m)) return null;
    return { p: p, m: m };
  }

  /** Vorgangsnummer (UUID v4). crypto.randomUUID gibt es auf aelteren iPhones (< iOS 15.4) nicht. */
  function neueVorgangsId(c) {
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function eintragOk(e) {
    return !!e && typeof e === "object" && HEX32.test(e.p) && HEX16.test(e.m) && UUID.test(e.vorgang) &&
      typeof e.handyzeit === "string" && Number.isFinite(Date.parse(e.handyzeit));
  }

  function zeitpunkt(x) { return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0; }

  /** Eintrag fuer die Warteschlange: Code + Zeit, dazu nur bei moeglicher Reservierung ab/rbis (ms, Handyuhr). */
  function eintragBauen(e, ab, rbis) {
    var n = { p: e.p, m: e.m, vorgang: e.vorgang, handyzeit: e.handyzeit };
    if (zeitpunkt(ab)) n.ab = ab;
    if (zeitpunkt(rbis)) n.rbis = rbis;
    return n;
  }

  /**
   * Netzfehler bei "tippen": Anfrage kam evtl. an, Code ist dann reserviert. ab = fruehestens nachreichen,
   * rbis = bis dahin kann die Reservierung hoechstens laufen (mit Token kann der Server trotzdem "anmelden" = 10 Min.
   * geantwortet haben, wenn das Token nicht mehr gilt).
   */
  function reservierungNachNetzfehler(jetzt, mitGeraet) {
    return {
      ab: jetzt + (mitGeraet ? RESERVIERUNG_PIN_MS : RESERVIERUNG_ANMELDEN_MS) + SICHERHEIT_MS,
      rbis: jetzt + RESERVIERUNG_ANMELDEN_MS + SICHERHEIT_MS
    };
  }

  /** Erneutes "tippen" mit derselben vorgang hat ein Ticket geliefert: Reservierung laeuft gueltig_sek ab jetzt. */
  function reservierungMitTicket(jetzt, gueltigSek) {
    var ms = Math.min(RESERVIERUNG_ANMELDEN_MS, Math.max(5, Number(gueltigSek) || RESERVIERUNG_ANMELDEN_MS / 1000) * 1000);
    return { ab: jetzt + ms + SICHERHEIT_MS, rbis: jetzt + ms + SICHERHEIT_MS };
  }

  /** Warteschlange aus localStorage-Text; Kaputtes wird still verworfen (nie eine Ausnahme). */
  function schlangeLesen(text) {
    if (!text) return [];
    var a;
    try { a = JSON.parse(text); } catch (e) { return []; }
    if (!Array.isArray(a)) return [];
    return a.filter(eintragOk).map(function (e) { return eintragBauen(e, zeitpunkt(e.ab), zeitpunkt(e.rbis)); });
  }

  /**
   * Neuen Offline-Tipp anhaengen; gleicher Code oder gleiche Vorgangsnummer nur einmal; max. 50 (aelteste fallen weg).
   * Gleiche Vorgangsnummer erneut: ab/rbis werden nie verkuerzt (die spaeteste moegliche Reservierung zaehlt).
   */
  function schlangeHinzu(liste, e) {
    var alt = null;
    var neu = liste.filter(function (x) {
      if (x.vorgang === e.vorgang) { alt = x; return false; }
      return !(x.p.toLowerCase() === e.p.toLowerCase() && x.m.toLowerCase() === e.m.toLowerCase());
    });
    neu.push(eintragBauen(e,
      Math.max(zeitpunkt(alt && alt.ab), zeitpunkt(e.ab)),
      Math.max(zeitpunkt(alt && alt.rbis), zeitpunkt(e.rbis))));
    neu.sort(function (a, b) { return Date.parse(a.handyzeit) - Date.parse(b.handyzeit); });
    while (neu.length > SCHLANGE_MAX) neu.shift();
    return neu;
  }

  /** Eintraege aelter als 72 Std. nimmt der Server nicht mehr an -> aussortieren und melden. */
  function schlangeAussortieren(liste, jetzt) {
    var behalten = [], zuAlt = [];
    liste.forEach(function (e) {
      (jetzt - Date.parse(e.handyzeit) > ZU_ALT_MS ? zuAlt : behalten).push(e);
    });
    return { behalten: behalten, zuAlt: zuAlt };
  }

  /** Darf jetzt gesendet werden? (ab vorbei; ab unplausibel weit in der Zukunft = Uhr verstellt -> senden) */
  function eintragBereit(e, jetzt) {
    var ab = zeitpunkt(e.ab);
    return !ab || ab <= jetzt || ab - jetzt > MAX_WARTEN_MS;
  }

  /** Teilt in sofort sendbare und noch wartende (Reservierung koennte noch laufen). */
  function schlangeBereit(liste, jetzt) {
    var bereit = [], warten = [];
    liste.forEach(function (e) { (eintragBereit(e, jetzt) ? bereit : warten).push(e); });
    return { bereit: bereit, warten: warten };
  }

  /** Fruehester Sendezeitpunkt der wartenden Eintraege (0 = keiner wartet). */
  function schlangeNaechsterVersuch(liste, jetzt) {
    var t = 0;
    liste.forEach(function (e) {
      if (!eintragBereit(e, jetzt) && (!t || e.ab < t)) t = e.ab;
    });
    return t;
  }

  /** Aelteste zuerst, je Anfrage hoechstens 20. Gesendet werden nur p, m, vorgang, handyzeit (API 1.5). */
  function schlangeStueck(liste, n) {
    var k = liste.slice().sort(function (a, b) { return Date.parse(a.handyzeit) - Date.parse(b.handyzeit); });
    return k.slice(0, n || NACHREICHEN_JE_ANFRAGE).map(function (e) { return eintragBauen(e, 0, 0); });
  }

  /**
   * Nach HTTP 200 auf "nachreichen": gesendete Eintraege raus (API: egal welcher Status), nur Netz-/5xx-Fehler
   * behalten sie. Ausnahme Funkloch beim "tippen": "benutzt", solange die eigene Reservierung (rbis) noch laufen
   * koennte -> Eintrag bleibt und wird nach Ablauf noch einmal gesendet; erst ein erneutes "benutzt" danach
   * entfernt ihn. pruefen: true = gespeichert, aber im Buero zu pruefen. Liefert Rest + Zaehler fuer die Meldung.
   */
  function schlangeNachErgebnis(liste, gesendet, ergebnisse, jetzt) {
    if (typeof jetzt !== "number") jetzt = Date.now();
    var weg = {}, spaeter = {}, gespeichert = {};
    gesendet.forEach(function (e) { weg[e.vorgang] = true; });
    liste.forEach(function (e) { gespeichert[e.vorgang] = e; });
    var z = { gesendet: 0, pruefen: 0, verbraucht: 0, abgewiesen: 0, spaeter: 0 };
    (Array.isArray(ergebnisse) ? ergebnisse : []).forEach(function (r) {
      var s = r && r.status;
      var e = r && typeof r.vorgang === "string" && weg[r.vorgang] ? gespeichert[r.vorgang] : null;
      if (s === "ok" || s === "schon") {
        z.gesendet++;
        if (r.pruefen === true) z.pruefen++;
      } else if (s === "abgewiesen") z.abgewiesen++;
      else if (s === "benutzt" && e && zeitpunkt(e.rbis) > jetzt) {
        // nie weiter als die laengste Reservierung warten (verstellte Uhr) -> beim naechsten "benutzt" sicher weg
        spaeter[e.vorgang] = Math.min(e.rbis, jetzt + RESERVIERUNG_ANMELDEN_MS + SICHERHEIT_MS);
        z.spaeter++;
      } else z.verbraucht++; // benutzt / ungueltig
    });
    var rest = [];
    liste.forEach(function (e) {
      if (spaeter[e.vorgang]) rest.push(eintragBauen(e, spaeter[e.vorgang], spaeter[e.vorgang]));
      else if (!weg[e.vorgang]) rest.push(e);
    });
    return { rest: rest, zaehler: z };
  }

  // ---------- Eingaben (gleiche Regeln wie der Server) ----------
  var TRIVIALE_PINS = ["1234", "2345", "3456", "4567", "5678", "6789", "0123",
    "4321", "5432", "6543", "7654", "8765", "9876", "3210",
    "1212", "1122", "1010", "2580", "0852", "1004", "2000", "2020", "1999"];

  function pinFormatOk(pin) { return typeof pin === "string" && /^[0-9]{4}$/.test(pin); }
  function pinErlaubt(pin) {
    if (!pinFormatOk(pin)) return false;
    if (/^(\d)\1{3}$/.test(pin)) return false;
    return TRIVIALE_PINS.indexOf(pin) < 0;
  }
  function startcodeOk(v) { return typeof v === "string" && /^[0-9]{6}$/.test(v); }
  function tokenOk(t) { return typeof t === "string" && TOKEN.test(t); }

  function nameBereinigen(roh) {
    if (typeof roh !== "string" || roh.length > 200) return null;
    var n = roh.normalize("NFC")
      .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, "")
      .replace(/[<>"'`\\{}\[\]|;$]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (n.length < 2 || n.length > 40) return null;
    if (!/^\p{L}[\p{L}\p{M} .\-]*$/u.test(n)) return null;
    return n;
  }

  function telefonNormalisieren(roh) {
    if (typeof roh !== "string" || roh.length > 40) return null;
    var t = roh.trim().replace(/^\+(\d{1,3})\s*\(0\)/, "+$1").replace(/[\s/\-(). ]/g, "");
    if (t.indexOf("00") === 0) t = "+" + t.slice(2);
    else if (t.indexOf("0") === 0) t = "+49" + t.slice(1);
    t = t.replace(/^\+(49|43|41)0/, "+$1");
    if (t.indexOf("+49") === 0 && !/^\+49[0-9]{10,}$/.test(t)) return null;
    return /^\+[1-9][0-9]{7,14}$/.test(t) ? t : null;
  }

  // ---------- Antworten ----------
  function artText(art) { return art === "gehen" ? "Gehen" : "Kommen"; }

  /** Ueberschrift fuer schritt "fertig". */
  function fertigTitel(j) {
    var a = artText(j && j.art), z = (j && j.zeit) || "";
    return j && j.schon ? "Schon erfasst: " + a + " " + z : a + " " + z + " erfasst";
  }

  /**
   * HTTP-Fehler -> was die Seite tut.
   * art: "eingabe" (gleicher Bildschirm, korrigieren), "neu_chip" (Vorgang vorbei, nochmal an den Chip),
   *      "geraet" (Token loeschen + neu an den Chip), "netz" (Verbindung/Server), "ende" (Text zeigen, fertig).
   */
  function fehlerAuswerten(status, j) {
    var code = (j && j.code) || "";
    var text = (j && typeof j.fehler === "string" && j.fehler) || "";
    if (status === 0 || status >= 500 || code === "server") {
      return { art: "netz", code: code || "server", text: "Keine Verbindung zum Server." };
    }
    if (status === 413) return { art: "netz", code: "gross", text: "Anfrage zu groß." };
    var eingabe = ["format", "name", "art", "telefon_ungueltig", "einverstaendnis_fehlt", "pin_ungleich", "pin_einfach",
      "startcode_fehlt"];
    if (status === 400 && code === "ungueltig") {
      return { art: "ende", code: code, text: text || "Dieser Chip wird nicht erkannt. Bitte im Büro melden." };
    }
    if (status === 400 && code === "einverstaendnis_fehlt") {
      return { art: "eingabe", code: code, text: text || "Bitte bestätigen, dass wir dich per WhatsApp erreichen dürfen." };
    }
    if (status === 400 && eingabe.indexOf(code) >= 0) return { art: "eingabe", code: code, text: text || "Bitte Eingabe prüfen." };
    if (code === "pin_falsch") {
      var rest = j && typeof j.rest === "number" ? j.rest : null;
      return { art: rest === 0 ? "neu_chip" : "eingabe", code: code, rest: rest, text: text || "PIN falsch." };
    }
    if (code === "startcode_falsch") {
      return { art: "eingabe", code: code, text: text || "Startcode falsch oder abgelaufen. Bitte im Büro einen neuen holen." };
    }
    if (code === "geraet") {
      return { art: "geraet", code: code, text: text || "Dieses Handy ist nicht mehr angemeldet. Bitte das Handy noch einmal an den Chip halten." };
    }
    if (code === "gesperrt") {
      return { art: "ende", code: code, text: text || "Zu viele falsche Versuche. Bitte in 15 Minuten erneut – oder im Büro melden." };
    }
    if (code === "nicht_freigeschaltet") {
      return { art: "ende", code: code, text: text || "Du bist nicht freigeschaltet. Bitte im Büro melden." };
    }
    if (code === "pin_vorhanden") {
      return { art: "eingabe", code: code, text: text || "Für diesen Namen ist schon eine PIN festgelegt – bitte im Büro melden." };
    }
    if (status === 410 || code === "abgelaufen" || code === "ticket") {
      return { art: "neu_chip", code: code || "abgelaufen", text: "Zeit abgelaufen. Bitte das Handy noch einmal an den Chip halten." };
    }
    if (code === "verbraucht" || code === "veraltet") {
      return { art: "neu_chip", code: code, text: text || "Dieser Code ist schon verbraucht. Bitte das Handy noch einmal an den Chip halten." };
    }
    if (code === "versuche") {
      return { art: "neu_chip", code: code, text: text || "Zu viele Versuche. Bitte das Handy noch einmal an den Chip halten." };
    }
    if (code === "name_existiert") {
      return { art: "ende", code: code, text: text || "Dieser Name ist schon angemeldet. Bitte im Büro melden." };
    }
    if (status === 429) return { art: "ende", code: code || "rate", text: text || "Zu viele Versuche. Bitte später erneut." };
    return { art: "ende", code: code || "unbekannt", text: text || "Das hat nicht geklappt. Bitte im Büro melden." };
  }

  /** Text nach dem Nachreichen. „im Büro geprüft“ nur fuer Eintraege mit pruefen: true. */
  function nachreichenText(z) {
    var t = [];
    var pr = z.pruefen || 0;
    if (z.gesendet === 1) {
      t.push(pr ? "1 gespeicherter Stempel wurde gesendet – er wird im Büro geprüft." : "1 gespeicherter Stempel wurde gesendet.");
    } else if (z.gesendet > 1) {
      t.push(z.gesendet + " gespeicherte Stempel wurden gesendet" + (
        pr >= z.gesendet ? " – sie werden im Büro geprüft." :
        pr === 1 ? ", davon wird 1 im Büro geprüft." :
        pr > 1 ? ", davon werden " + pr + " im Büro geprüft." : "."));
    }
    var sp = z.spaeter || 0;
    if (sp === 1) t.push("1 gespeicherter Stempel wird in ein paar Minuten noch einmal gesendet.");
    else if (sp > 1) t.push(sp + " gespeicherte Stempel werden in ein paar Minuten noch einmal gesendet.");
    var nicht = z.verbraucht + z.abgewiesen;
    if (nicht === 1) t.push("1 gespeicherter Stempel konnte nicht mehr angenommen werden – bitte im Büro melden, falls er fehlt.");
    else if (nicht > 1) t.push(nicht + " gespeicherte Stempel konnten nicht mehr angenommen werden – bitte im Büro melden, falls einer fehlt.");
    return t.join(" ");
  }

  function anzahlText(n) { return n === 1 ? "1 gespeicherter Stempel" : n + " gespeicherte Stempel"; }

  g.StzLogik = {
    SCHLANGE_MAX: SCHLANGE_MAX,
    NACHREICHEN_JE_ANFRAGE: NACHREICHEN_JE_ANFRAGE,
    codeAusHash: codeAusHash,
    neueVorgangsId: neueVorgangsId,
    schlangeLesen: schlangeLesen,
    schlangeHinzu: schlangeHinzu,
    schlangeAussortieren: schlangeAussortieren,
    schlangeStueck: schlangeStueck,
    schlangeBereit: schlangeBereit,
    schlangeNaechsterVersuch: schlangeNaechsterVersuch,
    reservierungNachNetzfehler: reservierungNachNetzfehler,
    reservierungMitTicket: reservierungMitTicket,
    schlangeNachErgebnis: schlangeNachErgebnis,
    pinFormatOk: pinFormatOk,
    pinErlaubt: pinErlaubt,
    startcodeOk: startcodeOk,
    tokenOk: tokenOk,
    nameBereinigen: nameBereinigen,
    telefonNormalisieren: telefonNormalisieren,
    artText: artText,
    fertigTitel: fertigTitel,
    fehlerAuswerten: fehlerAuswerten,
    nachreichenText: nachreichenText,
    anzahlText: anzahlText
  };
})(typeof window !== "undefined" ? window : globalThis);
