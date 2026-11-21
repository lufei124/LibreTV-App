import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import proxyHandler from './api/proxy/[...path].mjs';
import * as cast from './cast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'serve-local.config.json');
const localConfig = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : {};
const PORT = Number(process.env.PORT || 8899);
// Persist the bind address even when a desktop launcher passes a loopback HOST.
const HOST = localConfig.host || process.env.HOST || '0.0.0.0';
const password = process.env.PASSWORD || '';
const passwordHash = password
  ? crypto.createHash('sha256').update(password).digest('hex')
  : '';

const PASSWORD_PLACEHOLDER = 'window.__ENV__.PASSWORD = "{{PASSWORD}}";';
const PASSWORD_REPLACEMENT = `window.__ENV__.PASSWORD = "${passwordHash}";`;

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  const pathname = req.path || '';
  if (
    pathname.includes('..') ||
    pathname.startsWith('/.') ||
    pathname.startsWith('/node_modules') ||
    pathname.startsWith('/src-tauri')
  ) {
    res.status(404).end();
    return;
  }
  next();
});

app.use(async (req, res, next) => {
  const url = req.originalUrl || req.url || '';
  if (!url.startsWith('/proxy/')) {
    next();
    return;
  }

  req.url = url;

  try {
    await proxyHandler(req, res);
  } catch (error) {
    console.error('[proxy]', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

function castRoute(handler) {
  return async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      console.error('[cast]', error.message);
      res.status(error.status || 500).json({ error: error.message });
    }
  };
}

app.get('/api/cast/devices', castRoute((req) =>
  cast.discoverDevices({ refresh: req.query.refresh === '1' }).then((devices) => ({ devices }))));

app.post('/api/cast/play', express.json(), castRoute((req) =>
  cast.play(req.body.deviceId, req.body)));

app.post('/api/cast/control', express.json(), castRoute(async (req) => {
  await cast.control(req.body.deviceId, req.body.action, Number(req.body.seconds) || 0);
  return { ok: true };
}));

app.get('/api/cast/status', castRoute((req) => cast.status(req.query.deviceId)));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }

  const pathname = req.path === '/' ? '/index.html' : req.path;
  if (!pathname.endsWith('.html')) {
    next();
    return;
  }

  const filePath = path.normalize(path.join(__dirname, pathname));
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath)) {
    next();
    return;
  }

  const html = fs
    .readFileSync(filePath, 'utf8')
    .replaceAll(PASSWORD_PLACEHOLDER, PASSWORD_REPLACEMENT);

  res.type('html').send(html);
});

app.use(express.static(__dirname, { dotfiles: 'ignore', index: false }));

app.listen(PORT, HOST, () => {
  const passwordNote = password ? '已启用访问密码' : '未设置访问密码';
  console.log(`LibreTV 已启动: http://${HOST}:${PORT} （${passwordNote}）`);
});
