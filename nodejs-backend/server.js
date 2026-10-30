// Spuštění:  npm i express obs-websocket-js   a pak   node server.js
// Režie:     http://localhost:3000   (jen z tohoto PC)
import express from 'express';
import OBSWebSocket from 'obs-websocket-js';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';

// ---------- nastavení ----------
const OBS_PASSWORD = 'heslo';      // OBS → Nástroje → Nastavení WebSocket serveru
const PUBLIC_IP = '192.168.1.50';  // IP tohoto PC – sem se připojují řečníci
const INFO = 'INFO';               // scéna s grafikou (vytvoř v OBS ručně)
const TICKER = 'Lista';            // textový zdroj lišty (vytvoř v OBS ručně)
const FAILOVER_MS = 15000;

const obs = new OBSWebSocket();
const sources = []; // { id, port, key }
let counter = 0;
let downSince = null; // od kdy je vysílaný zdroj bez signálu
let ffmpeg = null;

// ---------- připojení k OBS (a znovupřipojení, když spadne) ----------
let connecting = false;
setInterval(async () => {
  if (obs.identified || connecting) return;
  connecting = true;
  try {
    await obs.connect('ws://127.0.0.1:4455', OBS_PASSWORD);
    console.log('✔ OBS připojeno');
  } catch {} finally { connecting = false; }
}, 3000);

const srtUrl = (s) => `srt://${PUBLIC_IP}:${s.port}?passphrase=${s.key}&pbkeylen=32`;
const isLive = async (s) =>
  (await obs.call('GetMediaInputStatus', { inputName: `${s.id} SRT` }).catch(() => ({})))
    .mediaState === 'OBS_MEDIA_STATE_PLAYING';

// ---------- failover: zdroj ve vysílání bez signálu 15 s => INFO ----------
setInterval(async () => {
  try {
    if (!obs.identified) return;
    const { currentProgramSceneName: program } = await obs.call('GetCurrentProgramScene');
    const s = sources.find((x) => x.id === program);
    if (!s || (await isLive(s))) return (downSince = null);
    downSince ??= Date.now();
    if (Date.now() - downSince > FAILOVER_MS) {
      await obs.call('SetCurrentProgramScene', { sceneName: INFO });
      console.log(`⚠ ${s.id} vypadl → ${INFO}`);
      downSince = null;
    }
  } catch {}
}, 1000);

// ---------- API ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // nginx-rtmp callbacky posílají formulář

// Express 4 nechytá chyby z async funkcí => bez tohohle by server spadl.
const h = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

app.get('/api/state', h(async (req, res) => {
  if (!obs.identified) return res.json({ obs: false });
  const { currentProgramSceneName: program } = await obs.call('GetCurrentProgramScene');
  const list = await Promise.all(sources.map(async (s) => ({ ...s, url: srtUrl(s), live: await isLive(s) })));
  const failoverIn = downSince && Math.ceil((FAILOVER_MS - (Date.now() - downSince)) / 1000);
  res.json({ obs: true, program, sources: list, failoverIn });
}));

app.post('/api/add', h(async (req, res) => {
  const s = { id: `src${++counter}`, port: 9000 + counter, key: randomBytes(12).toString('hex') };
  await obs.call('CreateScene', { sceneName: s.id });
  // OBS jako SRT listener; passphrase + pbkeylen=32 => šifrování AES-256
  const { sceneItemId } = await obs.call('CreateInput', {
    sceneName: s.id, inputName: `${s.id} SRT`, inputKind: 'ffmpeg_source',
    inputSettings: {
      is_local_file: false, input_format: 'mpegts', reconnect_delay_sec: 1, close_when_inactive: false,
      input: `srt://0.0.0.0:${s.port}?mode=listener&passphrase=${s.key}&pbkeylen=32`,
    },
  });
  // roztáhnout obraz na celé plátno (řečník může poslat 720p)
  await obs.call('SetSceneItemTransform', { sceneName: s.id, sceneItemId, sceneItemTransform:
    { boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080 } });
  await obs.call('CreateSceneItem', { sceneName: s.id, sourceName: TICKER }).catch(() => {}); // lišta navrch
  sources.push(s);
  res.json(s);
}));

app.post('/api/remove', h(async (req, res) => {
  const i = sources.findIndex((s) => s.id === req.body.id);
  if (i < 0) return res.sendStatus(404);
  await obs.call('RemoveInput', { inputName: `${req.body.id} SRT` }).catch(() => {});
  await obs.call('RemoveScene', { sceneName: req.body.id }).catch(() => {});
  sources.splice(i, 1);
  res.sendStatus(204);
}));

app.post('/api/program', h(async (req, res) => {
  await obs.call('SetCurrentProgramScene', { sceneName: req.body.scene });
  res.sendStatus(204);
}));

