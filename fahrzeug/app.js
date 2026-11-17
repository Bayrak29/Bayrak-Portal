"use strict";
(function () {
  var API = "https://vzrvncxmleshwgtbvrtc.supabase.co/functions/v1/fahrt";
  var MAX_FOTOS = 40;
  var MAX_SEITE = 1600;
  var QUALITAET = 0.8;

  var $ = function (id) { return document.getElementById(id); };
  var schritte = ["laden", "fehler", "schritt-wahl", "schritt-erfassen", "schritt-senden", "schritt-ok"];
  function zeige(id) {
    schritte.forEach(function (s) { $(s).classList.toggle("versteckt", s !== id); });
    window.scrollTo(0, 0);
  }
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
      try { sessionStorage.setItem("fz_token", token); } catch (e) {}
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
      return true;
    }
    if (!token) { try { token = sessionStorage.getItem("fz_token") || ""; } catch (e) {} }
    return false;
  }
  tokenLesen();
  // Erneuter Scan bei offener Seite aendert nur den #-Teil -> sauber neu laden
  window.addEventListener("hashchange", function () {
    if (tokenLesen()) location.reload();
  });

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
        if (!r.ok) throw new Error(j.fehler || ("Fehler " + r.status));
        return j;
      });
    }, function () {
      throw new Error("Keine Internetverbindung. Bitte erneut versuchen.");
    });
  }

  function zeitText(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }) +
      ", " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
  }

  // ---- Zustand ----
  var phase = "abholung";
  var fotos = []; // { blob, url }

  function fotoZahlAktualisieren() {
    var n = fotos.length;
    $("foto-zahl").textContent = n === 0 ? "Noch kein Foto." : (n === 1 ? "1 Foto" : n + " Fotos");
    $("knopf-fertig").disabled = n === 0 || $("name").value.trim().length < 2;
    $("knopf-foto").disabled = n >= MAX_FOTOS;
  }

  function fotoAnzeigen(eintrag) {
    var kachel = document.createElement("div");
    kachel.className = "foto";
    var img = document.createElement("img");
    img.alt = "Foto";
    img.src = eintrag.url;
    var weg = document.createElement("button");
    weg.type = "button";
    weg.setAttribute("aria-label", "Foto entfernen");
    weg.textContent = "✕";
    weg.addEventListener("click", function () {
      var i = fotos.indexOf(eintrag);
      if (i >= 0) fotos.splice(i, 1);
      URL.revokeObjectURL(eintrag.url);
      kachel.remove();
      fotoZahlAktualisieren();
    });
    kachel.appendChild(img);
    kachel.appendChild(weg);
    $("fotos").appendChild(kachel);
  }

  function bildLaden(datei) {
    if (window.createImageBitmap) {
      return createImageBitmap(datei, { imageOrientation: "from-image" }).catch(function () {
        return createImageBitmap(datei);
      });
    }
    return new Promise(function (ok, nein) {
      var img = new Image();
      var u = URL.createObjectURL(datei);
      img.onload = function () { URL.revokeObjectURL(u); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(u); nein(new Error("Bild nicht lesbar")); };
      img.src = u;
    });
  }

  function verkleinern(datei) {
    return bildLaden(datei).then(function (bild) {
      var b = bild.width, h = bild.height;
      var f = Math.min(1, MAX_SEITE / Math.max(b, h));
      var c = document.createElement("canvas");
      c.width = Math.round(b * f);
      c.height = Math.round(h * f);
      c.getContext("2d").drawImage(bild, 0, 0, c.width, c.height);
      if (bild.close) bild.close();
      return new Promise(function (ok, nein) {
        c.toBlob(function (blob) {
          c.width = c.height = 0;
          if (blob) ok(blob); else nein(new Error("Bild konnte nicht verarbeitet werden"));
        }, "image/jpeg", QUALITAET);
      });
    });
  }

  function hochladen(url, blob) {
    var versuch = 0;
    function los() {
      versuch++;
      return fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
        credentials: "omit",
        referrerPolicy: "no-referrer"
      }).then(function (r) {
        if (!r.ok && r.status !== 409) throw new Error("Upload " + r.status);
      }).catch(function (e) {
        if (versuch < 3) return new Promise(function (w) { setTimeout(w, 1500 * versuch); }).then(los);
        throw new Error("Foto konnte nicht hochgeladen werden. Bitte Internet prüfen und erneut auf Fertig tippen.");
      });
    }
    return los();
  }

  function erfassenStarten(neuePhase) {
    phase = neuePhase;
    $("phase-titel").textContent = phase === "abholung" ? "Abholung" : "Rückgabe";
    try { $("name").value = localStorage.getItem("fz_name") || ""; } catch (e) {}
    fotoZahlAktualisieren();
    zeige("schritt-erfassen");
  }

  // ---- Ablauf ----
  function start() {
    if (!token) {
      fehler("Bitte den NFC-Aufkleber oder QR-Code im Fahrzeug scannen.");
      return;
    }
    zeige("laden");
    anfrage({ aktion: "status" }).then(function (j) {
      $("fz-name").textContent = j.fahrzeug.bezeichnung;
      $("fz-kz").textContent = j.fahrzeug.kennzeichen;
      var u = j.unterwegs;
      $("unterwegs-info").classList.toggle("versteckt", !u);
      $("knopf-abholen").classList.toggle("versteckt", !!u);
      $("knopf-zurueck").classList.toggle("versteckt", !u);
      $("knopf-abholen-trotzdem").classList.toggle("versteckt", !u);
      if (u) $("unterwegs-info").textContent = "Abgeholt von " + u.name + " – " + zeitText(u.seit) + ".";
      zeige("schritt-wahl");
    }).catch(function (e) { fehler(e.message); });
  }

  $("fehler-neu").addEventListener("click", function () { location.reload(); });
  $("knopf-abholen").addEventListener("click", function () { erfassenStarten("abholung"); });
  $("knopf-zurueck").addEventListener("click", function () { erfassenStarten("rueckgabe"); });
  $("knopf-abholen-trotzdem").addEventListener("click", function () {
    if (confirm("Die offene Fahrt wird als „ohne Rückgabe“ abgeschlossen. Fortfahren?")) erfassenStarten("abholung");
  });
  $("knopf-abbrechen").addEventListener("click", function () {
    if (fotos.length && !confirm("Fotos verwerfen?")) return;
    fotos.forEach(function (f) { URL.revokeObjectURL(f.url); });
    fotos = [];
    $("fotos").textContent = "";
    start();
  });
  $("name").addEventListener("input", fotoZahlAktualisieren);
  $("knopf-foto").addEventListener("click", function () { $("kamera").click(); });

  $("kamera").addEventListener("change", function () {
    var dateien = Array.prototype.slice.call(this.files || []);
    this.value = "";
    var kette = Promise.resolve();
    dateien.forEach(function (d) {
      kette = kette.then(function () {
        if (fotos.length >= MAX_FOTOS) return;
        $("foto-zahl").textContent = "Foto wird vorbereitet …";
        return verkleinern(d).then(function (blob) {
          var e = { blob: blob, url: URL.createObjectURL(blob) };
          fotos.push(e);
          fotoAnzeigen(e);
        }).catch(function () { alert("Dieses Foto konnte nicht gelesen werden."); });
      });
    });
    kette.then(fotoZahlAktualisieren);
  });

  var sendet = false;
  $("knopf-fertig").addEventListener("click", function () {
    if (sendet) return;
    var name = $("name").value.replace(/\s+/g, " ").trim();
    if (name.length < 2) { alert("Bitte deinen Namen eingeben."); return; }
    if (!fotos.length) { alert("Bitte mindestens ein Foto aufnehmen."); return; }
    try { localStorage.setItem("fz_name", name); } catch (e) {}
    sendet = true;
    zeige("schritt-senden");
    var gesamt = fotos.length;
    var fertigZahl = 0;
    function fortschritt(t) {
      $("balken-innen").style.width = Math.round(100 * fertigZahl / (gesamt + 1)) + "%";
      $("senden-text").textContent = t;
    }
    fortschritt("Verbindung wird aufgebaut …");
    var vorgang;
    anfrage({ aktion: "start", phase: phase, name: name, anzahl: gesamt }).then(function (j) {
      vorgang = j.vorgang;
      var kette = Promise.resolve();
      j.ziele.forEach(function (z, i) {
        kette = kette.then(function () {
          fortschritt("Foto " + (i + 1) + " von " + gesamt + " …");
          return hochladen(z.url, fotos[i].blob).then(function () { fertigZahl++; });
        });
      });
      return kette;
    }).then(function () {
      fortschritt("Wird abgeschlossen …");
      return anfrage({ aktion: "fertig", vorgang: vorgang });
    }).then(function (j) {
      fertigZahl = gesamt + 1;
      fortschritt("");
      fotos.forEach(function (f) { URL.revokeObjectURL(f.url); });
      fotos = [];
      $("fotos").textContent = "";
      var jetzt = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      $("ok-titel").textContent = "Danke, " + name + "!";
      $("ok-text").textContent = (phase === "abholung" ? "Abholung" : "Rückgabe") + " um " + jetzt +
        " Uhr gespeichert (" + (j.fotos || gesamt) + " Fotos).";
      zeige("schritt-ok");
      try { sessionStorage.removeItem("fz_token"); } catch (e) {}
    }).catch(function (e) {
      sendet = false;
      zeige("schritt-erfassen");
      alert(e.message);
    });
  });

  start();
})();
