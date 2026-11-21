import dgram from 'dgram';
import os from 'os';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const AVTRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
const DEVICE_TTL_MS = 10 * 60 * 1000;

const devices = new Map();

function isPrivateIPv4(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function lanAddresses() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) {
        result.push(entry.address);
      }
    }
  }
  return result;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlText(xml, tag) {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function searchLocations(timeoutMs) {
  const addresses = lanAddresses();
  const message = Buffer.from([
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 2',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    '',
    '',
  ].join('\r\n'));

  return new Promise((resolve) => {
    const locations = new Set();
    const sockets = [];

    for (const address of addresses) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(socket);

      socket.on('error', () => socket.close());
      socket.on('message', (buffer, remote) => {
        if (!isPrivateIPv4(remote.address)) {
          return;
        }
        const location = buffer.toString().match(/^LOCATION:\s*(.+)$/im);
        if (location) {
          locations.add(location[1].trim());
        }
      });

      socket.bind(0, address, () => {
        try {
          socket.setMulticastInterface(address);
        } catch {
          // Older stacks route multicast by the bound address already.
        }
        socket.send(message, SSDP_PORT, SSDP_ADDRESS);
        setTimeout(() => socket.send(message, SSDP_PORT, SSDP_ADDRESS), 400);
      });
    }

    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // Already closed after an error.
        }
      }
      resolve([...locations]);
    }, timeoutMs);
  });
}

async function describe(location) {
  const response = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const xml = await response.text();

  const services = xml.split(/<service>/i).slice(1);
  const avService = services.find((block) => block.includes(AVTRANSPORT));
  if (!avService) {
    return null;
  }

  const base = xmlText(xml, 'URLBase') || location;
  const controlPath = xmlText(avService, 'controlURL');
  const host = new URL(location).hostname;

  return {
    id: xmlText(xml, 'UDN') || location,
    name: xmlText(xml, 'friendlyName') || host,
    host,
    location,
    controlUrl: new URL(controlPath, base).toString(),
    seenAt: Date.now(),
  };
}

export async function discoverDevices({ refresh = false } = {}) {
  const now = Date.now();
  for (const [id, device] of devices) {
    if (now - device.seenAt > DEVICE_TTL_MS) {
      devices.delete(id);
    }
  }

  if (refresh || devices.size === 0) {
    const locations = await searchLocations(3000);
    const described = await Promise.allSettled(locations.map(describe));
    for (const result of described) {
      if (result.status === 'fulfilled' && result.value) {
        devices.set(result.value.id, result.value);
      }
    }
  }

  return [...devices.values()].map(({ id, name, host }) => ({ id, name, host }));
}

function getDevice(id) {
  const device = devices.get(id);
  if (!device) {
    throw Object.assign(new Error('找不到这台电视，请重新搜索。'), { status: 404 });
  }
  return device;
}

async function soap(device, action, args) {
  const body = Object.entries(args)
    .map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`)
    .join('');

  const envelope = '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${AVTRANSPORT}">${body}</u:${action}></s:Body></s:Envelope>`;

  const response = await fetch(device.controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${AVTRANSPORT}#${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(6000),
  });

  const text = await response.text();
  if (!response.ok) {
    const code = xmlText(text, 'errorCode');
    const description = xmlText(text, 'errorDescription');
    throw Object.assign(new Error(`电视拒绝了 ${action}（${code || response.status} ${description}）`.trim()), { status: 502 });
  }
  return text;
}

function didl(url, title, mime) {
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
    + '<item id="0" parentID="-1" restricted="1">'
    + `<dc:title>${xmlEscape(title)}</dc:title>`
    + '<upnp:class>object.item.videoItem</upnp:class>'
    + `<res protocolInfo="http-get:*:${mime}:*">${xmlEscape(url)}</res>`
    + '</item></DIDL-Lite>';
}

function toTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fromTimestamp(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return 0;
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export async function play(deviceId, { url, title = 'LibreTV', position = 0 }) {
  if (!/^https?:\/\//i.test(url || '')) {
    throw Object.assign(new Error('播放地址无效。'), { status: 400 });
  }

  const device = getDevice(deviceId);
  await soap(device, 'Stop', { InstanceID: 0 }).catch(() => {});

  const isHls = /\.m3u8(\?|$)/i.test(url);
  const attempts = isHls
    ? [didl(url, title, 'application/vnd.apple.mpegurl'), didl(url, title, 'video/mp4'), '']
    : [didl(url, title, 'video/mp4'), ''];

  let lastError;
  for (const metadata of attempts) {
    try {
      await soap(device, 'SetAVTransportURI', {
        InstanceID: 0,
        CurrentURI: url,
        CurrentURIMetaData: metadata,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }

  await soap(device, 'Play', { InstanceID: 0, Speed: 1 });

  if (position > 5) {
    setTimeout(() => {
      soap(device, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: toTimestamp(position) }).catch(() => {});
    }, 4000);
  }

  return { device: device.name };
}

export async function control(deviceId, action, seconds) {
  const device = getDevice(deviceId);
  switch (action) {
    case 'pause':
      await soap(device, 'Pause', { InstanceID: 0 });
      break;
    case 'resume':
      await soap(device, 'Play', { InstanceID: 0, Speed: 1 });
      break;
    case 'stop':
      await soap(device, 'Stop', { InstanceID: 0 });
      break;
    case 'seek':
      await soap(device, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: toTimestamp(seconds) });
      break;
    default:
      throw Object.assign(new Error('未知的投屏操作。'), { status: 400 });
  }
}

export async function status(deviceId) {
  const device = getDevice(deviceId);
  const [transport, position] = await Promise.all([
    soap(device, 'GetTransportInfo', { InstanceID: 0 }),
    soap(device, 'GetPositionInfo', { InstanceID: 0 }),
  ]);

  return {
    state: xmlText(transport, 'CurrentTransportState'),
    position: fromTimestamp(xmlText(position, 'RelTime')),
    duration: fromTimestamp(xmlText(position, 'TrackDuration')),
  };
}