app.post('/api/ticker', h(async (req, res) => {
  await obs.call('SetInputSettings', { inputName: TICKER, inputSettings: { text: req.body.text } });
  res.sendStatus(204);
}));

// náhled scény jako JPEG (režie si ho stahuje každé 2 s)
app.get('/api/shot/:id', h(async (req, res) => {
  const { imageData } = await obs.call('GetSourceScreenshot', { sourceName: req.params.id, imageFormat: 'jpg', imageWidth: 320 });
  res.type('jpg').send(Buffer.from(imageData.split(',')[1], 'base64'));
}));

// ---------- transkódování: nginx zavolá, když OBS začne/přestane vysílat ----------
const variant = (height, kbps) => [
  '-map', '0:v', '-map', '0:a', '-vf', `scale=-2:${height}`, '-r', '30',
  '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-g', '60', // keyframe à 2 s = délka HLS segmentu
  '-c:a', 'aac', '-f', 'flv', `rtmp://127.0.0.1/hls/live_${height}p`,
];

app.post('/rtmp/start', (req, res) => {
  res.sendStatus(200);
  // malé zpoždění: stream se v nginx zaregistruje až po naší odpovědi
  setTimeout(() => {
    ffmpeg = spawn('ffmpeg', ['-i', 'rtmp://127.0.0.1/program/live',
      ...variant(1080, 5000), ...variant(720, 2800), ...variant(480, 1200)], { stdio: ['pipe', 'ignore', 'ignore'] });
    ffmpeg.stdin.on('error', () => {});
    console.log('▶ vysílání běží, FFmpeg transkóduje');
  }, 500);
});

app.post('/rtmp/stop', (req, res) => {
  res.sendStatus(200);
  ffmpeg?.stdin.write('q'); // "q" = korektní konec FFmpegu (funguje i na Windows)
  ffmpeg = null;
  // smazat playlist => divák uvidí „čekáme na vysílání“
  setTimeout(() => rmSync(new URL('../nginx/temp/hls/live.m3u8', import.meta.url), { force: true }), 3000);
  console.log('■ vysílání skončilo');
});

// ---------- režisérská stránka ----------
app.get('/', (req, res) => res.send(`<!doctype html><meta charset="utf-8"><title>Režie</title>
<style>
  body { font-family: sans-serif; background: #111; color: #eee; margin: 20px }
  .card { display: inline-block; margin: 6px; padding: 8px; background: #222; border: 3px solid #333; vertical-align: top }
  .card.on { border-color: red }
  img { width: 320px; height: 180px; background: #000; display: block }
  code { font-size: 11px; word-break: break-all; display: block; max-width: 320px; margin-top: 6px }
</style>
<h2 id="head">Režie</h2>
<div id="cards"></div>
<p><button data-add>+ Přidat zdroj</button></p>
<p>Lišta: <input id="text" size="50"> <button data-ticker>Uložit</button></p>
<script>
  const post = (url, body) => fetch('/api/' + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  document.onclick = (e) => {
    const d = e.target.dataset;
    if (d.scene) post('program', { scene: d.scene });
    if (d.remove && confirm('Smazat ' + d.remove + '?')) post('remove', { id: d.remove });
    if ('add' in d) post('add');
    if ('ticker' in d) post('ticker', { text: document.getElementById('text').value });
  };

  async function refresh() {
    const s = await fetch('/api/state').then((r) => r.json()).catch(() => ({}));
    if (!s.obs) { head.textContent = '⚠ OBS není připojeno'; cards.innerHTML = ''; return; }
    head.textContent = 'ON AIR: ' + s.program +
      (s.failoverIn ? '  ⚠ výpadek – přepnutí na ${INFO} za ' + s.failoverIn + ' s' : '');
    const t = Math.floor(Date.now() / 2000); // stejná URL 2 s => prohlížeč náhled nestahuje znovu
    cards.innerHTML = s.sources.concat([{ id: '${INFO}' }]).map((x) =>
      '<div class="card ' + (x.id === s.program ? 'on' : '') + '">' +
        '<img src="/api/shot/' + x.id + '?t=' + t + '">' +
        '<b>' + x.id + '</b> ' + (x.port ? (x.live ? '🟢' : '🔴') : '') + '<br>' +
        '<button data-scene="' + x.id + '">Vysílat</button> ' +
        (x.port ? '<button data-remove="' + x.id + '">Smazat</button><code>' + x.url + '</code>' : '') +
      '</div>').join('');
  }
  setInterval(refresh, 1000);
  refresh();
</script>`));

app.listen(3000, '127.0.0.1', () => console.log('Režie: http://localhost:3000'));
