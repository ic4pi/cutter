// Run: node test/test.js
const assert = require('assert');
const L = require('../lib.js');

// ---- URLs
assert.deepStrictEqual(
  L.extractUrls('a https://youtu.be/abc123XYZ_1, https://www.youtube.com/watch?v=30O5DyifDrg&t=5s).\nhttps://www.youtube.com/@x/videos'),
  ['https://youtu.be/abc123XYZ_1', 'https://www.youtube.com/watch?v=30O5DyifDrg&t=5s', 'https://www.youtube.com/@x/videos']
);
assert.deepStrictEqual(L.classify('https://youtu.be/abc123XYZ_1'), { kind: 'video', id: 'abc123XYZ_1' });
assert.deepStrictEqual(L.classify('https://www.youtube.com/watch?v=30O5DyifDrg&list=x'), { kind: 'video', id: '30O5DyifDrg' });
assert.strictEqual(L.classify('https://www.youtube.com/@x/videos').kind, 'page');
assert.strictEqual(L.classify('https://example.com/watch?v=1'), null);

// ---- captions -> words
const mk = (t, ws) => ({ tStartMs: t * 1000, dDurationMs: 4000, segs: ws.map((w, i) => ({ utf8: w, tOffsetMs: i * 400 })) });
const j = { events: [
  mk(100, ['so', 'this', 'satire', 'account', 'thing']),
  mk(300, ['thanks', 'for', 'watching']),
  mk(310, ['this', 'is', 'a', 'satire', 'account.']),
  mk(312.5, ['this', 'video', 'is', 'for', 'entertainment', 'purposes', 'only.']),
] };
const w = L.wordsFromJson3(j);

// exact, last occurrence, with end phrase
let c = L.findClips(w, { start: 'satire account', end: 'entertainment purposes only', strict: 'exact', which: 'last' }, { lead: 1, tail: 0.4 });
assert.strictEqual(c.length, 1);
assert(Math.abs(c[0].start - 310.2) < 0.01, 'last occurrence, 1s lead');
assert(c[0].end > 315.5 && c[0].end < 316.8);

// every hit
c = L.findClips(w, { start: 'satire account', strict: 'exact', which: 'all', after: 3 });
assert.strictEqual(c.length, 2);

// near match: mis-heard and split words
const w2 = L.wordsFromJson3({ events: [mk(50, ['this', 'is', 'a', 'satyr', 'account']), mk(90, ['the', 'sat', 'tire', 'account', 'ok'])] });
assert.strictEqual(L.findHits(w2, 'satire account', 1).length, 0, 'exact must not match typo');
assert.strictEqual(L.findHits(w2, 'satire account', L.STRICT.near).length, 2, 'near matches typo + split word');
assert.strictEqual(L.findHits(w2, 'banana smoothie', L.STRICT.loose).length, 0, 'unrelated text must not match');

// near sentence
const w3 = L.wordsFromJson3({ events: [mk(20, 'the truth is they are all fallen angels walking among us'.split(' '))] });
assert.strictEqual(L.findHits(w3, 'the truth is they re all fallen angels walking among us', L.STRICT.near).length, 1);

// end phrase only fallback
c = L.findClips(w, { start: 'zzz qqq', end: 'purposes only', strict: 'exact', which: 'last' });
assert.strictEqual(c[0].how, 'end phrase only');
assert.deepStrictEqual(L.findClips(w, { start: 'zzz', end: 'yyy', strict: 'exact', which: 'last' }), []);

// transcript-panel lines
const lw = L.wordsFromLines([{ t: 310, text: 'This is a satire account.' }, { t: 313, text: 'This video is for entertainment purposes only.' }, { t: 317, text: 'bye' }]);
c = L.findClips(lw, { start: 'satire account', end: 'entertainment purposes only', strict: 'near', which: 'last' });
assert(c.length === 1 && c[0].end > 316);

// ---- merge
const m = L.mergeRanges([{ start: 10, end: 15, how: 'a' }, { start: 14.9, end: 20, how: 'b' }, { start: 40, end: 45, how: 'c' }]);
assert.strictEqual(m.length, 2);
assert.strictEqual(m[0].end, 20);
assert.strictEqual(m[0].how, 'a + b');

// ---- describe-rule helpers
const tt = L.transcriptText(w, 5);
assert(/^\[100\.0\] so this satire account thing/.test(tt));
const pr = L.buildPrompt('the host making a claim', tt, 3);
assert(pr.includes('the host making a claim') && pr.includes('TRANSCRIPT:') && pr.includes('up to 3'));
const parsed = L.parseClips('Here you go:\n```json\n[{"start":10,"end":18.5,"quote":"they are fallen"},{"start":50,"end":40},{"start":"x","end":9},{"start":100,"end":400,"quote":"long"}]\n```', 200, 5);
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[1].end, 145, 'clamped to 45s');
assert.deepStrictEqual(L.parseClips('no json here', 100, 3), []);
assert.deepStrictEqual(L.parseClips('[not json]', 100, 3), []);

console.log('all tests pass');
