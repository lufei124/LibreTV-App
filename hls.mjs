import dns from 'dns';
import http from 'http';
import https from 'https';
import os from 'os';
import './js/m3u8-ad-filter.js';

const { filterPlaylist } = globalThis.LibreTVAdFilter;
const CACHE_TTL_MS = 10 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Domestic resolvers: local DNS may return proxy fake-IPs, and CDNs region-block overseas exits.
const DIRECT_DNS = ['223.5.5.5', '119.29.29.29'];

const cache = new Map();

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

function directLookup(localAddress) {
  const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(DIRECT_DNS);
  resolver.setLocalAddress(localAddress);
  return (hostname, options, callback) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return options.all ? callback(null, [{ address: hostname, family: 4 }]) : callback(null, hostname, 4);
    }
    resolver.resolve4(hostname, (error, addresses) => {
      if (error || !addresses?.length) {
        callback(error || new Error(`无法解析 ${hostname}`));
      } else if (options.all) {
        callback(null, addresses.map((address) => ({ address, family: 4 })));
      } else {
        callback(null, addresses[0], 4);
      }
    });
  };
}

function directGet(url, redirects = 5) {
  const localAddress = lanAddress();
  if (!localAddress) {
    return Promise.reject(new Error('没有可用的局域网地址'));
  }

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      localAddress,
      lookup: directLookup(localAddress),
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      timeout: 8000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects > 0) {
        response.resume();
        resolve(directGet(new URL(response.headers.location, url).toString(), redirects - 1));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
  });
}

export async function fetchPlaylist(url) {
  try {
    const { body } = await directGet(url);
    if (body.trimStart().startsWith('#EXTM3U')) {
      return body;
    }
  } catch {
    // Fall back to the system route below.
  }
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  const body = await response.text();
  if (!body.trimStart().startsWith('#EXTM3U')) {
    throw new Error(`上游返回的不是 m3u8（HTTP ${response.status}）`);
  }
  return body;
}

export function encodeToken(url) {
  return Buffer.from(url, 'utf8').toString('base64url');
}

function decodeToken(token) {
  const url = Buffer.from(token, 'base64url').toString('utf8');
  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error('无效的播放地址'), { status: 400 });
  }
  return url;
}

function rewriteMaster(content, baseUrl) {
  return content.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (line && !line.startsWith('#')) {
      return `/api/hls/${encodeToken(new URL(line, baseUrl).toString())}/index.m3u8`;
    }
    return line.replace(/URI="([^"]+)"/, (match, uri) => `URI="${new URL(uri, baseUrl).toString()}"`);
  }).join('\n');
}

export async function filteredPlaylist(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.content;
  }

  const source = await fetchPlaylist(url);
  let content;
  if (source.includes('#EXT-X-STREAM-INF')) {
    content = rewriteMaster(source, url);
  } else {
    const result = filterPlaylist(source, url, { absolute: true });
    if (result.removedSegments) {
      console.log(`[hls] 已移除 ${result.removedSegments} 个广告分片（${result.removedSeconds.toFixed(1)} 秒）: ${url}`);
    }
    content = result.content;
  }

  cache.set(url, { content, at: Date.now() });
  return content;
}

export async function handle(req, res) {
  try {
    const content = await filteredPlaylist(decodeToken(req.params.token));
    res.set('Cache-Control', 'no-cache');
    res.type('application/vnd.apple.mpegurl').send(content);
  } catch (error) {
    console.error('[hls]', error.message);
    res.status(error.status || 502).type('text/plain').send(error.message);
  }
}
