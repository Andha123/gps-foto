/* GPS-foto – feltdokumentasjon med UTM-koordinater brent inn i bildet. */
(function () {
  'use strict';

  // ---------- Innstillinger ----------
  var MAX_FIX_AGE_MS = 15000;      // eldste GPS-posisjon som godtas ved fotografering
  var ACC_GOOD = 5;                // ≤ 5 m: god
  var ACC_OK = 15;                 // ≤ 15 m: ok, ellers dårlig
  var JPEG_QUALITY = 0.92;
  var THUMB_SIZE = 360;
  var MAX_PIXELS = 16000000;       // iPhone tåler ikke canvas over ~16,7 MP
  var CAMERA_IDLE_STOP_MS = 5 * 60 * 1000;

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
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Lagring avbrutt')); };
        fn(t);
      });
    });
  }
  function reqValue(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function savePhoto(meta, blob) {
    return tx(['meta', 'photos'], 'readwrite', function (t) {
      t.objectStore('photos').put(blob, meta.id);
      t.objectStore('meta').put(meta);
    });
  }
  function putMeta(meta) { return tx(['meta'], 'readwrite', function (t) { t.objectStore('meta').put(meta); }); }
  function listMeta() {
    return db().then(function (d) {
      return reqValue(d.transaction('meta').objectStore('meta').getAll());
    }).then(function (all) {
      return all.sort(function (a, b) { return b.created - a.created; });
    });
  }
  function getMeta(id) { return db().then(function (d) { return reqValue(d.transaction('meta').objectStore('meta').get(id)); }); }
  function getPhoto(id) { return db().then(function (d) { return reqValue(d.transaction('photos').objectStore('photos').get(id)); }); }
  function deletePhotos(ids) {
    return tx(['meta', 'photos'], 'readwrite', function (t) {
      ids.forEach(function (id) { t.objectStore('photos').delete(id); t.objectStore('meta').delete(id); });
    });
  }
  function countPhotos() { return db().then(function (d) { return reqValue(d.transaction('meta').objectStore('meta').count()); }); }

  // ---------- Navigasjon ----------
  // Adressen (URL) endres aldri: på iPhone gjør en URL-endring at kameratillatelsen spørres om igjen.
  // På Android legges én historikk-oppføring til slik at telefonens tilbakeknapp virker.
  var current = null;
  var stack = [{ name: 'home' }];
  var hasExtra = false, ignorePop = false;

  function nav(name, arg) {
    if (name === 'home') stack = [{ name: 'home' }];
    else {
      var i = stack.findIndex(function (s) { return s.name === name; });
      if (i >= 0) stack = stack.slice(0, i);
      stack.push({ name: name, arg: arg });
    }
    show(name, arg);
    syncHistory();
  }
  function goBack() {
    if (stack.length > 1) stack.pop();
    var top = stack[stack.length - 1];
    show(top.name, top.arg);
    syncHistory();
  }
  function syncHistory() {
    if (isIOS) return;
    if (stack.length > 1 && !hasExtra) { history.pushState({ inner: 1 }, ''); hasExtra = true; }
    else if (stack.length === 1 && hasExtra) { ignorePop = true; hasExtra = false; history.back(); }
  }
  window.addEventListener('popstate', function () {
    if (ignorePop) { ignorePop = false; return; }
    hasExtra = false;
    if (!$('dialog').hidden) { $('dialogCancel').click(); syncHistory(); return; }
    goBack();
  });

  function show(name, arg) {
    if (current === 'camera' && name !== 'camera') leaveCamera();
    if (current === 'viewer' && name !== 'viewer') clearViewer();
    if (current === 'gallery' && name !== 'gallery') setSelectMode(false);
    current = name;
    $('saveBar').hidden = true;
    screens.forEach(function (s) { $(s).hidden = s !== name; });
    if (name === 'home') renderHome();
    if (name === 'camera') enterCamera();
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
  var gpsWanted = false;
  var gpsError = null;
  var gpsTimer = null;
  var fixWaiters = [];

  function startGPS() {
    gpsWanted = true;
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
    var w = fixWaiters; fixWaiters = [];
    w.forEach(function (fn) { fn(fix); });
  }
  function onPosErr(err) {
    if (err.code === 1) gpsError = 'Ingen tilgang til posisjon. Gi appen tillatelse til posisjon (nøyaktig posisjon) i innstillingene.';
    else if (err.code === 3) gpsError = fix ? null : 'Får ikke GPS-signal ennå. Gå gjerne ut i åpent område.';
    else gpsError = 'GPS-posisjon er ikke tilgjengelig. Sjekk at posisjonstjenester er slått på.';
    updateGpsUI();
  }
  function fixIsFresh() { return fix && (Date.now() - fix.at) <= MAX_FIX_AGE_MS; }
  function waitForFix(ms) {
    if (fixIsFresh()) return Promise.resolve(copy(fix));
    startGPS();
    return new Promise(function (resolve) {
      var done = false;
      fixWaiters.push(function (f) { if (!done) { done = true; resolve(copy(f)); } });
      setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
    });
  }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  function fmt(v) { return v.toFixed(2); }
  function accText(a) { return '±' + (a < 10 ? a.toFixed(1).replace('.0', '') : Math.round(a)) + ' m'; }

  function updateGpsUI() {
    if (current !== 'camera') return;
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
  // Kamerastrømmen holdes i gang mens appen er åpen (også når du ser i galleriet),
  // slik at telefonen ikke spør om kameratillatelse på nytt hver gang du går tilbake til kameraet.
  var stream = null;
  var camReady = false;
  var busy = false;
  var wakeLock = null;
  var torchOn = false;
  var camIdleTimer = null;
  var opening = false;

  function streamLive() {
    return stream && stream.getVideoTracks().some(function (t) { return t.readyState === 'live'; });
  }
  function enterCamera() {
    clearTimeout(camIdleTimer);
    startGPS();
    refreshLastThumb();
    hideCamMsg('cam');
    updateGpsUI();
    requestWakeLock();
    if (streamLive()) attachVideo();
    else openStream();
  }
  function leaveCamera() {
    $('video').pause();
    if (torchOn) setTorch(false);
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    clearTimeout(camIdleTimer);
    camIdleTimer = setTimeout(stopStream, CAMERA_IDLE_STOP_MS);
  }
  function openStream() {
    if (opening) return;
    camReady = false;
    updateShutter();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamMsg('Kameraet er ikke tilgjengelig i denne nettleseren. Appen må åpnes via https.', 'cam', true);
      return;
    }
    opening = true;
    var constraints = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } } };
    navigator.mediaDevices.getUserMedia(constraints).catch(function (err) {
      if (err && err.name === 'NotAllowedError') throw err;
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    }).then(function (s) {
      opening = false;
      stream = s;
      setupTorch(s);
      if (current === 'camera') attachVideo();
      else { clearTimeout(camIdleTimer); camIdleTimer = setTimeout(stopStream, CAMERA_IDLE_STOP_MS); }
    }).catch(function (err) {
      opening = false;
      var msg = (err && err.name === 'NotAllowedError')
        ? 'Appen har ikke tilgang til kameraet. Trykk «Prøv igjen» og velg «Tillat».'
        : 'Klarte ikke å starte kameraet (' + (err && err.name || 'ukjent feil') + ').';
      if (current === 'camera') showCamMsg(msg, 'cam', true);
    });
  }
  function attachVideo() {
    var v = $('video');
    if (v.srcObject !== stream) v.srcObject = stream;
    var ready = function () { camReady = v.videoWidth > 0; updateShutter(); };
    v.onloadedmetadata = ready;
    v.play().then(ready).catch(function () {});
    ready();
  }
  function stopStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    camReady = false;
    torchOn = false;
    $('video').srcObject = null;
  }
  function requestWakeLock() {
    if ('wakeLock' in navigator && !wakeLock) navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
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
  function setTorch(on) {
    if (!stream) return;
    torchOn = on;
    stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }).catch(function () {});
    $('torchBtn').classList.toggle('on', on);
  }
  $('torchBtn').onclick = function () { setTorch(!torchOn); };

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
      retry.onclick = function () { hideCamMsg('cam'); stopStream(); openStream(); };
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
    var pos = copy(fix);   // posisjonen i det bildet tas
    var v = $('video');
    var w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return;
    busy = true; updateShutter();
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    flash();
    if (navigator.vibrate) navigator.vibrate(40);
    finishPhoto(canvas, pos, new Date(), 'camera').then(function (r) {
      busy = false; updateShutter();
      if (r) autoSave(r);
    }).finally(function () { busy = false; updateShutter(); });
  };

  // Reserve: telefonens egen kamera-app (brukes kun hvis innebygd kamera ikke kan startes)
  $('fileFallback').onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!fixIsFresh()) { toast('Ingen fersk GPS-posisjon – bildet ble ikke lagret. Vent på GPS og prøv igjen.'); return; }
    var pos = copy(fix);
    busy = true; updateShutter();
    fileToCanvas(file).then(function (canvas) {
      return finishPhoto(canvas, pos, new Date(), 'camera');
    }).then(function (r) {
      if (r) autoSave(r);
    }).catch(function () { toast('Kunne ikke lese bildet.'); })
      .finally(function () { busy = false; updateShutter(); });
  };

  // ---------- Felles bildebehandling ----------
  // pos: {lat, lon, acc (kan være null), utm}; source: 'camera' | 'exif' | 'import-now'
  function finishPhoto(canvas, pos, date, source) {
    var created = Date.now();
    var id = String(created) + '-' + Math.random().toString(36).slice(2, 6);
    drawOverlay(canvas, pos, date, source === 'import-now' ? 'posisjon ved import' : '');
    var thumbCanvas = makeThumb(canvas);
    var w = canvas.width, h = canvas.height;
    return Promise.all([toBlob(canvas, JPEG_QUALITY), toBlob(thumbCanvas, 0.8)]).then(function (b) {
      canvas.width = canvas.height = 0;   // frigjør minne (viktig på iPhone)
      return addExif(b[0], pos, date).then(function (full) {
        var meta = {
          id: id, created: created, taken: date.getTime(), source: source,
          x: pos.utm.x, y: pos.utm.y, zone: pos.utm.zone, epsg: pos.utm.epsg, crs: pos.utm.label,
          acc: pos.acc, lat: pos.lat, lon: pos.lon,
          width: w, height: h, size: full.size, exported: false, thumb: b[1]
        };
        return savePhoto(meta, full).then(function () {
          refreshLastThumb();
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
          return { meta: meta, blob: full };
        });
      });
    }).catch(function (err) {
      toast('Kunne ikke lagre bildet: ' + (err && err.message || err));
      return null;
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
  function fileToCanvas(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var s = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
        var c = document.createElement('canvas');
        c.width = Math.round(w * s); c.height = Math.round(h * s);
        var ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Kunne ikke lese bildet')); };
      img.src = url;
    });
  }

  // Brenner koordinatene inn i bildepikslene, nederst til venstre.
  function drawOverlay(canvas, pos, date, note) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var base = Math.min(W, H);
    var fs = Math.max(22, Math.round(base * 0.048));   // hovedtekst
    var fs2 = Math.max(13, Math.round(fs * 0.5));       // detaljlinje
    var pad = Math.round(fs * 0.45);
    var gap = Math.round(fs * 0.18);
    var mono = '"Roboto Mono", "SF Mono", Menlo, Consolas, "Droid Sans Mono", monospace';
    var sans = '-apple-system, Roboto, "Segoe UI", Helvetica, Arial, sans-serif';

    var l1 = 'X: ' + fmt(pos.utm.x);
    var l2 = 'Y: ' + fmt(pos.utm.y);
    var parts = [pos.utm.label];
    if (pos.acc != null && isFinite(pos.acc)) parts.push(accText(pos.acc));
    parts.push(dateText(date));
    if (note) parts.push(note);
    var l3 = parts.join('  ·  ');

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
    var d = new Date(m.taken || m.created);
    return 'GPSfoto_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) +
      '_X' + Math.round(m.x) + '_Y' + Math.round(m.y) + '.jpg';
  }

  // ---------- EXIF: lese GPS fra importerte bilder ----------
  function readExif(buf) {
    var v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
    var p = 2;
    while (p + 4 <= v.byteLength) {
      var marker = v.getUint16(p);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      var len = v.getUint16(p + 2);
      if (marker === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) return parseTiff(v, p + 10);
      p += 2 + len;
    }
    return null;
  }
  function parseTiff(v, t) {
    var le = v.getUint16(t) === 0x4949;
    var u16 = function (o) { return v.getUint16(t + o, le); };
    var u32 = function (o) { return v.getUint32(t + o, le); };
    function readIFD(off) {
      var out = {};
      if (!off || t + off + 2 > v.byteLength) return out;
      var n = u16(off);
      for (var i = 0; i < n; i++) {
        var e = off + 2 + i * 12;
        if (t + e + 12 > v.byteLength) break;
        var tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        var size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 })[type] || 1;
        var vo = size * count > 4 ? u32(e + 8) : e + 8;
        out[tag] = { type: type, count: count, off: vo };
      }
      return out;
    }
    function rat(o) { var d = u32(o + 4); return d ? u32(o) / d : NaN; }
    function ascii(en) { var s = ''; for (var i = 0; i < en.count - 1 && t + en.off + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(t + en.off + i)); return s; }
    function dms(en) { return rat(en.off) + rat(en.off + 8) / 60 + rat(en.off + 16) / 3600; }

    var res = {};
    var ifd0 = readIFD(u32(4));
    if (ifd0[0x8769]) {
      var ex = readIFD(u32(ifd0[0x8769].off));
      if (ex[0x9003]) res.date = parseExifDate(ascii(ex[0x9003]));
    }
    if (ifd0[0x8825]) {
      var g = readIFD(u32(ifd0[0x8825].off));
      if (g[2] && g[4]) {
        var lat = dms(g[2]), lon = dms(g[4]);
        if (g[1] && String.fromCharCode(v.getUint8(t + g[1].off)) === 'S') lat = -lat;
        if (g[3] && String.fromCharCode(v.getUint8(t + g[3].off)) === 'W') lon = -lon;
        if (isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0)) { res.lat = lat; res.lon = lon; }
        if (g[0x1F]) { var a = rat(g[0x1F].off); if (isFinite(a) && a > 0) res.acc = a; }
      }
    }
    return res;
  }
  function parseExifDate(s) {
    var m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d) ? null : d;
  }

  // ---------- EXIF: skrive GPS og tidspunkt inn i bildefilen ----------
  // Gjør at bildet havner på riktig dato og sted på kartet i Bilder-appen.
  function addExif(blob, pos, date) {
    return blob.arrayBuffer().then(function (buf) {
      try {
        var src = new Uint8Array(buf);
        var tiff = buildTiff(pos, date);
        var rest = 2;
        if (src[2] === 0xFF && src[3] === 0xE0) rest = 4 + ((src[4] << 8) | src[5]);   // fjern JFIF (APP0)
        var segLen = 2 + 6 + tiff.length;
        var head = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, segLen >> 8, segLen & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
        return new Blob([head, tiff, src.subarray(rest)], { type: 'image/jpeg' });
      } catch (e) { return blob; }
    });
  }
  function buildTiff(pos, date) {
    var bytes = function (arr) { return arr; };
    var short = function (n) { return [n >> 8 & 255, n & 255]; };
    var long = function (n) { return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]; };
    var ascii = function (s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 127); a.push(0); return a; };
    var rational = function (num, den) { return long(num).concat(long(den)); };
    var dms = function (deg) {
      deg = Math.abs(deg);
      var d = Math.floor(deg), mf = (deg - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10000);
      return rational(d, 1).concat(rational(m, 1)).concat(rational(s, 10000));
    };
    var e = function (tag, type, count, data) { return { tag: tag, type: type, count: count, data: data }; };
    var size = function (entries) {
      return entries.reduce(function (n, x) { return n + (x.data.length > 4 ? x.data.length + (x.data.length % 2) : 0); }, 2 + entries.length * 12 + 4);
    };
    function ifd(entries, start) {
      var out = short(entries.length);
      var dataOff = start + 2 + entries.length * 12 + 4;
      var data = [];
      entries.forEach(function (x) {
        out = out.concat(short(x.tag), short(x.type), long(x.count));
        if (x.data.length <= 4) { var d = x.data.slice(); while (d.length < 4) d.push(0); out = out.concat(d); }
        else {
          out = out.concat(long(dataOff));
          data = data.concat(x.data);
          dataOff += x.data.length;
          if (x.data.length % 2) { data.push(0); dataOff++; }
        }
      });
      return out.concat(long(0), data);
    }
    var off = -date.getTimezoneOffset();
    var tz = (off >= 0 ? '+' : '-') + pad2(Math.floor(Math.abs(off) / 60)) + ':' + pad2(Math.abs(off) % 60);
    var dt = date.getFullYear() + ':' + pad2(date.getMonth() + 1) + ':' + pad2(date.getDate()) + ' ' +
      pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());

    var exifE = [e(0x9003, 2, 20, ascii(dt)), e(0x9011, 2, 7, ascii(tz))];
    var gpsE = [
      e(0x0000, 1, 4, bytes([2, 3, 0, 0])),
      e(0x0001, 2, 2, ascii(pos.lat >= 0 ? 'N' : 'S')),
      e(0x0002, 5, 3, dms(pos.lat)),
      e(0x0003, 2, 2, ascii(pos.lon >= 0 ? 'E' : 'W')),
      e(0x0004, 5, 3, dms(pos.lon))
    ];
    if (pos.acc != null && isFinite(pos.acc)) gpsE.push(e(0x001F, 5, 1, rational(Math.round(pos.acc * 100), 100)));
    var ifd0Size = 2 + 4 * 12 + 4 + 20;   // 4 oppføringer + DateTime (20 byte)
    var exifStart = 8 + ifd0Size;
    var gpsStart = exifStart + size(exifE);
    var ifd0E = [
      e(0x0112, 3, 1, short(1)),               // Orientering: normal (pikslene er allerede rettet opp)
      e(0x0132, 2, 20, ascii(dt)),
      e(0x8769, 4, 1, long(exifStart)),
      e(0x8825, 4, 1, long(gpsStart))
    ];
    var all = [0x4D, 0x4D, 0, 42, 0, 0, 0, 8]
      .concat(ifd(ifd0E, 8), ifd(exifE, exifStart), ifd(gpsE, gpsStart));
    return new Uint8Array(all);
  }

  // ---------- Import fra kamerarull ----------
  $('btnImport').onclick = function () { $('importInput').click(); };
  $('galImport').onclick = function () { $('importInput').click(); };
  $('importInput').onchange = function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (files.length) importFiles(files);
  };

  function importFiles(files) {
    var withGps = 0, failed = 0;
    var results = [];
    var missing = [];   // {file, date}
    var i = 0;
    showProgress('Henter bilder …');
    function next() {
      if (i >= files.length) return Promise.resolve();
      var f = files[i++];
      setProgress('Henter bilde ' + i + ' av ' + files.length + ' …');
      return f.arrayBuffer().then(function (buf) {
        var ex = null;
        try { ex = readExif(buf); } catch (err) { ex = null; }
        var date = (ex && ex.date) || new Date(f.lastModified || Date.now());
        if (ex && ex.lat != null) {
          var utm = UTM.toUTM(ex.lat, ex.lon);
          var pos = { lat: ex.lat, lon: ex.lon, acc: ex.acc != null ? ex.acc : null, utm: utm };
          return fileToCanvas(f).then(function (c) { return finishPhoto(c, pos, date, 'exif'); })
            .then(function (r) { if (r) { withGps++; results.push(r); } else failed++; });
        }
        missing.push({ file: f, date: date });
      }).catch(function () { failed++; }).then(next);
    }
    next().then(function () {
      hideProgress();
      if (!missing.length) return 0;
      var n = missing.length;
      var txt = (n === 1 ? 'Ett bilde' : n + ' bilder') + ' har ingen GPS-posisjon i bildefilen.\n\n' +
        'Vil du bruke posisjonen der du står nå? Gjør det bare hvis bildet er tatt akkurat her.';
      return confirmDialog(txt, 'Bruk posisjonen nå', 'Hopp over', false).then(function (ok) {
        if (!ok) return 0;
        showProgress('Venter på GPS-posisjon …');
        return waitForFix(30000).then(function (pos) {
          if (!pos) { hideProgress(); toast('Fikk ikke GPS-posisjon – bildene uten posisjon ble ikke hentet.'); return 0; }
          var done = 0, j = 0;
          function step() {
            if (j >= missing.length) return Promise.resolve(done);
            var it = missing[j++];
            setProgress('Lagrer bilde ' + j + ' av ' + missing.length + ' …');
            return fileToCanvas(it.file).then(function (c) { return finishPhoto(c, pos, it.date, 'import-now'); })
              .then(function (r) { if (r) { done++; results.push(r); } else failed++; }, function () { failed++; }).then(step);
          }
          return step().then(function (d) { hideProgress(); return d; });
        });
      });
    }).then(function (nowCount) {
      var total = withGps + (nowCount || 0);
      var msg = total ? (total === 1 ? '1 bilde hentet' : total + ' bilder hentet') : 'Ingen bilder hentet';
      if (failed) msg += ' · ' + failed + ' feilet';
      toast(msg);
      nav('gallery');
      if (!results.length) return;
      var files = results.map(function (r) { return toFile(r.blob, r.meta); });
      var ids = results.map(function (r) { return r.meta.id; });
      var q = (files.length === 1 ? 'Bildet har' : 'Bildene har') + ' nå koordinatene skrevet inn.\n\nLagre ' +
        (files.length === 1 ? 'det' : 'dem') + ' i kamerarullen nå?';
      return confirmDialog(q, 'Lagre i Bilder', 'Senere', false).then(function (ok) {
        if (ok) saveToPhotos(files, ids).then(function () { if (current === 'gallery') renderGallery(); });
      });
    });
  }

  // ---------- Automatisk lagring i kamerarullen ----------
  // iPhone: delingsarket åpnes rett etter fotografering – trykk «Arkiver bilde».
  // Android: bildet lastes ned automatisk og vises i Google Foto / Galleri (mappen Download).
  function autoSave(r) {
    var file = toFile(r.blob, r.meta), id = r.meta.id;
    var coords = 'X ' + fmt(r.meta.x) + '  Y ' + fmt(r.meta.y);
    if (isIOS && canShareFiles([file])) {
      navigator.share({ files: [file] }).then(function () {
        markExported([id]).then(function () { toast('Lagret  ·  ' + coords); });
      }, function (e) {
        if (e && e.name === 'AbortError') toast('Lagret i appen, ikke i Bilder  ·  ' + coords);
        else showSaveBar();   // delingsarket ble blokkert – vis knapp
      });
    } else if (!isIOS) {
      downloadAll([file]);
      markExported([id]).then(function () { toast('Lagret i Bilder  ·  ' + coords); });
    } else {
      toast('Lagret i appen  ·  ' + coords);
      showSaveBar();
    }
  }

  // Linje med «Lagre i Bilder» for alle bilder som ikke er lagret i kamerarullen ennå.
  var pending = { ids: [], files: {} };
  function showSaveBar() {
    listMeta().then(function (all) {
      var un = all.filter(function (m) { return !m.exported; });
      var bar = $('saveBar');
      if (!un.length || selectMode || (current !== 'gallery' && current !== 'camera')) { bar.hidden = true; return; }
      pending.ids = un.map(function (m) { return m.id; });
      Object.keys(pending.files).forEach(function (id) { if (pending.ids.indexOf(id) < 0) delete pending.files[id]; });
      un.forEach(function (m) {
        if (!pending.files[m.id]) getPhoto(m.id).then(function (b) { if (b) pending.files[m.id] = toFile(b, m); });
      });
      $('saveBarText').textContent = un.length === 1 ? '1 bilde er ikke lagret i Bilder' : un.length + ' bilder er ikke lagret i Bilder';
      bar.classList.toggle('on-camera', current === 'camera');
      bar.hidden = false;
    });
  }
  $('saveBarBtn').onclick = function () {
    var files = pending.ids.map(function (id) { return pending.files[id]; });
    if (!files.length || files.some(function (f) { return !f; })) { toast('Klargjør bildene … trykk igjen om et øyeblikk'); return; }
    saveToPhotos(files, pending.ids.slice()).then(function (ok) {
      if (ok) { $('saveBar').hidden = true; if (current === 'gallery') renderGallery(); }
    });
  };

  // ---------- Galleri ----------
  var thumbUrls = [];
  var selectMode = false;
  var selected = {};       // id -> true
  var fileCache = {};      // id -> File (lastet på forhånd så deling starter umiddelbart)
  var galleryMetas = [];

  function renderGallery() {
    thumbUrls.forEach(URL.revokeObjectURL);
    thumbUrls = [];
    var grid = $('grid');
    listMeta().then(function (all) {
      galleryMetas = all;
      grid.innerHTML = '';
      $('galEmpty').hidden = all.length > 0;
      $('galSelect').hidden = selectMode || !all.length;
      all.forEach(function (m) {
        var b = document.createElement('button');
        b.className = 'tile' + (selected[m.id] ? ' sel' : '');
        if (m.thumb) {
          var u = URL.createObjectURL(m.thumb);
          thumbUrls.push(u);
          b.style.backgroundImage = 'url(' + u + ')';
        }
        var s = document.createElement('span');
        s.textContent = dateText(new Date(m.taken || m.created));
        b.appendChild(s);
        if (m.exported) { var sv = document.createElement('i'); sv.className = 'saved'; sv.textContent = '✓ lagret'; b.appendChild(sv); }
        if (selectMode) { var c = document.createElement('i'); c.className = 'check'; c.textContent = selected[m.id] ? '✓' : ''; b.appendChild(c); }
        b.onclick = function () {
          if (selectMode) toggleSelect(m.id);
          else nav('viewer', m.id);
        };
        grid.appendChild(b);
      });
      updateSelUI();
      showSaveBar();
    });
  }
  function setSelectMode(on) {
    selectMode = on;
    if (!on) { selected = {}; fileCache = {}; }
    $('galSelect').hidden = on;
    $('galImport').hidden = on;
    $('galAll').hidden = !on;
    $('galDone').hidden = !on;
    $('galCamera').hidden = on;
    $('selBar').hidden = !on;
    if (on) $('saveBar').hidden = true;
  }
  function toggleSelect(id) {
    if (selected[id]) { delete selected[id]; delete fileCache[id]; }
    else { selected[id] = true; cacheFile(id); }
    renderGallery();
  }
  function cacheFile(id) {
    var m = galleryMetas.find(function (x) { return x.id === id; });
    getPhoto(id).then(function (blob) {
      if (blob && selected[id] && m) fileCache[id] = toFile(blob, m);
    });
  }
  function selectedIds() { return Object.keys(selected); }
  function updateSelUI() {
    var n = selectedIds().length;
    $('galTitle').textContent = selectMode ? (n ? n + ' valgt' : 'Velg bilder') : 'Bilder (' + galleryMetas.length + ')';
    ['selSave', 'selShare', 'selDelete'].forEach(function (b) { $(b).disabled = !n; });
  }
  function selectedFiles() {
    var ids = selectedIds();
    var files = ids.map(function (id) { return fileCache[id]; });
    if (files.some(function (f) { return !f; })) return null;
    return { ids: ids, files: files };
  }

  $('galSelect').onclick = function () { setSelectMode(true); renderGallery(); };
  $('galDone').onclick = function () { setSelectMode(false); renderGallery(); };
  $('galAll').onclick = function () {
    var all = galleryMetas.every(function (m) { return selected[m.id]; });
    if (all) { selected = {}; fileCache = {}; }
    else galleryMetas.forEach(function (m) { if (!selected[m.id]) { selected[m.id] = true; cacheFile(m.id); } });
    renderGallery();
  };
  $('selSave').onclick = function () {
    var s = selectedFiles();
    if (!s) { toast('Klargjør bildene … trykk igjen om et øyeblikk'); return; }
    saveToPhotos(s.files, s.ids).then(function (ok) { if (ok) { setSelectMode(false); renderGallery(); } });
  };
  $('selShare').onclick = function () {
    var s = selectedFiles();
    if (!s) { toast('Klargjør bildene … trykk igjen om et øyeblikk'); return; }
    shareFiles(s.files, s.ids);
  };
  $('selDelete').onclick = function () {
    var ids = selectedIds();
    if (!ids.length) return;
    confirmDialog('Slette ' + (ids.length === 1 ? 'dette bildet' : 'disse ' + ids.length + ' bildene') + '?', 'Slett', 'Avbryt', true).then(function (ok) {
      if (!ok) return;
      deletePhotos(ids).then(function () { toast(ids.length === 1 ? 'Bildet er slettet' : ids.length + ' bilder slettet'); setSelectMode(false); renderGallery(); });
    });
  };

  // ---------- Visning ----------
  var viewUrl = null;
  var viewing = null;   // {meta, file}
  function clearViewer() {
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    viewUrl = null; viewing = null;
    $('viewImg').removeAttribute('src');
  }
  var SOURCE_TEXT = {
    camera: 'Tatt i appen',
    exif: 'Kamerarull (GPS fra bildet)',
    'import-now': 'Kamerarull (posisjon ved import)'
  };
  function renderViewer(id) {
    clearViewer();
    Promise.all([getMeta(id), getPhoto(id)]).then(function (r) {
      var m = r[0], blob = r[1];
      if (!m || !blob) { nav('gallery'); return; }
      viewing = { meta: m, file: toFile(blob, m) };
      viewUrl = URL.createObjectURL(blob);
      $('viewImg').src = viewUrl;
      $('viewTitle').textContent = dateText(new Date(m.taken || m.created));
      var rows = [
        ['X (øst)', fmt(m.x)],
        ['Y (nord)', fmt(m.y)],
        ['System', m.crs + ' (EPSG:' + m.epsg + ')'],
        ['Nøyaktighet', m.acc != null ? accText(m.acc) : 'ukjent'],
        ['Tatt', dateText(new Date(m.taken || m.created))],
        ['Kilde', SOURCE_TEXT[m.source] || SOURCE_TEXT.camera],
        ['Oppløsning', m.width + ' × ' + m.height + ' px'],
        ['Lagret i Bilder', m.exported ? 'Ja' : 'Nei']
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

  function toFile(blob, m) {
    return new File([blob], fileName(m), { type: 'image/jpeg', lastModified: m.taken || m.created });
  }
  function canShareFiles(files) {
    try { return !!(navigator.canShare && navigator.canShare({ files: files })); } catch (e) { return false; }
  }
  function markExported(ids) {
    return Promise.all(ids.map(function (id) {
      return getMeta(id).then(function (m) { if (m) { m.exported = true; return putMeta(m); } });
    }));
  }
  // Deling må startes direkte fra trykket, ellers blokkerer iPhone delingsarket.
  function shareFiles(files, ids) {
    if (canShareFiles(files)) {
      return navigator.share({ files: files }).then(function () {
        return markExported(ids).then(function () { return true; });
      }, function (e) {
        if (e && e.name !== 'AbortError') toast('Deling feilet: ' + e.message);
        return false;
      });
    }
    downloadAll(files);
    return markExported(ids).then(function () { toast('Deling støttes ikke her – bildene er lastet ned i stedet.'); return true; });
  }
  function saveToPhotos(files, ids) {
    if (isIOS && canShareFiles(files)) {
      toast(files.length === 1 ? 'Velg «Arkiver bilde»' : 'Velg «Arkiver ' + files.length + ' bilder»');
      return shareFiles(files, ids);
    }
    downloadAll(files);
    return markExported(ids).then(function () {
      toast(files.length === 1 ? 'Bildet er lagret i Nedlastinger' : files.length + ' bilder lagret i Nedlastinger');
      return true;
    });
  }
  function downloadAll(files) {
    files.forEach(function (file, i) {
      setTimeout(function () {
        var a = document.createElement('a');
        var u = URL.createObjectURL(file);
        a.href = u; a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 20000);
      }, i * 400);
    });
  }

  $('actShare').onclick = function () {
    if (viewing) shareFiles([viewing.file], [viewing.meta.id]).then(function (ok) { if (ok) viewing && renderViewer(viewing.meta.id); });
  };
  $('actSave').onclick = function () {
    if (viewing) saveToPhotos([viewing.file], [viewing.meta.id]).then(function (ok) { if (ok) viewing && renderViewer(viewing.meta.id); });
  };
  $('actDelete').onclick = function () {
    if (!viewing) return;
    var id = viewing.meta.id;
    confirmDialog('Slette dette bildet?', 'Slett', 'Avbryt', true).then(function (ok) {
      if (!ok) return;
      deletePhotos([id]).then(function () { toast('Bildet er slettet'); goBack(); });
    });
  };

  // ---------- Små hjelpere ----------
  function confirmDialog(text, okText, cancelText, danger) {
    return new Promise(function (resolve) {
      $('dialogText').textContent = text;
      $('dialogText').style.whiteSpace = 'pre-line';
      $('dialogOk').textContent = okText || 'OK';
      $('dialogCancel').textContent = cancelText || 'Avbryt';
      $('dialogOk').className = 'act' + (danger ? ' danger' : ' primary');
      $('dialog').hidden = false;
      $('dialogOk').onclick = function () { $('dialog').hidden = true; resolve(true); };
      $('dialogCancel').onclick = function () { $('dialog').hidden = true; resolve(false); };
    });
  }
  function showProgress(t) { $('progressText').textContent = t; $('progress').hidden = false; }
  function setProgress(t) { $('progressText').textContent = t; }
  function hideProgress() { $('progress').hidden = true; }
  var toastTimer = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
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

  // ---------- Knapper ----------
  $('btnTake').onclick = function () { nav('camera'); };
  $('btnGallery').onclick = function () { nav('gallery'); };
  $('galCamera').onclick = function () { nav('camera'); };
  $('camBack').onclick = goBack;
  $('galBack').onclick = goBack;
  $('viewBack').onclick = goBack;
  $('lastThumb').onclick = function () { nav('gallery'); };

  // Når appen legges i bakgrunnen slås kamera og GPS av (sparer batteri, frigjør kameraet).
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopStream();
      stopGPS();
      if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    } else {
      if (gpsWanted) startGPS();
      if (current === 'camera') enterCamera();
    }
  });

  // Gamle lenker med #/… fra forrige versjon: rydd adressen én gang ved oppstart.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  show('home');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  // Til testing
  window.__gpsfoto = { drawOverlay: drawOverlay, listMeta: listMeta, getPhoto: getPhoto, readExif: readExif, addExif: addExif, importFiles: importFiles };
})();
