"use strict";
// Stempeluhr MTU – reine Logik ohne Bildschirm (testbar mit Deno: webseite\tests\logik_test.js).
// Regeln 1:1 wie in supabase\functions\_shared\werkzeuge.ts, damit die Seite Eingabefehler schon VOR dem
// Senden erkennt (jedes Ticket erlaubt nur 3 Anfragen). Entscheidend bleibt immer der Server.
// Texte (24.11.2026): alle sichtbaren Texte kommen aus texte.js (window.StzTexte) ueber t(sprache, schluessel, werte);
// fehlt ein Text in der Sprache -> Deutsch, fehlt er ganz -> der Schluessel selbst.
(function (g) {
  var SPRACHEN = ["de", "tr", "ro", "ru", "fa", "prs"];
  var FSI = "⁨", PDI = "⁩"; // Unicode-Isolierung (wie <bdi>) fuer Uhrzeiten/Zahlen/Namen in RTL-Saetzen
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

  function pinFormatOk(pin) { return typeof pin === "string" && /^[0-9]{4}$/.test(ziffernWestlich(pin)); }
  function pinErlaubt(pin) {
    if (!pinFormatOk(pin)) return false;
    pin = ziffernWestlich(pin);
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

  /** Persische (۰-۹) und arabisch-indische (٠-٩) Ziffern -> 0-9 (wie ziffernWestlich in werkzeuge.ts). */
  function ziffernWestlich(roh) {
    if (typeof roh !== "string") return roh;
    return roh.replace(/[۰-۹٠-٩]/g, function (z) { return String((z.charCodeAt(0) & 0xf) % 10); });
  }

  function telefonNormalisieren(roh) {
    if (typeof roh !== "string" || roh.length > 40) return null;
    var t = ziffernWestlich(roh).trim().replace(/^\+(\d{1,3})\s*\(0\)/, "+$1").replace(/[\s/\-(). ]/g, "");
    if (t.indexOf("00") === 0) t = "+" + t.slice(2);
    else if (t.indexOf("0") === 0) t = "+49" + t.slice(1);
    t = t.replace(/^\+(49|43|41)0/, "+$1");
    if (t.indexOf("+49") === 0 && !/^\+49[0-9]{10,}$/.test(t)) return null;
    return /^\+[1-9][0-9]{7,14}$/.test(t) ? t : null;
  }

  // ---------- Sprachen (24.11.2026) ----------
  function spracheOk(s) { return typeof s === "string" && SPRACHEN.indexOf(s) >= 0; }

  /** Flagge, Name in eigener Schrift, Schreibrichtung, HTML-lang. prs (Dari) -> lang "fa-AF". */
  function sprachInfo(s) {
    var i = g.StzSprachen && g.StzSprachen[s];
    if (i) return i;
    var rtl = s === "fa" || s === "prs";
    return { flagge: "", name: String(s), dir: rtl ? "rtl" : "ltr", lang: s === "prs" ? "fa-AF" : String(s) };
  }

  /** Text oder null (Sprache, sonst Deutsch). */
  function textRoh(s, k) {
    var T = g.StzTexte || {};
    var a = T[s] && T[s][k];
    if (typeof a === "string" && a) return a;
    var b = T.de && T.de[k];
    return typeof b === "string" && b ? b : null;
  }

  /** Text mit Platzhaltern {n}, {zeit}, {name} … In RTL-Sprachen werden die Werte isoliert (FSI … PDI). */
  function t(s, k, werte) {
    var x = textRoh(s, k);
    if (x === null) return k;
    var rtl = sprachInfo(s).dir === "rtl";
    return x.replace(/\{(\w+)\}/g, function (m, n) {
      if (!werte || !Object.prototype.hasOwnProperty.call(werte, n)) return m;
      var v = String(werte[n]);
      return rtl ? FSI + v + PDI : v;
    });
  }

  /** Handy-Sprache (z. B. "fa-AF", "tr-TR") -> unser Code oder null. Dari: fa-AF/prs*; Persisch: fa*. */
  function spracheAusTag(tag) {
    if (typeof tag !== "string") return null;
    var x = tag.toLowerCase().replace(/_/g, "-");
    var h = x.split("-")[0];
    if (h === "prs" || x === "fa-af" || x.indexOf("fa-af-") === 0) return "prs";
    if (h === "fa") return "fa";
    if (h === "ro" || h === "mo") return "ro";
    if (h === "de" || h === "tr" || h === "ru") return h;
    return null;
  }

  /** E13: 1. Flagge von Hand  2. Sprache der erkannten Person  3. Handy-Sprache  4. Deutsch. */
  function spracheErmitteln(wahl, person, navigatorSprachen) {
    if (spracheOk(wahl)) return wahl;
    if (spracheOk(person)) return person;
    var l = Array.isArray(navigatorSprachen) ? navigatorSprachen : [navigatorSprachen];
    for (var i = 0; i < l.length; i++) {
      var s = spracheAusTag(l[i]);
      if (s) return s;
    }
    return "de";
  }

  function sprache(s) { return spracheOk(s) ? s : "de"; }

  // ---------- Antworten ----------
  function artText(art, s) { return t(sprache(s), art === "gehen" ? "gehen" : "kommen"); }

  /** Ueberschrift fuer schritt "fertig" (25.11.2026): „Eingestempelt um 07:47“ / „Ausgestempelt um 16:02“. */
  function fertigTitel(j, s) {
    var art = j && j.art === "gehen" ? "gehen" : "kommen";
    return t(sprache(s), (j && j.schon ? "schon_" : "erfasst_") + art, { zeit: (j && j.zeit) || "" });
  }

  /**
   * Zustand fuer den Stempel-Bildschirm aus tippen/bereit (25.11.2026): ein = eingestempelt (naechstes "gehen"),
   * seit = "HH:MM", bei Kommen an einem anderen Tag (Nachtschicht) "HH:MM (TT.MM.)", oder "" (alter Server ohne seit). Knopf: ein -> Ausstempeln, sonst Einstempeln.
   */
  function zustand(j) {
    var ein = !!j && j.naechstes === "gehen";
    var seit = ein && typeof j.seit === "string" && /^[0-9]{2}:[0-9]{2}( \([0-9]{2}\.[0-9]{2}\.\))?$/.test(j.seit) ? j.seit : "";
    return {
      ein: ein,
      seit: seit,
      text: ein ? (seit ? "zustand_ein" : "zustand_ein_ohne") : "zustand_aus",
      knopf: ein ? "knopf_aus" : "knopf_ein"
    };
  }

  var CODE_SCHLUESSEL = { veraltet: "f_verbraucht", ticket: "f_abgelaufen", gross: "f_zu_gross" };

  function restText(s, praefix, rest) {
    if (rest === 0) return t(s, praefix + "_0");
    if (rest === 1) return t(s, praefix + "_1");
    return t(s, praefix + "_n", { n: rest });
  }

  /**
   * Text zu einem ausgewerteten Fehler (E12): uebersetzt NUR nach code. Der Server-Text wird nur bei Deutsch
   * gezeigt; unbekannter Code -> Sammeltext. pin_falsch / anmeldung_falsch baut die Seite selbst aus rest.
   * f.schluessel = eigener Text der Seite, f.zusatz = Satz, der angehaengt wird.
   */
  function fehlerText(f, s) {
    s = sprache(s);
    var x;
    if (f.schluessel) x = t(s, f.schluessel, f.werte);
    else if (f.art === "netz") x = t(s, "netz_text");
    else if (f.code === "pin_falsch") x = f.rest === null || f.rest === undefined ? t(s, "pin_falsch") : restText(s, "pin_falsch", f.rest);
    else if (f.code === "anmeldung_falsch") x = restText(s, "anm_falsch", f.rest || 0) + " " + t(s, "anm_hinweis");
    else if (f.code === "abgelaufen" || f.code === "ticket") x = t(s, "f_abgelaufen");
    else if (s === "de" && f.server) x = f.server;
    else {
      var k = CODE_SCHLUESSEL[f.code] || "f_" + f.code;
      x = textRoh(s, k) !== null ? t(s, k) : t(s, "f_unbekannt");
    }
    if (f.zusatz) x += " " + t(s, f.zusatz);
    return x;
  }

  /**
   * HTTP-Fehler -> was die Seite tut. Liefert {art, code, rest, server, text}; text ist in `sprache` (Standard de)
   * und laesst sich mit fehlerText(f, andereSprache) neu bauen (Flagge gewechselt).
   * art: "eingabe" (gleicher Bildschirm, korrigieren), "neu_chip" (Vorgang vorbei, nochmal an den Chip),
   *      "geraet" (Token loeschen + neu an den Chip), "netz" (Verbindung/Server), "ende" (Text zeigen, fertig).
   */
  function fehlerAuswerten(status, j, spr) {
    var code = (j && typeof j.code === "string" && j.code) || "";
    var server = (j && typeof j.fehler === "string" && j.fehler) || "";
    var rest = j && typeof j.rest === "number" ? j.rest : null;
    var f;
    var eingabe = ["format", "name", "art", "telefon_ungueltig", "einverstaendnis_fehlt", "pin_ungleich", "pin_einfach",
      "startcode_fehlt", "startcode_falsch", "pin_vorhanden", "hinweis_fehlt", "passkey_falsch", "passkey_noetig"];
    if (status === 0 || status >= 500 || code === "server") f = { art: "netz", code: code || "server" };
    // 26.11.2026: gesperrtes Handy / Handy einer anderen Person -> Text, Token NICHT loeschen (sonst waere es „unbekannt“)
    else if (code === "geraet_abgelehnt" || code === "handy_vergeben") f = { art: "ende", code: code };
    else if (code === "passkey_falsch" && rest === 0) f = { art: "neu_chip", code: code, rest: rest };
    else if (status === 413) f = { art: "netz", code: "zu_gross" };
    else if (status === 400 && code === "ungueltig") f = { art: "ende", code: code };
    else if (code === "pin_falsch") f = { art: rest === 0 ? "neu_chip" : "eingabe", code: code, rest: rest };
    else if (code === "anmeldung_falsch") f = { art: rest === 0 || rest === null ? "neu_chip" : "eingabe", code: code, rest: rest };
    else if ((status === 400 || status === 401 || status === 409) && eingabe.indexOf(code) >= 0) f = { art: "eingabe", code: code };
    else if (code === "geraet") f = { art: "geraet", code: code };
    else if (code === "gesperrt" || code === "nicht_freigeschaltet") f = { art: "ende", code: code };
    else if (status === 410 || code === "abgelaufen" || code === "ticket") f = { art: "neu_chip", code: code || "abgelaufen" };
    else if (code === "verbraucht" || code === "veraltet" || code === "versuche") f = { art: "neu_chip", code: code };
    else if (status === 429) f = { art: "ende", code: code || "rate" };
    else f = { art: "ende", code: code || "unbekannt" };
    f.server = server;
    if (f.rest === undefined) f.rest = rest;
    f.text = fehlerText(f, spr);
    return f;
  }

  /** Text nach dem Nachreichen. „im Büro geprüft“ nur fuer Eintraege mit pruefen: true. */
  function nachreichenText(z, s) {
    s = sprache(s);
    var a = [];
    var pr = z.pruefen || 0;
    var n = z.gesendet || 0;
    if (n === 1) a.push(t(s, pr ? "g_1_p" : "g_1"));
    else if (n > 1) {
      a.push(pr >= n ? t(s, "g_n_alle", { n: n }) : pr === 1 ? t(s, "g_n_p1", { n: n }) :
        pr > 1 ? t(s, "g_n_pn", { n: n, p: pr }) : t(s, "g_n", { n: n }));
    }
    var sp = z.spaeter || 0;
    if (sp === 1) a.push(t(s, "sp_1"));
    else if (sp > 1) a.push(t(s, "sp_n", { n: sp }));
    var nicht = (z.verbraucht || 0) + (z.abgewiesen || 0);
    if (nicht === 1) a.push(t(s, "nicht_1"));
    else if (nicht > 1) a.push(t(s, "nicht_n", { n: nicht }));
    return a.join(" ");
  }

  function anzahlText(n, s) { return n === 1 ? t(sprache(s), "anzahl_1") : t(sprache(s), "anzahl_n", { n: n }); }

  // ---------- Sicherheit (26.11.2026): Passkey, Fotos, Pflichthinweis – PLAN-SICHERHEIT.md Kap. 7.2 ----------
  var RP_ID = "bayrak29.github.io";
  var B64URL = /^[A-Za-z0-9_-]*$/;
  var GESTEN = { daumen: "👍", zwei: "✌️", hand: "✋", finger: "☝️" };
  var FOTO_MAX_BYTES = 110 * 1024; // Server nimmt bis 150 KB, Body foto bis 160 KB (base64 = 4/3)
  var FOTO_QUALITAETEN = [0.7, 0.6, 0.45, 0.35];
  var FOTO_BREITE = 480;

  /** Fassung des Pflichthinweises (texte.js); der Server kennt die gueltigen Fassungen. */
  function hinweisVersion() {
    var v = g.StzHinweisVersion;
    return typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}[a-z]?$/.test(v) ? v : null;
  }

  /** base64url-Text -> Uint8Array, kaputt -> null. */
  function b64urlZuBytes(s) {
    if (typeof s !== "string" || !B64URL.test(s) || s.length % 4 === 1 || s.length > 20000) return null;
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin;
    try { bin = atob(b64); } catch (e) { return null; }
    var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  /** ArrayBuffer/Uint8Array (auch DataView) -> base64url ohne "=". null/undefined -> null. */
  function bytesZuB64url(b) {
    if (b === null || b === undefined) return null;
    var a;
    if (b instanceof Uint8Array) a = b;
    else if (b instanceof ArrayBuffer) a = new Uint8Array(b);
    else if (b && b.buffer instanceof ArrayBuffer) a = new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
    else return null;
    var s = "";
    for (var i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function kennungenWandeln(liste) {
    if (!Array.isArray(liste)) return [];
    var r = [];
    liste.slice(0, 300).forEach(function (x) {
      var id = typeof x === "string" ? x : x && x.id;
      var b = b64urlZuBytes(id);
      if (!b || b.length < 8) return;
      var e = { type: "public-key", id: b };
      if (x && Array.isArray(x.transports)) e.transports = x.transports.filter(function (t) { return typeof t === "string"; });
      r.push(e);
    });
    return r;
  }

  /**
   * Registrier-Optionen vom Server (JSON, Strings base64url) -> publicKey-Objekt fuer navigator.credentials.create.
   * Nimmt das Objekt direkt oder in {optionen} / {publicKey}. Kaputt -> null.
   */
  function registrierOptionenWandeln(json) {
    var o = json && (json.optionen || json.publicKey || json);
    if (!o || typeof o !== "object") return null;
    var ch = b64urlZuBytes(o.challenge);
    var uid = o.user && b64urlZuBytes(o.user.id);
    if (!ch || ch.length < 16 || !uid || !uid.length || !o.rp || typeof o.rp.name !== "string") return null;
    var auswahl = o.authenticatorSelection || {};
    return {
      challenge: ch,
      rp: { id: o.rp.id || RP_ID, name: o.rp.name },
      user: { id: uid, name: String(o.user.name || ""), displayName: String(o.user.displayName || o.user.name || "") },
      pubKeyCredParams: Array.isArray(o.pubKeyCredParams) && o.pubKeyCredParams.length ? o.pubKeyCredParams
        : [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      timeout: Number(o.timeout) || 120000,
      attestation: "none",
      excludeCredentials: kennungenWandeln(o.excludeCredentials),
      authenticatorSelection: {
        authenticatorAttachment: auswahl.authenticatorAttachment || "platform",
        residentKey: auswahl.residentKey || "required",
        requireResidentKey: true,
        userVerification: "required"
      }
    };
  }

  /**
   * Anmelde-/Stempel-Optionen -> publicKey-Objekt fuer navigator.credentials.get.
   * Server-Form aus tippen: {challenge, erlaubt:[credential_id…]} (Stempeln) bzw. {challenge} (Anmelden ohne Liste);
   * ebenso die Standard-Form {challenge, allowCredentials:[{id}], rpId, timeout}. Kaputt -> null.
   */
  function anmeldeOptionenWandeln(json) {
    var o = json && (json.optionen || json.publicKey || json);
    if (!o || typeof o !== "object") return null;
    var ch = b64urlZuBytes(o.challenge);
    if (!ch || ch.length < 16) return null;
    var r = { challenge: ch, rpId: o.rpId || RP_ID, timeout: Number(o.timeout) || 120000, userVerification: "required" };
    var erlaubt = kennungenWandeln(o.erlaubt || o.allowCredentials);
    if (erlaubt.length) r.allowCredentials = erlaubt;
    return r;
  }

  /** Antwort von create()/get() -> JSON fuer den Server (Format wie @simplewebauthn). Kaputt -> null. */
  function credentialZuJson(cred) {
    if (!cred || typeof cred !== "object" || !cred.response) return null;
    var r = cred.response;
    var id = bytesZuB64url(cred.rawId);
    if (!id) return null;
    var antwort = { clientDataJSON: bytesZuB64url(r.clientDataJSON) };
    if (r.attestationObject) {
      antwort.attestationObject = bytesZuB64url(r.attestationObject);
      try { if (typeof r.getTransports === "function") antwort.transports = r.getTransports(); } catch (e) { /* egal */ }
    } else {
      antwort.authenticatorData = bytesZuB64url(r.authenticatorData);
      antwort.signature = bytesZuB64url(r.signature);
      var uh = bytesZuB64url(r.userHandle);
      if (uh) antwort.userHandle = uh;
      if (!antwort.authenticatorData || !antwort.signature) return null;
    }
    if (!antwort.clientDataJSON) return null;
    var ext = {};
    try { if (typeof cred.getClientExtensionResults === "function") ext = cred.getClientExtensionResults() || {}; } catch (e) { /* egal */ }
    var j = { id: id, rawId: id, type: "public-key", response: antwort, clientExtensionResults: ext };
    if (typeof cred.authenticatorAttachment === "string") j.authenticatorAttachment = cred.authenticatorAttachment;
    return j;
  }

  /** Kann das Handy Face ID / Fingerabdruck (Plattform-Passkey mit Pruefung)? Promise<boolean>, wirft nie. */
  function kannPasskey(w, nav) {
    try {
      var pkc = w && w.PublicKeyCredential;
      if (!pkc || typeof pkc.isUserVerifyingPlatformAuthenticatorAvailable !== "function" || !nav || !nav.credentials ||
          typeof nav.credentials.create !== "function" || typeof nav.credentials.get !== "function") {
        return Promise.resolve(false);
      }
      return Promise.resolve(pkc.isUserVerifyingPlatformAuthenticatorAvailable())
        .then(function (x) { return x === true; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  function gesteOk(x) { return typeof x === "string" && Object.prototype.hasOwnProperty.call(GESTEN, x); }
  /** {geste} vom Server -> Gesten-Schluessel (unbekannt -> "daumen"), kein Foto verlangt -> null. */
  function fotoGeste(f) {
    if (!f || typeof f !== "object") return null;
    return gesteOk(f.geste) ? f.geste : "daumen";
  }

  /**
   * Entscheidungstabelle (Kap. 7.2). j = Antwort von tippen ("pin") bzw. Anmeldung ("bereit").
   * z = {fotoErledigt, kannPasskey, passkeyGefragt, pinStatt, passkeyAnmeldung, mitPinFeld}.
   * Phase "bereit" (gleich nach der Anmeldung): {schritt: "foto", geste} -> {schritt: "passkey"} -> {schritt: "knopf"}.
   * Phase Knopf (z.knopf = true): {weg: "passkey"|"pin"|"anmeldung"|"passkey_anmeldung", geste|null}.
   */
  function naechsterSchritt(j, z) {
    j = j || {};
    z = z || {};
    if (z.knopf) {
      var pk = !z.pinStatt && z.kannPasskey && !!anmeldeOptionenWandeln(j.passkey);
      var weg = pk ? "passkey" : z.passkeyAnmeldung ? "passkey_anmeldung" : z.mitPinFeld === false ? "anmeldung" : "pin";
      var geste = null;
      if (!z.fotoErledigt) geste = fotoGeste(j.foto) || (weg === "pin" || weg === "anmeldung" ? fotoGeste(j.foto_bei_pin) : null);
      return { weg: weg, geste: geste };
    }
    if (j.schritt === "bereit") {
      if (!z.fotoErledigt && fotoGeste(j.foto)) return { schritt: "foto", geste: fotoGeste(j.foto) };
      if (j.passkey_moeglich === true && z.kannPasskey && !z.passkeyGefragt) return { schritt: "passkey" };
    }
    return { schritt: "knopf" };
  }

  /** Naechste JPEG-Qualitaet: passt -> {ok}, zu gross -> {q: kleiner}, auch bei 0.35 zu gross -> {aufgeben}. */
  function fotoQualitaet(bytes, q) {
    if (typeof bytes === "number" && bytes > 0 && bytes <= FOTO_MAX_BYTES) return { ok: true };
    for (var i = 0; i < FOTO_QUALITAETEN.length; i++) if (FOTO_QUALITAETEN[i] < q - 1e-9) return { q: FOTO_QUALITAETEN[i] };
    return { aufgeben: true };
  }

  function zwei(n) { return (n < 10 ? "0" : "") + n; }
  /** Band unten im Foto: „24.11.2026 07:47 · MTU Werk 1 · 👍“ (Handyzeit; massgeblich ist die Serverzeit). */
  function bildText(datum, ort, geste) {
    var d = datum instanceof Date && !isNaN(datum.getTime()) ? datum : new Date();
    var teile = [zwei(d.getDate()) + "." + zwei(d.getMonth() + 1) + "." + d.getFullYear() + " " +
      zwei(d.getHours()) + ":" + zwei(d.getMinutes())];
    var o = typeof ort === "string" ? ort.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 40) : "";
    if (o) teile.push(o);
    if (gesteOk(geste)) teile.push(GESTEN[geste]);
    return teile.join(" · ");
  }

  g.StzLogik = {
    RP_ID: RP_ID,
    FOTO_BREITE: FOTO_BREITE,
    FOTO_QUALITAETEN: FOTO_QUALITAETEN,
    hinweisVersion: hinweisVersion,
    b64urlZuBytes: b64urlZuBytes,
    bytesZuB64url: bytesZuB64url,
    registrierOptionenWandeln: registrierOptionenWandeln,
    anmeldeOptionenWandeln: anmeldeOptionenWandeln,
    credentialZuJson: credentialZuJson,
    kannPasskey: kannPasskey,
    fotoGeste: fotoGeste,
    naechsterSchritt: naechsterSchritt,
    fotoQualitaet: fotoQualitaet,
    bildText: bildText,
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
    ziffernWestlich: ziffernWestlich,
    artText: artText,
    fertigTitel: fertigTitel,
    zustand: zustand,
    fehlerAuswerten: fehlerAuswerten,
    fehlerText: fehlerText,
    nachreichenText: nachreichenText,
    anzahlText: anzahlText,
    SPRACHEN: SPRACHEN,
    spracheOk: spracheOk,
    sprachInfo: sprachInfo,
    textRoh: textRoh,
    t: t,
    spracheAusTag: spracheAusTag,
    spracheErmitteln: spracheErmitteln
  };
})(typeof window !== "undefined" ? window : globalThis);
