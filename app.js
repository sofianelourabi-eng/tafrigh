'use strict';
const $ = id => document.getElementById(id);
const txt = $('txt');
const SR = 16000;

/* ===== Hors ligne : service worker ===== */
if ('serviceWorker' in navigator) {
  const first = !navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (first) {
    // Première visite : on recharge une fois pour activer le mode hors ligne et le calcul multi-cœur
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      let done = false;
      try { done = sessionStorage.getItem('tf-reloaded') === '1'; sessionStorage.setItem('tf-reloaded', '1'); } catch (e) {}
      if (!done && !busyAny()) location.reload();
    });
  }
}
function netChip() {
  const c = $('net');
  if (navigator.onLine) { c.textContent = 'En ligne'; c.className = 'chip on'; }
  else { c.textContent = 'Hors ligne'; c.className = 'chip off'; }
}
addEventListener('online', netChip); addEventListener('offline', netChip); netChip();

/* ===== Choix du modèle ===== */
const sel = $('model');
const hasGPU = !!navigator.gpu;
[...sel.options].forEach(o => { o.textContent = o.dataset.label; });
if (!hasGPU) {
  const o = sel.querySelector('[data-gpu]');
  o.disabled = true; o.dataset.label += ' — indisponible ici'; o.textContent = o.dataset.label;
}
try { const saved = localStorage.getItem('tf-model'); if (saved && sel.querySelector(`option[value="${saved}"]:not([disabled])`)) sel.value = saved; } catch (e) {}
sel.addEventListener('change', () => { try { localStorage.setItem('tf-model', sel.value); } catch (e) {} });

async function refreshCached() {
  try {
    const c = await caches.open('transformers-cache');
    const urls = (await c.keys()).map(k => k.url);
    [...sel.options].forEach(o => {
      const mine = urls.filter(u => u.includes('/' + o.value + '/'));
      const ok = mine.some(u => u.includes('encoder_model')) && mine.some(u => u.includes('decoder_model_merged'));
      o.textContent = o.dataset.label + (ok ? '  ✓ téléchargé' : '');
    });
  } catch (e) {}
}
refreshCached();

/* ===== Moteur (worker) ===== */
let worker = null, seq = 0, onProgress = null, loadedKey = '';
const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker('./worker.js', { type: 'module' });
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') { if (onProgress) onProgress(m.data); return; }
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id);
      if (m.type === 'loadError' || m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
    };
    worker.onerror = () => {
      for (const [, p] of pending) p.reject(new Error('Le moteur n’a pas pu se charger. Au tout premier lancement, une connexion internet est nécessaire ; ensuite, utilisez Chrome à jour.'));
      pending.clear(); worker = null; loadedKey = '';
    };
  }
  return worker;
}
function call(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    getWorker().postMessage(Object.assign({ id }, msg), transfer || []);
  });
}
function errMsg(e) {
  const m = String((e && e.message) || e);
  if (location.protocol === 'file:')
    return 'L’application est ouverte comme un simple fichier : le moteur ne peut pas démarrer ainsi. Ouvrez-la depuis son adresse web (GitHub Pages, voir LISEZMOI).';
  if (!navigator.onLine || /fetch|network|Failed to/i.test(m))
    return 'Ce modèle n’est pas encore sur l’appareil. Connectez-vous une fois à internet et touchez « Préparer hors ligne ».';
  return 'Erreur : ' + m;
}
let preparing = null;
async function ensureModel(report) {
  const model = sel.value;
  if (loadedKey.startsWith(model + '|')) return;
  if (preparing) { await preparing; if (loadedKey.startsWith(model + '|')) return; }
  preparing = (async () => {
    const files = {};
    onProgress = p => {
      if (p.status === 'progress' && p.file && p.total) {
        files[p.file] = [p.loaded, p.total];
        let l = 0, t = 0; for (const k in files) { l += files[k][0]; t += files[k][1]; }
        report('Téléchargement du modèle : ' + Math.round(l / 1e6) + ' / ' + Math.round(t / 1e6) + ' Mo', t ? l / t * 100 : 0);
      }
    };
    const devices = hasGPU ? ['webgpu', 'wasm'] : ['wasm'];
    let last;
    try {
      for (const d of devices) {
        if (d === 'wasm' && model.includes('large')) break;
        try {
          report('Chargement du modèle…', 0);
          await call({ cmd: 'load', model, device: d });
          loadedKey = model + '|' + d;
          return;
        } catch (e) { last = e; }
      }
      throw last || new Error('Ce modèle demande une carte graphique compatible. Choisissez « Précis ».');
    } finally { onProgress = null; refreshCached(); }
  })();
  try { await preparing; } finally { preparing = null; }
}
async function transcribe(audio) {
  const r = await call({ cmd: 'transcribe', audio }, [audio.buffer]);
  return clean(r.text);
}

