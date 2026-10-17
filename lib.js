/* Pure helpers (no DOM, no chrome.*): URL parsing, caption -> word timeline,
   exact/near phrase search, range merging, and the prompt/parser for "describe" rules. */
(function (root) {
  const norm = s =>
    String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- URLs ----------
  function extractUrls(text) {
    const m = String(text || '').match(/https?:\/\/[^\s"'<>,]+/g) || [];
    return [...new Set(m.map(u => u.replace(/[).;\]]+$/, '')))];
  }

  // -> {kind:'video', id} | {kind:'page', url} | null
  function classify(u) {
    let url;
    try { url = new URL(u); } catch (e) { return null; }
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/')[1];
      return id ? { kind: 'video', id } : null;
    }
    if (host !== 'youtube.com') return null;
    if (url.pathname === '/watch' && url.searchParams.get('v')) {
      return { kind: 'video', id: url.searchParams.get('v') };
    }
    const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
    if (m) return { kind: 'video', id: m[2] };
    return { kind: 'page', url: url.toString() };
  }

  // ---------- captions -> words ----------
  function finish(words) {
    words.sort((a, b) => a.t - b.t);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      let e = Math.min(w.e, w.t + 0.9);
      const nx = words[i + 1];
      if (nx && nx.t > w.t) e = Math.min(e, nx.t);
      w.e = Math.max(e, w.t + 0.15);
    }
    return words;
  }

  // YouTube json3 caption format (auto and manual captions)
  function wordsFromJson3(j) {
    const out = [];
    for (const ev of (j && j.events) || []) {
      if (!ev.segs) continue;
      const base = ev.tStartMs || 0;
      const dur = ev.dDurationMs || 0;
      const segs = ev.segs;
      for (let i = 0; i < segs.length; i++) {
        const ws = norm(segs[i].utf8 || '').split(' ').filter(Boolean);
        if (!ws.length) continue;
        const s = base + (segs[i].tOffsetMs || 0);
        const nextS = i + 1 < segs.length ? base + (segs[i + 1].tOffsetMs || 0) : base + dur;
        const span = Math.max(nextS - s, 300);
        ws.forEach((w, k) =>
          out.push({ w, t: (s + (span * k) / ws.length) / 1000, e: (s + (span * (k + 1)) / ws.length) / 1000 })
        );
      }
    }
    return finish(out);
  }

  // Transcript-panel lines [{t:seconds, text}] (no word timing, so spread evenly)
  function wordsFromLines(lines) {
    const L = (lines || []).filter(l => isFinite(l.t) && l.text).sort((a, b) => a.t - b.t);
    const out = [];
    L.forEach((l, i) => {
      const next = i + 1 < L.length ? L[i + 1].t : l.t + 4;
      const span = Math.min(Math.max(next - l.t, 0.5), 8);
      const ws = norm(l.text).split(' ').filter(Boolean);
      ws.forEach((w, k) =>
        out.push({ w, t: l.t + (span * k) / ws.length, e: l.t + (span * (k + 1)) / ws.length })
      );
    });
    return finish(out);
  }

  // ---------- phrase search ----------
  const STRICT = { exact: 1, near: 0.8, loose: 0.68 };

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }
  const sim = (a, b) => (a.length || b.length ? 1 - lev(a, b) / Math.max(a.length, b.length) : 1);

  function findSeq(words, phrase) {
    const toks = norm(phrase).split(' ').filter(Boolean);
    const hits = [];
    if (!toks.length) return hits;
    for (let i = 0; i + toks.length <= words.length; i++) {
      let ok = true;
      for (let k = 0; k < toks.length; k++) {
        if (words[i + k].w !== toks[k]) { ok = false; break; }
      }
      if (ok) hits.push({ i, j: i + toks.length - 1, score: 1 });
    }
    return hits;
  }

  // Exact (thr = 1) or near match. Near match compares the phrase with windows of
  // consecutive words (a bit shorter/longer) as letter strings, so a mis-heard or
  // split word still matches. Returns non-overlapping hits in time order.
  function findHits(words, phrase, thr) {
    if (thr >= 1) return findSeq(words, phrase);
    const toks = norm(phrase).split(' ').filter(Boolean);
    if (!toks.length) return [];
    const target = toks.join('');
    const n = toks.length;
    const delta = Math.max(1, Math.round(n * 0.25));
    const cand = [];
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let len = 1; len <= n + delta && i + len <= words.length; len++) {
        joined += words[i + len - 1].w;
        if (len < Math.max(1, n - delta)) continue;
        const maxL = Math.max(joined.length, target.length);
        if (Math.abs(joined.length - target.length) > (1 - thr) * maxL) continue;
        const s = sim(joined, target);
        if (s >= thr) cand.push({ i, j: i + len - 1, score: s });
      }
    }
    cand.sort((a, b) => b.score - a.score || a.i - b.i);
    const taken = [];
    for (const c of cand) if (!taken.some(t => c.i <= t.j && c.j >= t.i)) taken.push(c);
    return taken.sort((a, b) => a.i - b.i);
  }

  const pick = (hits, which) =>
    which === 'all' ? hits : which === 'first' ? hits.slice(0, 1) : hits.slice(-1);

  // rule: {start, end?, strict:'exact'|'near'|'loose', which:'last'|'first'|'all', after?}
  // -> [{start, end, how, score}] (seconds, padded with lead/tail)
  function findClips(words, rule, o) {
    o = o || {};
    const lead = o.lead != null ? o.lead : 1;
    const tail = o.tail != null ? o.tail : 0.4;
    const maxLen = o.maxLen || 20;
    const thr = STRICT[rule.strict] != null ? STRICT[rule.strict] : STRICT.near;
    const sTxt = String(rule.start || '').trim();
    const eTxt = String(rule.end || '').trim();
    const afterN = rule.after === '' || rule.after == null ? NaN : Number(rule.after);
    const after = Number.isFinite(afterN) ? afterN : 5;
    const sHits = sTxt ? findHits(words, sTxt, thr) : [];
    const eHits = eTxt ? findHits(words, eTxt, thr) : [];
    const out = [];
    const add = (a, b, how, score) =>
      out.push({ start: Math.max(0, a - lead), end: b + tail, how, score });

    if (sHits.length) {
      for (const s of pick(sHits, rule.which)) {
        const t0 = words[s.i].t;
        const e = eHits.find(h => h.i >= s.i && words[h.j].e - t0 <= maxLen);
        if (e) add(t0, words[e.j].e, 'start+end phrase', s.score);
        else add(t0, words[s.j].e + after, eTxt ? 'start phrase (end not found)' : 'phrase', s.score);
      }
    } else if (eHits.length) {
      for (const e of pick(eHits, rule.which)) add(words[e.j].e - 6, words[e.j].e, 'end phrase only', e.score);
    }
    return out;
  }

  // Keyword rule (no API needed): every spot where any listed term is said.
  // rule: {words:'fallen angel, fallen angels', strict, before, after, max}
  // Nearby hits are grouped into one clip; if more than `max` groups, keep the densest.
  function findKeywordClips(words, rule, o) {
    o = o || {};
    const lead = o.lead != null ? o.lead : 0;
    const tail = o.tail != null ? o.tail : 0.4;
    const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
    const before = num(rule.before, 5);
    const after = num(rule.after, 10);
    const max = Math.max(1, Math.floor(num(rule.max, 5)));
    const gap = 15;      // hits closer than this share a clip
    const maxSpan = 40;  // never let one clip chain on longer than this
    const thr = STRICT[rule.strict] != null ? STRICT[rule.strict] : STRICT.near;
    const terms = String(rule.words || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    let hits = [];
    for (const term of terms) {
      for (const h of findHits(words, term, thr)) hits.push({ t: words[h.i].t, e: words[h.j].e, term });
    }
    hits.sort((a, b) => a.t - b.t);
    const groups = [];
    for (const h of hits) {
      const g = groups[groups.length - 1];
      if (g && h.t - g.last <= gap && h.e - g.first <= maxSpan) {
        g.last = h.t; g.end = Math.max(g.end, h.e); g.n++;
        if (!g.terms.includes(h.term)) g.terms.push(h.term);
      } else {
        groups.push({ first: h.t, last: h.t, end: h.e, n: 1, terms: [h.term] });
      }
    }
    const kept = groups.map((g, i) => ({ g, i })).sort((a, b) => b.g.n - a.g.n || a.i - b.i).slice(0, max)
      .sort((a, b) => a.i - b.i).map(x => x.g);
    return kept.map(g => ({
      start: Math.max(0, g.first - before - lead),
      end: g.end + after + tail,
      how: 'keyword "' + g.terms.join('", "') + '" x' + g.n,
      score: g.n,
    }));
  }

  // Merge overlapping/adjacent ranges, joining their labels.
  function mergeRanges(clips, gap) {
    gap = gap == null ? 0.3 : gap;
    const s = clips.slice().sort((a, b) => a.start - b.start);
    const out = [];
    for (const c of s) {
      const last = out[out.length - 1];
      if (last && c.start <= last.end + gap) {
        last.end = Math.max(last.end, c.end);
        if (c.how && !last.how.includes(c.how)) last.how += ' + ' + c.how;
      } else {
        out.push({ ...c });
      }
    }
    return out;
  }

  // ---------- "describe the moment" rules (LLM) ----------
  function transcriptText(words, perLine, maxChars) {
    perLine = perLine || 12;
    maxChars = maxChars || 300000;
    const lines = [];
    for (let i = 0; i < words.length; i += perLine) {
      const chunk = words.slice(i, i + perLine);
      lines.push('[' + chunk[0].t.toFixed(1) + '] ' + chunk.map(w => w.w).join(' '));
    }
    let txt = lines.join('\n');
    if (txt.length > maxChars) txt = txt.slice(0, maxChars);
    return txt;
  }

  function buildPrompt(description, transcript, max) {
    return [
      'You are locating moments in a video transcript. Each line starts with its start time in seconds, like [312.4]. There are no speaker labels and the text is lowercase auto-captions.',
      '',
      'Find up to ' + max + ' moments that match this description:',
      '"' + description + '"',
      '',
      'Rules:',
      '- Only return moments that are clearly in the transcript. If nothing fits, return [].',
      '- Each moment must cover the complete spoken sentence(s) of the match, usually 3 to 25 seconds.',
      '- "start" is the timestamp of the first relevant line. "end" is where the last relevant line finishes (use the next line\'s timestamp as a guide).',
      '- Return ONLY a JSON array, no other text: [{"start": 312.4, "end": 326.0, "quote": "short quote from the transcript"}]',
      '',
      'TRANSCRIPT:',
      transcript,
    ].join('\n');
  }

  function parseClips(text, duration, max) {
    const a = String(text || '').indexOf('[');
    const b = String(text || '').lastIndexOf(']');
    if (a < 0 || b < a) return [];
    let arr;
    try { arr = JSON.parse(text.slice(a, b + 1)); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      let s = Number(x && x.start);
      let e = Number(x && x.end);
      if (!isFinite(s) || !isFinite(e) || e <= s || s < 0) continue;
      if (duration && s > duration) continue;
      if (e - s > 45) e = s + 45;
      if (duration && e > duration) e = duration;
      out.push({ start: s, end: e, quote: String((x && x.quote) || '').slice(0, 120) });
    }
    return out.slice(0, max || 3);
  }

  const api = {
    norm, extractUrls, classify, wordsFromJson3, wordsFromLines,
    STRICT, lev, sim, findSeq, findHits, findClips, findKeywordClips, mergeRanges,
    transcriptText, buildPrompt, parseClips,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClipLib = api;
})(typeof self !== 'undefined' ? self : this);
