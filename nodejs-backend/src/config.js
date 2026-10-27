const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  obsUrl: env.OBS_WS_URL ?? 'ws://127.0.0.1:4455',
  obsPassword: env.OBS_WS_PASSWORD ?? '',
  publicHost: env.PUBLIC_HOST ?? 'localhost',
  srtPortMin: Number(env.SRT_PORT_MIN ?? 9001),
  srtPortMax: Number(env.SRT_PORT_MAX ?? 9010),
  srtLatencyUs: Number(env.SRT_LATENCY_US ?? 200000),
  previewIntervalMs: Number(env.PREVIEW_INTERVAL_MS ?? 2000),
  failoverMs: Number(env.FAILOVER_MS ?? 15000),
  dataFile: env.DATA_FILE ?? 'data/sources.json',
  ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
  videoEncoder: env.VIDEO_ENCODER ?? 'auto',
  rtmpBase: env.RTMP_BASE ?? 'rtmp://127.0.0.1:1935',
};

export const NAMES = {
  infoScene: 'INFO • Grafika',
  tickerScene: '_Lišta',
  tickerText: 'Lišta • Text',
  sceneFor: (id) => `SRC • ${id}`,
  inputFor: (id) => `SRT • ${id}`,
};
