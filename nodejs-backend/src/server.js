import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config, NAMES } from './config.js';
import { bus } from './bus.js';
import { connectObs, call, isConnected, getProgramScene } from './obs.js';
import * as sources from './sources.js';
import * as transcoder from './transcoder.js';
import { instructions } from './instructions.js';
import { startWatchdog, isLive } from './watchdog.js';
import { startPreviews } from './previews.js';

async function snapshot() {
  const state = {
    obsConnected: isConnected(),
    program: getProgramScene(),
    infoScene: NAMES.infoScene,
    transcoder: transcoder.getStatus(),
    // passphrase sem záměrně nepatří – jen přes endpoint s pokyny
    sources: sources.list().map((s) => ({
      id: s.id,
      port: s.port,
      scene: NAMES.sceneFor(s.id),
      live: isLive(s.id),
    })),
    scenes: [],
    ticker: '',
  };
  if (!isConnected()) return state;

  const { scenes } = await call('GetSceneList');
  state.scenes = scenes
    .map((s) => s.sceneName)
    .filter((n) => !n.startsWith('_'))
    .reverse();

  try {
    const { inputSettings } = await call('GetInputSettings', { inputName: NAMES.tickerText });
    state.ticker = inputSettings.text ?? '';
  } catch {
    /* lišta v OBS chybí */
  }
  return state;
}

const app = express();

const rtmp = express.Router();
rtmp.use(express.urlencoded({ extended: false }));

const validStream = (name) => typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);

rtmp.post('/publish', (req, res) => {
  const { app: rtmpApp, name } = req.body ?? {};
  if (rtmpApp !== 'program' || !validStream(name)) return res.status(403).end();

  res.status(200).end();
  console.log(`[rtmp] OBS začalo vysílat "${name}"`);
  setTimeout(() => transcoder.start(name), 500);
});

rtmp.post('/publish_done', (req, res) => {
  res.status(200).end();
  console.log('[rtmp] OBS přestalo vysílat');
  transcoder.stop();
});

app.use('/rtmp', rtmp);

app.use('/api', express.json({ limit: '16kb' }));

const route = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(err.status ?? 500).json({ error: err.message }));

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

app.get('/api/state', route(async (req, res) => res.json(await snapshot())));

app.post('/api/sources', route(async (req, res) => {
  const s = await sources.create();
  res.status(201).json(instructions(s));
}));

app.delete('/api/sources/:id', route(async (req, res) => {
  const ok = await sources.remove(req.params.id);
  ok ? res.status(204).end() : res.status(404).json({ error: 'Zdroj neexistuje' });
}));

app.get('/api/sources/:id/instructions', route(async (req, res) => {
  const s = sources.get(req.params.id);
  s ? res.json(instructions(s)) : res.status(404).json({ error: 'Zdroj neexistuje' });
}));

app.post('/api/program', route(async (req, res) => {
  const { scene } = req.body ?? {};
  if (typeof scene !== 'string' || !scene) throw badRequest('Chybí scene');
  try {
    await call('SetCurrentProgramScene', { sceneName: scene });
  } catch (err) {
    throw badRequest(err.message);
  }
  res.status(204).end();
}));

app.put('/api/ticker', route(async (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== 'string' || text.length > 300) throw badRequest('Text musí být řetězec do 300 znaků');
  await call('SetInputSettings', { inputName: NAMES.tickerText, inputSettings: { text } });
  scheduleStateBroadcast();
  res.status(204).end();
}));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, payload = {}) {
  const msg = JSON.stringify({ type, ...payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

let stateTimer = null;
function scheduleStateBroadcast() {
  if (stateTimer) return;
  stateTimer = setTimeout(async () => {
    stateTimer = null;
    try {
      broadcast('state', await snapshot());
    } catch (err) {
      console.warn('[ws] snapshot:', err.message);
    }
  }, 100);
}

wss.on('connection', async (ws) => {
  try {
    ws.send(JSON.stringify({ type: 'state', ...(await snapshot()) }));
  } catch {
    /* OBS zrovna nedostupné, stav přijde s další změnou */
  }
});

bus.on('preview', (p) => broadcast('preview', p));
bus.on('source-status', (p) => broadcast('source-status', p));
bus.on('outage', (p) => broadcast('outage', p));
for (const ev of ['program', 'scenes', 'sources', 'obs', 'transcoder']) {
  bus.on(ev, scheduleStateBroadcast);
}

bus.on('obs', ({ connected }) => connected && sources.syncAll());

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    transcoder.stop();
    setTimeout(() => process.exit(0), 500);
  });
}

await sources.load();
transcoder.initTranscoder();
connectObs();
startWatchdog();
startPreviews(() => wss.clients.size > 0);

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] http://127.0.0.1:${config.port}`);
});
