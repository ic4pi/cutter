/* global chrome, ClipLib, ytPrepare, ytCaptions, ytRecord, ytCollect */
const L = ClipLib;
const $ = id => document.getElementById(id);
const FIELDS = ['urls', 'lead', 'tail', 'fallbackOn', 'fallbackSec', 'maxPage', 'autoBuild', 'apiKey', 'model'];
const DEFAULT_RULES = [
  { type: 'phrase', start: 'satire account', end: 'entertainment purposes only', strict: 'near', which: 'last', after: 5 },
];
let rules = DEFAULT_RULES.map(r => ({ ...r }));
const clips = [];
let running = false;
let abort = false;

// ---------- persistence ----------
function save() {
  const o = { rules };
  FIELDS.forEach(f => { const el = $(f); o[f] = el.type === 'checkbox' ? el.checked : el.value; });
  try { localStorage.setItem('cutter2', JSON.stringify(o)); } catch (e) {}
}
function restore() {
  try {
    const o = JSON.parse(localStorage.getItem('cutter2') || '{}');
    FIELDS.forEach(f => {
      if (!(f in o)) return;
      const el = $(f);
      if (el.type === 'checkbox') el.checked = !!o[f]; else el.value = o[f];
    });
    if (Array.isArray(o.rules) && o.rules.length) rules = o.rules;
  } catch (e) {}
}
function log(msg) {
  const d = $('log');
  d.textContent += msg + '\n';
  d.scrollTop = d.scrollHeight;
}
function settings() {
  return {
    lead: parseFloat($('lead').value) || 0,
    tail: parseFloat($('tail').value) || 0,
    fallbackOn: $('fallbackOn').checked,
    fallbackSec: parseFloat($('fallbackSec').value) || 12,
    maxPage: parseInt($('maxPage').value, 10) || 12,
    autoBuild: $('autoBuild').checked,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'claude-sonnet-5-5',
  };
}

// ---------- rules UI ----------
function field(r, key, label, type, extra) {
  const l = document.createElement('label');
  l.append(label);
  let i;
  if (type === 'select') {
    i = document.createElement('select');
    extra.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; i.appendChild(o); });
  } else {
    i = document.createElement('input');
    i.type = type;
    if (extra && extra.size) i.size = extra.size;
    if (extra && extra.placeholder) i.placeholder = extra.placeholder;
    if (extra && extra.min != null) i.min = extra.min;
  }
  i.value = r[key] == null ? '' : r[key];
  i.addEventListener('input', () => { r[key] = type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value; save(); });
  l.appendChild(i);
  return l;
}
function renderRules() {
  const box = $('rules');
  box.innerHTML = '';
  rules.forEach((r, idx) => {
    const d = document.createElement('div');
    d.className = 'rule';
    const head = document.createElement('div');
    head.innerHTML = '<span class="tag"></span>';
    head.querySelector('.tag').textContent =
      r.type === 'phrase' ? 'PHRASE / SENTENCE' : r.type === 'keywords' ? 'KEYWORDS (NO API KEY)' : 'DESCRIBED MOMENT (CLAUDE)';
    const rm = document.createElement('button');
    rm.className = 'alt small';
    rm.textContent = 'Remove';
    rm.onclick = () => { rules.splice(idx, 1); save(); renderRules(); };
    head.appendChild(rm);
    d.appendChild(head);
    const row = document.createElement('div');
    row.className = 'row';
    if (r.type === 'phrase') {
      row.append(
        field(r, 'start', 'Says (start)', 'text', { size: 28, placeholder: 'e.g. satire account' }),
        field(r, 'end', 'Until (optional)', 'text', { size: 28, placeholder: 'e.g. entertainment purposes only' }),
        field(r, 'strict', 'Match', 'select', [['exact', 'Exact'], ['near', 'Near (typos, split words)'], ['loose', 'Loose']]),
        field(r, 'which', 'Which hits', 'select', [['last', 'Last in video'], ['first', 'First in video'], ['all', 'Every hit']]),
        field(r, 'after', 'No end phrase: secs after', 'number', { min: 0 })
      );
    } else if (r.type === 'keywords') {
      row.append(
        field(r, 'words', 'Any of these (comma separated)', 'text', { size: 44, placeholder: 'e.g. fallen angel, fallen angels, nephilim' }),
        field(r, 'strict', 'Match', 'select', [['exact', 'Exact'], ['near', 'Near (typos, split words)'], ['loose', 'Loose']]),
        field(r, 'before', 'Secs before', 'number', { min: 0 }),
        field(r, 'after', 'Secs after', 'number', { min: 0 }),
        field(r, 'max', 'Max clips per video', 'number', { min: 1 })
      );
    } else {
      row.append(
        field(r, 'desc', 'Describe the moment', 'text', { size: 60, placeholder: 'e.g. the host making a claim about fallen angels' }),
        field(r, 'max', 'Max per video', 'number', { min: 1 })
      );
    }
    d.appendChild(row);
    box.appendChild(d);
  });
}
$('addPhrase').onclick = () => { rules.push({ type: 'phrase', start: '', end: '', strict: 'near', which: 'all', after: 5 }); save(); renderRules(); };
$('addKeywords').onclick = () => { rules.push({ type: 'keywords', words: '', strict: 'near', before: 5, after: 10, max: 5 }); save(); renderRules(); };
$('addDescribe').onclick = () => { rules.push({ type: 'describe', desc: '', max: 3 }); save(); renderRules(); };

