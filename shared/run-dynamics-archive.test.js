// ════════════════════════════════════════════════════════════════
// shared/run-dynamics-archive.test.js
//
// Pins for reading .fit files out of an imported .zip: a COROS export (the
// .fit files in the .zip itself) and a Garmin account export (the .fit files
// in zips inside the .zip). Run with plain node:
//
//   node shared/run-dynamics-archive.test.js
//
// run-dynamics.js is a browser IIFE that exposes only window.RunDynamics, so
// fitArchiveRuns and corosErrMsg are lifted out of its source text and
// evaluated alone. JSZip and the FIT parser are stand-ins: an archive is a
// map of path → file, and a file's "bytes" are the made-up runs it holds.
// ════════════════════════════════════════════════════════════════
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');

var src = fs.readFileSync(path.join(__dirname, 'run-dynamics.js'), 'utf8');
function lift(name) {
  var a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error(name + ' not found in run-dynamics.js');
  var b = src.indexOf('\n}\n', a);
  return src.slice(a, b + 2);
}
var lib = vm.runInNewContext([lift('fitFileType'), lift('fitArchiveRuns'), lift('corosErrMsg'),
  lift('norm'), lift('fitNum'), lift('fitPos'), lift('runFromFitSession')].join('\n') +
  '; ({ fitFileType: fitFileType, fitArchiveRuns: fitArchiveRuns, corosErrMsg: corosErrMsg, runFromFitSession: runFromFitSession })',
  { Uint8Array: Uint8Array, Date: Date, Math: Math, String: String, isFinite: isFinite });

var failures = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.log('  FAIL ' + label + ': got ' + g + ', want ' + w); }
}

// The JSZip stand-in. zip(files) is an archive; a path ending in / is a folder.
// log records, in order, every archive opened and every file read.
function zip(files) { return { zipOf: files }; }
function fit() { return { runs: Array.prototype.slice.call(arguments) }; }
function harness() {
  var log = [];
  var JSZip = {
    loadAsync: function (buf) {
      if (!buf || !buf.zipOf) return Promise.reject(new Error('Corrupted zip: missing end of central directory'));
      log.push('open ' + Object.keys(buf.zipOf).join(','));
      var files = buf.zipOf;
      return Promise.resolve({
        forEach: function (cb) {
          Object.keys(files).forEach(function (p) {
            cb(p, { dir: /\/$/.test(p), async: function (type) { log.push('read ' + p + ' as ' + type); return Promise.resolve(files[p]); } });
          });
        },
      });
    },
  };
  function parseFit(buf) { log.push('parse'); return Promise.resolve(buf && buf.runs ? buf.runs : []); }
  var progress = [];
  function onProgress(done, total, part, parts) { progress.push([done, total, part, parts]); }
  return {
    log: log, progress: progress,
    run: function (archive) { return lib.fitArchiveRuns(JSZip, parseFit, archive, onProgress); },
  };
}

var sections = [];
function section(name, fn) { sections.push({ name: name, fn: fn }); }

section('a COROS .zip: the .fit files in the .zip itself', function () {
  var h = harness();
  return h.run(zip({ 'a.fit': fit('run1'), 'b.FIT': fit('run2', 'run3'), 'notes.txt': {} })).then(function (runs) {
    eq('every run from every .fit', runs, ['run1', 'run2', 'run3']);
    eq('progress counts the files, no parts', h.progress, [[1, 2, 0, 0], [2, 2, 0, 0]]);
    eq('the .txt is never read', h.log.filter(function (l) { return /notes/.test(l) && /^read/.test(l); }), []);
  });
});

