// ════════════════════════════════════════════════════════════════
// Gait engine for esFormLab: pose-overlay drawing, per-frame
// metric computation, the FPPA / functional-metric helpers, and
// the rules-engine (REPORT_DATA / COACHING_CUES / detectIssues).
//
// Extracted from the main esformlab/index.html inline <script>.
// Pure relocation -- function bodies are byte-identical and the
// globals they reference (MIN_CONF, LEFT_KPS, RIGHT_KPS, SKELETON,
// PHASE_DEFS, METRIC_ROWS, isRelevant, phases, lastIssues, etc.)
// continue to live in gait-data.js or the main inline script.
// Both share global scope; this file is loaded after gait-data.js
// so that COACHING_CUES (initialised from REPORT_DATA at top level)
// can read REPORT_DATA defined inside this same file.
// ════════════════════════════════════════════════════════════════

// Drawing
function isSideView(kps){
  var MIN2 = 0.25;
  var lHi = (kps[11]&&kps[11].score>=MIN2) ? kps[11] : null;
  var rHi = (kps[12]&&kps[12].score>=MIN2) ? kps[12] : null;
  var lSh = (kps[5] &&kps[5].score>=MIN2)  ? kps[5]  : null;
  var rSh = (kps[6] &&kps[6].score>=MIN2)  ? kps[6]  : null;
  if(!lHi||!rHi) return true;
  var hipSpread = Math.abs(lHi.x - rHi.x);
  var torsoH = (lSh&&rSh)
    ? Math.abs(((lSh.y+rSh.y)/2) - ((lHi.y+rHi.y)/2))
    : Math.abs(lHi.y - rHi.y) * 2 || 100;
  var ratio = hipSpread / (torsoH || 100);
  return ratio < 0.7;
}

function drawPose(ctx,kps,W,H){
  ctx.save();SKELETON.forEach(function(pair){var a=pair[0],b=pair[1];var ka=kps[a],kb=kps[b];if(!ka||!kb||ka.score<MIN_CONF||kb.score<MIN_CONF)return;ctx.beginPath();ctx.moveTo(ka.x,ka.y);ctx.lineTo(kb.x,kb.y);ctx.strokeStyle=LEFT_KPS.has(a)&&LEFT_KPS.has(b)?'#00d4aa':RIGHT_KPS.has(a)&&RIGHT_KPS.has(b)?'#ff6b35':'#8b7cf8';ctx.lineWidth=Math.max(2,W*0.003);ctx.lineCap='round';ctx.globalAlpha=0.85;ctx.stroke();});
  ctx.globalAlpha=1;var r=Math.max(4,W*0.007);
  kps.forEach(function(k,i){if(!k||k.score<MIN_CONF)return;ctx.beginPath();ctx.arc(k.x,k.y,r,0,2*Math.PI);ctx.fillStyle=i<5?'#fff':LEFT_KPS.has(i)?'#00d4aa':'#ff6b35';ctx.fill();ctx.strokeStyle='rgba(0,0,0,.55)';ctx.lineWidth=Math.max(1.5,W*0.002);ctx.stroke();});
  if(isSideView(kps)){
    drawAngles(ctx,kps,W);
  } else {
    ctx.save();
    var fs=Math.max(12,Math.min(18,W*0.02));
    ctx.font='700 '+fs+'px "Space Mono","Courier New",monospace';
    ctx.textAlign='center';ctx.textBaseline='middle';
    var msg='Front/back view -- pose overlay only';
    var tw=ctx.measureText(msg).width+20;
    var bh=fs+12;
    ctx.fillStyle='rgba(6,8,13,.82)';
    ctx.beginPath();
    if(ctx.roundRect)ctx.roundRect(W/2-tw/2,H-bh-12,tw,bh,6);
    else ctx.rect(W/2-tw/2,H-bh-12,tw,bh);
    ctx.fill();
    ctx.fillStyle='#8b7cf8';
    ctx.fillText(msg,W/2,H-bh/2-12);
    ctx.restore();
  }
  ctx.restore();
}
function drawAngles(ctx,kps,W){
  var r=Math.max(28,W*0.046);var p=function(i){return (kps[i]&&kps[i].score>=MIN_CONF)?kps[i]:null;};
  var lSh=p(5),rSh=p(6),lHi=p(11),rHi=p(12),lKn=p(13),rKn=p(14),lAn=p(15),rAn=p(16),lEl=p(7),rEl=p(8),lWr=p(9),rWr=p(10);
  if(lSh&&rSh&&lHi&&rHi){var shM={x:(lSh.x+rSh.x)/2,y:(lSh.y+rSh.y)/2},hiM={x:(lHi.x+rHi.x)/2,y:(lHi.y+rHi.y)/2};var lean=Math.atan2(shM.x-hiM.x,hiM.y-shM.y)*180/Math.PI;ctx.save();ctx.beginPath();ctx.moveTo(hiM.x,hiM.y);ctx.lineTo(shM.x,shM.y);ctx.strokeStyle='#f5c842';ctx.lineWidth=Math.max(2,W*0.003);ctx.setLineDash([Math.max(5,W*0.006),Math.max(3,W*0.004)]);ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(hiM.x,hiM.y);ctx.lineTo(hiM.x,hiM.y-Math.abs(hiM.y-shM.y));ctx.strokeStyle='rgba(245,200,66,.22)';ctx.lineWidth=Math.max(1,W*0.001);ctx.setLineDash([4,4]);ctx.stroke();ctx.setLineDash([]);ctx.restore();drawLabel(ctx,(lean>0?'+':'')+lean.toFixed(1)+'\u00b0',(shM.x+hiM.x)/2+r*0.8,(shM.y+hiM.y)/2,'#f5c842',W);}
  if(lHi&&lKn&&lAn)arcAt(ctx,lKn,lHi,lAn,'#00d4aa',r,W);if(rHi&&rKn&&rAn)arcAt(ctx,rKn,rHi,rAn,'#ff6b35',r,W);
  if(lSh&&lHi&&lKn)arcAt(ctx,lHi,lSh,lKn,'#00b890',r*0.72,W);if(rSh&&rHi&&rKn)arcAt(ctx,rHi,rSh,rKn,'#e05520',r*0.72,W);
  if(lSh&&lEl&&lWr)arcAt(ctx,lEl,lSh,lWr,'#00c0a0',r*0.62,W);if(rSh&&rEl&&rWr)arcAt(ctx,rEl,rSh,rWr,'#e06030',r*0.62,W);
}
function arcAt(ctx,vertex,p1,p2,color,r,W){var angle=calcAngle(p1,vertex,p2);if(!angle)return;var a1=Math.atan2(p1.y-vertex.y,p1.x-vertex.x),a2=Math.atan2(p2.y-vertex.y,p2.x-vertex.x);var diff=a2-a1;while(diff>Math.PI)diff-=2*Math.PI;while(diff<-Math.PI)diff+=2*Math.PI;ctx.save();ctx.beginPath();ctx.moveTo(vertex.x,vertex.y);ctx.arc(vertex.x,vertex.y,r,a1,a2,diff<0);ctx.closePath();ctx.fillStyle=color+'15';ctx.fill();ctx.beginPath();ctx.arc(vertex.x,vertex.y,r,a1,a2,diff<0);ctx.strokeStyle=color;ctx.lineWidth=Math.max(1.5,r*0.045);ctx.stroke();ctx.restore();var midA=a1+diff/2;drawLabel(ctx,angle.toFixed(0)+'\u00b0',vertex.x+(r+r*0.55)*Math.cos(midA),vertex.y+(r+r*0.55)*Math.sin(midA),color,W);}
function drawLabel(ctx,text,x,y,color,W){ctx.save();var fs=Math.max(11,Math.min(17,W*0.018));ctx.font='700 '+fs+'px "Space Mono","Courier New",monospace';ctx.textAlign='center';ctx.textBaseline='middle';var tw=ctx.measureText(text).width,pw=tw+9,ph=fs+7;ctx.fillStyle='rgba(6,8,13,.84)';ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x-pw/2,y-ph/2,pw,ph,3);else ctx.rect(x-pw/2,y-ph/2,pw,ph);ctx.fill();ctx.fillStyle=color;ctx.fillText(text,x,y);ctx.restore();}
function drawMiniSkeleton(ctx,kps,sx,sy){SKELETON.forEach(function(pair){var a=pair[0],b=pair[1];var ka=kps[a],kb=kps[b];if(!ka||!kb||ka.score<MIN_CONF||kb.score<MIN_CONF)return;ctx.beginPath();ctx.moveTo(ka.x*sx,ka.y*sy);ctx.lineTo(kb.x*sx,kb.y*sy);ctx.strokeStyle=LEFT_KPS.has(a)&&LEFT_KPS.has(b)?'#00d4aa':RIGHT_KPS.has(a)&&RIGHT_KPS.has(b)?'#ff6b35':'#8b7cf8';ctx.lineWidth=1.5;ctx.globalAlpha=0.8;ctx.stroke();});ctx.globalAlpha=1;kps.forEach(function(k,i){if(!k||k.score<MIN_CONF)return;ctx.beginPath();ctx.arc(k.x*sx,k.y*sy,2.5,0,2*Math.PI);ctx.fillStyle=i<5?'#fff':LEFT_KPS.has(i)?'#00d4aa':'#ff6b35';ctx.fill();});}