// ---------- tab helpers ----------
function load(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('page load timeout'));
    }, 45000);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}
async function inject(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: args || [] });
  return r.result;
}
function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type });
}

// ---------- describe rules (Claude API) ----------
async function askClaude(prompt, s) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: s.model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return (j.content || []).map(b => b.text || '').join('');
}

async function planClips(words, s, duration, tag) {
  const found = [];
  for (const r of rules) {
    if (r.type === 'phrase') {
      if (!String(r.start || '').trim() && !String(r.end || '').trim()) continue;
      const cs = L.findClips(words, r, { lead: s.lead, tail: s.tail });
      const name = `"${(r.start || r.end).trim()}" (${r.strict})`;
      cs.forEach(c => found.push({ ...c, how: `${name}: ${c.how}` }));
      if (!cs.length) log(`${tag} no hit for ${name}`);
    } else if (r.type === 'keywords') {
      if (!String(r.words || '').trim()) continue;
      const cs = L.findKeywordClips(words, r, { lead: s.lead, tail: s.tail });
      cs.forEach(c => found.push(c));
      log(`${tag} keywords "${String(r.words).trim().slice(0, 40)}": ${cs.length} clip(s)`);
    } else if (r.type === 'describe') {
      const desc = String(r.desc || '').trim();
      if (!desc) continue;
      if (!s.apiKey) { log(`${tag} skipped describe rule: no API key set`); continue; }
      try {
        const max = Number(r.max) > 0 ? Number(r.max) : 3;
        const text = await askClaude(L.buildPrompt(desc, L.transcriptText(words), max), s);
        const cs = L.parseClips(text, duration, max);
        cs.forEach(c => found.push({
          start: Math.max(0, c.start - s.lead),
          end: c.end + s.tail,
          how: `described "${desc.slice(0, 40)}": ${c.quote}`,
        }));
        if (!cs.length) log(`${tag} nothing matched "${desc.slice(0, 40)}"`);
      } catch (e) {
        log(`${tag} describe rule failed: ${e.message}`);
      }
    }
  }
  return L.mergeRanges(found);
}

// ---------- clips ----------
function addClip(c) {
  c.include = true;
  c.url = URL.createObjectURL(c.blob);
  clips.push(c);
  const ext = c.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const d = document.createElement('div');
  d.className = 'clip';
  d.innerHTML =
    '<video controls preload="metadata"></video>' +
    '<label class="inline"><input type="checkbox" checked> <span></span></label>' +
    '<div><a download>save clip</a></div>';
  d.querySelector('video').src = c.url;
  d.querySelector('span').textContent = `${c.title} (${c.range}) ${c.how}`;
  d.querySelector('input').onchange = e => { c.include = e.target.checked; };
  const a = d.querySelector('a');
  a.href = c.url;
  a.download = `clip_${c.id}_${clips.length}.${ext}`;
  $('clips').appendChild(d);
  $('build').disabled = false;
}

async function processVideo(tabId, id, n, total, s) {
  const tag = `[${n + 1}/${total}] ${id}`;
  try {
    await load(tabId, `https://www.youtube.com/watch?v=${id}`);
    const prep = await inject(tabId, ytPrepare);
    if (!prep.ok) { log(`${tag} skipped: ${prep.error}`); return; }

    let plan = [];
    const cap = await inject(tabId, ytCaptions);
    if (cap.ok) {
      const words = cap.method === 'transcript' ? L.wordsFromLines(cap.lines) : L.wordsFromJson3(cap.json3);
      log(`${tag} "${prep.title}": ${words.length} caption words (${cap.method})`);
      plan = await planClips(words, s, prep.duration, tag);
    } else {
      log(`${tag} ${cap.error}`);
    }
    if (!plan.length && s.fallbackOn && prep.duration) {
      plan = [{ start: Math.max(0, prep.duration - s.fallbackSec), end: Math.max(1, prep.duration - 0.3), how: `last ${s.fallbackSec}s fallback` }];
    }
    if (!plan.length) { log(`${tag} skipped: no match`); return; }

    for (let k = 0; k < plan.length && !abort; k++) {
      const p = plan[k];
      log(`${tag} clip ${k + 1}/${plan.length} ${p.start.toFixed(1)}-${p.end.toFixed(1)}s. Recording...`);
      const rec = await inject(tabId, ytRecord, [p.start, p.end]);
      if (!rec.ok) { log(`${tag} record failed: ${rec.error}`); if (/autoplay/.test(rec.error)) return; continue; }
      if (!rec.hasAudio) log(`${tag} WARNING: clip has no audio track`);
      addClip({
        id,
        title: prep.title,
        range: `${p.start.toFixed(1)}-${p.end.toFixed(1)}s`,
        how: p.how,
        w: rec.w,
        h: rec.h,
        blob: b64ToBlob(rec.b64, rec.mime),
      });
      log(`${tag} saved ${(rec.b64.length * 0.75 / 1e6).toFixed(1)} MB, ${rec.w}x${rec.h}`);
    }
  } catch (e) {
    log(`${tag} failed: ${e.message}`);
  }
}