/* Phrases parasites que Whisper invente parfois sur du silence */
const HALLU = [/ترجمة\s*نانسي/, /اشتركوا\s*في\s*القناة/, /شكرا\s*(لكم\s*)?(على|ل)\s*المشاهدة/, /نسخ\s*و\s*تدقيق/];
function clean(t) {
  t = (t || '').replace(/[\[(（](?:موسيقى|موسيقي|Music|music|تصفيق)[\])）]/g, '').trim();
  if (t.length < 80 && HALLU.some(r => r.test(t))) return '';
  if (/^[\s.،,…!؟?-]*$/.test(t)) return '';
  return t;
}
function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); }
function fmt(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); }

/* ===== Préparer hors ligne ===== */
function setStatus(el, msg, cls) { el.textContent = msg; el.className = 'status' + (cls ? ' ' + cls : ''); }
function pReport(msg, pct) { setStatus($('pstatus'), msg); $('pbar').style.width = (pct || 0) + '%'; }
$('prep').onclick = async () => {
  $('prep').disabled = true;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  try {
    await ensureModel(pReport);
    $('pbar').style.width = '100%';
    setStatus($('pstatus'), 'Modèle prêt : l’application fonctionne maintenant sans internet.', 'ok');
  } catch (e) { setStatus($('pstatus'), errMsg(e), 'err'); }
  $('prep').disabled = false;
};
sel.addEventListener('change', () => { setStatus($('pstatus'), ''); $('pbar').style.width = '0'; });

/* ===== Onglets ===== */
function showTab(which) {
  const f = which === 'file';
  $('tab-file').setAttribute('aria-selected', f); $('tab-live').setAttribute('aria-selected', !f);
  $('p-file').hidden = !f; $('p-live').hidden = f;
}
$('tab-file').onclick = () => showTab('file');
$('tab-live').onclick = () => showTab('live');

/* ===== Mode fichier ===== */
let audioData = null, fileBusy = false, stopFile = false, chunks = [], baseText = '';
const drop = $('drop'), fileIn = $('file');
drop.onclick = () => fileIn.click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
fileIn.onchange = () => { if (fileIn.files[0]) pick(fileIn.files[0]); fileIn.value = ''; };
function fReport(msg, pct, cls) { setStatus($('fstatus'), msg, cls); if (pct != null) $('fbar').style.width = pct + '%'; }

async function pick(file) {
  if (fileBusy) return;
  $('fname').textContent = file.name;
  sourceName = file.name;
  $('go').disabled = true; audioData = null;
  fReport('Lecture du fichier…', 0);
  try {
    const buf = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
    try { ctx.close(); } catch (e) {}
    // Mono 16 kHz (format attendu par Whisper)
    const off = new OfflineAudioContext(1, Math.ceil(ab.duration * SR), SR);
    const src = off.createBufferSource(); src.buffer = ab; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    audioData = rendered.getChannelData(0).slice();
    fReport('Durée : ' + fmt(audioData.length / SR) + ' — prêt à transcrire.', 0, 'ok');
    $('go').disabled = false;
  } catch (e) {
    fReport('Ce fichier n’a pas pu être lu. Essayez un MP3, M4A ou WAV.', 0, 'err');
  }
}