section('a Garmin account export: the .fit files in the zips inside it', function () {
  var h = harness();
  var exp = zip({
    'DI_CONNECT/': {},
    'DI_CONNECT/DI-Connect-Fitness/summary.json': {},
    'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_Part1.zip': zip({ 'x_1.fit': fit('runA'), 'x_2.fit': fit(), 'readme.json': {} }),
    'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_Part2.zip': zip({ 'x_3.FIT': fit('runB') }),
  });
  return h.run(exp).then(function (runs) {
    eq('runs from both inner zips; a file without runs adds none', runs, ['runA', 'runB']);
    eq('progress counts within each part', h.progress, [[1, 2, 1, 2], [2, 2, 1, 2], [1, 1, 2, 2]]);
    eq('inner zips are read as bytes', h.log.filter(function (l) { return /Part\d\.zip as arraybuffer$/.test(l); }).length, 2);
  });
});

section('the inner zips are opened one after another, each finished before the next', function () {
  var h = harness();
  var exp = zip({ 'p1.zip': zip({ 'a.fit': fit('r1') }), 'p2.zip': zip({ 'b.fit': fit('r2') }) });
  return h.run(exp).then(function () {
    eq('order', h.log, [
      'open p1.zip,p2.zip',
      'read p1.zip as arraybuffer', 'open a.fit', 'read a.fit as arraybuffer', 'parse',
      'read p2.zip as arraybuffer', 'open b.fit', 'read b.fit as arraybuffer', 'parse',
    ]);
  });
});

section('the .zip\'s own .fit files are read before its inner zips', function () {
  var h = harness();
  return h.run(zip({ 'inner.zip': zip({ 'b.fit': fit('r2') }), 'a.fit': fit('r1') })).then(function (runs) {
    eq('own first', runs, ['r1', 'r2']);
    eq('progress: part 0 then part 1', h.progress, [[1, 1, 0, 1], [1, 1, 1, 1]]);
  });
});

section('a folder named like a .fit file is skipped', function () {
  var h = harness();
  return h.run(zip({ 'odd.fit/': {}, 'a.fit': fit('r1') })).then(function (runs) {
    eq('runs', runs, ['r1']);
    eq('one file counted', h.progress, [[1, 1, 0, 0]]);
  });
});

section('an inner zip with no .fit files is fine when another part has some', function () {
  var h = harness();
  return h.run(zip({ 'empty.zip': zip({ 'a.json': {} }), 'full.zip': zip({ 'a.fit': fit('r1') }) })).then(function (runs) {
    eq('runs', runs, ['r1']);
  });
});

section('no .fit files anywhere: the import says so', function () {
  var h = harness();
  return h.run(zip({ 'a.json': {}, 'inner.zip': zip({ 'b.gpx': {} }) })).then(function () {
    eq('rejected', 'resolved', 'rejected');
  }, function (e) {
    eq('message', e.message, 'No .fit files found inside the .zip.');
    eq('in words the athlete can act on', lib.corosErrMsg(e), 'No .fit files found inside the .zip. Use the .zip from Garmin’s Export Your Data email, or a COROS export saved as .FIT.');
  });
});

section('a broken inner zip stops the import with the could-not-open message', function () {
  var h = harness();
  return h.run(zip({ 'a.fit': fit('r1'), 'bad.zip': { notAZip: true } })).then(function () {
    eq('rejected', 'resolved', 'rejected');
  }, function (e) {
    eq('in words the athlete can act on', lib.corosErrMsg(e), 'That .zip couldn’t be opened — download it again from the Garmin or COROS email.');
  });
});

// Made-up FIT bytes for fitFileType: a 14-byte header, the given records, a 2-byte CRC (not checked).
function fitBytes(records) {
  var data = [].concat.apply([], records), n = data.length;
  var head = [14, 0x20, 0x2D, 0x08, n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF, 0x2E, 0x46, 0x49, 0x54, 0, 0];
  return new Uint8Array(head.concat(data, [0, 0])).buffer;
}
// A definition record: local message, global number, fields [number, size, base type], developer
// fields [number, size, index] (sets the developer-data flag), big endian or not.
function def(local, global, fields, devFields, big) {
  var r = [0x40 | (devFields ? 0x20 : 0) | local, 0, big ? 1 : 0];
  r = r.concat(big ? [global >> 8, global & 0xFF] : [global & 0xFF, global >> 8], [fields.length]);
  fields.forEach(function (f) { r = r.concat(f); });
  if (devFields) { r.push(devFields.length); devFields.forEach(function (f) { r = r.concat(f); }); }
  return r;
}
function dat(local, bytes) { return [local].concat(bytes); }
var MANUFACTURER_THEN_TYPE = [[1, 2, 0x84], [0, 1, 0x00]];

