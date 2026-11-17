/* Inventaire chargement Solustoc — appli web (PWA). Aucune donnée n'est stockée sur GitHub :
   tout reste sur le téléphone (IndexedDB) puis part vers le relais Google (Drive + Sheet de Brice). */
(function () {
  "use strict";
  var CFG = window.APP_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  // ---------- Utilitaires ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? n : 0; }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    return Math.random().toString(36).slice(2, 14);
  }
  function clean(s) { return String(s || "").trim().replace(/[\\/:*?"<>|#%]+/g, "-").replace(/\s+/g, " "); }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function fmt(n) { return Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 }); }

  // ---------- Base locale (IndexedDB) ----------
  var db;
  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open("chargement-solustoc", 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
        if (!d.objectStoreNames.contains("chs")) d.createObjectStore("chs", { keyPath: "id" });
      };
      r.onsuccess = function () { db = r.result; res(); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, mode), s = t.objectStore(store), out = fn(s);
      t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error); };
    });
  }
  function getAll(store) { return tx(store, "readonly", function (s) { return s.getAll(); }); }
  function put(store, v) { return tx(store, "readwrite", function (s) { return s.put(v); }); }

  // ---------- Session ----------
  var session = null; // {name, code, ch}
  function loadSession() { try { return JSON.parse(localStorage.getItem("chg_session")); } catch (e) { return null; } }
  function saveSession() { try { localStorage.setItem("chg_session", JSON.stringify(session)); } catch (e) {} }

  // ---------- État ----------
  var editingId = null;        // id de la palette en cours de modification
  var photos = [];             // [{blob, url, kind}] du formulaire
  var pendingKind = "PALETTE"; // type de la photo en cours de cadrage
  var syncing = false;
  var lastError = "";
  var chClosed = false;

  function chId(name) { return name; }

  // ---------- Navigation ----------
  function show(view) {
    ["vLogin", "vList", "vForm"].forEach(function (v) { $(v).hidden = (v !== view); });
    $("bar").hidden = (view === "vLogin");
    $("backBtn").hidden = (view !== "vForm");
    if (view === "vList") { $("barTitle").textContent = "Chargement"; }
    window.scrollTo(0, 0);
  }

  // ---------- Connexion ----------
  function initLogin() {
    getAll("chs").then(function (all) {
      $("chList").innerHTML = all.filter(function (c) { return !c.deleted; }).map(function (c) { return '<option value="' + esc(c.name) + '">'; }).join("");
    }).catch(function () {});
    var s = loadSession();
    if (s) $("loginCh").value = s.ch || "";
  }

  function call(payload) {
    return fetch(CFG.SCRIPT_URL, { method: "POST", body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); });
  }

  function doLogin() {
    var name = "", code = $("loginCode").value.trim(), ch = clean($("loginCh").value).toUpperCase();
    var msg = $("loginMsg"); msg.textContent = ""; msg.className = "msg";
    if (!ch || (!code && CFG.SCRIPT_URL)) { msg.textContent = "Le code et le nom du chargement sont obligatoires."; return; }
    var btn = $("loginBtn"); btn.disabled = true; btn.textContent = "Vérification…";
    var done = function (offline, nomCode) {
      name = nomCode || name || "Inconnu";
      session = { name: name, code: code, ch: ch };
      saveSession();
      btn.disabled = false; btn.textContent = "Commencer";
      $("loginCode").value = "";
      if (offline) toast("Hors ligne : le code sera vérifié à l'envoi.");
      enterList();
    };
    var fail = function (m) { btn.disabled = false; btn.textContent = "Commencer"; msg.textContent = m; };
    if (!CFG.SCRIPT_URL) { done(false); return; }
    call({ action: "check", code: code, helper: name }).then(function (r) {
      if (r && r.ok) done(false, r.name); else fail("Code refusé. Vérifie-le auprès de Brice.");
    }).catch(function () {
      if (!navigator.onLine) done(true); else fail("Le relais ne répond pas. Réessaie dans un instant.");
    });
  }

  function logout() {
    session = null; try { localStorage.removeItem("chg_session"); } catch (e) {}
    $("menuDlg").close(); initLogin(); show("vLogin");
  }

  // ---------- Liste des palettes du chargement ----------
  function getCh() {
    return getAll("chs").then(function (all) {
      return all.filter(function (c) { return c.id === chId(session.ch); })[0] || null;
    });
  }

  function ensureCh() {
    return getCh().then(function (c) {
      if (c) {
        if (c.deleted) { // chargement supprimé puis rouvert sous le même nom : on repart de zéro
          c.deleted = false; c.closed = false; c.closedAt = null; c.created = Date.now(); c.sync = "pending";
          return put("chs", c).then(function () { return c; });
        }
        return c;
      }
      c = { id: chId(session.ch), name: session.ch, created: Date.now(), closed: false, sync: "pending" };
      return put("chs", c).then(function () { return c; });
    });
  }

  function enterList() {
    $("barSub").textContent = session.ch + " · " + session.name;
    ensureCh().then(function () { show("vList"); renderList(); updateChip(); sync(); });
  }

  function myItems(all) { return all.filter(function (l) { return l.ch === session.ch && !l.deleted; }).sort(function (a, b) { return b.seq - a.seq; }); }

  function renderList() {
    Promise.all([getAll("items"), getCh()]).then(function (r) {
      var ls = myItems(r[0]), c = r[1];
      chClosed = !!(c && c.closed);
      var colis = ls.reduce(function (a, l) { return a + (l.colis || 0); }, 0);
      $("chName").textContent = session.ch;
      $("chStats").textContent = "· " + ls.length + " palette(s)" + (colis ? " · " + fmt(colis) + " colis" : "");
      $("closeChBtn").hidden = chClosed; $("chClosedBox").hidden = !chClosed; $("newPalBtn").hidden = chClosed;
      $("palEmpty").hidden = ls.length > 0 || chClosed;
      $("palList").innerHTML = ls.map(function (l) {
        var np = (l.photos || []).length;
        return '<li data-id="' + esc(l.id) + '"><div><div class="t">#' + l.seq + " · " + esc(l.num || "(sans n°)") + '</div><div class="s">' +
          (l.dest ? esc(l.dest) + " · " : "") + (l.colis ? fmt(l.colis) + " colis · " : "") + np + ' photo(s) <span class="tag ' +
          (l.sync === "sent" ? "sent" : "pending") + '">' + (l.sync === "sent" ? "envoyé" : "à envoyer") + '</span></div></div>' +
          (chClosed ? "" : '<div class="acts"><button data-act="edit" aria-label="Modifier">✏️</button><button data-act="del" aria-label="Supprimer">🗑️</button></div>') + '</li>';
      }).join("");
    });
  }

  function setChState(closed) {
    return ensureCh().then(function (c) {
      c.closed = closed; c.closedAt = closed ? Date.now() : null; c.sync = "pending";
      return put("chs", c);
    });
  }

  function closeCh() {
    getAll("items").then(function (all) {
      var ls = myItems(all);
      if (!ls.length) { toast("Aucune palette dans ce chargement."); return; }
      if (!confirm("Terminer le chargement " + session.ch + " ?\n" + ls.length + " palette(s).\nIl sera verrouillé (tu pourras le rouvrir si besoin).")) return;
      return setChState(true).then(function () { toast("Chargement terminé ✓"); renderList(); updateChip(); sync(); });
    });
  }

  function reopenCh() { setChState(false).then(function () { renderList(); updateChip(); sync(); }); }

  function deleteCh() {
    $("menuDlg").close();
    getAll("items").then(function (all) {
      var ls = myItems(all);
      var msg = "Supprimer le chargement " + session.ch + " ?\n" +
        (ls.length ? ls.length + " palette(s) seront supprimées avec lui." : "Il est vide.") + "\nCette action est définitive.";
      if (!confirm(msg)) return;
      var now = Date.now();
      return Promise.all(ls.map(function (l) { l.deleted = true; l.sync = "pending"; l.updated = now; return put("items", l); }))
        .then(ensureCh).then(function (c) { c.deleted = true; c.sync = "pending"; return put("chs", c); })
        .then(function () { toast("Chargement supprimé"); updateChip(); sync(); logout(); });
    });
  }

  // ---------- Formulaire palette ----------
  function openForm() {
    resetForm(); show("vForm"); $("barTitle").textContent = "Nouvelle palette";
  }

  function resetForm() {
    $("palForm").reset();
    photos.forEach(function (p) { URL.revokeObjectURL(p.url); }); photos = [];
    editingId = null; $("editBanner").hidden = true; $("saveBtn").textContent = "Enregistrer et palette suivante";
    $("palMsg").textContent = ""; clearAi(); renderThumbs();
  }

  function renderThumbs() {
    $("thumbs").innerHTML = "";
    photos.forEach(function (p, i) {
      var d = document.createElement("div"); d.className = "thumb";
      var im = document.createElement("img"); im.src = p.url; im.alt = "photo " + (i + 1);
      var k = document.createElement("span"); k.className = "kind"; k.textContent = p.kind === "BL" ? "BL" : "Palette";
      var b = document.createElement("button"); b.type = "button"; b.textContent = "×"; b.setAttribute("aria-label", "Retirer la photo");
      b.onclick = function () { URL.revokeObjectURL(p.url); photos.splice(i, 1); renderThumbs(); };
      d.appendChild(im); d.appendChild(k); d.appendChild(b); $("thumbs").appendChild(d);
    });
    $("aiBtn").hidden = !CFG.SCRIPT_URL;
    $("aiBtn").disabled = photos.length < 1;
    $("aiBtn").textContent = photos.length < 1 ? "✨ Lire étiquette / BL (IA) — prends d'abord une photo" : "✨ Lire étiquette / BL (IA)";
    var full = photos.length >= (CFG.MAX_PHOTOS || 5);
    ["photoBtn", "photoBtnBl", "photoBtnGal"].forEach(function (id) { $(id).classList.toggle("disabled", full); });
  }

  function onPhoto(kind) {
    return function (ev) {
      var f = ev.target.files && ev.target.files[0]; ev.target.value = "";
      if (!f) return;
      if (photos.length >= (CFG.MAX_PHOTOS || 5)) { toast("Maximum " + (CFG.MAX_PHOTOS || 5) + " photos."); return; }
      pendingKind = kind; openCrop(f);
    };
  }

  // ---------- Lecture par IA ----------
  var AI_FIELDS = ["fNum", "fColis", "fBl", "fDest", "fContenu"];
  function clearAi() {
    AI_FIELDS.forEach(function (id) { $(id).classList.remove("ai"); });
    $("aiMsg").textContent = ""; $("aiMsg").className = "msg";
  }

  var AI_ERR = {
    NO_KEY: "La lecture par IA n'est pas encore activée. Tape à la main.",
    PLAFOND_JOUR: "Limite de lectures IA atteinte pour aujourd'hui. Tape à la main.",
    CODE_INVALIDE: "Code refusé : reconnecte-toi.",
    IA_401: "La clé de l'IA est refusée. Préviens Brice.", IA_402: "Plus de crédit sur le compte IA. Préviens Brice.",
    IA_429: "L'IA est saturée, réessaie dans un instant."
  };

  function readLabel() {
    if (!photos.length) return;
    if (!navigator.onLine) { $("aiMsg").textContent = "Pas de réseau : la lecture IA est impossible, tape à la main."; return; }
    var btn = $("aiBtn"), msg = $("aiMsg"); clearAi();
    btn.disabled = true; btn.textContent = "Lecture en cours…";
    Promise.all(photos.map(function (p) { return blobToDataUrl(p.blob); })).then(function (urls) {
      return call({ action: "ocr", code: session.code, images: urls });
    }).then(function (r) {
      if (!r || !r.ok) { msg.textContent = AI_ERR[r && r.error] || ("Lecture impossible (" + ((r && r.error) || "erreur") + "). Tape à la main."); return; }
      var d = r.data || {}, filled = 0;
      var put2 = function (id, v) { if (v && !$(id).value) { $(id).value = v; $(id).classList.add("ai"); filled++; } };
      put2("fNum", d.num); put2("fColis", d.colis || ""); put2("fBl", d.bl); put2("fDest", d.destinataire); put2("fContenu", d.contenu);
      if (filled) { msg.className = "msg ok"; msg.textContent = "✨ Lu par IA : vérifie les champs en jaune avant d'enregistrer."; }
      else msg.textContent = "Rien de lisible sur ces photos. Tape à la main ou reprends la photo.";
    }).catch(function () { msg.textContent = "Lecture impossible (réseau). Tape à la main."; })
      .then(function () { btn.disabled = photos.length < 1; btn.textContent = "✨ Lire étiquette / BL (IA)"; });
  }

  // ---------- Cadrage de la photo ----------
  var crop = { url: null, dw: 0, dh: 0, r: { x: 0, y: 0, w: 0, h: 0 }, drag: null };

  function applyCrop() {
    var s = $("cropRect").style, r = crop.r;
    s.left = r.x + "px"; s.top = r.y + "px"; s.width = r.w + "px"; s.height = r.h + "px";
  }

  function openCrop(file) {
    var im = $("cropImg");
    if (crop.url) URL.revokeObjectURL(crop.url);
    crop.url = URL.createObjectURL(file);
    im.onload = function () {
      $("cropDlg").showModal();
      var measure = function (n) {
        crop.dw = im.clientWidth; crop.dh = im.clientHeight; // lire la taille force la mise en page
        if (!(crop.dw > 0 && crop.dh > 0) && n < 20) { setTimeout(function () { measure(n + 1); }, 50); return; }
        crop.r = { x: crop.dw * 0.06, y: crop.dh * 0.06, w: crop.dw * 0.88, h: crop.dh * 0.88 };
        applyCrop();
      };
      measure(0);
    };
    im.onerror = function () { toast("Photo illisible, réessaie."); };
    im.src = crop.url;
  }

  function closeCrop() {
    try { $("cropDlg").close(); } catch (e) {}
    if (crop.url) { URL.revokeObjectURL(crop.url); crop.url = null; }
    $("cropImg").removeAttribute("src");
  }

  function cropMove(e) {
    var d = crop.drag; if (!d) return;
    var dx = e.clientX - d.sx, dy = e.clientY - d.sy, r = d.r, MIN = 48, W = crop.dw, H = crop.dh;
    var x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
    if (d.mode === "move") {
      var nx = Math.min(Math.max(r.x + dx, 0), W - r.w), ny = Math.min(Math.max(r.y + dy, 0), H - r.h);
      crop.r = { x: nx, y: ny, w: r.w, h: r.h };
    } else {
      if (d.mode.indexOf("l") >= 0) x1 = Math.min(Math.max(r.x + dx, 0), x2 - MIN);
      if (d.mode.indexOf("r") >= 0) x2 = Math.max(Math.min(x2 + dx, W), x1 + MIN);
      if (d.mode.indexOf("t") >= 0) y1 = Math.min(Math.max(r.y + dy, 0), y2 - MIN);
      if (d.mode.indexOf("b") >= 0) y2 = Math.max(Math.min(y2 + dy, H), y1 + MIN);
      crop.r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    applyCrop();
  }

  function cropDone(full) {
    var im = $("cropImg"), k = im.naturalWidth / crop.dw, r = full ? { x: 0, y: 0, w: crop.dw, h: crop.dh } : crop.r;
    var sx = Math.round(r.x * k), sy = Math.round(r.y * k), sw = Math.round(r.w * k), sh = Math.round(r.h * k);
    var side = CFG.PHOTO_MAX_SIDE || 1600, s = Math.min(1, side / Math.max(sw, sh));
    var cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(sw * s)); cv.height = Math.max(1, Math.round(sh * s));
    cv.getContext("2d").drawImage(im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    cv.toBlob(function (b) {
      closeCrop();
      if (!b) { toast("Photo illisible, réessaie."); return; }
      photos.push({ blob: b, url: URL.createObjectURL(b), kind: pendingKind }); renderThumbs();
    }, "image/jpeg", CFG.PHOTO_QUALITY || 0.72);
  }

  function bindCrop() {
    $("cropRect").addEventListener("pointerdown", function (e) {
      e.preventDefault();
      crop.drag = { mode: e.target.getAttribute("data-h") || "move", sx: e.clientX, sy: e.clientY, r: { x: crop.r.x, y: crop.r.y, w: crop.r.w, h: crop.r.h } };
      try { $("cropRect").setPointerCapture(e.pointerId); } catch (x) {}
    });
    $("cropRect").addEventListener("pointermove", cropMove);
    ["pointerup", "pointercancel"].forEach(function (t) { $("cropRect").addEventListener(t, function () { crop.drag = null; }); });
    $("cropOk").onclick = function () { cropDone(false); };
    $("cropFull").onclick = function () { cropDone(true); };
    $("cropCancel").onclick = closeCrop;
    $("cropDlg").addEventListener("cancel", function (e) { e.preventDefault(); closeCrop(); });
  }

  // ---------- Enregistrer / modifier / supprimer une palette ----------
  function saveItem(ev) {
    ev.preventDefault();
    var msg = $("palMsg"); msg.textContent = "";
    if (photos.length < 1) { msg.textContent = "Prends au moins une photo de la palette."; return; }
    getAll("items").then(function (all) {
      var existing = editingId ? all.filter(function (l) { return l.id === editingId; })[0] : null;
      var inCh = all.filter(function (l) { return l.ch === session.ch; });
      var it = existing || {
        id: uid(), ch: session.ch,
        seq: inCh.reduce(function (m, l) { return Math.max(m, l.seq || 0); }, 0) + 1,
        helper: session.name, created: Date.now()
      };
      it.num = $("fNum").value.trim(); it.colis = num($("fColis").value); it.bl = $("fBl").value.trim();
      it.dest = $("fDest").value.trim(); it.contenu = $("fContenu").value.trim(); it.comment = $("fComment").value.trim();
      it.photos = photos.map(function (p) { return p.blob; });
      it.kinds = photos.map(function (p) { return p.kind; });
      it.photoNames = it.photos.map(function (b, i) {
        return clean(it.ch + "_" + it.seq + "_" + it.id.slice(0, 5) + "_" + (it.kinds[i] === "BL" ? "BL" : "PAL") + "_" + (i + 1)) + ".jpg";
      });
      it.updated = Date.now(); it.sync = "pending"; it.deleted = false;
      return put("items", it);
    }).then(function () {
      toast(editingId ? "Palette mise à jour ✓" : "Palette enregistrée ✓");
      var wasEdit = !!editingId;
      resetForm(); updateChip(); sync();
      if (wasEdit) { show("vList"); renderList(); }
      else { $("barTitle").textContent = "Nouvelle palette"; window.scrollTo(0, 0); }
    }).catch(function () { msg.textContent = "Enregistrement impossible sur ce téléphone (mémoire pleine ?)."; });
  }

  function editItem(id) {
    getAll("items").then(function (all) {
      var l = all.filter(function (x) { return x.id === id; })[0]; if (!l) return;
      resetForm(); editingId = id;
      $("fNum").value = l.num || ""; $("fColis").value = l.colis || ""; $("fBl").value = l.bl || "";
      $("fDest").value = l.dest || ""; $("fContenu").value = l.contenu || ""; $("fComment").value = l.comment || "";
      photos = (l.photos || []).map(function (b, i) { return { blob: b, url: URL.createObjectURL(b), kind: (l.kinds && l.kinds[i]) || "PALETTE" }; });
      renderThumbs();
      $("editBanner").hidden = false; $("saveBtn").textContent = "Mettre à jour la palette";
      show("vForm"); $("barTitle").textContent = "Palette #" + l.seq;
    });
  }

  function deleteItem(id) {
    if (!confirm("Supprimer cette palette ?")) return;
    getAll("items").then(function (all) {
      var l = all.filter(function (x) { return x.id === id; })[0]; if (!l) return;
      l.deleted = true; l.sync = "pending"; l.updated = Date.now();
      return put("items", l);
    }).then(function () { renderList(); updateChip(); sync(); });
  }

  // ---------- Scan code-barres ----------
  var scanner = null;
  function loadScanLib() {
    return new Promise(function (res, rej) {
      if (window.Html5Qrcode) return res();
      var s = document.createElement("script");
      s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
      s.onload = res; s.onerror = function () { rej(new Error("lib")); };
      document.head.appendChild(s);
    });
  }
  function openScan() {
    $("scanMsg").textContent = "Chargement de la caméra…"; $("scanDlg").showModal();
    loadScanLib().then(function () {
      scanner = new Html5Qrcode("reader");
      return scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 150 } }, function (txt) {
        $("fNum").value = txt; closeScan(); toast("Code lu : " + txt);
      }, function () {});
    }).then(function () { $("scanMsg").textContent = "Place le code-barres dans le cadre."; })
      .catch(function () { $("scanMsg").textContent = "Scan impossible (caméra refusée ou pas de réseau). Tape le numéro à la main."; });
  }
  function closeScan() {
    var done = function () { try { $("scanDlg").close(); } catch (e) {} scanner = null; };
    if (scanner) { scanner.stop().then(function () { scanner.clear(); done(); }).catch(done); } else done();
  }

  // ---------- Envoi vers le relais ----------
  function blobToDataUrl(b) {
    return new Promise(function (res, rej) {
      var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(b);
    });
  }

  function pendingItems() { return getAll("items").then(function (all) { return all.filter(function (l) { return l.sync === "pending"; }); }); }

  function pendingCount() {
    return Promise.all([pendingItems(), getAll("chs")]).then(function (r) {
      return r[0].length + r[1].filter(function (c) { return c.sync === "pending"; }).length;
    });
  }

  function syncChs() {
    return getAll("chs").then(function (all) {
      var c = all.filter(function (x) { return x.sync === "pending"; })[0];
      if (!c) return;
      return getAll("items").then(function (its) {
        its = its.filter(function (l) { return l.ch === c.name && !l.deleted; });
        var colis = its.reduce(function (a, l) { return a + (l.colis || 0); }, 0), ver = JSON.stringify([c.closed, c.closedAt, !!c.deleted]);
        return call({ action: "chargement", code: session.code, helper: session.name,
          ch: { name: c.name, closed: !!c.closed, closedAt: c.closedAt, palettes: its.length, colis: colis, deleted: !!c.deleted } })
          .then(function (r) {
            if (!r || !r.ok) { lastError = (r && r.error) || "réponse invalide"; throw new Error("stop"); }
            lastError = "";
            return getAll("chs").then(function (a2) {
              var cur = a2.filter(function (x) { return x.id === c.id; })[0];
              if (cur && JSON.stringify([cur.closed, cur.closedAt, !!cur.deleted]) === ver) { cur.sync = "sent"; return put("chs", cur); }
            });
          }).then(function () { return syncChs(); });
      });
    });
  }

  function updateChip() {
    pendingCount().then(function (n) {
      var c = $("syncChip");
      if (!CFG.SCRIPT_URL) { c.textContent = "Local seulement"; return; }
      if (lastError && n) c.textContent = "⚠ " + n + " à envoyer";
      else if (n) c.textContent = "⏳ " + n + " à envoyer";
      else c.textContent = "✓ Tout est envoyé";
      $("mInfo").textContent = lastError ? ("Dernier incident : " + lastError) : "";
    });
  }

  function sendOne(l) {
    return Promise.all((l.photos || []).map(blobToDataUrl)).then(function (urls) {
      var payload = {
        action: "save", code: session.code, helper: session.name,
        item: {
          id: l.id, ch: l.ch, seq: l.seq, num: l.num, colis: l.colis, bl: l.bl, dest: l.dest, contenu: l.contenu,
          comment: l.comment, deleted: !!l.deleted, updated: l.updated, helper: l.helper
        },
        photos: l.deleted ? [] : urls.map(function (u, i) { return { name: l.photoNames[i], kind: (l.kinds && l.kinds[i]) || "PALETTE", data: u }; })
      };
      return call(payload);
    });
  }

  function sync() {
    if (syncing || !session || !CFG.SCRIPT_URL || !navigator.onLine) { updateChip(); return Promise.resolve(); }
    syncing = true;
    var loop = function () {
      return pendingItems().then(function (list) {
        if (!list.length) return syncChs();
        var l = list[0], stamp = l.updated;
        return sendOne(l).then(function (r) {
          if (!r || !r.ok) {
            var err = (r && r.error) || "réponse invalide";
            if (err === "CODE_INVALIDE") { lastError = "code refusé"; toast("Code refusé : reconnecte-toi."); throw new Error("stop"); }
            lastError = err; throw new Error("stop");
          }
          lastError = "";
          return getAll("items").then(function (all) {
            var cur = all.filter(function (x) { return x.id === l.id; })[0];
            if (cur && cur.updated === stamp) { cur.sync = "sent"; return put("items", cur); } // pas modifié entre-temps
          });
        }).then(function () { updateChip(); return loop(); });
      });
    };
    return loop().catch(function (e) { if (!lastError) lastError = "réseau"; })
      .then(function () { syncing = false; updateChip(); if (!$("vList").hidden) renderList(); });
  }

  // ---------- Sauvegarde CSV locale ----------
  function exportCsv() {
    getAll("items").then(function (all) {
      var ls = all.filter(function (l) { return !l.deleted; });
      var head = ["Chargement", "N°", "N° palette / étiquette", "Nb colis", "Réf BL", "Client / destinataire", "Contenu", "Commentaire", "Photos", "Aidant", "Envoyé"];
      var rows = ls.map(function (l) {
        return [l.ch, l.seq, l.num, l.colis, l.bl, l.dest, l.contenu, l.comment, (l.photoNames || []).join(" ; "), l.helper, l.sync === "sent" ? "oui" : "non"];
      });
      var csv = [head].concat(rows).map(function (r) {
        return r.map(function (v) { v = String(v == null ? "" : v); return '"' + v.replace(/"/g, '""') + '"'; }).join(";");
      }).join("\r\n");
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
      a.download = "chargement-" + (session ? clean(session.ch) : "x") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
    });
  }

  // ---------- Branchements ----------
  function bind() {
    bindCrop();
    $("loginBtn").onclick = doLogin;
    $("loginCode").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
    $("newPalBtn").onclick = openForm;
    $("closeChBtn").onclick = closeCh; $("reopenChBtn").onclick = reopenCh;
    $("palList").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]"); if (!b) return;
      var id = b.closest("li").getAttribute("data-id");
      if (b.getAttribute("data-act") === "edit") editItem(id); else deleteItem(id);
    });
    $("backBtn").onclick = function () { resetForm(); show("vList"); renderList(); };
    $("palForm").addEventListener("submit", saveItem);
    $("fPhoto").addEventListener("change", onPhoto("PALETTE"));
    $("fPhotoBl").addEventListener("change", onPhoto("BL"));
    $("fPhotoGal").addEventListener("change", onPhoto("PALETTE"));
    $("scanBtn").onclick = openScan; $("scanClose").onclick = closeScan;
    $("scanDlg").addEventListener("cancel", function (e) { e.preventDefault(); closeScan(); });
    $("cancelEdit").onclick = function () { resetForm(); show("vList"); renderList(); };
    $("aiBtn").onclick = readLabel;
    AI_FIELDS.forEach(function (id) { $(id).addEventListener("input", function () { $(id).classList.remove("ai"); }); });
    $("syncChip").onclick = function () { lastError = ""; sync().then(function () { toast($("syncChip").textContent); }); };
    $("menuBtn").onclick = function () { updateChip(); $("menuDlg").showModal(); };
    $("mClose").onclick = function () { $("menuDlg").close(); };
    $("mSync").onclick = function () { $("menuDlg").close(); lastError = ""; sync(); };
    $("mCsv").onclick = exportCsv; $("mDelCh").onclick = deleteCh;
    $("mLogout").onclick = function () {
      pendingItems().then(function (p) {
        if (p.length && !confirm(p.length + " palette(s) ne sont pas encore envoyées. Changer de personne quand même ? (Elles restent sur ce téléphone.)")) return;
        logout();
      });
    };
    window.addEventListener("online", sync);
    setInterval(function () { pendingCount().then(function (n) { if (n) sync(); }); }, 25000);
  }

  // ---------- Démarrage ----------
  openDb().then(function () {
    initLogin(); bind();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    var s = loadSession();
    if (s && s.name && s.ch && (s.code || !CFG.SCRIPT_URL)) { session = s; enterList(); } else show("vLogin");
    if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(function () {});
  }).catch(function () {
    document.body.innerHTML = '<main><h1>Inventaire chargement</h1><p>Ce navigateur bloque le stockage local (navigation privée ?). Ouvre l\'appli dans un onglet normal.</p></main>';
  });
})();