async function run() {
  if (running) return;
  running = true;
  abort = false;
  $('run').disabled = true;
  $('stop').disabled = false;
  save();
  const s = settings();
  const items = L.extractUrls($('urls').value).map(L.classify).filter(Boolean);
  if (!items.length) {
    log('No YouTube URLs found.');
    running = false; $('run').disabled = false; $('stop').disabled = true;
    return;
  }
  if (!rules.length) log('No rules set; only the last-seconds fallback will be used.');
  const me = await chrome.tabs.getCurrent();
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  try {
    let ids = [];
    for (const it of items) {
      if (it.kind === 'video') { ids.push(it.id); continue; }
      log(`Collecting videos from ${it.url} ...`);
      try {
        await load(tab.id, it.url);
        const got = await inject(tab.id, ytCollect, [s.maxPage]);
        log(`  found ${got.length}`);
        ids.push(...got);
      } catch (e) { log(`  failed: ${e.message}`); }
    }
    ids = [...new Set(ids)];
    log(`Processing ${ids.length} video(s).`);
    for (let i = 0; i < ids.length && !abort; i++) await processVideo(tab.id, ids[i], i, ids.length, s);
  } catch (e) {
    log('Error: ' + e.message);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
    try { await chrome.tabs.update(me.id, { active: true }); } catch (e) {}
    running = false;
    $('run').disabled = false;
    $('stop').disabled = true;
  }
  log(`Done: ${clips.length} clip(s).`);
  if (s.autoBuild && clips.some(c => c.include) && !abort) {
    await new Promise(r => setTimeout(r, 600));
    await build();
  }
}

// ---------- montage ----------
async function build() {
  const sel = clips.filter(c => c.include);
  if (!sel.length) { log('No clips checked.'); return; }
  $('build').disabled = true;
  log(`Building montage from ${sel.length} clip(s). Keep this tab in front...`);
  const W = Math.max(...sel.map(c => c.w || 0)) || 1280;
  const H = Math.max(...sel.map(c => c.h || 0)) || 720;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const ac = new AudioContext();
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  const vids = [];
  for (const c of sel) {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.src = c.url;
    await new Promise(r => { v.onloadeddata = r; v.onerror = r; });
    ac.createMediaElementSource(v).connect(dest);
    vids.push(v);
  }
  const mimes = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || '';
  const out = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: 10e6, audioBitsPerSecond: 192e3 } : {});
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  rec.start(500);

  for (const v of vids) {
    await new Promise(res => {
      let done = false;
      const end = () => { if (!done) { done = true; res(); } };
      v.onended = end;
      v.onerror = end;
      if (isFinite(v.duration)) setTimeout(end, (v.duration + 2) * 1000);
      v.play().then(() => {
        const tick = () => {
          if (done) return;
          if (v.videoWidth) {
            const k = Math.min(W / v.videoWidth, H / v.videoHeight);
            const dw = v.videoWidth * k, dh = v.videoHeight * k;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
            ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
          }
          requestAnimationFrame(tick);
        };
        tick();
      }).catch(end);
    });
  }
  rec.stop();
  await stopped;
  ac.close();
  const blob = new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' });
  const url = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  $('out').innerHTML = '<h2>Montage</h2><video controls></video><div><a id="dl">Download montage.' + ext + '</a></div>';
  $('out').querySelector('video').src = url;
  const a = $('dl');
  a.href = url;
  a.download = 'montage.' + ext;
  $('build').disabled = false;
  log(`Montage ready (${(blob.size / 1e6).toFixed(1)} MB, ${ext}).`);
}

// ---------- wiring ----------
$('file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  const t = await f.text();
  $('urls').value = ($('urls').value ? $('urls').value + '\n' : '') + L.extractUrls(t).join('\n');
  save();
};
$('run').onclick = run;
$('stop').onclick = () => { abort = true; log('Stopping after current clip...'); };
$('build').onclick = build;
FIELDS.forEach(f => { $(f).addEventListener('change', save); });
restore();
renderRules();
