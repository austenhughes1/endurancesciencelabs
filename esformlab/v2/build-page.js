#!/usr/bin/env node
'use strict';
// Keeps the v2 detection scripts wired into esformlab/index.html.
//
//   node esformlab/v2/build-page.js           rewrite the v2 script block in esformlab/index.html
//   node esformlab/v2/build-page.js --check   exit 1 if the block is out of date or the page drifted
//
// esformlab/index.html loads gait-events.js, pose-v2.js and scan-v2.js from v2/ after
// its inline script and before initModel(). They replace the page's scan and pose
// functions (see esformlab/v2/README.md). Each script tag carries ?v=<hash of the
// script>, so an edited script is never served stale: after editing one, run this
// script and commit the page with it. `npm test` runs it with --check.
//
// It also guards against the page drifting under the v2 scripts. It fails when:
//   - the block's markers are missing;
//   - a global the v2 scripts use is no longer declared by the page or its modules;
//   - the page's autoScanAll changed (scan-v2.js holds a reviewed copy of its body).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'index.html');

// The v2 scripts, in load order.
const V2_SCRIPTS = ['gait-events.js', 'pose-v2.js', 'scan-v2.js'];

// The main page's own modules (searched, with the page, for the globals the v2 scripts use).
const V1_MODULES = ['frame-store', 'report-render', 'saved-analyses', 'auth-paywall', 'gait-data', 'gait-engine'];

// scan-v2.js replaces autoScanAll with a copy of the main page's body in which only
// the sampling and detection core changed. When the page's autoScanAll changes,
// this hash stops matching and the check fails until the copy in scan-v2.js has
// been brought up to date; then put the new hash here.
const AUTO_SCAN_ALL_SHA = 'ef34252c22103e1c';

// Names in the v2 scripts' /* global */ comments that are not the main page's.
const NOT_V1_GLOBALS = ['EslPoseV2', 'EslGaitEvents', 'EslScanV2', 'tf', 'poseDetection', 'location'];

const BEGIN = '<!-- esFormLab v2 detection (esformlab/v2/README.md). Tags kept current by esformlab/v2/build-page.js. -->';
const END = '<!-- /esFormLab v2 detection -->';

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); }

// The page's `async function autoScanAll(){ ... }` (up to the first closing brace in column 0), or null.
function autoScanAllOf(src) {
  const a = src.indexOf('\nasync function autoScanAll(){');
  if (a < 0) return null;
  const e = src.indexOf('\n}\n', a + 1);
  return e < 0 ? null : src.slice(a + 1, e + 2);
}

// The names the v2 scripts list in their /* global */ comments, less their own.
function v2Globals(v2) {
  const names = new Set();
  V2_SCRIPTS.forEach(function (f) {
    const re = /\/\*\s*global\s+([\s\S]*?)\*\//g;
    let m;
    while ((m = re.exec(v2[f]))) m[1].split(/[\s,]+/).filter(Boolean).forEach(function (n) { names.add(n); });
  });
  NOT_V1_GLOBALS.forEach(function (n) { names.delete(n); });
  return Array.from(names);
}

// Is name declared at the top level (column 0) of the page's source: a function, or a
// var/let/const (also later in a comma list on the same line)?
function declares(src, name) {
  const re = new RegExp('^(?:(?:async\\s+)?function\\s+' + name + '\\s*\\(|(?:var|let|const)\\s+(?:[^;\\n]*,\\s*)?' + name + '\\s*[=,;])', 'm');
  return re.test(src);
}

function block(v2) {
  return BEGIN + '\n' +
    V2_SCRIPTS.map(function (s) { return '<script src="v2/' + s + '?v=' + sha(v2[s]) + '"></script>\n'; }).join('') +
    END;
}

// src: esformlab/index.html. v2: {file name: content} of V2_SCRIPTS. modules: the text of the
// page's modules (V1_MODULES). Returns the page with the v2 block brought up to date; throws
// when the page no longer matches what the v2 scripts were written against.
function build(src, v2, modules) {
  const missingFiles = V2_SCRIPTS.filter(function (f) { return typeof v2[f] !== 'string'; });
  if (missingFiles.length) throw new Error('build-page: missing v2 script(s): ' + missingFiles.join(', '));
  const asa = autoScanAllOf(src);
  if (!asa) throw new Error('build-page: esformlab/index.html no longer declares async function autoScanAll(){');
  if (sha(asa) !== AUTO_SCAN_ALL_SHA) {
    throw new Error('build-page: autoScanAll in esformlab/index.html changed (hash ' + sha(asa) + '). scan-v2.js holds a copy of its body: ' +
      'bring that copy up to date, then set AUTO_SCAN_ALL_SHA in esformlab/v2/build-page.js to the new hash.');
  }
  const all = [src].concat(modules || []).join('\n');
  const missing = v2Globals(v2).filter(function (n) { return !declares(all, n); });
  if (missing.length) {
    throw new Error('build-page: the v2 scripts use globals the page no longer declares at top level: ' + missing.join(', '));
  }
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < a || src.indexOf(BEGIN, a + 1) >= 0) {
    throw new Error('build-page: esformlab/index.html must contain the v2 block markers exactly once, after the inline script and before initModel()');
  }
  return src.slice(0, a) + block(v2) + src.slice(b + END.length);
}

// The inputs build() takes, read from disk.
function readInputs() {
  const v2 = {};
  V2_SCRIPTS.forEach(function (f) { v2[f] = fs.readFileSync(path.join(__dirname, f), 'utf8'); });
  const modules = V1_MODULES.map(function (m) { return fs.readFileSync(path.join(__dirname, '..', m + '.js'), 'utf8'); });
  return { src: fs.readFileSync(SRC, 'utf8'), v2: v2, modules: modules };
}

module.exports = { build, readInputs, declares, v2Globals, autoScanAllOf, sha, block, SRC, V2_SCRIPTS, V1_MODULES, AUTO_SCAN_ALL_SHA, BEGIN, END };

if (require.main === module) {
  const inp = readInputs();
  const want = build(inp.src, inp.v2, inp.modules);
  if (process.argv.includes('--check')) {
    if (inp.src !== want) {
      console.error('esformlab/index.html: the v2 script tags are out of date: run node esformlab/v2/build-page.js');
      process.exit(1);
    }
    console.log('esformlab/index.html: v2 script tags current, page matches the v2 scripts');
  } else {
    fs.writeFileSync(SRC, want);
    console.log('updated', path.relative(process.cwd(), SRC));
  }
}