// Math
function calcAngle(a,b,c){if(!a||!b||!c)return null;var ba={x:a.x-b.x,y:a.y-b.y},bc={x:c.x-b.x,y:c.y-b.y};var dot=ba.x*bc.x+ba.y*bc.y,mag=Math.hypot(ba.x,ba.y)*Math.hypot(bc.x,bc.y);if(!mag||!isFinite(mag))return null;return Math.acos(Math.max(-1,Math.min(1,dot/mag)))*180/Math.PI;}


function computeMetrics(kps){
  var g2=function(i){return (kps[i]&&kps[i].score>=MIN_CONF)?kps[i]:null;};var m={};
  var lSh=g2(5),rSh=g2(6),lHi=g2(11),rHi=g2(12),lAn=g2(15),rAn=g2(16),nose=g2(0);
  if(lSh&&rSh&&lHi&&rHi){var shM={x:(lSh.x+rSh.x)/2,y:(lSh.y+rSh.y)/2},hiM={x:(lHi.x+rHi.x)/2,y:(lHi.y+rHi.y)/2};var dir=(nose&&nose.x>hiM.x)?1:-1;var rawLean=Math.atan2(shM.x-hiM.x,hiM.y-shM.y)*180/Math.PI;m.trunk=dir*rawLean;var th=Math.abs(hiM.y-shM.y);if(lAn&&th>0)m.lFoot=dir*(lAn.x-hiM.x)/th;if(rAn&&th>0)m.rFoot=dir*(rAn.x-hiM.x)/th;}
  var lKnA=calcAngle(g2(11),g2(13),g2(15));if(lKnA!==null)m.lKnee=lKnA;var rKnA=calcAngle(g2(12),g2(14),g2(16));if(rKnA!==null)m.rKnee=rKnA;
  var lHiA=calcAngle(g2(5),g2(11),g2(13));if(lHiA!==null)m.lHip=lHiA;var rHiA=calcAngle(g2(6),g2(12),g2(14));if(rHiA!==null)m.rHip=rHiA;
  var lElA=calcAngle(g2(5),g2(7),g2(9));if(lElA!==null)m.lElbow=lElA;var rElA=calcAngle(g2(6),g2(8),g2(10));if(rElA!==null)m.rElbow=rElA;
  return m;
}

