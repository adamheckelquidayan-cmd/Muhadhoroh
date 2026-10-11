// server.js — Zero-dependency server (Node.js 18+)
// Fungsi: sajikan index.html + proxy untuk YouTube caption, terjemahan, dan AI (harakat/koreksi)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ENV_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

function extractVideoId(input) {
  const m = String(input).match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) return input.trim();
  return null;
}

// ---------- 1) Ambil caption YouTube ----------
async function getTranscript(url, start, end) {
  const id = extractVideoId(url);
  if (!id) throw new Error('Link YouTube tidak valid.');

  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '20.10.38',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'ar', gl: 'US' } },
      videoId: id,
    }),
  });
  if (!r.ok) throw new Error('Gagal menghubungi YouTube (' + r.status + ').');
  const data = await r.json();
  const ps = data.playabilityStatus;
  if (ps && ps.status && ps.status !== 'OK') throw new Error('Video tidak bisa diakses: ' + (ps.reason || ps.status));

  const cap = data.captions && data.captions.playerCaptionsTracklistRenderer;
  const tracks = (cap && cap.captionTracks) || [];
  if (!tracks.length) throw new Error('Video ini tidak memiliki caption/subtitle.');

  const isAr = (t) => (t.languageCode || '').toLowerCase().startsWith('ar');
  let track = tracks.find((t) => isAr(t) && t.kind !== 'asr') || tracks.find((t) => isAr(t));
  let kind = track ? (track.kind === 'asr' ? 'auto-generated (otomatis)' : 'subtitle resmi') : '';
  let tlang = '';
  if (!track) {
    // Tidak ada caption Arab: pakai caption lain yang bisa diterjemahkan ke Arab
    track = tracks.find((t) => t.isTranslatable) || tracks[0];
    tlang = '&tlang=ar';
    kind = 'diterjemahkan otomatis ke Arab dari "' + track.languageCode + '"';
  }

  const capUrl = track.baseUrl.replace(/&fmt=[^&]*/, '') + '&fmt=json3' + tlang;
  const cr = await fetch(capUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!cr.ok) throw new Error('Gagal mengunduh caption (' + cr.status + ').');
  const txt = await cr.text();
  if (!txt) throw new Error('Caption kosong (YouTube mungkin memblokir permintaan ini).');
  const cj = JSON.parse(txt);

  const segments = [];
  for (const ev of cj.events || []) {
    if (!ev.segs) continue;
    const t = ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (!t) continue;
    const s = (ev.tStartMs || 0) / 1000;
    const e = s + (ev.dDurationMs || 0) / 1000;
    if (start != null && e < start) continue;
    if (end != null && s > end) continue;
    segments.push({ start: s, end: e, text: t });
  }
  if (!segments.length) throw new Error('Tidak ada teks pada rentang waktu tersebut.');
  return { videoId: id, kind, lang: track.languageCode, segments };
}

// ---------- 2) Terjemahan Arab -> Indonesia (Google gtx, tanpa API key) ----------
async function translate(text) {
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ar&tl=id&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('Layanan terjemahan gagal (' + r.status + ').');
  const j = await r.json();
  return (j[0] || []).map((x) => x[0]).join('');
}

// ---------- 3) AI (Claude) untuk harakat & koreksi ----------
const PROMPTS = {
  tashkeel_full:
    'Kamu pakar Nahwu dan Sharf. Berikan harakat PENUH (fathah, dhammah, kasrah, sukun, syaddah, tanwin) pada SELURUH huruf teks Arab berikut sesuai kaidah Nahwu dan Sharf. Jangan mengubah, menambah, atau menghapus kata. Pertahankan pemisah paragraf. Keluarkan HANYA teks hasilnya.',
  tashkeel_end:
    'Kamu pakar Nahwu. Berikan harakat HANYA pada huruf terakhir setiap kata (harakat i\'rab/khatimah: rafa\', nashab, jar, jazm, atau bina\' sesuai kedudukan kata dalam kalimat), tanpa harakat di huruf lainnya. Jangan mengubah, menambah, atau menghapus kata. Pertahankan pemisah paragraf. Keluarkan HANYA teks hasilnya.',
  correct:
    'Kamu penyunting bahasa Arab. Teks berikut berasal dari caption otomatis YouTube. Perbaiki kata yang salah sambung/terpotong, ejaan yang jelas keliru, spasi, dan tanda baca standar Arab (، ؛ ؟ .). Jangan meringkas, jangan menambah isi, jangan menerjemahkan. Pertahankan pemisah paragraf. Keluarkan HANYA teks hasilnya.',
};

async function askClaude(task, text, clientKey) {
  const key = clientKey || ENV_KEY;
  if (!key) throw new Error('API key Anthropic belum diatur (lihat tombol ⚙ Pengaturan).');
  if (!PROMPTS[task]) throw new Error('Tugas tidak dikenal.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: PROMPTS[task],
      messages: [{ role: 'user', content: text }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Permintaan AI gagal (' + r.status + ').');
  return (j.content || []).map((c) => c.text || '').join('').trim();
}

// ---------- Server ----------
http
  .createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
      }
      if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, { hasKey: !!ENV_KEY });
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (req.url === '/api/transcript') return json(res, 200, await getTranscript(b.url, b.start, b.end));
        if (req.url === '/api/translate') return json(res, 200, { text: await translate(b.text || '') });
        if (req.url === '/api/ai') return json(res, 200, { text: await askClaude(b.task, b.text || '', b.apiKey) });
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      json(res, 500, { error: e.message || String(e) });
    }
  })
  .listen(PORT, () => console.log('Aplikasi berjalan di http://localhost:' + PORT));
