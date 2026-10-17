/* These run INSIDE the YouTube page (MAIN world). Each must be fully self-contained. */

async function ytPrepare() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const q = () => ({
    p: document.getElementById('movie_player'),
    v: document.querySelector('video.html5-main-video') || document.querySelector('video'),
  });
  for (let i = 0; i < 80; i++) {
    const { p, v } = q();
    if (p && typeof p.getPlayerResponse === 'function' && v && v.readyState >= 1) break;
    await sleep(250);
  }
  const { p, v } = q();
  if (!p || !v) return { ok: false, error: 'player not found' };
  const pr = (p.getPlayerResponse && p.getPlayerResponse()) || window.ytInitialPlayerResponse || {};
  const st = pr.playabilityStatus;
  if (st && st.status && st.status !== 'OK') {
    return { ok: false, error: 'unplayable: ' + st.status + ' ' + (st.reason || '') };
  }
  const vd = pr.videoDetails || {};
  const d = Number(vd.lengthSeconds) || (isFinite(v.duration) ? v.duration : 0);
  return { ok: true, title: vd.title || document.title, duration: d };
}

async function ytCaptions() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const p = document.getElementById('movie_player');
  const pr = (p && p.getPlayerResponse && p.getPlayerResponse()) || {};
  const tracks =
    (pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  const pick =
    tracks.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr') ||
    tracks.find(t => /^en/.test(t.languageCode)) ||
    tracks[0];

  const tryFetch = async url => {
    const u = new URL(url, location.origin);
    u.searchParams.set('fmt', 'json3');
    const r = await fetch(u.toString(), { credentials: 'include' });
    const t = await r.text();
    if (!t || t[0] !== '{') return null;
    const j = JSON.parse(t);
    return j.events && j.events.length ? j : null;
  };

  // 1a: caption track URL straight from the player response
  try {
    if (pick) {
      const j = await tryFetch(pick.baseUrl);
      if (j) return { ok: true, method: 'captions', json3: j };
    }
  } catch (e) {}

  // 1b: let the player request captions itself (adds the token), then reuse that URL
  try {
    if (pick && p) {
      if (p.loadModule) p.loadModule('captions');
      if (p.toggleSubtitlesOn) p.toggleSubtitlesOn();
      for (let i = 0; i < 24; i++) {
        const urls = performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/api/timedtext'));
        if (urls.length) {
          const j = await tryFetch(urls[urls.length - 1]);
          if (j) return { ok: true, method: 'captions(player)', json3: j };
        }
        await sleep(250);
      }
    }
  } catch (e) {}

  // 2: transcript panel
  try {
    const ts = s => {
      const a = String(s || '').trim().split(':').map(Number);
      return a.some(isNaN) ? NaN : a.reduce((x, y) => x * 60 + y, 0);
    };
    const exp = document.querySelector('ytd-text-inline-expander #expand') || document.querySelector('#expand');
    if (exp) exp.click();
    await sleep(600);
    let btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (!btn) {
      btn = [...document.querySelectorAll('button')].find(b =>
        /show transcript/i.test((b.textContent || '') + (b.getAttribute('aria-label') || ''))
      );
    }
    if (btn) {
      btn.click();
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        if (document.querySelectorAll('ytd-transcript-segment-renderer').length) break;
      }
      const lines = [...document.querySelectorAll('ytd-transcript-segment-renderer')]
        .map(s => ({
          t: ts((s.querySelector('.segment-timestamp') || {}).textContent),
          text: ((s.querySelector('.segment-text') || {}).textContent || '').trim(),
        }))
        .filter(l => isFinite(l.t) && l.text);
      if (lines.length) return { ok: true, method: 'transcript', lines };
    }
  } catch (e) {}

  return { ok: false, error: 'no captions or transcript available' };
}

async function ytRecord(start, end) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const p = document.getElementById('movie_player');
  const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
  if (!p || !v) return { ok: false, error: 'player not found' };

  // wait out / skip ads
  for (let i = 0; i < 120; i++) {
    if (!p.classList.contains('ad-showing')) break;
    const sk = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (sk) sk.click();
    await sleep(500);
  }
  if (p.classList.contains('ad-showing')) return { ok: false, error: 'ad would not skip' };

  try { p.unMute(); p.setVolume(100); } catch (e) {}
  v.muted = false;
  v.volume = 1;
  try { p.setPlaybackQualityRange('hd1080', 'hd1080'); } catch (e) {}
  p.pauseVideo();
  await sleep(1200);

  const from = Math.max(0, start - 0.3);
  p.seekTo(from, true);
  p.pauseVideo();
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (!v.seeking && v.readyState >= 3 && Math.abs(v.currentTime - from) < 1.5) break;
  }

  p.playVideo();
  for (let i = 0; i < 60; i++) {
    if (!v.paused && v.readyState >= 3 && v.currentTime > from + 0.02) break;
    await sleep(100);
  }
  if (v.paused) {
    return { ok: false, error: 'playback blocked by browser autoplay policy (play any YouTube video once in this browser, then retry)' };
  }

  const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
  const hasAudio = stream.getAudioTracks().length > 0;
  const mimes = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192e3 } : {});
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(250);

  const t0 = Date.now();
  const limit = (end - from) * 1000 + 20000;
  while (v.currentTime < end && !v.ended && Date.now() - t0 < limit) await sleep(40);
  const reached = v.currentTime;
  rec.stop();
  await stopped;
  p.pauseVideo();

  const blob = new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' });
  const b64 = await new Promise(res => {
    const fr = new FileReader();
    // data URL mime can itself contain a comma (codecs=avc1...,mp4a...), so cut at "base64,"
    fr.onload = () => { const s = String(fr.result); res(s.slice(s.indexOf('base64,') + 7)); };
    fr.readAsDataURL(blob);
  });
  return { ok: true, b64, mime: blob.type, w: v.videoWidth, h: v.videoHeight, hasAudio, from, reached };
}

async function ytCollect(max) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(2500);
  const ids = new Set();
  for (let i = 0; i < 30; i++) {
    document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]').forEach(a => {
      const m = a.href.match(/[?&]v=([\w-]{11})/) || a.href.match(/\/shorts\/([\w-]{11})/);
      if (m) ids.add(m[1]);
    });
    if (ids.size >= max) break;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(900);
  }
  return [...ids].slice(0, max);
}