// Front/Back metrics. Every measurement below is expressed in a BODY-RELATIVE frame
// (body-up = hipMid->shMid, body-lateral = perpendicular to it), so image rotation
// or camera roll doesn't affect any reported value. Pose keypoint positions are used
// only via projections onto body-frame axes and via rotation-invariant cross products.
function computeFrontBackMetrics(kps) {
  var g3=function(i){return (kps[i]&&kps[i].score>=MIN_CONF)?kps[i]:null;};
  var lSh=g3(5),rSh=g3(6),lHi=g3(11),rHi=g3(12),lKn=g3(13),rKn=g3(14),lAn=g3(15),rAn=g3(16),lWr=g3(9),rWr=g3(10);

  var result = {
    hipDrop: null, hipDropAbs: null, hipDropDeg: null,
    lWristCross: null, rWristCross: null,
    lKneeValgus: null, rKneeValgus: null,
    lKneeValgusDeg: null, rKneeValgusDeg: null,
    avgConfidence: 0
  };

  var totalConf = 0, count = 0;
  for(var ci=0;ci<kps.length;ci++){ totalConf += (kps[ci].score||0); count++; }
  result.avgConfidence = count > 0 ? totalConf/count : 0;

  // Body frame. body-up points from hip midpoint to shoulder midpoint (along the torso).
  // body-lat is the in-plane perpendicular, oriented so rHi has a positive lateral
  // component (i.e. +lat = subject's right side in anatomy).
  var bodyUp = null, bodyLat = null, hipMid = null, shMid = null, torsoLen = 0;
  if(lSh && rSh && lHi && rHi) {
    shMid  = {x:(lSh.x+rSh.x)/2, y:(lSh.y+rSh.y)/2};
    hipMid = {x:(lHi.x+rHi.x)/2, y:(lHi.y+rHi.y)/2};
    var upX = shMid.x - hipMid.x, upY = shMid.y - hipMid.y;
    torsoLen = Math.hypot(upX, upY);
    if(torsoLen > 10) {
      bodyUp = {x: upX/torsoLen, y: upY/torsoLen};
      var perp = {x: -bodyUp.y, y: bodyUp.x};
      var rDotPerp = (rHi.x - hipMid.x)*perp.x + (rHi.y - hipMid.y)*perp.y;
      bodyLat = rDotPerp >= 0 ? perp : {x: bodyUp.y, y: -bodyUp.x};
    }
  }
  var proj = function(p, origin, axis) {
    return (p.x - origin.x)*axis.x + (p.y - origin.y)*axis.y;
  };

  // Pelvic obliquity in body frame.
  // Decompose (rHi - lHi) into body-lateral and body-up components. In a level pelvis the
  // separation is entirely lateral; any body-up component is the obliquity we're measuring.
  if(bodyUp && bodyLat && lHi && rHi) {
    var hhVert = proj(rHi, lHi, bodyUp);   // >0 if rHip is higher along torso than lHip
    var hhLat  = proj(rHi, lHi, bodyLat);  // lateral separation (positive by construction)
    if(Math.abs(hhLat) > 10) {
      result.hipDropDeg = Math.atan2(Math.abs(hhVert), Math.abs(hhLat)) * 180 / Math.PI;
      // Legacy signed ratio: positive = left hip lower (= rHip higher in body frame).
      result.hipDrop = torsoLen > 0 ? hhVert / torsoLen : null;
      result.hipDropAbs = result.hipDrop !== null ? Math.abs(result.hipDrop) : null;
    }
  }

  // Wrist crossing = wrist's body-lateral offset from shoulder midline, normalized by
  // the shoulder-to-shoulder body-lateral distance. Crossing the midline means the
  // wrist has a lateral component on the opposite side of the body's midline.
  if(bodyLat && shMid && lSh && rSh) {
    var shWidthLat = Math.abs(proj(rSh, shMid, bodyLat) - proj(lSh, shMid, bodyLat));
    if(shWidthLat > 10) {
      if(lWr) {
        // lWr is on subject's left; crossing = moves toward subject's right (+lat).
        var lLat = proj(lWr, shMid, bodyLat);
        result.lWristCross = Math.max(0, lLat / shWidthLat);
      }
      if(rWr) {
        // rWr is on subject's right; crossing = moves toward subject's left (-lat).
        var rLat = proj(rWr, shMid, bodyLat);
        result.rWristCross = Math.max(0, -rLat / shWidthLat);
      }
    }
  }

  // Stance side = whichever ankle is further "below" the hip midpoint in the body
  // frame (larger projection on -bodyUp). Rotation-invariant substitute for the
  // legacy "lower ankle in image y" heuristic.
  var stanceSide = null;
  if(bodyUp && hipMid && lAn && rAn) {
    var lDown = -proj(lAn, hipMid, bodyUp);
    var rDown = -proj(rAn, hipMid, bodyUp);
    stanceSide = (lDown >= rDown) ? 'left' : 'right';
  } else if(lAn && !rAn) {
    stanceSide = 'left';
  } else if(rAn && !lAn) {
    stanceSide = 'right';
  }

  // Knee valgus (FPPA). Magnitude = 180 - angle at the knee (rotation-invariant by
  // construction). Sign: use 2D cross products to test whether the knee lies on the
  // same side of the hip-ankle line as the opposite hip. Same side = medial (valgus),
  // opposite side = lateral (varus). Both cross products are rotation-invariant.
  var fppaSignedDeg = function(hip, knee, ankle, oppHip) {
    if(!hip || !knee || !ankle || !oppHip) return null;
    var ang = calcAngle(hip, knee, ankle);
    if(ang === null || !isFinite(ang)) return null;
    var dev = 180 - ang;
    var refX = ankle.x - hip.x, refY = ankle.y - hip.y;
    var kneeCross = refX*(knee.y - hip.y) - refY*(knee.x - hip.x);
    var oppCross  = refX*(oppHip.y - hip.y) - refY*(oppHip.x - hip.x);
    return (kneeCross * oppCross) >= 0 ? dev : -dev;
  };
  // Legacy ratio metric, now rotation-invariant: signed perpendicular distance from
  // knee to the hip-ankle line divided by the body-lateral hip width.
  var fppaRatio = function(hip, knee, ankle, oppHip, latHipWidth) {
    if(!hip || !knee || !ankle || !oppHip || !(latHipWidth > 0)) return null;
    var refX = ankle.x - hip.x, refY = ankle.y - hip.y;
    var refLen = Math.hypot(refX, refY);
    if(refLen < 5) return null;
    var kneeCross = refX*(knee.y - hip.y) - refY*(knee.x - hip.x);
    var oppCross  = refX*(oppHip.y - hip.y) - refY*(oppHip.x - hip.x);
    var perpRatio = (Math.abs(kneeCross) / refLen) / latHipWidth;
    return (kneeCross * oppCross) >= 0 ? perpRatio : -perpRatio;
  };

  if(bodyLat && lHi && rHi) {
    var latHipWidth = Math.abs(proj(rHi, lHi, bodyLat));
    if(latHipWidth > 10) {
      if(stanceSide === 'left' && lKn && lAn) {
        var rL = fppaRatio(lHi, lKn, lAn, rHi, latHipWidth);
        result.lKneeValgus = (rL !== null && rL > 0) ? rL : 0;
        result.lKneeValgusDeg = fppaSignedDeg(lHi, lKn, lAn, rHi);
        result.stanceSide = 'left';
      }
      if(stanceSide === 'right' && rKn && rAn) {
        var rR = fppaRatio(rHi, rKn, rAn, lHi, latHipWidth);
        result.rKneeValgus = (rR !== null && rR > 0) ? rR : 0;
        result.rKneeValgusDeg = fppaSignedDeg(rHi, rKn, rAn, lHi);
        result.stanceSide = 'right';
      }
    }
  }

  return result;
}

// -- Add functional metric keys for bilateral side-view phases --
// ── Brightness normalization fallback ─────────────────────
// Only used when initial detection is weak. Stretches the image
// histogram to improve contrast before a retry.
function normalizeAndRetry(srcCanvas) {
  var w = srcCanvas.width, h = srcCanvas.height;
  var tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = w; tmpCanvas.height = h;
  var tmpCtx = tmpCanvas.getContext('2d', {willReadFrequently: true});
  tmpCtx.drawImage(srcCanvas, 0, 0);
  var imageData = tmpCtx.getImageData(0, 0, w, h);
  var data = imageData.data;
  var minL = 255, maxL = 0;
  for (var i = 0; i < data.length; i += 64) {
    var lum = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
    if (lum < minL) minL = lum;
    if (lum > maxL) maxL = lum;
  }
  var range = maxL - minL;
  if (range > 5 && range < 230) {
    var scale = 255 / range;
    for (var j = 0; j < data.length; j += 4) {
      data[j]   = Math.min(255, Math.max(0, (data[j]   - minL) * scale));
      data[j+1] = Math.min(255, Math.max(0, (data[j+1] - minL) * scale));
      data[j+2] = Math.min(255, Math.max(0, (data[j+2] - minL) * scale));
    }
    tmpCtx.putImageData(imageData, 0, 0);
  }
  return tmpCanvas;
}

function isWeakDetection(kps) {
  if (!kps) return true;
  var relevant = [5,6,7,8,11,12,13,14,15,16];
  var scores = relevant.map(function(i) { return (kps[i] && kps[i].score) || 0; });
  var avg = scores.reduce(function(a,b) { return a+b; }, 0) / scores.length;
  var min = Math.min.apply(null, scores);
  return avg < 0.5 || min < 0.25;
}

