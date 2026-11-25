"use strict";
// Stempeluhr MTU – Offline-Huelle. Bereich nur /Bayrak-Portal/stempeluhr/ (liegt in diesem Ordner, Scope "./").
// Haelt nur die eigenen Dateien im Cache, damit die Seite auch ohne Netz aufgeht.
// Faesst KEINE Anfragen an Supabase an (fremde Adresse -> Browser macht es selbst), speichert nie Antworten mit Daten.
// Neue Version: VERSION hochzaehlen (und ?v= in index.html), alte eigene Caches werden beim Aktivieren geloescht.
var VERSION = "stz-stempeluhr-v6"; // 26.11.2026: Sicherheit (Foto, Face ID, Pflichthinweis)
var PRAEFIX = "stz-stempeluhr-";
var DATEIEN = ["./index.html", "./style.css", "./texte.js", "./logik.js", "./app.js"];
var NETZ_WARTEN_MS = 4000;

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(DATEIEN); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (namen) {
      // nur eigene, alte Caches loeschen – nie fremde (Portal/Fahrzeug)
      return Promise.all(namen.filter(function (n) { return n.indexOf(PRAEFIX) === 0 && n !== VERSION; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function eigeneDatei(url) {
  if (url.origin !== self.location.origin) return null;
  var basis = new URL("./", self.location.href).pathname; // /Bayrak-Portal/stempeluhr/
  if (url.pathname.indexOf(basis) !== 0) return null;
  var rest = url.pathname.slice(basis.length);
  if (rest === "" || rest === "index.html") return "./index.html";
  if (rest === "style.css" || rest === "texte.js" || rest === "logik.js" || rest === "app.js") return "./" + rest;
  return null;
}

// Netz zuerst (damit Aenderungen sofort ankommen), nach 4 s oder ohne Netz aus dem Cache.
self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  var schluessel = eigeneDatei(url);
  if (!schluessel) return;
  ev.respondWith(new Promise(function (fertig) {
    var erledigt = false;
    function ausCache() {
      return caches.open(VERSION).then(function (c) { return c.match(schluessel); });
    }
    var uhr = setTimeout(function () {
      ausCache().then(function (r) { if (r && !erledigt) { erledigt = true; fertig(r); } });
    }, NETZ_WARTEN_MS);
    // fetch(req) ohne zweites Argument: Seitenaufrufe (mode "navigate") vertragen kein RequestInit
    fetch(req).then(function (antwort) {
      clearTimeout(uhr);
      if (antwort && antwort.ok && antwort.type === "basic") {
        var kopie = antwort.clone();
        caches.open(VERSION).then(function (c) { return c.put(schluessel, kopie); }).catch(function () {});
      }
      if (!erledigt) { erledigt = true; fertig(antwort); }
    }).catch(function () {
      clearTimeout(uhr);
      ausCache().then(function (r) {
        if (erledigt) return;
        erledigt = true;
        fertig(r || new Response("Keine Verbindung.", {
          status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
        }));
      });
    });
  }));
});
