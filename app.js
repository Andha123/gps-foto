/* GPS-foto – feltdokumentasjon med UTM-koordinater brent inn i bildet. */
(function () {
  'use strict';

  // ---------- Innstillinger ----------
  var MAX_FIX_AGE_MS = 15000;   // eldste GPS-posisjon som godtas ved fotografering
  var ACC_GOOD = 5;             // ≤ 5 m: god
  var ACC_OK = 15;              // ≤ 15 m: ok, ellers dårlig
  var JPEG_QUALITY = 0.92;
  var THUMB_SIZE = 360;

  var $ = function (id) { return document.getElementById(id); };
  var screens = ['home', 'camera', 'gallery', 'viewer'];
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ---------- Lagring (IndexedDB) ----------
  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open('gpsfoto', 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        d.createObjectStore('meta', { keyPath: 'id' });   // metadata + miniatyr
        d.createObjectStore('photos');                     // fullt bilde (Blob), nøkkel = id
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function tx(stores, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode);
        var result;
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Lagring avbrutt')); };
        result = fn(t);
      });
    });
  }
  function reqValue(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function savePhoto(meta, blob, thumb) {
    meta.thumb = thumb;
    return tx(['meta', 'photos'], 'readwrite', function (t) {
      t.objectStore('photos').put(blob, meta.id);
      t.objectStore('meta').put(meta);
    });
  }
  function listMeta() {
    return db().then(function (d) {
      return reqValue(d.transaction('meta').objectStore('meta').getAll());
    }).then(function (all) {
      return all.sort(function (a, b) { return b.created - a.created; });
    });
  }
  function getMeta(id) { return db().then(function (d) { return reqValue(d.transaction('meta').objectStore('meta').get(id)); }); }
  function getPhoto(id) { return db().then(function (d) { return reqValue(d.transaction('photos').objectStore('photos').get(id)); }); }
  function deletePhoto(id) {
    return tx(['meta', 'photos'], 'readwrite', function (t) {
      t.objectStore('photos').delete(id);
      t.objectStore('meta').delete(id);
    });
  }
  function countPhotos() { return db().then(function (d) { return reqValue(d.transaction('meta').objectStore('meta').count()); }); }

  // ---------- Navigasjon ----------
  var current = null;
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var name = parts[0] || 'home';
    if (name === 'kamera') show('camera');
    else if (name === 'bilder') show('gallery');
    else if (name === 'bilde' && parts[1]) show('viewer', parts[1]);
    else show('home');
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
  function back() { if (history.length > 1 && current !== 'home') history.back(); else go('#/'); }

  function show(name, arg) {
    if (current === 'camera' && name !== 'camera') stopCamera();
    if (current === 'viewer' && name !== 'viewer') clearViewer();
    current = name;
    screens.forEach(function (s) { $(s).hidden = s !== name; });
    if (name === 'home') renderHome();
    if (name === 'camera') startCamera();
    if (name === 'gallery') renderGallery();
    if (name === 'viewer') renderViewer(arg);
  }

  // ---------- Hjem ----------
  function renderHome() {
    countPhotos().then(function (n) { $('photoCount').textContent = n ? '(' + n + ')' : ''; }).catch(function () {});
    var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    var hint = $('installHint');
    if (!standalone) {
      hint.hidden = false;
      hint.textContent = isIOS
        ? 'Tips: Trykk Del-knappen i Safari og velg «Legg til på Hjem-skjerm».'
        : 'Tips: Åpne nettlesermenyen (⋮) og velg «Legg til på startskjermen».';
    } else hint.hidden = true;
  }

  // ---------- GPS ----------
  var fix = null;          // siste posisjon {lat, lon, acc, at, utm}
  var watchId = null;
  var gpsError = null;
  var gpsTimer = null;

  function startGPS() {
    if (!('geolocation' in navigator)) { gpsError = 'Telefonen/nettleseren støtter ikke GPS-posisjon.'; updateGpsUI(); return; }
    if (watchId !== null) return;
    gpsError = null;
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    gpsTimer = setInterval(updateGpsUI, 1000);
    updateGpsUI();
  }
  function stopGPS() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearInterval(gpsTimer);
  }
  function onPos(p) {
    var c = p.coords;
    var utm;
    try { utm = UTM.toUTM(c.latitude, c.longitude); } catch (e) { gpsError = e.message; updateGpsUI(); return; }
    fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, at: Date.now(), utm: utm };
    gpsError = null;
    updateGpsUI();
  }
  function onPosErr(err) {
    if (err.code === 1) gpsError = 'Ingen tilgang til posisjon. Gi appen tillatelse til posisjon (nøyaktig posisjon) i innstillingene.';
    else if (err.code === 3) gpsError = fix ? null : 'Får ikke GPS-signal ennå. Gå gjerne ut i åpent område.';
    else gpsError = 'GPS-posisjon er ikke tilgjengelig. Sjekk at posisjonstjenester er slått på.';
    updateGpsUI();
  }
  function fixIsFresh() { return fix && (Date.now() - fix.at) <= MAX_FIX_AGE_MS; }

  function fmt(v) { return v.toFixed(2); }
  function accText(a) { return '±' + (a < 10 ? a.toFixed(1).replace('.0', '') : Math.round(a)) + ' m'; }

  function updateGpsUI() {
    var box = $('gpsBox');
    var acc = $('gpsAcc');
    var coords = $('gpsCoords');
    box.className = 'gps-box';
    if (gpsError && !fixIsFresh()) {
      box.classList.add('err');
      acc.textContent = 'Ingen GPS';
      coords.textContent = '';
      showCamMsg(gpsError, 'gps');
    } else if (!fixIsFresh()) {
      box.classList.add('wait');
      acc.textContent = fix ? 'Venter på ny GPS-posisjon …' : 'Venter på GPS …';
      coords.textContent = '';
      hideCamMsg('gps');
    } else {
      var q = fix.acc <= ACC_GOOD ? 'good' : fix.acc <= ACC_OK ? 'ok' : 'bad';
      box.classList.add(q);
      acc.textContent = 'Nøyaktighet ' + accText(fix.acc) + (q === 'bad' ? ' – DÅRLIG SIGNAL' : '');
      coords.innerHTML = 'X: ' + fmt(fix.utm.x) + '<br>Y: ' + fmt(fix.utm.y) + ' <span style="opacity:.7">· UTM ' + fix.utm.zone + '</span>';
      hideCamMsg('gps');
    }
    updateShutter();
  }

  // ---------- Kamera ----------
  var stream = null;
  var camReady = false;
  var busy = false;
  var wakeLock = null;
  var torchOn = false;

  function startCamera() {
    startGPS();
    refreshLastThumb();
    hideCamMsg();
    camReady = false;
    updateShutter();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamMsg('Kameraet er ikke tilgjengelig i denne nettleseren. Appen må åpnes via https.', 'cam', true);
      return;
    }
    var constraints = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } } };
    navigator.mediaDevices.getUserMedia(constraints).catch(function () {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    }).then(function (s) {
      if (current !== 'camera') { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      var v = $('video');
      v.srcObject = s;
      v.onloadedmetadata = function () {
        v.play().catch(function () {});
        camReady = true;
        updateShutter();
      };
      setupTorch(s);
      requestWakeLock();
    }).catch(function (err) {
      var msg = (err && err.name === 'NotAllowedError')
        ? 'Appen har ikke tilgang til kameraet. Gi tillatelse til kamera i telefonens innstillinger og prøv igjen.'
        : 'Klarte ikke å starte kameraet (' + (err && err.name || 'ukjent feil') + ').';
      showCamMsg(msg, 'cam', true);
    });
  }
  function stopCamera() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    camReady = false;
    torchOn = false;
    $('video').srcObject = null;
    stopGPS();
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }
  function requestWakeLock() {
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
  }
  function setupTorch(s) {
    var btn = $('torchBtn');
    btn.hidden = true;
    btn.classList.remove('on');
    var track = s.getVideoTracks()[0];
    setTimeout(function () {
      try {
        var caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) btn.hidden = false;
      } catch (e) {}
    }, 500);
  }
  $('torchBtn').onclick = function () {
    if (!stream) return;
    torchOn = !torchOn;
    stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
    $('torchBtn').classList.toggle('on', torchOn);
  };

  var camMsgKind = null;
  function showCamMsg(text, kind, withFallback) {
    var el = $('camMsg');
    camMsgKind = kind;
    el.hidden = false;
    el.innerHTML = '';
    var p = document.createElement('div');
    p.textContent = text;
    el.appendChild(p);
    if (kind === 'cam') {
      var retry = document.createElement('button');
      retry.textContent = 'Prøv igjen';
      retry.onclick = function () { stopCamera(); startCamera(); };
      el.appendChild(retry);
      if (withFallback) {
        var fb = document.createElement('button');
        fb.textContent = 'Bruk kamera-appen';
        fb.onclick = function () { $('fileFallback').click(); };
        el.appendChild(fb);
      }
    }
  }
  function hideCamMsg(kind) {
    if (kind && camMsgKind !== kind) return;
    $('camMsg').hidden = true;
    camMsgKind = null;
  }
  function updateShutter() {
    var s = $('shutter');
    s.disabled = busy || !camReady || !fixIsFresh();
    s.classList.toggle('busy', busy);
  }

  $('shutter').onclick = function () {
    if (busy || !camReady) return;
    if (!fixIsFresh()) { toast('Venter på GPS-posisjon – bildet ble ikke tatt.'); return; }
    var snap = JSON.parse(JSON.stringify(fix));   // posisjonen i det bildet tas
    var v = $('video');
    var w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return;
    busy = true; updateShutter();
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(v, 0, 0, w, h);
    flash();
    if (navigator.vibrate) navigator.vibrate(40);
    finishPhoto(canvas, snap).finally(function () { busy = false; updateShutter(); });
  };

  // Reserve: telefonens egen kamera-app (brukes kun hvis innebygd kamera ikke kan startes)
  $('fileFallback').onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!fixIsFresh()) { toast('Ingen fersk GPS-posisjon – bildet ble ikke lagret. Vent på GPS og prøv igjen.'); return; }
    var snap = JSON.parse(JSON.stringify(fix));
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      busy = true; updateShutter();
      finishPhoto(canvas, snap).finally(function () { busy = false; updateShutter(); });
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('Kunne ikke lese bildet.'); };
    img.src = url;
  };

  function finishPhoto(canvas, snap) {
    var created = Date.now();
    drawOverlay(canvas, snap, new Date(created));
    var id = String(created);
    var thumbCanvas = makeThumb(canvas);
    return Promise.all([toBlob(canvas, JPEG_QUALITY), toBlob(thumbCanvas, 0.8)]).then(function (b) {
      var meta = {
        id: id, created: created,
        x: snap.utm.x, y: snap.utm.y, zone: snap.utm.zone, epsg: snap.utm.epsg, crs: snap.utm.label,
        acc: snap.acc, lat: snap.lat, lon: snap.lon, alt: snap.alt,
        width: canvas.width, height: canvas.height, size: b[0].size
      };
      return savePhoto(meta, b[0], b[1]).then(function () {
        canvas.width = canvas.height = 0;  // frigjør minne (viktig på iPhone)
        refreshLastThumb();
        toast('Lagret  ·  X ' + fmt(meta.x) + '  Y ' + fmt(meta.y));
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      });
    }).catch(function (err) {
      toast('Kunne ikke lagre bildet: ' + (err && err.message || err));
    });
  }

  function toBlob(canvas, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Bildekoding feilet')); }, 'image/jpeg', q);
    });
  }
  function makeThumb(src) {
    var s = THUMB_SIZE / Math.max(src.width, src.height);
    var c = document.createElement('canvas');
    c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  // Brenner koordinatene inn i bildepikslene, nederst til venstre.
  function drawOverlay(canvas, snap, date) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var base = Math.min(W, H);
    var fs = Math.max(22, Math.round(base * 0.048));   // hovedtekst
    var fs2 = Math.max(13, Math.round(fs * 0.5));       // detaljlinje
    var pad = Math.round(fs * 0.45);
    var gap = Math.round(fs * 0.18);
    var mono = '"Roboto Mono", "SF Mono", Menlo, Consolas, "Droid Sans Mono", monospace';
    var sans = '-apple-system, Roboto, "Segoe UI", Helvetica, Arial, sans-serif';

    var l1 = 'X: ' + fmt(snap.utm.x);
    var l2 = 'Y: ' + fmt(snap.utm.y);
    var l3 = snap.utm.label + '  ·  ' + accText(snap.acc) + '  ·  ' + dateText(date);

    ctx.font = 'bold ' + fs + 'px ' + mono;
    var w1 = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
    ctx.font = fs2 + 'px ' + sans;
    var w3 = ctx.measureText(l3).width;

    var boxW = Math.ceil(Math.max(w1, w3) + pad * 2);
    var boxH = Math.ceil(pad + fs + gap + fs + gap * 1.6 + fs2 + pad);
    var x0 = 0, y0 = H - boxH;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x0, y0, boxW, boxH);

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold ' + fs + 'px ' + mono;
    ctx.fillText(l1, x0 + pad, y0 + pad);
    ctx.fillText(l2, x0 + pad, y0 + pad + fs + gap);
    ctx.font = fs2 + 'px ' + sans;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(l3, x0 + pad, y0 + pad + 2 * fs + gap * 2.6);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateText(d) {
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fileName(m) {
    var d = new Date(m.created);
    return 'GPSfoto_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) +
      '_X' + Math.round(m.x) + '_Y' + Math.round(m.y) + '.jpg';
  }

  function flash() {
    var f = $('flash');
    f.classList.add('on');
    requestAnimationFrame(function () { requestAnimationFrame(function () { f.classList.remove('on'); }); });
  }

  var lastThumbUrl = null;
  function refreshLastThumb() {
    listMeta().then(function (all) {
      var el = $('lastThumb');
      if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
      lastThumbUrl = null;
      if (all.length && all[0].thumb) {
        lastThumbUrl = URL.createObjectURL(all[0].thumb);
        el.style.backgroundImage = 'url(' + lastThumbUrl + ')';
      } else el.removeAttribute('style');
    }).catch(function () {});
  }

  // ---------- Galleri ----------
  var thumbUrls = [];
  function renderGallery() {
    thumbUrls.forEach(URL.revokeObjectURL);
    thumbUrls = [];
    var grid = $('grid');
    grid.innerHTML = '';
    listMeta().then(function (all) {
      $('galTitle').textContent = 'Bilder (' + all.length + ')';
      $('galEmpty').hidden = all.length > 0;
      all.forEach(function (m) {
        var b = document.createElement('button');
        b.className = 'tile';
        if (m.thumb) {
          var u = URL.createObjectURL(m.thumb);
          thumbUrls.push(u);
          b.style.backgroundImage = 'url(' + u + ')';
        }
        var s = document.createElement('span');
        s.textContent = dateText(new Date(m.created));
        b.appendChild(s);
        b.onclick = function () { go('#/bilde/' + m.id); };
        grid.appendChild(b);
      });
    });
  }

  // ---------- Visning ----------
  var viewUrl = null;
  var viewing = null;   // {meta, blob}
  function clearViewer() {
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    viewUrl = null; viewing = null;
    $('viewImg').removeAttribute('src');
  }
  function renderViewer(id) {
    clearViewer();
    Promise.all([getMeta(id), getPhoto(id)]).then(function (r) {
      var m = r[0], blob = r[1];
      if (!m || !blob) { go('#/bilder'); return; }
      viewing = { meta: m, blob: blob };
      viewUrl = URL.createObjectURL(blob);
      $('viewImg').src = viewUrl;
      $('viewTitle').textContent = dateText(new Date(m.created));
      var rows = [
        ['X (øst)', fmt(m.x)],
        ['Y (nord)', fmt(m.y)],
        ['System', m.crs + ' (EPSG:' + m.epsg + ')'],
        ['Nøyaktighet', accText(m.acc)],
        ['Tatt', dateText(new Date(m.created))],
        ['Oppløsning', m.width + ' × ' + m.height + ' px']
      ];
      var dl = $('viewInfo');
      dl.innerHTML = '';
      rows.forEach(function (r) {
        var dt = document.createElement('dt'); dt.textContent = r[0];
        var dd = document.createElement('dd'); dd.textContent = r[1];
        dl.appendChild(dt); dl.appendChild(dd);
      });
    });
  }

  function viewingFile() {
    return new File([viewing.blob], fileName(viewing.meta), { type: 'image/jpeg', lastModified: viewing.meta.created });
  }
  function shareFile() {
    var file = viewingFile();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: file.name }).catch(function (e) {
        if (e && e.name !== 'AbortError') toast('Deling feilet: ' + e.message);
      });
    }
    download(file);
    toast('Deling støttes ikke her – bildet er lastet ned i stedet.');
    return Promise.resolve();
  }
  function download(file) {
    var a = document.createElement('a');
    var u = URL.createObjectURL(file);
    a.href = u; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 10000);
  }

  $('actShare').onclick = function () { if (viewing) shareFile(); };
  $('actSave').onclick = function () {
    if (!viewing) return;
    if (isIOS) {
      toast('Velg «Arkiver bilde» for å lagre i Bilder');
      shareFile();
    } else {
      download(viewingFile());
      toast('Bildet er lagret i Nedlastinger');
    }
  };
  $('actDelete').onclick = function () {
    if (!viewing) return;
    var id = viewing.meta.id;
    confirmDialog('Slette dette bildet?').then(function (ok) {
      if (!ok) return;
      deletePhoto(id).then(function () { toast('Bildet er slettet'); go('#/bilder'); });
    });
  };

  // ---------- Små hjelpere ----------
  function confirmDialog(text) {
    return new Promise(function (resolve) {
      $('dialogText').textContent = text;
      $('dialog').hidden = false;
      $('dialogOk').onclick = function () { $('dialog').hidden = true; resolve(true); };
      $('dialogCancel').onclick = function () { $('dialog').hidden = true; resolve(false); };
    });
  }
  var toastTimer = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------- Knapper ----------
  $('btnTake').onclick = function () { go('#/kamera'); };
  $('btnGallery').onclick = function () { go('#/bilder'); };
  $('galCamera').onclick = function () { go('#/kamera'); };
  $('camBack').onclick = back;
  $('galBack').onclick = function () { go('#/'); };
  $('viewBack').onclick = function () { go('#/bilder'); };
  $('lastThumb').onclick = function () { go('#/bilder'); };

  document.addEventListener('visibilitychange', function () {
    if (current !== 'camera') return;
    if (document.hidden) stopCamera();
    else startCamera();
  });

  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  // Til testing
  window.__gpsfoto = { drawOverlay: drawOverlay, listMeta: listMeta, getPhoto: getPhoto };
})();