function addFunctionalMetrics(metrics, phaseKey, kps) {
  if (!metrics || !kps) return;
  var g4 = function(i) { return (kps[i] && kps[i].score >= MIN_CONF) ? kps[i] : null; };

  // Near-camera elbow (always computed)
  var lSh = g4(5), rSh = g4(6), lEl = g4(7), rEl = g4(8), lWr = g4(9), rWr = g4(10);
  var lArmConf = 0, rArmConf = 0, lArmN = 0, rArmN = 0;
  if (lSh) { lArmConf += lSh.score; lArmN++; }
  if (lEl) { lArmConf += lEl.score; lArmN++; }
  if (lWr) { lArmConf += lWr.score; lArmN++; }
  if (rSh) { rArmConf += rSh.score; rArmN++; }
  if (rEl) { rArmConf += rEl.score; rArmN++; }
  if (rWr) { rArmConf += rWr.score; rArmN++; }
  var nearSide = (lArmN > 0 ? lArmConf / lArmN : 0) >= (rArmN > 0 ? rArmConf / rArmN : 0) ? 'l' : 'r';
  if (metrics[nearSide + 'Elbow'] != null) {
    metrics.nearElbow = metrics[nearSide + 'Elbow'];
  }
  metrics.nearElbowSide = nearSide === 'l' ? 'L' : 'R';

  // Lead/trail/plant detection
  var lAnkle = g4(15), rAnkle = g4(16);
  var lAnkleY = lAnkle ? lAnkle.y : -Infinity;
  var rAnkleY = rAnkle ? rAnkle.y : -Infinity;

  if (phaseKey === 'l_foot') {
    // Left foot striking = left is lead
    metrics.leadSide = 'L'; metrics.trailSide = 'R';
    if (metrics.lKnee != null) metrics.leadKnee = metrics.lKnee;
    if (metrics.lHip != null) metrics.leadHip = metrics.lHip;
    if (metrics.lFoot != null) metrics.leadFoot = metrics.lFoot;
  } else if (phaseKey === 'r_foot') {
    metrics.leadSide = 'R'; metrics.trailSide = 'L';
    if (metrics.rKnee != null) metrics.leadKnee = metrics.rKnee;
    if (metrics.rHip != null) metrics.leadHip = metrics.rHip;
    if (metrics.rFoot != null) metrics.leadFoot = metrics.rFoot;
  } else if (phaseKey === 'l_toe') {
    // Left toe-off: left leg is pushing off (trail), right is swinging forward (lead)
    metrics.leadSide = 'R'; metrics.trailSide = 'L';
    if (metrics.rHip != null) metrics.leadHip = metrics.rHip;
    if (metrics.lHip != null) metrics.trailHip = metrics.lHip;
  } else if (phaseKey === 'r_toe') {
    metrics.leadSide = 'L'; metrics.trailSide = 'R';
    if (metrics.lHip != null) metrics.leadHip = metrics.lHip;
    if (metrics.rHip != null) metrics.trailHip = metrics.rHip;
  } else if (phaseKey === 'mid') {
    var plantSide = (lAnkleY >= rAnkleY) ? 'l' : 'r';
    metrics.plantSide = plantSide === 'l' ? 'L' : 'R';
    if (metrics[plantSide + 'Knee'] != null) metrics.plantKnee = metrics[plantSide + 'Knee'];
    if (metrics[plantSide + 'Hip'] != null) metrics.plantHip = metrics[plantSide + 'Hip'];
  }
}

function metricSideLabel(key, m) {
  if (!m) return '';
  if (key === 'nearElbow' && m.nearElbowSide) return ' (' + m.nearElbowSide + ')';
  if ((key === 'leadKnee' || key === 'leadHip' || key === 'leadFoot') && m.leadSide) return ' (' + m.leadSide + ')';
  if (key === 'trailHip' && m.trailSide) return ' (' + m.trailSide + ')';
  if ((key === 'plantKnee' || key === 'plantHip') && m.plantSide) return ' (' + m.plantSide + ')';
  return '';
}

