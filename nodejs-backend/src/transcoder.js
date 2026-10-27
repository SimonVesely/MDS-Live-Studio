import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { bus } from './bus.js';

const VARIANTS = [
  { suffix: '_1080p', height: 1080, vKbps: 5000, aKbps: 160 },
  { suffix: '_720p',  height: 720,  vKbps: 2800, aKbps: 128 },
  { suffix: '_480p',  height: 480,  vKbps: 1200, aKbps: 96 },
];

const ENCODERS = {
  h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-realtime', '1'],        // macOS
  h264_nvenc:        ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll'], // NVIDIA
  h264_qsv:          ['-c:v', 'h264_qsv', '-preset', 'veryfast'],            // Intel
  h264_amf:          ['-c:v', 'h264_amf', '-usage', 'lowlatency'],           // AMD
  libx264:           ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'],
};

let encoder = null;
let proc = null;
let wanted = null;
let log = null;

function encoderWorks(name) {
  const r = spawnSync(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=640x360:r=30',
    '-frames:v', '5', ...ENCODERS[name], '-f', 'null', '-',
  ], { timeout: 15000, windowsHide: true });
  return r.status === 0;
}

export function initTranscoder() {
  const probe = spawnSync(config.ffmpegPath, ['-version'], { windowsHide: true });
  if (probe.error) {
    console.error(`[ffmpeg] "${config.ffmpegPath}" nenalezen – nastav FFMPEG_PATH v .env`);
    return;
  }

  if (config.videoEncoder !== 'auto') {
    encoder = config.videoEncoder;
  } else {
    const candidates = process.platform === 'darwin'
      ? ['h264_videotoolbox']
      : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
    encoder = candidates.find(encoderWorks) ?? 'libx264';
  }
  if (!ENCODERS[encoder]) throw new Error(`Neznámý VIDEO_ENCODER: ${encoder}`);
  console.log(`[ffmpeg] kodér: ${encoder}`);

  mkdirSync('logs', { recursive: true });
  log = createWriteStream('logs/ffmpeg.log', { flags: 'a' });
}

function buildArgs(name) {
  const args = ['-hide_banner', '-loglevel', 'warning',
                '-i', `${config.rtmpBase}/program/${name}`];
  for (const v of VARIANTS) {
    args.push(
      '-map', '0:v:0', '-map', '0:a:0',
      '-vf', `scale=-2:${v.height}`, '-r', '30',
      ...ENCODERS[encoder],
      '-b:v', `${v.vKbps}k`, '-maxrate', `${v.vKbps}k`, '-bufsize', `${v.vKbps * 2}k`,
      '-g', '60', '-keyint_min', '60',
      '-c:a', 'aac', '-b:a', `${v.aKbps}k`, '-ar', '48000',
      '-f', 'flv', `${config.rtmpBase}/hls/${name}${v.suffix}`,
    );
  }
  return args;
}

function launch() {
  const name = wanted;
  log?.write(`\n=== ${new Date().toISOString()} start "${name}" (${encoder}) ===\n`);

  const p = spawn(config.ffmpegPath, buildArgs(name), {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  proc = p;
  p.stderr.pipe(log, { end: false });
  p.stdin.on('error', () => {});

  p.on('error', (err) => {
    console.error('[ffmpeg] nelze spustit:', err.message);
    proc = null;
  });

  p.on('exit', (code) => {
    proc = null;
    bus.emit('transcoder', getStatus());
    if (wanted) {
      console.warn(`[ffmpeg] skončil (kód ${code}), restart za 2 s`);
      setTimeout(() => wanted && !proc && launch(), 2000);
    }
  });

  bus.emit('transcoder', getStatus());
}

export function start(name) {
  if (!encoder) return;
  wanted = name;
  if (!proc) launch();
}

export function stop() {
  wanted = null;
  const p = proc;
  if (!p) return;
  p.stdin.write('q');
  setTimeout(() => p.exitCode === null && p.kill(), 3000);
}

export const getStatus = () => ({ running: !!proc, encoder, stream: wanted });
