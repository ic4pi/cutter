# Cutter

Chrome extension. Paste YouTube URLs, say what to cut, and Cutter records just those moments and stitches them into one montage. No ffmpeg, no yt-dlp, no server.

## Install

1. `chrome://extensions` > turn on Developer mode.
2. Load unpacked > pick this folder.
3. Click the Cutter icon.

## Rules (what to cut)

- **Phrase / sentence.** Exact, near (tolerates mis-heard or split words), or loose match. Optional "until" phrase sets the clip end. Take the last, first, or every hit in each video.
- **Keywords (no API key).** Comma-separated terms, e.g. `fallen angel, fallen angels`. Exact or near match. Every spot where one is said becomes a clip (seconds before/after adjustable); nearby hits are grouped, and if there are more than the max, the densest groups win.
- **Described moment.** Plain-language description, e.g. `the host making a claim about fallen angels`. Cutter sends that video's transcript to the Anthropic API and records the timestamps Claude returns. Needs your own Anthropic API key (entered in the page, kept in this browser's localStorage). Captions have no speaker labels, so "host" or "narrator" is inferred from what is said.

Overlapping hits from different rules are merged into one clip. The "last N seconds" fallback is off by default; turn it on only for videos that end with the line you want.

## How it works

1. Opens a tab per video, reads its captions (player caption URL, then the player-requested caption URL, then the transcript panel).
2. Finds clip ranges from your rules.
3. Seeks to each range and records it with `video.captureStream()` + `MediaRecorder` (picture and sound together).
4. Plays the checked clips back through a canvas and records one montage file (`.mp4` if Chrome supports it, else `.webm`).

## Limits

- Recording is real time, with sound, in a tab brought to the front. Leave it uncovered.
- Keep the Cutter tab in front while the montage builds.
- Videos with no captions or transcript only work through the last-N-seconds fallback.
- If playback is blocked, play any YouTube video once in that Chrome profile and retry.
- You are responsible for how you use recorded footage (fair use, creator terms, YouTube terms).

## Dev

```
node test/test.js
```

`lib.js` holds the pure logic (no DOM, no chrome APIs) and is covered by `test/test.js`. `inject.js` runs inside the YouTube page. `app.js` drives the tabs and the UI.