// ==============================================================
//  DETECTION RULES (6 issues)
// ==============================================================
// ==============================================================
//  FULL REPORT PROTOCOL DATA (from running_stride_analysis_protocols.csv)
// ==============================================================
var REPORT_DATA = {
  overstriding: {
    title: 'Overstriding',
    clear: 'No significant overstriding detected',
    summary: {
      notable: 'Your foot is landing well ahead of your hip at contact, which acts like a brake with every stride.',
      mild: 'Your foot is landing slightly ahead of your hip at contact. This is common but can increase braking forces over time.'
    },
    whatThisMeans: 'Your foot is landing too far in front of your body at initial contact, often with a reaching pattern and a less vertical shin upon landing. This can result in a strong heel-first contact farther in front of the body than is ideal.',
    whyItMatters: 'Landing with the foot far ahead of the hip is linked to greater braking forces, higher knee demands, and a less energy-efficient stride. These higher loading patterns have been associated with several running injury profiles, though the relationship is not perfectly consistent across all studies.',
    whyItMattersRef: 'https://pubmed.ncbi.nlm.nih.gov/26538175/',
    possibleReasons: [
      {text: 'Low cadence relative to speed -- not enough flight time between steps, often because the trailing leg is not generating enough vertical force at push-off to let the lead leg naturally land more underneath the body before contact.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6883353/'},
      {text: 'Reaching forward from the hip or knee in terminal swing instead of letting the body travel over the foot, potentially due to not enough push-off from the trailing leg.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4714754/'},
      {text: 'Running too upright, which increases the leg angle at contact.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4714754/'},
      {text: 'Fatigue, downhill running, or pushing pace faster than is well controlled.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10818105/'},
      {text: 'Measurement note: the selected foot-strike frame may be slightly before or after actual contact, or the side camera may not be perfectly perpendicular.', ref: ''}
    ],
    formCues: [
      {text: 'Increase cadence by not "reaching" with the lead leg. This is the most well-supported first cue for overstriding -- it usually shortens step length and reduces lower-body loading.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10761631/'},
      {text: 'Take shorter, quicker steps. Decreasing step length has been shown to reduce musculoskeletal loads and tibial strain.', ref: 'https://pubmed.ncbi.nlm.nih.gov/37488528/'},
      {text: 'Land closer underneath your body with a more vertical shin. A relatively vertical shin at landing is tied to lower braking forces. This can be achieved by producing more vertical force with the trailing leg push-off, giving yourself more time in the air to get the leg back underneath you.', ref: 'https://pubmed.ncbi.nlm.nih.gov/26538175/'},
      {text: 'Run softer and quieter. Soft-landing cues can reduce impact-related forces and work well when paired with cadence feedback.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10939780/'}
    ],
    confidence: 'This can be flagged with relatively high confidence when it repeats across multiple left and right foot strikes from the side view.'
  },
  hipDrop: {
    title: 'Hip drop',
    clear: 'No significant hip drop detected',
    summary: {
      notable: 'Your hip is dropping significantly on the swing side during stance, which increases stress on the knee and IT band.',
      mild: 'Your hip is dropping slightly on the swing side during stance -- a sign that your glute medius could be working harder.'
    },
    whatThisMeans: 'During stance, your pelvis tilts so the swing-leg side drops below horizontal instead of staying level. Healthy recreational runners typically sit in the 3\u20138\u00b0 range; values above ~10\u00b0 are consistent with higher injury risk per Bramah et al. 2018. 2D video carries roughly \u00b13\u20135\u00b0 of measurement uncertainty vs 3D motion capture, so a single value near a threshold is a prompt for further assessment, not a diagnosis. A left\u2013right asymmetry of 3\u00b0 or more is itself clinically meaningful, even when both sides are within the healthy range.',
    whyItMatters: 'Greater pelvic drop and related hip mechanics are commonly observed in runners with patellofemoral pain, ITBS, MTSS, and other lower-chain overload patterns (Bramah 2018: each 1\u00b0 increase raises the odds of injured classification by ~80%). Not every runner with pelvic drop will have symptoms, but persistent elevation with marked asymmetry warrants a closer look.',
    whyItMattersRef: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3984468/',
    possibleReasons: [
      {text: 'Hip abductor or glute medius strength may not be sufficient to hold the pelvis level under the demands of single-leg stance.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9528670/'},
      {text: 'Decreased knee drive and vertical force at push-off, resulting in longer ground contact times -- the longer the foot is on the ground, the more time the pelvis has to hold position under load.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9629574/'},
      {text: 'Fatigue or pain-related compensation.', ref: 'https://pubmed.ncbi.nlm.nih.gov/30503256/'},
      {text: 'Coordination issue rather than pure weakness -- strength alone does not fully explain pelvic control in all runners.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8628027/'},
      {text: 'Measurement note: camera not perfectly centered, pelvis obscured by clothing, or phase selected outside true mid-stance.', ref: ''}
    ],
    formCues: [
      {text: 'Improve knee drive and vertical force at push-off. A compact, relaxed arm carriage -- shoulders dropped, shoulder blades not squeezed together -- supports this by reducing rotational drag through the trunk. The combined effect can lower ground contact time and reduce the time the pelvis needs to stabilize.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9629574/'},
      {text: 'Strengthen the glute medius with side planks, banded clamshells, monster walks, and similar exercises.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3201064/'},
      {text: 'Run tall through the stance hip. This is a simplified cue for reducing collapse over the support leg -- best paired with visual feedback.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3501612/'},
      {text: 'Consider a slight cadence increase. A modest increase often reduces hip and knee loading and can help runners who collapse into stance. Most useful if you are also overstriding or have a low cadence (under 165 spm for most runners, possibly under 160 for taller runners).', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3022995/'}
    ],
    confidence: 'This often responds to hip and pelvic control work, but should be confirmed across several mid-stance frames before drawing strong conclusions.'
  },
  torsoUpright: {
    title: 'Torso position (too upright)',
    clear: 'No significant trunk position issues detected',
    summary: {
      notable: 'You are running very upright or even leaning slightly backward, which works against forward momentum.',
      mild: 'You are running quite upright, which can reduce the natural forward momentum from a slight lean.'
    },
    whatThisMeans: 'Your trunk shows very little forward lean, especially at contact and during stance. You may be running very upright or even leaning slightly backward.',
    whyItMatters: 'A more upright or backward trunk posture increases the leg angle at contact and can increase knee loading. A modest forward lean can reduce patellofemoral loading and improve economy -- but too much or too little lean can work against you.',
    whyItMattersRef: 'https://pubmed.ncbi.nlm.nih.gov/33257431/',
    possibleReasons: [
      {text: 'Overstriding and low cadence often pair with an upright posture.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4714754/'},
      {text: 'Natural posture preference or habitual standing posture carrying into running.', ref: ''},
      {text: 'Overcorrecting against slouching, or a fear of falling forward.', ref: ''},
      {text: 'Pain avoidance strategy.', ref: ''},
      {text: 'Measurement note: wrong phase frame, side camera not level, or treadmill handrail or background affecting the vertical reference.', ref: ''}
    ],
    formCues: [
      {text: 'Lean slightly from the ankles, not the waist.', ref: 'https://pubmed.ncbi.nlm.nih.gov/34537800/'},
      {text: '"Fall" into the next step. This is a practical cue for creating a small whole-body lean without bending at the hips.', ref: ''},
      {text: 'Quicker feet under you. Increasing cadence can reduce the need to reach in front and may indirectly improve trunk posture.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3022995/'},
      {text: 'Keep your ribcage stacked over your pelvis, then tip the whole unit slightly forward. Reduce the space between the front of your ribs and your pelvis in a natural way -- do not actively crunch or tuck. This helps distinguish a beneficial lean from bending at the waist.', ref: 'https://pubmed.ncbi.nlm.nih.gov/34537800/'}
    ],
    confidence: 'A mild increase in whole-body forward lean may reduce braking and knee load, but excessive lean is not the goal.'
  },
  torsoLean: {
    title: 'Torso position (excessive lean)',
    clear: 'No significant trunk position issues detected',
    summary: {
      notable: 'Your trunk is leaning significantly forward during stance, which can overload the lower back and hamstrings.',
      mild: 'Your forward lean is slightly more than typical for efficient running.'
    },
    whatThisMeans: 'Your trunk shows more forward lean than is typical during stance.',
    whyItMatters: 'Excessive forward lean can shift load to the lower back and hamstrings and reduce running economy.',
    whyItMattersRef: 'https://pubmed.ncbi.nlm.nih.gov/33257431/',
    possibleReasons: [
      {text: 'Bending at the waist rather than leaning from the ankles.', ref: ''},
      {text: 'Fatigue causing loss of core stability.', ref: ''},
      {text: 'Measurement note: wrong phase frame or camera not level.', ref: ''}
    ],
    formCues: [
      {text: 'Make sure the lean comes from the ankles rather than the waist. A slight forward lean is good -- but too much shifts load to the lower back.', ref: 'https://pubmed.ncbi.nlm.nih.gov/34537800/'},
      {text: 'Engage your core to maintain a neutral spine -- keep your ribcage stacked over your pelvis.', ref: ''}
    ],
    confidence: 'A mild increase in whole-body forward lean may reduce braking and knee load, but excessive lean is not the goal.'
  },
  armAngle: {
    title: 'Arm angle too open',
    clear: 'No significant arm angle issues detected',
    summary: {
      notable: 'Your hands are dropping well below the ideal range during the swing phase, which makes the arm swing larger and less efficient, and may increase energy cost.',
      mild: 'Your hands are dropping lower than ideal, which makes the arm swing larger and less efficient, and may increase energy cost.'
    },
    whatThisMeans: 'Your elbows are more extended than expected during running, with hands dropping low and traveling in a wider arc than may be beneficial.',
    whyItMatters: 'A very open elbow angle tends to produce a longer, lower arm lever -- which can drag the trunk forward, increase rotational drag through the torso, and reduce running economy. An ideal elbow angle is not precisely defined in the literature, but this is flagged when the elbow angles are well outside the typical range.',
    whyItMattersRef: 'https://pubmed.ncbi.nlm.nih.gov/31289110/',
    possibleReasons: [
      {text: 'Natural style -- this may not be a problem on its own for every runner.', ref: ''},
      {text: 'Fatigue leading to a longer arm lever or less compact carriage.', ref: ''},
      {text: 'Pace mismatch: faster running tends to produce a more compact arm swing.', ref: ''},
      {text: 'Measurement note: elbow partially occluded, or the phase captured at the end of swing.', ref: ''}
    ],
    formCues: [
      {text: 'Keep your hands relaxed and let the swing originate at the shoulder, not the hands. Think of driving forward from the elbow, rather than pumping the hands up and down. Palms should face the torso (not the ground, not pointed away).', ref: 'https://pubmed.ncbi.nlm.nih.gov/31289110/'},
      {text: 'Use the arms to support a strong, vertical push-off rather than to drag yourself forward with a wide, low swing. A more compact arm path keeps the trunk quiet so the legs can do the work of lengthening stride and adding flight time.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4887549/'}
    ],
    confidence: 'Arm swing is very individual. The goal is an efficient, natural-feeling, compact arm carriage that supports a strong push-off rather than dragging you forward with a wide, low swing.'
  },
  kneeValgus: {
    title: 'Knee valgus',
    clear: 'No significant knee valgus detected',
    summary: {
      notable: 'Your knee is collapsing noticeably inward during stance, which increases stress on the ACL and patellofemoral joint.',
      mild: 'There is slight inward movement of the knee during stance. This is very common and often responds well to targeted exercises.'
    },
    whatThisMeans: 'Your knee collapses inward from the hip\u2013ankle line during stance (measured as 2D Frontal Plane Projection Angle (FPPA) at peak knee flexion). Healthy recreational runners typically sit in the 2\u20136\u00b0 range; values above ~10\u00b0 are uncommon in uninjured cohorts. 2D video carries roughly \u00b13\u20135\u00b0 of measurement uncertainty vs 3D motion capture, and FPPA is a composite that captures hip adduction and pelvic drop alongside true knee motion -- so an elevated FPPA usually indicates upstream hip control issues, not isolated knee dysfunction. A left\u2013right asymmetry of 3\u00b0 or more is itself clinically meaningful even when both sides look "OK".',
    whyItMatters: 'Visible medial knee collapse is associated with patellofemoral pain (PFP), iliotibial band syndrome (ITBS), and medial tibial stress syndrome in runners (Powers 2010; Bramah 2018). Most of that association runs through hip adduction and pelvic drop -- "knee valgus" in running is largely a downstream expression of hip/glute control. A runner with elevated FPPA should also look at their hip drop result, since strengthening hips/core is usually higher-yield than knee-focused work.',
    whyItMattersRef: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9818693/',
    possibleReasons: [
      {text: 'Hip strength and control may not be sufficient to keep the knee tracking straight.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9818693/'},
      {text: 'Pelvic drop upstream can contribute to knee collapse.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3501612/'},
      {text: 'Narrow step width -- widening it can reduce hip adduction and knee loading.', ref: 'https://pubmed.ncbi.nlm.nih.gov/40095991/'},
      {text: 'Fatigue.', ref: ''},
      {text: 'Measurement note: front or back camera misalignment, foot angle making a neutral knee appear valgus in 2D, or analyzing a stride with pelvic rotation.', ref: ''}
    ],
    formCues: [
      {text: 'Strengthen the glute medius with side planks, banded clamshells, monster walks, and similar exercises.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3201064/'},
      {text: 'Slightly increase step width. Try running on a surface with a visible line -- ideally, the feet should land to either side of the line, rather than both landing on top of it or crossing to the opposite side.', ref: 'https://pubmed.ncbi.nlm.nih.gov/40095991/'},
      {text: 'Slightly increase cadence. Increasing step rate reduces hip and knee loading and tends to reduce peak hip adduction.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3022995/'}
    ],
    confidence: '2D running valgus can be noisy from stride to stride. Confirm with multiple frame analyses. You can further confirm by doing loaded or single-leg squats and checking if the knee tracks inward during the squat.'
  },
  armsCrossing: {
    title: 'Arms crossing midline',
    clear: 'No significant arm crossing detected',
    summary: {
      notable: 'Your arms are clearly crossing your body centerline, which creates rotational force your core has to counteract with every step.',
      mild: 'Your arms are occasionally crossing your body centerline, which creates slight rotational forces.'
    },
    whatThisMeans: 'Your hands swing across the body past the midline (halfway between your shoulders) instead of staying on their own side. When only one arm crosses, that asymmetry can reflect compensatory trunk rotation -- often pointing back to a lower-body issue (asymmetric hip drop, foot strike, or stride length) rather than an arm-swing problem in isolation.',
    whyItMatters: 'Arm swing helps control whole-body angular momentum. Active arm swing can reduce torso rotation and metabolic cost. Excessive arm crossing is commonly described as a potential economy issue, though there is not strong evidence proving a specific amount of midline crossing is harmful in otherwise healthy runners. Asymmetric crossing (one arm only) is a stronger signal than symmetric crossing -- look at your hip drop and overstriding results too if one arm is flagged.',
    whyItMattersRef: 'https://pubmed.ncbi.nlm.nih.gov/25031455/',
    possibleReasons: [
      {text: 'Elbows too far from the body, causing the direction of arm swing to be at an angle rather than straight forward and back.', ref: ''},
      {text: 'Compensation for trunk rotation, narrow step width, or asymmetry elsewhere.', ref: ''},
      {text: 'Measurement note: front or back camera not centered, shoulder landmarks obscured, or the stride captured during a turn or head movement.', ref: ''}
    ],
    formCues: [
      {text: 'Swing "chin to hip" -- not across your zipper. The arm swing should focus on the path of the elbow, not the hands. An effective arm swing reduces torso rotation.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11929735/'},
      {text: 'Let the arms swing naturally -- do not force a big drive or suppress arm motion. The evidence favors preserving a natural arm swing rather than over-manipulating it.', ref: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4887549/'},
      {text: 'Relax the shoulders and hands. This is more of a coaching heuristic than a directly studied intervention, but it helps.', ref: ''}
    ],
    confidence: 'Arm crossing is typically not a large issue unless it is a strong, excessive crossing of the midline that causes extra torso rotation.'
  }
};

// Keep backward-compatible COACHING_CUES for detectIssues() detail text
var COACHING_CUES = {};
Object.keys(REPORT_DATA).forEach(function(k) {
  COACHING_CUES[k] = {
    notable: REPORT_DATA[k].summary.notable,
    mild: REPORT_DATA[k].summary.mild,
    clear: REPORT_DATA[k].clear
  };
});

function detectIssues() {
  var issues = {};

  // 1. OVERSTRIDING (side: l_foot + r_foot)
  // Elite baseline: L and R foot-strike leadFoot values pooled into one distribution
  // (symmetric gait assumption) → single pooled center + spread. Each user side is
  // z-scored against that pooled baseline. Per-side severity is reported, and the
  // top-level severity is the worst of the two. z > 1 = mild, z > 2 = notable.
  var lFootM = phases.l_foot && phases.l_foot.metrics ? phases.l_foot.metrics : null;
  var rFootM = phases.r_foot && phases.r_foot.metrics ? phases.r_foot.metrics : null;
  var getSideVal = function(m, sideLetter) {
    if(!m) return null;
    if(m.leadFoot !== undefined) return m.leadFoot;
    var fallback = sideLetter === 'l' ? m.lFoot : m.rFoot;
    return fallback !== undefined ? fallback : null;
  };
  var lVal = getSideVal(lFootM, 'l');
  var rVal = getSideVal(rFootM, 'r');
  if(lVal === null && rVal === null) {
    issues.overstriding = {detected:false, severity:null, details:COACHING_CUES.overstriding.clear};
  } else {
    var poolStats = getPooledStats('leadFoot');
    var gradeZ = function(z) {
      if(z === null) return null;
      if(z > 2) return 'notable';
      if(z > 1) return 'mild';
      return null;
    };
    var zL = lVal !== null ? (lVal - poolStats.mean) / poolStats.sd : null;
    var zR = rVal !== null ? (rVal - poolStats.mean) / poolStats.sd : null;
    var sevL = gradeZ(zL);
    var sevR = gradeZ(zR);
    var worst = function(a,b) {
      var order = {notable:2, mild:1};
      var aR = order[a]||0, bR = order[b]||0;
      return aR >= bR ? a : b;
    };
    var topSev = worst(sevL, sevR);
    var formatSide = function(val, z, sev) {
      if(val === null) return 'no data';
      var s = val.toFixed(2) + ' (z=' + (z>=0?'+':'') + z.toFixed(1) + ')';
      if(sev) s += ' ' + sev;
      else s += ' clear';
      return s;
    };
    if(topSev) {
      var detail = 'L: ' + formatSide(lVal, zL, sevL) + ' \u00b7 R: ' + formatSide(rVal, zR, sevR) +
        ' \u00b7 elite pooled ' + poolStats.mean.toFixed(2) + ' \u00b1 ' + poolStats.sd.toFixed(2);
      issues.overstriding = {detected:true, severity:topSev, details:detail, sideSev:{L:sevL, R:sevR}};
    } else {
      issues.overstriding = {detected:false, severity:null, details:COACHING_CUES.overstriding.clear};
    }
  }

  // 2. HIP DROP -- per-stance pelvic obliquity (degrees), bilateral asymmetry.
  // Computes CPD angle at L-stance and R-stance from the front frame, blended 2:1 with the
  // back frame for that same stance side when available. Thresholds are in degrees and
  // derived from the CPD literature (Bramah 2018, Dingenen 2019, Willson & Davis 2008).
  // Females run ~1-2 deg higher average pelvic obliquity, so thresholds get a +1 deg bump.
  var frontL_FBM = phases.mid_front_l && phases.mid_front_l.frontBackMetrics ? phases.mid_front_l.frontBackMetrics : null;
  var frontR_FBM = phases.mid_front_r && phases.mid_front_r.frontBackMetrics ? phases.mid_front_r.frontBackMetrics : null;
  var backL_FBM  = phases.mid_back_l  && phases.mid_back_l.frontBackMetrics  ? phases.mid_back_l.frontBackMetrics  : null;
  var backR_FBM  = phases.mid_back_r  && phases.mid_back_r.frontBackMetrics  ? phases.mid_back_r.frontBackMetrics  : null;

  var blendCPD = function(front, back) {
    var fVal = front && front.hipDropDeg !== null && front.hipDropDeg !== undefined ? front.hipDropDeg : null;
    var bVal = back  && back.hipDropDeg  !== null && back.hipDropDeg  !== undefined ? back.hipDropDeg  : null;
    if(fVal === null && bVal === null) return null;
    if(fVal === null) return bVal;
    if(bVal === null) return fVal;
    // 2:1 front:back weighting, but only if back frame confidence is acceptable
    if(back.avgConfidence >= 0.4) return (fVal * 2 + bVal) / 3;
    return fVal;
  };
  var lCPD = blendCPD(frontL_FBM, backL_FBM);
  var rCPD = blendCPD(frontR_FBM, backR_FBM);

  var isFemale = selectedSex === 'female';
  var mildT    = isFemale ? 9  : 8;   // degrees
  var notableT = isFemale ? 13 : 12;  // degrees
  var asymT    = 3;                   // degrees L-R difference
  var gradeCPD = function(deg) {
    if(deg === null) return null;
    if(deg > notableT) return 'notable';
    if(deg > mildT) return 'mild';
    return null;
  };
  var sevL = gradeCPD(lCPD);
  var sevR = gradeCPD(rCPD);
  // Asymmetry: clinically meaningful at |L-R| >= 3 deg (Bramah 2018 / PMC3761484).
  // Only applies when the higher side's absolute CPD exceeds the 4 deg noise floor --
  // a 3 deg gap between two very low values is indistinguishable from 2D measurement
  // noise (literature reports +/- 3-5 deg uncertainty vs 3D motion capture).
  var asymFlag = false;
  var ASYM_FLOOR = 4;
  if(lCPD !== null && rCPD !== null && Math.abs(lCPD - rCPD) >= asymT) {
    asymFlag = true;
    var higherSide = lCPD > rCPD ? 'L' : 'R';
    var higherVal  = Math.max(lCPD, rCPD);
    var upgradeSide = function(cur) {
      if(cur === 'mild') return 'notable';
      if(!cur && higherVal > ASYM_FLOOR) return 'mild';
      return cur;
    };
    if(higherSide === 'L') sevL = upgradeSide(sevL);
    else                   sevR = upgradeSide(sevR);
  }
  var worstCPD = function(a,b){var o={notable:2,mild:1};return (o[a]||0)>=(o[b]||0)?a:b;};
  var topCPDSev = worstCPD(sevL, sevR);
  if(topCPDSev) {
    var fmtCPD = function(deg, sev){ if(deg===null) return 'no data'; return deg.toFixed(1)+'\u00b0'+(sev?' '+sev:' clear'); };
    var cpdDetail = 'L-stance: '+fmtCPD(lCPD, sevL)+' \u00b7 R-stance: '+fmtCPD(rCPD, sevR);
    if(asymFlag) cpdDetail += ' \u00b7 asymmetry '+Math.abs(lCPD-rCPD).toFixed(1)+'\u00b0';
    issues.hipDrop = {detected:true, severity:topCPDSev, details:cpdDetail, sideSev:{L:sevL, R:sevR}};
  } else {
    issues.hipDrop = {detected:false, severity:null, details:COACHING_CUES.hipDrop.clear};
  }

  // 3. ARMS CROSSING MIDLINE (front view) -- per-arm detection.
  // Each arm peaks across the body at a different gait moment (right arm forward at L
  // mid-stance; left arm forward at R mid-stance), so take the max for each arm across
  // both available front frames. Per-arm severity surfaces asymmetric arm swing, which
  // can reflect compensatory trunk rotation from a lower-body issue.
  var crossAt = function(fbm, key){ return fbm && fbm[key] !== null && fbm[key] !== undefined ? fbm[key] : 0; };
  var hasFront = !!(frontL_FBM || frontR_FBM);
  var peakLCross = Math.max(crossAt(frontL_FBM, 'lWristCross'), crossAt(frontR_FBM, 'lWristCross'));
  var peakRCross = Math.max(crossAt(frontL_FBM, 'rWristCross'), crossAt(frontR_FBM, 'rWristCross'));
  var gradeCross = function(v){ if(v > 0.15) return 'notable'; if(v > 0.05) return 'mild'; return null; };
  var sevLArm = hasFront ? gradeCross(peakLCross) : null;
  var sevRArm = hasFront ? gradeCross(peakRCross) : null;
  var topArmSev = worstCPD(sevLArm, sevRArm);
  if(topArmSev) {
    var fmtArm = function(v, sev){ return (v*100).toFixed(1)+'% '+(sev||'clear'); };
    var armDetail = 'L arm: '+fmtArm(peakLCross, sevLArm)+' \u00b7 R arm: '+fmtArm(peakRCross, sevRArm);
    issues.armsCrossing = {detected:true, severity:topArmSev, details:armDetail, sideSev:{L:sevLArm, R:sevRArm}, sideTagLabel:'arm'};
  } else {
    issues.armsCrossing = {detected:false, severity:null, details:COACHING_CUES.armsCrossing.clear};
  }

  // 4. TORSO POSITION -- z-score average across all side-view phases that measure trunk lean.
  // Each phase is compared to its own elite mean/SD (mid-stance lean differs from peak-KF lean),
  // then z-scores are averaged. |avg z| > 1 = mild, > 2 = notable. Sign picks upright vs lean.
  var TRUNK_PHASES = ['l_foot','r_foot','l_toe','r_toe','mid'];
  var trunkZs = [], userTrunks = [], eliteTrunks = [];
  TRUNK_PHASES.forEach(function(pk) {
    var pm = phases[pk] && phases[pk].metrics ? phases[pk].metrics : null;
    if(!pm || pm.trunk === undefined) return;
    var st = getRangeStats(pk, 'trunk');
    if(!st.sd || st.sd <= 0) return;
    trunkZs.push((pm.trunk - st.mean) / st.sd);
    userTrunks.push(pm.trunk);
    eliteTrunks.push(st.mean);
  });
  issues.torsoPosition = {detected:false, severity:null, details:COACHING_CUES.torsoUpright.clear};
  if(trunkZs.length > 0) {
    var avgZ = trunkZs.reduce(function(a,b){return a+b;}, 0) / trunkZs.length;
    var userAvg = userTrunks.reduce(function(a,b){return a+b;}, 0) / userTrunks.length;
    var eliteAvg = eliteTrunks.reduce(function(a,b){return a+b;}, 0) / eliteTrunks.length;
    var zStr = (avgZ>=0?'+':'')+avgZ.toFixed(2);
    var detailStr = 'Trunk lean: avg '+userAvg.toFixed(1)+'\u00b0 vs elite '+eliteAvg.toFixed(1)+'\u00b0 (z='+zStr+' across '+trunkZs.length+' phases)';
    if(avgZ < -2) {
      issues.torsoPosition = {detected:true, severity:'notable', details:detailStr, cueKey:'torsoUpright'};
    } else if(avgZ > 2) {
      issues.torsoPosition = {detected:true, severity:'notable', details:detailStr, cueKey:'torsoLean'};
    } else if(avgZ < -1) {
      issues.torsoPosition = {detected:true, severity:'mild', details:detailStr, cueKey:'torsoUpright'};
    } else if(avgZ > 1) {
      issues.torsoPosition = {detected:true, severity:'mild', details:detailStr, cueKey:'torsoLean'};
    }
  }

  // 5. ARM ANGLE TOO OPEN -- averaged near-elbow at L toe-off (arm forward-drive peak) and
  // R toe-off (arm back-drive peak). Two readings per runner smooths single-frame noise and
  // covers both ends of the arm-swing cycle. Uses SEX-COMBINED elite range: no strong evidence
  // for sex differences in elbow carriage, and pooling gives a more stable baseline.
  function elbowAt(phaseKey){
    var m = phases[phaseKey] && phases[phaseKey].metrics ? phases[phaseKey].metrics : null;
    if(!m) return null;
    if(m.nearElbow !== undefined && m.nearElbow !== null) return m.nearElbow;
    var eCount = 0, eSum = 0;
    if(m.lElbow !== undefined && m.lElbow !== null) { eSum += m.lElbow; eCount++; }
    if(m.rElbow !== undefined && m.rElbow !== null) { eSum += m.rElbow; eCount++; }
    return eCount ? eSum / eCount : null;
  }
  var lToeElbow = elbowAt('l_toe');
  var rToeElbow = elbowAt('r_toe');
  var armElbow = null;
  if(lToeElbow !== null && rToeElbow !== null) armElbow = (lToeElbow + rToeElbow) / 2;
  else if(lToeElbow !== null) armElbow = lToeElbow;
  else if(rToeElbow !== null) armElbow = rToeElbow;
  if(armElbow === null) {
    issues.armAngle = {detected:false, severity:null, details:COACHING_CUES.armAngle.clear};
  } else {
    var armStats = getCombinedStats('arm_drive', 'nearElbow');
    var armMild = armStats.mean + 2 * armStats.sd;
    var armNotable = armStats.mean + 4 * armStats.sd;
    if(armElbow > armNotable) {
      issues.armAngle = {detected:true, severity:'notable', details:'Elbow: '+armElbow.toFixed(0)+'\u00b0 (mean L+R toe-off; elite '+armStats.mean.toFixed(0)+' \u00b1 '+armStats.sd.toFixed(0)+', pooled sexes)'};
    } else if(armElbow > armMild) {
      issues.armAngle = {detected:true, severity:'mild', details:'Elbow: '+armElbow.toFixed(0)+'\u00b0 (mean L+R toe-off; elite '+armStats.mean.toFixed(0)+' \u00b1 '+armStats.sd.toFixed(0)+', pooled sexes)'};
    } else {
      issues.armAngle = {detected:false, severity:null, details:COACHING_CUES.armAngle.clear};
    }
  }

  // 6. KNEE VALGUS -- per-stance 2D FPPA in degrees from each side's front frame.
  // Thresholds from running-specific FPPA literature (NOT SLS/DVJ -- those allow much
  // greater knee flexion and run 13deg+, which would miss runners). Sex bump +1deg
  // (Nakagawa 2012: females show ~3.9deg greater knee abduction in SLS). Asymmetry
  // >= 3deg with the higher side exceeding the 4deg 2D noise floor flags the higher
  // side as mild and upgrades an existing mild to notable -- same pattern as hip drop.
  var lValgusDeg = frontL_FBM && frontL_FBM.lKneeValgusDeg !== null && frontL_FBM.lKneeValgusDeg !== undefined ? frontL_FBM.lKneeValgusDeg : null;
  var rValgusDeg = frontR_FBM && frontR_FBM.rKneeValgusDeg !== null && frontR_FBM.rKneeValgusDeg !== undefined ? frontR_FBM.rKneeValgusDeg : null;
  var vMildT    = isFemale ? 7  : 6;   // degrees
  var vNotableT = isFemale ? 11 : 10;  // degrees
  var vAsymT    = 3;
  var vFloor    = 4;
  var gradeFPPA = function(deg){
    if(deg === null) return null;
    if(deg > vNotableT) return 'notable';
    if(deg > vMildT) return 'mild';
    return null;
  };
  var sevLV = gradeFPPA(lValgusDeg);
  var sevRV = gradeFPPA(rValgusDeg);
  var vAsymFlag = false;
  if(lValgusDeg !== null && rValgusDeg !== null && Math.abs(lValgusDeg - rValgusDeg) >= vAsymT) {
    vAsymFlag = true;
    var higherSideV = lValgusDeg > rValgusDeg ? 'L' : 'R';
    var higherValV  = Math.max(lValgusDeg, rValgusDeg);
    var upgradeV = function(cur){
      if(cur === 'mild') return 'notable';
      if(!cur && higherValV > vFloor) return 'mild';
      return cur;
    };
    if(higherSideV === 'L') sevLV = upgradeV(sevLV);
    else                    sevRV = upgradeV(sevRV);
  }
  var topValgusSev = worstCPD(sevLV, sevRV);
  if(topValgusSev) {
    var fmtV = function(deg, sev){ if(deg===null) return 'no data'; return deg.toFixed(1)+'\u00b0 '+(sev||'clear'); };
    var vDetail = 'L-stance: '+fmtV(lValgusDeg, sevLV)+' \u00b7 R-stance: '+fmtV(rValgusDeg, sevRV);
    if(vAsymFlag) vDetail += ' \u00b7 asymmetry '+Math.abs(lValgusDeg-rValgusDeg).toFixed(1)+'\u00b0';
    issues.kneeValgus = {detected:true, severity:topValgusSev, details:vDetail, sideSev:{L:sevLV, R:sevRV}};
  } else {
    issues.kneeValgus = {detected:false, severity:null, details:COACHING_CUES.kneeValgus.clear};
  }

  return issues;
}