section('fitFileType reads the file type from file_id without parsing the file', function () {
  eq('activity', lib.fitFileType(fitBytes([def(0, 0, MANUFACTURER_THEN_TYPE), dat(0, [0xFF, 0x00, 4])])), 4);
  eq('monitoring', lib.fitFileType(fitBytes([def(0, 0, MANUFACTURER_THEN_TYPE), dat(0, [0xFF, 0x00, 32])])), 32);
  eq('big endian', lib.fitFileType(fitBytes([def(0, 0, MANUFACTURER_THEN_TYPE, null, true), dat(0, [0x00, 0xFF, 4])])), 4);
  eq('after another message', lib.fitFileType(fitBytes([
    def(1, 49, [[0, 2, 0x84]]), dat(1, [1, 0]),
    def(0, 0, [[0, 1, 0x00]]), dat(0, [4]),
  ])), 4);
  eq('after a message with developer fields', lib.fitFileType(fitBytes([
    def(1, 49, [[0, 2, 0x84]], [[0, 3, 0]]), dat(1, [1, 0, 9, 9, 9]),
    def(0, 0, [[0, 1, 0x00]]), dat(0, [32]),
  ])), 32);
});

section('fitFileType gives null when it can\'t tell, so the file is parsed in full', function () {
  eq('not a FIT file', lib.fitFileType(new Uint8Array(20).buffer), null);
  eq('too short', lib.fitFileType(new Uint8Array(4).buffer), null);
  eq('no file_id, only a session', lib.fitFileType(fitBytes([def(0, 18, [[5, 1, 0x00]]), dat(0, [1])])), null);
  eq('file_id without a type field', lib.fitFileType(fitBytes([def(0, 0, [[1, 2, 0x84]]), dat(0, [1, 0])])), null);
  eq('cut off after the definition', lib.fitFileType(fitBytes([def(0, 0, MANUFACTURER_THEN_TYPE)])), null);
  eq('compressed-timestamp header', lib.fitFileType(fitBytes([[0x80, 0, 0]])), null);
});

section('runFromFitSession keeps runs only: a session without a sport is not one', function () {
  var base = { start_time: '2026-10-03T04:00:00Z', total_timer_time: 2400, total_distance: 8046.7, avg_speed: 3.353 };
  function s(extra) { return Object.assign({}, base, extra); }
  eq('running', lib.runFromFitSession(s({ sport: 'running' })).type, 'Running');
  eq('trail running', lib.runFromFitSession(s({ sport: 'trail_running' })).type, 'Trail_running');
  eq('treadmill', lib.runFromFitSession(s({ sport: 'running', sub_sport: 'treadmill' })).type, 'Treadmill Running');
  eq('cycling', lib.runFromFitSession(s({ sport: 'cycling' })), null);
  eq('swimming', lib.runFromFitSession(s({ sport: 'swimming' })), null);
  eq('no sport (a Garmin Connect-made activity, could be anything)', lib.runFromFitSession(s({})), null);
  eq('sport undefined', lib.runFromFitSession(s({ sport: undefined, sub_sport: 'generic' })), null);
  eq('no start time', lib.runFromFitSession({ sport: 'running' }), null);
});

section('corosErrMsg passes other messages through, and has a fallback', function () {
  eq('other', lib.corosErrMsg(new Error('Something else')), 'Something else');
  eq('empty', lib.corosErrMsg(null), 'Could not read this file.');
});

sections.reduce(function (chain, s) {
  return chain.then(function () { console.log(s.name); return s.fn(); });
}, Promise.resolve()).then(function () {
  console.log('\n' + checks + ' checks, ' + (checks - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}, function (e) {
  console.log('CRASH ' + (e && e.stack || e));
  process.exit(1);
});