// Coupe vers 30 s, au moment le plus silencieux, pour ne pas couper un mot
function nextCut(start) {
  const max = start + 30 * SR;
  if (max >= audioData.length) return audioData.length;
  const from = start + 22 * SR, step = SR / 10;
  let best = max, bestE = Infinity;
  for (let p = from; p + step <= max; p += step) {
    const e = rms(audioData.subarray(p, p + step));
    if (e < bestE) { bestE = e; best = p + step / 2; }
  }
  return Math.floor(best);
}

$('go').onclick = async () => {
  if (fileBusy) { stopFile = true; $('go').disabled = true; return; }
  if (!audioData) return;
  fileBusy = true; stopFile = false; chunks = [];
  baseText = txt.value.trim();
  $('go').textContent = 'Arrêter';
  const total = audioData.length;
  try {
    await ensureModel((m, p) => fReport(m, p));
    fReport('Transcription en cours…', 0);
    let pos = 0;
    const t0 = performance.now();
    while (pos < total && !stopFile) {
      const end = nextCut(pos);
      const seg = audioData.slice(pos, end);
      if (seg.length > SR / 2 && rms(seg) > 0.002) {
        const t = await transcribe(seg);
        if (t) { chunks.push({ start: pos / SR, text: t }); render(); }
      }
      pos = end;
      const done = pos / total, el = (performance.now() - t0) / 1000;
      const rest = done > 0.05 ? Math.round(el / done - el) : null;
      fReport('Transcrit : ' + fmt(pos / SR) + ' sur ' + fmt(total / SR) + (rest != null && pos < total ? ' — reste environ ' + fmt(rest) : ''), done * 100);
    }
    fReport(stopFile ? 'Arrêté. Le texte déjà transcrit est conservé.' : 'Terminé. Relisez et corrigez directement dans la zone de texte.', stopFile ? null : 100, 'ok');
  } catch (e) { fReport(errMsg(e), null, 'err'); }
  fileBusy = false; $('go').textContent = 'Transcrire'; $('go').disabled = !audioData;
};

/* ===== Zone de texte ===== */
function render() {
  if (chunks.length) {
    const withTs = $('ts').checked;
    const body = chunks.map(c => withTs ? '[' + fmt(c.start) + '] ' + c.text : c.text).join('\n\n');
    txt.value = (baseText ? baseText + '\n\n' : '') + body;
  }
  count();
}
function count() {
  const n = txt.value.trim() ? txt.value.trim().split(/\s+/).length : 0;
  $('count').textContent = n + (n > 1 ? ' mots' : ' mot');
}
txt.addEventListener('input', () => { chunks = []; count(); });
$('ts').onchange = render;
$('clear').onclick = () => {
  if (txt.value.trim() && !confirm('Effacer tout le texte ?')) return;
  txt.value = ''; chunks = []; baseText = ''; count();
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(txt.value); }
  catch (e) { txt.select(); try { document.execCommand('copy'); } catch (_) {} }
  $('copy').textContent = 'Copié'; setTimeout(() => { $('copy').textContent = 'Copier'; }, 1500);
};
if (navigator.share) {
  $('share').hidden = false;
  $('share').onclick = () => { navigator.share({ text: txt.value }).catch(() => {}); };
}
$('dl').onclick = () => {
  saveBlob(new Blob(['﻿' + txt.value], { type: 'text/plain;charset=utf-8' }), baseName() + '.txt');
};

