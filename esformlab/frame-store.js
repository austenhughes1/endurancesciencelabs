// ==============================================================
//  FrameStore -- decode each uploaded clip ONCE into a frame cache
// ==============================================================
//
// Every frame esFormLab shows or poses (scan, phase cards, scrubber, report
// images) is read from here instead of by seeking a live <video>.
//
// Seeking was the root of the upload failures. Each seek re-decodes from the
// previous keyframe -- on a phone's 4K / HEVC / 60fps clip that is dozens of
// frames per seek, times hundreds of seeks per scan. Seeks that overran their
// timeout silently drew a stale frame (the "one frame for the whole clip"
// scrubber), three live decoders exhausted Android's hardware decoder slots
// (one clip black), concurrent seeks on one element raced each other, and
// native-size canvases blew through iOS Safari's canvas memory cap (black
// cards and scrubber).
//
// Instead each clip is played through once, muted, on ONE shared <video>, and
// every presented frame is captured with requestVideoFrameCallback into a
// size-capped JPEG keyed by its exact presentation time. Anything the playback
// pass missed (or the whole clip, where playback capture is unavailable) is
// filled by seeking. The decoder is then released and every frame can be drawn
// instantly and deterministically.
var FrameStore = (function () {
  'use strict';

  var HAS_RVFC = typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  // A canvas.toBlob encode still in flight holds a full-size snapshot; past
  // this many we skip frames (filled by seeking later) rather than pile up.
  var MAX_PENDING_ENCODES = 6;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Resolves with the first of `events` fired on el, or null after ms.
  function waitEvent(el, events, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { finish(null); }, ms);
      function finish(ev) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        events.forEach(function (n) { el.removeEventListener(n, finish); });
        resolve(ev);
      }
      events.forEach(function (n) { el.addEventListener(n, finish); });
    });
  }

  function quietPlay(vid) {
    try { var p = vid.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }

  // Call synchronously inside the user's click, before any await. iOS (always
  // in Low Power Mode) refuses programmatic play() on an element that was
  // never played from a user gesture; one gesture-time play() unlocks it for
  // every clip later loaded into it.
  function prime(vid) {
    vid.muted = true;
    vid.defaultMuted = true;
    vid.playsInline = true;
    vid.setAttribute('muted', '');
    vid.setAttribute('playsinline', '');
    vid.setAttribute('webkit-playsinline', '');
    quietPlay(vid);
    try { vid.pause(); } catch (e) {}
  }

  // The frame on screen at time t is the last one presented at or before t --
  // the same frame a <video> shows after seeking to t.
  function indexAt(times, t) {
    var n = times.length;
    if (!n) return -1;
    var key = t + 5e-4;
    if (!(key >= times[0])) return 0;
    var lo = 0, hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (times[mid] <= key) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function decodeViaImg(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function decode(blob) {
    if (!blob) return Promise.resolve(null);
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).catch(function () { return decodeViaImg(blob); });
    }
    return decodeViaImg(blob);
  }

  function closeLater(p) {
    // Deferred so a caller that already holds this bitmap can finish drawing.
    p.then(function (img) {
      if (img && typeof img.close === 'function') setTimeout(function () { img.close(); }, 1500);
    });
  }

  // ── Store: one decoded clip ───────────────────────────────────────────
  //
  // Duck-types the parts of HTMLVideoElement the app reads (duration,
  // videoWidth, videoHeight). videoWidth/videoHeight are the STORED frame size,
  // which is the coordinate space every pose estimated from these frames lives
  // in; nativeWidth/nativeHeight are the original clip's.
  function Store(info) {
    this.times = info.times;
    this.blobs = info.blobs;
    this.ok = this.times.length > 0;
    this.videoWidth = this.ok ? info.width : 0;
    this.videoHeight = this.ok ? info.height : 0;
    this.nativeWidth = info.nativeWidth || 0;
    this.nativeHeight = info.nativeHeight || 0;
    this.duration = info.duration;
    this.fps = info.fps || null;
    this.coverage = info.coverage;
    this.method = info.method;
    this.error = info.error || null;
    this.extractMs = info.extractMs || 0;
    this.bytes = info.bytes || 0;
    this.stats = info.stats || {};
    this._cache = new Map();
    this._cacheMax = info.cacheMax || 16;
  }

  Store.prototype.frameCount = function () { return this.times.length; };
  Store.prototype.indexAt = function (t) { return indexAt(this.times, t); };

  // Presentation time of the frame shown at t.
  Store.prototype.frameTime = function (t) {
    var i = this.indexAt(t);
    return i < 0 ? t : this.times[i];
  };

  // Presentation time of the frame n frames away from the one shown at t.
  Store.prototype.step = function (t, n) {
    var i = this.indexAt(t);
    if (i < 0) return t;
    return this.times[Math.max(0, Math.min(this.times.length - 1, i + n))];
  };

  // Decoded image (ImageBitmap or <img>) of the frame shown at t, or null.
  // Draw it immediately: evicted entries are closed shortly afterwards.
  Store.prototype.image = function (t) {
    var i = this.indexAt(t);
    if (i < 0) return Promise.resolve(null);
    var hit = this._cache.get(i);
    if (hit) {
      this._cache.delete(i);
      this._cache.set(i, hit);
      return hit;
    }
    var p = decode(this.blobs[i]);
    this._cache.set(i, p);
    while (this._cache.size > this._cacheMax) {
      var oldest = this._cache.keys().next().value;
      closeLater(this._cache.get(oldest));
      this._cache.delete(oldest);
    }
    return p;
  };

  Store.prototype.release = function () {
    this._cache.forEach(closeLater);
    this._cache.clear();
    this.times = [];
    this.blobs = [];
    this.ok = false;
  };

  // ── Extraction ────────────────────────────────────────────────────────
  //
  // opts:
  //   maxDim      longest side of stored frames (px)
  //   maxFps      highest frame rate stored (higher-fps clips keep every Nth)
  //   maxFrames   cap per clip; long clips store a lower frame rate
  //   quality     JPEG quality
  //   maxRate     fastest playbackRate to try while capturing
  //   maxSeeks    cap on seek-filled frames
  //   cacheMax    decoded frames kept for scrubbing
  //   onProgress  function(fraction 0-1)
  async function extract(file, vid, opts) {
    opts = opts || {};
    var maxDim = opts.maxDim || 1280;
    var maxFps = opts.maxFps || 60;
    var maxFrames = opts.maxFrames || 900;
    var quality = opts.quality || 0.85;
    var maxRate = opts.maxRate || 1;
    var maxSeeks = opts.maxSeeks || 300;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};

    var started = performance.now();
    var url = URL.createObjectURL(file);
    var slots = [];             // {t, blob} in capture order
    var pending = 0, drainWaiter = null;
    var canvas = null, ctx = null;
    var W = 0, H = 0, nativeW = 0, nativeH = 0;
    var duration = NaN, srcPeriod = 0, minInterval = 1 / maxFps;
    var method = 'none', error = null;
    var stats = { playbackFrames: 0, seekFrames: 0, stop: null, rates: [] };

    function stored(t) {
      for (var i = slots.length - 1; i >= 0; i--) if (Math.abs(slots[i].t - t) < 1e-3) return true;
      return false;
    }

    // Snapshot the element's current frame and queue its JPEG encode.
    // toBlob copies the canvas synchronously, so the one canvas is reusable.
    function grab(t) {
      try { ctx.drawImage(vid, 0, 0, W, H); } catch (e) { return false; }
      var slot = { t: t, blob: null };
      slots.push(slot);
      pending++;
      try {
        canvas.toBlob(function (b) {
          slot.blob = b;
          if (--pending === 0 && drainWaiter) drainWaiter();
        }, 'image/jpeg', quality);
      } catch (e) {
        if (--pending === 0 && drainWaiter) drainWaiter();
        return false;
      }
      return true;
    }

    function drain(ms) {
      if (pending === 0) return Promise.resolve();
      return Promise.race([
        new Promise(function (r) { drainWaiter = r; }),
        sleep(ms)
      ]);
    }

    function capturePlayback() {
      return new Promise(function (resolve) {
        var finished = false, ended = false;
        var lastMt = -1, lastStored = -Infinity, lastFrameWall = performance.now();
        var rate = 1, ceiling = maxRate, winStart = null, winCount = 0, sawFrame = false;
        var dog = setInterval(watchdog, 1000);

        function finish(reason) {
          if (finished) return;
          finished = true;
          clearInterval(dog);
          vid.removeEventListener('ended', onEnded);
          try { vid.pause(); } catch (e) {}
          resolve(reason);
        }
        function onEnded() {
          ended = true;
          // The last frame's callback can land just after 'ended'.
          setTimeout(function () { finish('ended'); }, 250);
        }
        function watchdog() {
          if (finished || ended) return;
          if (document.visibilityState !== 'visible') {
            // Phones pause media in background tabs; resume on return.
            lastFrameWall = performance.now();
            return;
          }
          if (vid.paused) quietPlay(vid);
          if (performance.now() - lastFrameWall > 6000) finish(sawFrame ? 'stalled' : 'no-frames');
        }
        function onFrame(now, meta) {
          if (finished) return;
          var mt = meta.mediaTime;
          lastFrameWall = performance.now();
          if (mt > lastMt + 1e-4) {
            sawFrame = true;
            if (lastMt >= 0) {
              var d = mt - lastMt;
              if (d > 0.002 && (!srcPeriod || d < srcPeriod)) srcPeriod = d;
            }
            lastMt = mt;
            var keep = mt - lastStored >= minInterval * 0.9 && pending < MAX_PENDING_ENCODES;
            if (keep && grab(mt)) lastStored = mt;
            else keep = false;
            if (isFinite(duration)) onProgress(Math.min(1, mt / duration) * 0.9);

            // Every ~0.5s of media, compare frames stored against frames due.
            // Slow playback when capture can't keep up, speed it up when it
            // can -- but never back up to a rate that already dropped frames.
            if (winStart === null) { winStart = mt; winCount = 0; }
            else {
              if (keep) winCount++;
              var span = mt - winStart;
              if (span >= 0.5 && srcPeriod > 0) {
                var ratio = winCount / (span / Math.max(srcPeriod, minInterval));
                var next = rate;
                if (ratio < 0.85 && rate > 0.5) next = ceiling = Math.max(0.5, rate / 2);
                else if (ratio > 0.97 && rate < ceiling) next = Math.min(ceiling, rate * 2);
                if (next !== rate) {
                  rate = next;
                  stats.rates.push(rate + '@' + mt.toFixed(2));
                  try { vid.playbackRate = rate; } catch (e) {}
                }
                winStart = mt;
                winCount = 0;
              }
            }
          }
          vid.requestVideoFrameCallback(onFrame);
        }

        vid.addEventListener('ended', onEnded);
        vid.requestVideoFrameCallback(onFrame);
        try { vid.playbackRate = 1; } catch (e) {}
        var p;
        try { p = vid.play(); } catch (e) { finish('play-error'); return; }
        if (p && p.catch) {
          p.catch(function (e) {
            if (!sawFrame) finish('play-blocked:' + (e && e.name));
          });
        }
      });
    }

    // Seek to t and grab the frame shown there. With requestVideoFrameCallback
    // the frame's true presentation time is recorded; without it, t is.
    async function seekGrab(t) {
      var meta = null, handle = null;
      if (HAS_RVFC) handle = vid.requestVideoFrameCallback(function (now, m) { meta = m; });
      try { vid.currentTime = t; } catch (e) { return 'fail'; }
      var ev = await waitEvent(vid, ['seeked'], 5000);
      if (!ev) {
        if (handle != null) try { vid.cancelVideoFrameCallback(handle); } catch (e) {}
        return 'fail';
      }
      if (HAS_RVFC) {
        for (var w = 0; w < 6 && !meta; w++) await sleep(50);
        if (!meta && handle != null) try { vid.cancelVideoFrameCallback(handle); } catch (e) {}
      } else {
        await sleep(40);
      }
      var ft = meta ? meta.mediaTime : t;
      if (stored(ft)) return 'dup';
      return grab(ft) ? 'ok' : 'fail';
    }

    // Seek targets for frames missing from the playback capture.
    function missingTargets() {
      var times = slots.map(function (s) { return s.t; }).sort(function (a, b) { return a - b; });
      var period = Math.max(srcPeriod || 1 / 30, minInterval);
      var half = (srcPeriod || 1 / 30) / 2;
      var end = isFinite(duration) ? duration : (times.length ? times[times.length - 1] + period : 0);
      var out = [];
      var prev = -period;
      times.concat([end]).forEach(function (t) {
        if (t - prev > period * 1.6) {
          for (var x = prev + period; x < t - period * 0.5; x += period) out.push(Math.max(0, x + half));
        }
        prev = t;
      });
      return out;
    }

    // Fixed-step seek grid: used when playback capture got nothing.
    function gridTargets() {
      var step = Math.max(1 / 30, minInterval);
      var out = [];
      for (var t = 0; t < duration - 0.01; t += step) out.push(t);
      return out;
    }

    async function seekFill(targets, share0) {
      if (!targets.length) return;
      if (targets.length > maxSeeks) {
        // Spread the budget evenly rather than filling only the start.
        var thinned = [];
        for (var k = 0; k < maxSeeks; k++) thinned.push(targets[Math.floor(k * targets.length / maxSeeks)]);
        targets = thinned;
      }
      var fails = 0;
      for (var i = 0; i < targets.length; i++) {
        while (pending >= MAX_PENDING_ENCODES) await sleep(10);
        var r = await seekGrab(targets[i]);
        if (r === 'fail') { if (++fails >= 4) break; } else fails = 0;
        onProgress(share0 + (1 - share0) * (i + 1) / targets.length);
      }
    }

    try {
      vid.src = url;
      vid.load();
      var ev = await waitEvent(vid, ['loadedmetadata', 'error'], 6000);
      if (!ev && !vid.error && vid.readyState < 1) {
        // Some mobile browsers defer loading until playback is requested.
        quietPlay(vid);
        ev = await waitEvent(vid, ['loadedmetadata', 'error'], 8000);
        try { vid.pause(); } catch (e) {}
      }
      if (vid.error || !vid.videoWidth) {
        throw new Error(vid.error ? 'unsupported' : 'no-metadata');
      }
      if (vid.readyState < 2) await waitEvent(vid, ['loadeddata', 'error'], 6000);

      nativeW = vid.videoWidth;
      nativeH = vid.videoHeight;
      duration = (isFinite(vid.duration) && vid.duration > 0) ? vid.duration : NaN;
      if (isFinite(duration)) minInterval = Math.max(minInterval, duration / maxFrames);
      var scale = Math.min(1, maxDim / Math.max(nativeW, nativeH));
      W = Math.max(2, Math.round(nativeW * scale));
      H = Math.max(2, Math.round(nativeH * scale));
      canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('no-canvas');

      if (HAS_RVFC) {
        var reason = await capturePlayback();
        stats.stop = reason;
        stats.playbackFrames = slots.length;
        method = 'playback';
        if (!isFinite(duration) && slots.length) {
          duration = slots[slots.length - 1].t + Math.max(srcPeriod || 1 / 30, minInterval);
        }
        if (slots.length) {
          var gaps = missingTargets();
          if (gaps.length) { method = 'playback+seek'; await seekFill(gaps, 0.9); }
        } else {
          console.warn('[frame-store] playback capture got no frames (' + reason + '); seeking instead');
        }
      }
      if (!slots.length && isFinite(duration)) {
        method = 'seek';
        await seekFill(gridTargets(), 0);
      }
      stats.seekFrames = slots.length - stats.playbackFrames;
      await drain(15000);
    } catch (e) {
      error = (e && e.message) || String(e);
    } finally {
      try { vid.pause(); } catch (e) {}
      try { vid.removeAttribute('src'); vid.load(); } catch (e) {}
      URL.revokeObjectURL(url);
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }

    var kept = slots.filter(function (s) { return s.blob; }).sort(function (a, b) { return a.t - b.t; });
    var bytes = 0;
    kept.forEach(function (s) { bytes += s.blob.size; });
    var period = Math.max(srcPeriod || 1 / 30, minInterval);
    var expected = isFinite(duration) ? Math.max(1, Math.round(duration / period)) : kept.length;
    var store = new Store({
      times: kept.map(function (s) { return s.t; }),
      blobs: kept.map(function (s) { return s.blob; }),
      width: W, height: H, nativeWidth: nativeW, nativeHeight: nativeH,
      duration: duration,
      fps: srcPeriod ? Math.round(1 / srcPeriod) : null,
      coverage: kept.length ? Math.min(1, kept.length / expected) : 0,
      method: method,
      error: error || (kept.length ? null : 'no-frames'),
      extractMs: Math.round(performance.now() - started),
      bytes: bytes,
      stats: stats,
      cacheMax: opts.cacheMax
    });
    console.log('[frame-store] ' + (file && file.name) + ': ' + store.frameCount() + ' frames, ' +
      nativeW + 'x' + nativeH + ' -> ' + W + 'x' + H + ', ' + (store.fps || '?') + 'fps, coverage ' +
      Math.round(store.coverage * 100) + '%, ' + method + ', ' + Math.round(bytes / 1024) + 'KB, ' +
      store.extractMs + 'ms' + (store.error ? ', error: ' + store.error : ''), stats);
    return store;
  }

  return { prime: prime, extract: extract };
})();