/* ===== Export Word / PDF (mise en page aérée) ===== */
let sourceName = '';
function baseName() {
  const d = new Date();
  return 'transcription-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
    '-' + String(d.getHours()).padStart(2, '0') + 'h' + String(d.getMinutes()).padStart(2, '0');
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
// Découpe en paragraphes courts : un par ligne, et les blocs trop longs coupés à une ponctuation
function paragraphs() {
  const out = [];
  txt.value.replace(/\r/g, '').split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(line => {
    const m = line.match(/^\[(\d{2}:\d{2})\]\s*(.*)$/);
    const ts = m ? m[1] : '', body = m ? m[2] : line;
    const words = body.split(/\s+/);
    let cur = [], first = true;
    const push = () => { if (cur.length) { out.push({ ts: first ? ts : '', text: cur.join(' ') }); first = false; cur = []; } };
    for (const w of words) {
      cur.push(w);
      if ((cur.length >= 55 && /[.!؟?،:؛]$/.test(w)) || cur.length >= 85) push();
    }
    push();
  });
  return out;
}
function metaLine() {
  const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return 'Transcription du ' + date + (sourceName ? ' — ' + sourceName : '');
}
function nothing() {
  if (txt.value.trim()) return false;
  alert('Il n’y a pas encore de texte à exporter.');
  return true;
}

// --- Word (.docx) généré sur l'appareil, sans internet ---
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files, type) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cd = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cd, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
}
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildDocx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const ar = (t, rpr) => `<w:r><w:rPr><w:rtl/>${rpr || ''}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const lt = (t, rpr) => `<w:r><w:rPr>${rpr || ''}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const body = [];
  body.push(`<w:p><w:pPr><w:bidi/><w:jc w:val="center"/><w:spacing w:after="80"/></w:pPr>${ar('تفريغ صوتي', '<w:b/><w:bCs/><w:color w:val="1F6B52"/><w:sz w:val="44"/><w:szCs w:val="44"/>')}</w:p>`);
  body.push(`<w:p><w:pPr><w:jc w:val="center"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="12" w:color="BFC8C2"/></w:pBdr><w:spacing w:after="480"/></w:pPr>${lt(metaLine(), '<w:color w:val="666666"/><w:sz w:val="20"/><w:szCs w:val="20"/>')}</w:p>`);
  for (const p of paragraphs()) {
    const ts = p.ts ? lt(p.ts, '<w:b/><w:color w:val="1F6B52"/><w:sz w:val="20"/><w:szCs w:val="20"/>') + ar('   ') : '';
    body.push(`<w:p><w:pPr><w:bidi/><w:jc w:val="both"/><w:spacing w:after="280" w:line="440" w:lineRule="auto"/></w:pPr>${ts}${ar(p.text)}</w:p>`);
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="32"/><w:szCs w:val="32"/><w:lang w:val="fr-FR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles }
  ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
$('word').onclick = () => { if (!nothing()) saveBlob(buildDocx(), baseName() + '.docx'); };

// --- PDF : page d'impression mise en forme, puis « Enregistrer au format PDF » ---
$('pdf').onclick = () => {
  if (nothing()) return;
  const pr = $('print');
  pr.innerHTML = '';
  const h = document.createElement('h1'); h.lang = 'ar'; h.dir = 'rtl'; h.textContent = 'تفريغ صوتي';
  const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = metaLine();
  pr.append(h, meta);
  for (const p of paragraphs()) {
    const el = document.createElement('p'); el.lang = 'ar'; el.dir = 'rtl';
    if (p.ts) { const s = document.createElement('span'); s.className = 'ts'; s.dir = 'ltr'; s.textContent = p.ts; el.append(s); }
    el.append(document.createTextNode(p.text));
    pr.append(el);
  }
  const old = document.title;
  document.title = baseName();
  const restore = () => { document.title = old; removeEventListener('afterprint', restore); };
  addEventListener('afterprint', restore);
  setTimeout(() => window.print(), 50);
};

/* ===== Dictée (micro, sur l'appareil) ===== */
let live = null, waiting = 0;
function lReport(msg, pct, cls) { setStatus($('lstatus'), msg, cls); }
function liveStatus() {
  if (!live) return;
  lReport(waiting ? 'À l’écoute… (' + waiting + ' phrase' + (waiting > 1 ? 's' : '') + ' en cours d’écriture)' : 'À l’écoute… parlez.');
}
function append(t) {
  if (!t) return;
  chunks = [];
  const cur = txt.value.replace(/\s+$/, '');
  txt.value = cur ? cur + ' ' + t : t;
  txt.scrollTop = txt.scrollHeight;
  count();
}
function sendSegment(frames) {
  let n = 0; for (const f of frames) n += f.length;
  const a = new Float32Array(n); let o = 0;
  for (const f of frames) { a.set(f, o); o += f.length; }
  waiting++; liveStatus();
  transcribe(a).then(append).catch(e => lReport(errMsg(e), null, 'err')).finally(() => {
    waiting--;
    if (live) liveStatus(); else if (!waiting) lReport('Dictée arrêtée.', null, 'ok');
  });
}
function downsample(f, rate) {
  if (rate === SR) return f;
  const ratio = rate / SR, n = Math.floor(f.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * ratio), e = Math.min(f.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = s; j < e; j++) sum += f[j];
    out[i] = sum / Math.max(1, e - s);
  }
  return out;
}
function onFrame(raw) {
  const L = live; if (!L) return;
  const f = downsample(raw, L.rate);
  const r = rms(f), ms = f.length / SR * 1000;
  $('lvl').style.width = Math.min(100, r * 900) + '%';
  const thr = Math.max(0.012, L.noise * 2.5);
  if (r > thr) {
    if (!L.speaking) { L.speaking = true; L.seg = L.pre.slice(); L.speechMs = 0; L.segMs = 0; }
    L.seg.push(f); L.speechMs += ms; L.segMs += ms; L.silMs = 0;
  } else if (L.speaking) {
    L.seg.push(f); L.segMs += ms; L.silMs += ms;
    if (L.silMs >= 700) flushLive();
  } else {
    L.noise = L.noise * 0.95 + r * 0.05;
    L.pre.push(f); if (L.pre.length > 3) L.pre.shift();
  }
  if (L.speaking && L.segMs >= 20000) flushLive();
}
function flushLive() {
  const L = live; if (!L || !L.speaking) return;
  if (L.speechMs >= 300) sendSegment(L.seg);
  L.speaking = false; L.seg = []; L.silMs = 0; L.segMs = 0; L.speechMs = 0;
}
async function startLive() {
  $('micbtn').disabled = true;
  try {
    await ensureModel((m) => lReport(m));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.audioWorklet.addModule('./recorder.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'rec');
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    live = { stream, ctx, node, rate: ctx.sampleRate, noise: 0.01, pre: [], seg: [], speaking: false, silMs: 0, segMs: 0, speechMs: 0, lock: null };
    node.port.onmessage = e => onFrame(e.data);
    try { if (navigator.wakeLock) live.lock = await navigator.wakeLock.request('screen'); } catch (e) {}
    $('micbox').classList.add('live');
    $('micbtn').textContent = 'Arrêter';
    liveStatus();
  } catch (e) {
    const m = String((e && e.name) || '');
    lReport(m === 'NotAllowedError' ? 'Micro refusé : autorisez le micro pour Tafrigh dans les réglages du navigateur.'
      : m === 'NotFoundError' ? 'Aucun micro détecté.' : errMsg(e), null, 'err');
    stopLive(true);
  }
  $('micbtn').disabled = false;
}
function stopLive(silent) {
  const L = live; if (!L) return;
  flushLive();
  live = null;
  try { L.node.port.onmessage = null; } catch (e) {}
  try { L.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { L.ctx.close(); } catch (e) {}
  try { if (L.lock) L.lock.release(); } catch (e) {}
  $('micbox').classList.remove('live');
  $('micbtn').textContent = 'Démarrer la dictée';
  $('lvl').style.width = '0';
  if (!silent) lReport(waiting ? 'Fin de l’écriture des dernières phrases…' : 'Dictée arrêtée.', null, 'ok');
}
$('micbtn').onclick = () => { if (live) stopLive(); else startLive(); };
document.addEventListener('visibilitychange', async () => {
  if (live && document.visibilityState === 'visible' && navigator.wakeLock) {
    try { live.lock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
});

function busyAny() { return fileBusy || !!live || !!preparing; }
count();
