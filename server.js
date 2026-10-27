'use strict';

const path = require('path');
const fs = require('fs');
const legacyUrl = require('url');
const express = require('express');
const compression = require('compression');
const Unblocker = require('unblocker');
const http = require('http');
const https = require('https');
const { Transform } = require('stream');
const registerBloxdRelay = require('./sites/bloxd-relay');
const registerPokiRelay = require('./sites/poki-auth-relay');
const registerYoutubeRelay = require('./sites/youtube-tv-relay');
const registerMcpedlRelay = require('./sites/mcpedl-relay');
const { POKI_CLEAN_NAVIGATION_PATCH } = require('./sites/poki');
const { TYPINGERZ_FORCE_PROXY_PATCH, TYPINGERZ_NETWORK_PATCH } = require('./sites/typingerz');
const { BLOXD_RELATIVE_RESOURCE_PATCH } = require('./sites/bloxd');
const { GLOBAL_PROXIED_NAVIGATION_PATCH } = require('./sites/navigation');
const { MINECRAFT_DOWNLOAD_NAVIGATION_PATCH } = require('./sites/minecraft');
const { YOUTUBE_TV_WATERMARK_PATCH } = require('./sites/youtube-tv');
const { MCPEDL_CLIENT_RECOVERY } = require('./sites/mcpedl');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROXY_PREFIX = '/proxy/';
const CONTEXT_COOKIE = '__proxy_origin';
const ABEMA_WORKER_URL = 'https://myproxy-api.xenonsan123.workers.dev/';
const GARTIC_PHONE_HOST = 'garticphone.com';
const GARTIC_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const POKI_WEB_ORIGIN = 'https://poki.com';
const POKI_ROUTE_PREFIX = '/jp';
const POKI_AUTH_HOSTS = new Set(['poki-auth.poki.com']);
const YOUTUBE_TV_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; UHD Google TV STB Build/UTT1.250214.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.7922.199 Mobile Safari/537.36';
const MAX_SOCKETS = positiveInteger(process.env.MAX_SOCKETS, 64);
const MAX_FREE_SOCKETS = positiveInteger(process.env.MAX_FREE_SOCKETS, 32);
const MAX_TOTAL_SOCKETS = positiveInteger(process.env.MAX_TOTAL_SOCKETS, 128);
const ASSET_CACHE_SECONDS = positiveInteger(process.env.ASSET_CACHE_SECONDS, 1800);
const MINECRAFT_DOWNLOAD_HOSTS = new Set([
  'minecraft-mcworld.com',
  'www.minecraft-mcworld.com'
]);
const MINECRAFT_DOWNLOAD_EXTENSIONS = new Set(['.mcworld', '.mcpack', '.zip']);

const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  maxTotalSockets: MAX_TOTAL_SOCKETS,
  scheduling: 'lifo'
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const originalSetHeader = res.setHeader;
  res.setHeader = function setSafeHeader(name, value) {
    const lowerName = String(name).toLowerCase();
    if (lowerName === 'location') {
      value = sanitizeLocationValue(value);
    }
    if (lowerName === 'permissions-policy') {
      value = sanitizePermissionsPolicyValue(value);
      if (value == null || value === '') return this;
    }
    return originalSetHeader.call(this, name, value);
  };
  next();
});

function sanitizePermissionsPolicyValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const cleaned = values
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^(?:attribution-reporting|private-aggregation|join-ad-interest-group|run-ad-auction)\s*=/i.test(item));
  return cleaned.length ? cleaned.join(', ') : null;
}

function sanitizeLocationValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeLocationValue);
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/ /g, '%20')
    .replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character));
}

function keepYouTubeTvRedirectInsideProxy(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  let source;
  try { source = new URL(data.url); } catch { return; }
  const sourceHost = source.hostname.toLowerCase();
  if (sourceHost !== 'youtube.com' && sourceHost !== 'www.youtube.com') return;
  const rewrite = (value) => {
    if (typeof value !== 'string') return value;
    try {
      const target = new URL(value, source);
      const host = target.hostname.toLowerCase();
      if ((host === 'youtube.com' || host === 'www.youtube.com') &&
          (target.pathname === '/tv' || target.pathname.startsWith('/tv/'))) {
        return `${PROXY_PREFIX}${target.href}`;
      }
    } catch {}
    return value;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(rewrite)
    : rewrite(data.headers.location);
}

function keepPokiRedirectOnCleanRoute(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  let source;
  try { source = new URL(data.url); } catch { return; }
  const host = source.hostname.toLowerCase();
  if (host !== 'poki.com' && host !== 'www.poki.com') return;
  const rewrite = (value) => {
    if (typeof value !== 'string') return value;
    try {
      const target = new URL(value, source);
      const targetHost = target.hostname.toLowerCase();
      if ((targetHost === 'poki.com' || targetHost === 'www.poki.com') &&
          (target.pathname === POKI_ROUTE_PREFIX || target.pathname.startsWith(`${POKI_ROUTE_PREFIX}/`))) {
        return `${target.pathname}${target.search}${target.hash}`;
      }
    } catch {}
    return value;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(rewrite)
    : rewrite(data.headers.location);
}

function sanitizeProxyResponseHeaders(data) {
  if (!data?.headers || data.headers.location == null) return;
  data.headers.location = sanitizeLocationValue(data.headers.location);
}

// Normalize malformed proxied Location values such as /proxy/https:/host/path.
function repairMalformedProxyLocation(data) {
  if (!data?.headers || data.headers.location == null) return;
  const repair = (location) => {
    if (typeof location !== 'string') return location;
    return location.replace(
      /\/proxy\/(https?):\/(?!\/)/gi,
      '/proxy/$1://'
    );
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(repair)
    : repair(data.headers.location);
}

// Fix minecraft-mcworld.com download redirects whose Japanese filename was
// decoded as Latin-1 and then encoded again, for example ç·´ç¿ã... -> 練習ワールド.
function repairMinecraftDownloadRedirect(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  const repair = (location) => {
    const repaired = repairMinecraftDownloadLocation(location, data.url);
    if (repaired !== location) {
      console.log(JSON.stringify({
        type: 'minecraft-download-redirect-repaired',
        sourceUrl: data.url,
        before: location,
        after: repaired
      }));
    }
    return repaired;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(repair)
    : repair(data.headers.location);
}
function repairMinecraftDownloadLocation(location, baseUrl) {
  if (typeof location !== 'string') return location;
  let absolute;
  try {
    absolute = new URL(location, baseUrl);
  } catch {
    return location;
  }

  // Unblocker may already have wrapped the upstream Location in this proxy's
  // URL. Repair the inner minecraft-mcworld.com URL without confusing the
  // proxy host with the upstream host.
  const proxyIndex = absolute.pathname.indexOf(PROXY_PREFIX);
  if (proxyIndex !== -1) {
    let innerTarget =
      absolute.pathname.slice(proxyIndex + PROXY_PREFIX.length) +
      absolute.search +
      absolute.hash;
    innerTarget = innerTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
    innerTarget = innerTarget.replace(/%25([0-9a-f]{2})/gi, '%$1');
    const repairedInnerTarget = repairMinecraftDownloadUrl(innerTarget);
    if (repairedInnerTarget !== innerTarget) {
      const proxyPath = absolute.pathname.slice(0, proxyIndex + PROXY_PREFIX.length);
      return `${absolute.origin}${proxyPath}${repairedInnerTarget}`;
    }
  }

  return repairMinecraftDownloadUrl(absolute.href);
}

function repairMinecraftDownloadUrl(value) {
  if (typeof value !== 'string') return value;

  let target;
  try {
    target = new URL(value);
  } catch {
    return value;
  }

  if (!MINECRAFT_DOWNLOAD_HOSTS.has(target.hostname.toLowerCase())) return value;
  if (!target.pathname.startsWith('/wp-content/uploads/')) return value;

  const lowerPath = target.pathname.toLowerCase();
  const matchingExtension = [...MINECRAFT_DOWNLOAD_EXTENSIONS]
    .some((extension) => lowerPath.endsWith(extension));
  if (!matchingExtension) return value;

  const repairedPath = target.pathname
    .split('/')
    .map(repairEncodedMojibakeSegment)
    .join('/');

  if (repairedPath === target.pathname) return value;
  return `${target.protocol}//${target.host}${repairedPath}${target.search}${target.hash}`;
}

function repairEncodedMojibakeSegment(segment) {
  if (!segment) return segment;

  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }

  const repaired = repairUtf8Mojibake(decoded);
  return repaired === decoded ? segment : encodeURIComponent(repaired);
}

function repairUtf8Mojibake(value) {
  // These characters commonly appear when UTF-8 Japanese text is interpreted
  // as Latin-1/Windows-1252. Restricting conversion avoids changing valid names.
  if (!/[ÃÂãçåæä]/u.test(value)) return value;
  if ([...value].some((character) => character.codePointAt(0) > 0xff)) return value;

  const repaired = Buffer.from(value, 'latin1').toString('utf8');
  if (!repaired || repaired.includes('\uFFFD')) return value;
  return mojibakeScore(repaired) < mojibakeScore(value) ? repaired : value;
}

function mojibakeScore(value) {
  return (value.match(/[ÃÂãçåæä]/gu) || []).length;
}

app.use(compression({
  level: 1,
  threshold: 4 * 1024,
  filter(req, res) {
    if (req.headers.range || req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Expose Poki on a clean local pathname. Poki's React router reads
// window.location.pathname, so /proxy/https://poki.com/jp/... is interpreted
// as an unknown Poki route after hydration. Internally rewriting /jp/... keeps
// the browser-visible pathname compatible with Poki while still using Unblocker.
app.use((req, res, next) => {
  if (!isCleanPokiRequest(req)) return next();
  const target = new URL(req.originalUrl, `${POKI_WEB_ORIGIN}/`);
  req.url = `${PROXY_PREFIX}${target.href}`;
  next();
});

function isCleanPokiRequest(req) {
  if (req.path === POKI_ROUTE_PREFIX || req.path.startsWith(`${POKI_ROUTE_PREFIX}/`)) {
    return true;
  }
  const referer = req.get('referer');
  const requestHost = req.get('host');
  if (!referer || !requestHost || isLocalRoute(req.path)) return false;
  try {
    const ref = new URL(referer);
    return ref.host === requestHost &&
      (ref.pathname === POKI_ROUTE_PREFIX || ref.pathname.startsWith(`${POKI_ROUTE_PREFIX}/`));
  } catch {
    return false;
  }
}

app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.[a-f0-9]{8,}\./i.test(path.basename(filePath))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

app.use((req, res, next) => {
  const repairedUrl = repairProxyPath(req.url);
  if (typeof req.headers.referer === 'string') {
    req.headers.referer = repairProxyReference(req.headers.referer);
  }
  if (repairedUrl !== req.url) req.url = repairedUrl;
  next();
});

function repairProxyReference(value) {
  try {
    const reference = new URL(value);
    const repaired = repairProxyPath(
      `${reference.pathname}${reference.search}${reference.hash}`
    );
    return `${reference.origin}${repaired}`;
  } catch {
    return repairProxyPath(value);
  }
}

function repairProxyPath(value) {
  if (typeof value !== 'string' || !value.includes(PROXY_PREFIX)) return value;
  const prefixIndex = value.indexOf(PROXY_PREFIX);
  const before = value.slice(0, prefixIndex + PROXY_PREFIX.length);
  let target = value.slice(prefixIndex + PROXY_PREFIX.length);
  if (!/^https?:/i.test(target)) return value;
  target = target.replace(/^(https?):\/(?!\/)/i, '$1://');
  target = target.replace(/%25([0-9a-f]{2})/gi, '%$1');
  target = repairMinecraftDownloadUrl(target);
  return before + target;
}

function rememberDocumentOrigin(data) {
  if (!data?.headers || !data.url || !data.clientRequest) return;
  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return;
  const contentType = String(
    data.headers['content-type'] || data.contentType || ''
  ).toLowerCase();
  if (!contentType.includes('text/html')) return;
  const destination = String(
    data.clientRequest.headers['sec-fetch-dest'] || ''
  ).toLowerCase();
  if (destination && destination !== 'document' && destination !== 'iframe') return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!isHttpOrigin(target)) return;
  const encodedOrigin = Buffer.from(target.origin, 'utf8').toString('base64url');
  const secure = isSecureClientRequest(data.clientRequest) ? '; Secure' : '';
  const cookie = `${CONTEXT_COOKIE}=${encodedOrigin}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax${secure}`;
  appendSetCookie(data.headers, cookie);
}

function cleanProxyRequest(data) {
  if (!data?.headers) return;
  delete data.headers['proxy-connection'];
}

function routeAbemaRequestThroughWorker(data) {
  if (!data?.url || !data?.headers) return;

  const pageOrigin = data.headers['x-skyrox-page-origin'];
  delete data.headers['x-skyrox-page-origin'];

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (target.protocol !== 'https:' || !isAbemaRequest(data, target, pageOrigin)) return;
  normalizeAbemaHostname(target);

  const workerUrl = new URL(ABEMA_WORKER_URL);
  workerUrl.searchParams.set('url', target.href);
  data.abemaOriginalUrl = target.href;
  data.url = workerUrl.href;
  data.headers.host = workerUrl.host;
  const abemaPageOrigin = getAbemaPageOrigin(data, target, pageOrigin);
  if (data.headers.origin && abemaPageOrigin) data.headers.origin = abemaPageOrigin;
  if (typeof data.headers.referer === 'string') {
    try {
      const referer = new URL(data.headers.referer);
      normalizeAbemaHostname(referer);
      data.headers.referer = referer.href;
    } catch {}
  }

  if (data.uri) {
    Object.assign(data.uri, legacyUrl.parse(workerUrl.href));
  }
}

function normalizeAbemaHostname(url) {
  if (url.hostname.toLowerCase() === 'www.abema.tv') {
    url.hostname = 'abema.tv';
  }
}

function getAbemaPageOrigin(data, target, pageOrigin) {
  if (isAbemaHost(target.hostname)) {
    normalizeAbemaHostname(target);
    return target.origin;
  }

  if (typeof pageOrigin === 'string' && pageOrigin) {
    try {
      const parsed = new URL(pageOrigin);
      if (parsed.protocol !== 'https:' || !isAbemaHost(parsed.hostname)) return null;
      normalizeAbemaHostname(parsed);
      return parsed.origin;
    } catch {
      return null;
    }
  }

  for (const value of [data.headers.referer, data.headers.origin]) {
    if (typeof value !== 'string' || !value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && isAbemaHost(parsed.hostname)) {
        normalizeAbemaHostname(parsed);
        return parsed.origin;
      }
    } catch {}
  }
  return null;
}

function isAbemaRequest(data, target, pageOrigin) {
  return Boolean(getAbemaPageOrigin(data, target, pageOrigin));
}

function isAbemaHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'abema.tv' || host.endsWith('.abema.tv');
}

function restoreAbemaWorkerResponseUrl(data) {
  if (!data?.abemaOriginalUrl) return;

  let responseUrl = data.abemaOriginalUrl;
  const finalUrl = data.headers?.['x-proxy-final-url'];
  if (typeof finalUrl === 'string') {
    try {
      const parsed = new URL(finalUrl);
      if (parsed.protocol === 'https:') responseUrl = parsed.href;
    } catch {}
  }

  data.url = responseUrl;
  if (data.uri) Object.assign(data.uri, legacyUrl.parse(responseUrl));
}

function findHtmlHeadEnd(source) {
  let position = 0;
  while (position < source.length) {
    const tagStart = source.indexOf('<', position);
    if (tagStart === -1) return -1;

    if (source.startsWith('<!--', tagStart)) {
      const commentEnd = source.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) return -1;
      position = commentEnd + 3;
      continue;
    }

    const openingTag = source.slice(tagStart).match(/^<(head|script|style|textarea|title)\b/i);
    if (!openingTag) {
      position = tagStart + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(source, tagStart + openingTag[0].length);
    if (tagEnd === -1) return -1;
    if (openingTag[1].toLowerCase() === 'head') return tagEnd + 1;

    const closingTag = new RegExp(`<\\/\\s*${openingTag[1]}\\s*>`, 'ig');
    closingTag.lastIndex = tagEnd + 1;
    const closingMatch = closingTag.exec(source);
    if (!closingMatch) return -1;
    position = closingTag.lastIndex;
  }

  return -1;
}

function findHtmlTagEnd(source, position) {
  let quote = '';
  for (let index = position; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function injectUnblockerClientSafely(data) {
  const contentType = String(data?.contentType || data?.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/html') || !data.stream) return;

  const injection = `\n<script src="${PROXY_PREFIX}client/unblocker-client.js"></script>\n` +
    `<script>unblockerInit(${JSON.stringify({ prefix: PROXY_PREFIX, url: data.url })}, window);</script>\n`;
  let pending = '';
  let injected = false;

  data.stream = data.stream.pipe(new Transform({
    decodeStrings: false,
    transform(chunk, encoding, callback) {
      if (injected) {
        this.push(chunk.toString());
        callback();
        return;
      }

      pending += chunk.toString();
      const headEnd = findHtmlHeadEnd(pending);
      if (headEnd !== -1) {
        this.push(pending.slice(0, headEnd) + injection + pending.slice(headEnd));
        pending = '';
        injected = true;
      } else if (pending.length > 1024 * 1024) {
        this.push(pending);
        pending = '';
        injected = true;
      }
      callback();
    },
    flush(callback) {
      if (pending) this.push(pending);
      callback();
    }
  }));
}

function applyGarticPhoneBrowserHeaders(data) {
  if (!data?.headers || !data.url) return;

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }

  if (!isGarticPhoneHost(target.hostname)) return;

  const headers = data.headers;
  headers['user-agent'] ||= GARTIC_BROWSER_USER_AGENT;
  headers.accept ||= data.isWebsocket
    ? '*/*'
    : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  headers['accept-language'] ||= 'ja,en-US;q=0.9,en;q=0.8';
  headers['sec-ch-ua'] ||= '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"';
  headers['sec-ch-ua-mobile'] ||= '?0';
  headers['sec-ch-ua-platform'] ||= '"Windows"';

  let pageUrl;
  try {
    pageUrl = new URL(headers.referer);
  } catch {}

  if (pageUrl && isGarticPhoneHost(pageUrl.hostname)) {
    const isSameOrigin = pageUrl.origin === target.origin;
    headers['sec-fetch-site'] = isSameOrigin ? 'same-origin' : 'same-site';
    if (headers.origin) headers.origin = pageUrl.origin;
  } else if (!headers['sec-fetch-site']) {
    headers['sec-fetch-site'] = data.isWebsocket ? 'same-origin' : 'none';
  }

  if (data.isWebsocket) {
    headers['sec-fetch-mode'] = 'websocket';
    headers['sec-fetch-dest'] = 'empty';
  }
}

function isGarticPhoneHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === GARTIC_PHONE_HOST || host.endsWith(`.${GARTIC_PHONE_HOST}`);
}

function logTypingerRequest(data) {
  if (!data?.url || !data?.clientRequest) return;

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }

  const hostname = target.hostname.toLowerCase();
  if (hostname !== 'typingerz.com' && hostname !== 'www.typingerz.com') return;

  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  const interesting =
    method !== 'GET' ||
    /\/(?:api|ajax|battle|matching|room|socket|ws)/i.test(target.pathname);

  if (!interesting) return;

  console.info(JSON.stringify({
    type: 'typinger-request',
    method,
    url: target.href,
    origin: data.headers?.origin || null,
    referer: data.headers?.referer || null,
    hasCookie: Boolean(data.headers?.cookie)
  }));
}
// Keep Poki authentication requests consistent with the upstream web origin.
// This does not bypass authentication. A 401 from /sessions/whoami remains the
// correct response when the browser has no valid Poki session cookie.
function applyPokiRequestContext(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return;

  data.headers.origin = POKI_WEB_ORIGIN;
  data.headers.referer = `${POKI_WEB_ORIGIN}/`;
  data.headers.host = target.host;

  // These browser-facing values describe the proxy origin and can cause an
  // upstream origin check to fail. Let Node generate the actual connection
  // headers while retaining Cookie and Authorization when present.
  delete data.headers['proxy-connection'];
  delete data.headers['sec-fetch-site'];
  delete data.headers['sec-fetch-mode'];
  delete data.headers['sec-fetch-dest'];
}

// Poki auth responses must never be cached. cookieRewrite:true below remains
// responsible for mapping upstream Set-Cookie headers onto the proxy origin.
function normalizePokiAuthResponse(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return;

  data.headers['cache-control'] = 'private, no-store, max-age=0';
  data.headers.pragma = 'no-cache';
  delete data.headers.expires;

  // Keep redirects from the authentication service inside the proxy.
  if (data.headers.location != null) {
    const rewrite = (value) => {
      if (typeof value !== 'string') return value;
      try {
        const redirected = new URL(value, target);
        return `${PROXY_PREFIX}${redirected.href}`;
      } catch {
        return value;
      }
    };
    data.headers.location = Array.isArray(data.headers.location)
      ? data.headers.location.map(rewrite)
      : rewrite(data.headers.location);
  }

  const status = Number(data.remoteResponse?.statusCode || 0);
  if (status === 401 && target.pathname === '/sessions/whoami') {
    console.info(JSON.stringify({
      type: 'poki-auth-session-missing',
      status,
      path: target.pathname,
      note: 'Expected when no valid Poki session cookie is available'
    }));
  }
}

// Remove unsupported ad-related directives that cause browser warnings and
// can block APIs used by embedded game pages.
function sanitizePermissionsPolicy(data) {
  if (!data?.headers || data.headers['permissions-policy'] == null) return;
  const values = Array.isArray(data.headers['permissions-policy'])
    ? data.headers['permissions-policy']
    : [data.headers['permissions-policy']];
  const cleaned = values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !/^(?:attribution-reporting|private-aggregation|join-ad-interest-group|run-ad-auction)\s*=/i.test(value));
  if (cleaned.length) data.headers['permissions-policy'] = cleaned.join(', ');
  else delete data.headers['permissions-policy'];
}

function applyYouTubeTvUserAgent(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  const hostname = target.hostname.toLowerCase();
  const isYouTubeHost = hostname === 'youtube.com' || hostname === 'www.youtube.com';
  if (!isYouTubeHost) return;
  const referer = String(data.headers.referer || '');
  const isTvRequest = target.pathname === '/tv' || target.pathname.startsWith('/tv/');
  const isTvSubrequest = /^https?:\/\/(?:www\.)?youtube\.com\/tv(?:[/?#]|$)/i.test(referer);
  if (!isTvRequest && !isTvSubrequest) return;
  data.headers['user-agent'] = YOUTUBE_TV_USER_AGENT;
  data.headers.origin = 'https://www.youtube.com';
  if (data.headers.referer) data.headers.referer = 'https://www.youtube.com/tv';
}

function addConservativeAssetCache(data) {
  if (!data?.headers || !data.clientRequest || !data.remoteResponse) return;
  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  if ((method !== 'GET' && method !== 'HEAD') || data.remoteResponse.statusCode !== 200) return;
  if (
    data.headers['cache-control'] ||
    data.headers['set-cookie'] ||
    data.clientRequest.headers.authorization
  ) return;
  const contentType = String(data.headers['content-type'] || '').toLowerCase();
  const staticAsset =
    contentType.startsWith('image/') ||
    contentType.startsWith('font/') ||
    contentType.startsWith('audio/') ||
    contentType.includes('text/css') ||
    contentType.includes('javascript') ||
    contentType.includes('application/wasm');
  if (staticAsset) {
    data.headers['cache-control'] =
      `private, max-age=${ASSET_CACHE_SECONDS}, stale-while-revalidate=60`;
  }
}

function preserveDownloadResponse(data) {
  if (!data?.headers || !data.url || !data.remoteResponse) return;
  const status = Number(data.remoteResponse.statusCode || 0);
  if (status < 200 || status >= 300) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  const pathname = target.pathname;
  const extension = pathname.includes('.')
    ? pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
    : '';
  const contentType = String(data.headers['content-type'] || '').toLowerCase();
  const contentDisposition = String(data.headers['content-disposition'] || '').toLowerCase();
  const downloadExtensions = new Set([
    '.mcworld', '.mcpack', '.zip', '.rar', '.7z', '.tar', '.gz',
    '.pdf', '.apk', '.exe', '.msi', '.dmg', '.iso'
  ]);
  const isDownload =
    contentDisposition.includes('attachment') ||
    downloadExtensions.has(extension) ||
    contentType.includes('application/zip') ||
    contentType.includes('application/octet-stream') ||
    contentType.includes('application/x-rar-compressed') ||
    contentType.includes('application/vnd.rar');
  if (!isDownload) return;
  if (!data.headers['content-disposition']) {
    const rawName = decodePathFilename(pathname) || `download${extension}`;
    const asciiName = rawName
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .slice(0, 180) || `download${extension}`;
    const encodedName = encodeURIComponent(rawName).replace(/['()]/g, escapeChar);
    data.headers['content-disposition'] =
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
  }
  data.headers['cache-control'] ||= 'private, no-transform';
}

function escapeChar(character) {
  return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
}

function decodePathFilename(pathname) {
  const last = pathname.split('/').filter(Boolean).pop();
  if (!last) return '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// Fallback for hosting environments where /dl/ reaches Express. Cloud Shell may
// reserve /dl/, so the browser-side patch below remains the primary fix there.
app.use((req, res, next) => {
  if (req.path !== '/dl' && req.path !== '/dl/') return next();
  const refererOrigin = getOriginFromProxyReferer(req);
  if (refererOrigin !== 'https://minecraft-mcworld.com' &&
      refererOrigin !== 'https://www.minecraft-mcworld.com') return next();
  let target;
  try {
    target = new URL(req.originalUrl, `${refererOrigin}/`);
  } catch {
    return next();
  }
  req.url = `${PROXY_PREFIX}${target.href}`;
  console.log(JSON.stringify({
    type: 'minecraft-download-navigation',
    originalUrl: req.originalUrl,
    target: target.href
  }));
  next();
});

app.use((req, res, next) => {
  if (req.originalUrl.startsWith(PROXY_PREFIX)) return next();
  if (req.path === '/') return next();
  if (isLocalRoute(req.path)) return next();
  const proxyRefererOrigin = getOriginFromProxyReferer(req);
  const contextCookieOrigin = getOriginFromContextCookie(req);
  // If a Referer exists but cannot be parsed as a proxied page, do not reuse a
  // stale origin cookie from another site.
  const upstreamOrigin = req.get('referer')
    ? proxyRefererOrigin
    : contextCookieOrigin;
  // Relative URLs emitted by the upstream page arrive at this Express app as
  // /textures/..., /cdn-cgi/..., etc. Proxy both navigations and subresources;
  // limiting this to navigations was the reason thumbnails returned local 404s.
  if (!upstreamOrigin) return next();
  let target;
  try {
    target = new URL(req.originalUrl, `${upstreamOrigin}/`);
  } catch {
    return next();
  }
  if (!isHttpOrigin(target)) return next();
  req.url = `${PROXY_PREFIX}${target.href}`;
  next();
});

const relayDependencies = {
  https,
  httpsAgent,
  PROXY_PREFIX,
  POKI_AUTH_HOSTS,
  POKI_WEB_ORIGIN,
  YOUTUBE_TV_USER_AGENT,
  sanitizeLocationValue,
  setRelayCors,
  applyRelayCors,
  stripHopByHopHeaders,
  parseCookies,
  appendVary
};

registerBloxdRelay(app, relayDependencies);

function setRelayCors(req, res) {
  const origin = req.get('origin');
  if (origin) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'content-type,authorization');
  res.set('Access-Control-Max-Age', '600');
  res.set('Vary', 'Origin, Access-Control-Request-Headers');
}

function applyRelayCors(req, headers) {
  const origin = req.get('origin');
  if (!origin) return;
  headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-credentials'] = 'true';
  headers.vary = appendVary(headers.vary, 'Origin');
}

function stripHopByHopHeaders(headers) {
  for (const name of [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
  ]) delete headers[name];
}

function appendVary(current, value) {
  const values = String(current || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(', ');
}

registerPokiRelay(app, relayDependencies);

registerYoutubeRelay(app, relayDependencies);

registerMcpedlRelay(app, relayDependencies);

const unblockerConfig = {
  prefix: PROXY_PREFIX,
  cookieRewrite: true,
  redirectFollow: true,
  clientScripts: false,
  httpAgent,
  httpsAgent,
  requestMiddleware: [
    cleanProxyRequest,
    logTypingerRequest,
    applyPokiRequestContext,
    applyYouTubeTvUserAgent,
    applyGarticPhoneBrowserHeaders,
    routeAbemaRequestThroughWorker
  ],
  responseMiddleware: [
    repairMalformedProxyLocation,
    keepPokiRedirectOnCleanRoute,
    normalizePokiAuthResponse,
    sanitizePermissionsPolicy,
    repairMinecraftDownloadRedirect,
    keepYouTubeTvRedirectInsideProxy,
    sanitizeProxyResponseHeaders,
    rememberDocumentOrigin,
    preserveDownloadResponse,
    addConservativeAssetCache,
    injectUnblockerClientSafely
  ]
};
const unblocker = new Unblocker(unblockerConfig);
unblockerConfig.responseMiddleware.unshift(restoreAbemaWorkerResponseUrl);

// Prefer the package's local browser helper. If its layout differs, fall back
// to Unblocker's own route instead of returning a false 404.
const unblockerClientPath = findUnblockerClientScript();
let unblockerClientSource = null;
if (unblockerClientPath) {
  try {
    unblockerClientSource = patchUnblockerClientForUrlObjects(
      fs.readFileSync(unblockerClientPath, 'utf8')
    );
  } catch (error) {
    console.error('Unable to load unblocker client script:', error.message);
  }
}

// YouTube TV uses Trusted Types and may assign TrustedScriptURL objects to
// script.src. Older unblocker clients assume src is always a string and crash
// in fixUrl() when they call urlStr.substr(...). Coerce the value at the start
// of fixUrl so both strings and URL-like Trusted Types values are supported.
function patchUnblockerClientForUrlObjects(source) {
  let patched = String(source || '');

  // Unblocker compares location.protocol with "https" instead of "https:".
  // On HTTPS deployments this incorrectly creates insecure ws:// proxy URLs.
  patched = patched.replace(
    /location\.protocol\s*===\s*["']https["']/g,
    'location.protocol === "https:"'
  );

  // note uses Next.js/webpack and can pass URL, TrustedScriptURL, TrustedURL,
  // or other string-like values to script/link setters. Older unblocker builds
  // call string-only methods directly, which aborts hydration on note.
  const declarations = [
    /(function\s+fixUrl\s*\(\s*urlStr\b[^)]*\)\s*\{)/,
    /(fixUrl\s*=\s*function\s*\(\s*urlStr\b[^)]*\)\s*\{)/,
    /((?:const|let|var)\s+fixUrl\s*=\s*\(\s*urlStr\b[^)]*\)\s*=>\s*\{)/
  ];

  for (const declaration of declarations) {
    if (declaration.test(patched)) {
      patched = patched.replace(declaration, '$1\n    urlStr = String(urlStr);');
      break;
    }
  }

  // Cover minified/transformed variants and other string-only operations.
  patched = patched
    .replace(/urlStr\.substr\(/g, 'String(urlStr).substr(')
    .replace(/urlStr\.substring\(/g, 'String(urlStr).substring(')
    .replace(/urlStr\.startsWith\(/g, 'String(urlStr).startsWith(')
    .replace(/urlStr\.indexOf\(/g, 'String(urlStr).indexOf(');

  return patched;
}

function sendPatchedUnblockerClient(req, res, next) {
  if (!unblockerClientSource) return next();
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(`${unblockerClientSource}\n${TYPINGERZ_FORCE_PROXY_PATCH}\n${TYPINGERZ_NETWORK_PATCH}\n${BLOXD_RELATIVE_RESOURCE_PATCH}\n${GLOBAL_PROXIED_NAVIGATION_PATCH}\n${MINECRAFT_DOWNLOAD_NAVIGATION_PATCH}\n${YOUTUBE_TV_WATERMARK_PATCH}\n${MCPEDL_CLIENT_RECOVERY}\n${POKI_CLEAN_NAVIGATION_PATCH}`);
}

// Different unblocker releases emit either path. Register both before
// app.use(unblocker), so note always receives the patched browser helper.
app.get(`${PROXY_PREFIX}client/unblocker-client.js`, sendPatchedUnblockerClient);
app.get(`${PROXY_PREFIX}unblocker-client.js`, sendPatchedUnblockerClient);

// Keep top-level link navigation inside the proxy. Unblocker's URL wrappers
// cover many DOM assignments, but sites such as DuckDuckGo can install a
// direct absolute result URL after rendering. Capture navigation gestures and
// normalize those links before the browser leaves this origin.

// Typinger Z emits some image URLs through inline styles and late JavaScript.
// Those assignments can bypass ordinary anchor/src rewriting, so synchronously
// normalize every typingerz.com URL before the browser starts the request.

// Cloud Shell reserves the top-level /dl/ path. Crafters Colony's original
// download_bt_func navigates there, so intercept the gesture before the site's
// inline onclick handler and navigate directly to the proxied upstream /dl/.

// YouTube TV inserts <yt-debug-watermark> when the current host is not an
// approved debug-access domain. This UI-only patch removes that warning node
// and watches for later re-insertion by client-side rendering.

// MCPEDL marks the home-page Nuxt fetch as client-only. When its cached SSR
// response contains frontpageV2=null, hydration can leave all shelves empty.
// Retry the site's own Vuex action after Nuxt is ready. The existing XHR/fetch
// wrappers proxy the api.mcpedl.com request through this server.

function findUnblockerClientScript() {
  let entry;
  try { entry = require.resolve('unblocker'); } catch { return null; }
  let root = path.dirname(entry);
  for (let i = 0; i < 8 && path.dirname(root) !== root; i += 1) {
    if (fs.existsSync(path.join(root, 'package.json'))) break;
    root = path.dirname(root);
  }
  return findNamedFile(root, 'unblocker-client.js', 5);
}

function findNamedFile(directory, filename, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) if (entry.isFile() && entry.name === filename) return path.join(directory, filename);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const found = findNamedFile(path.join(directory, entry.name), filename, depth - 1);
    if (found) return found;
  }
  return null;
}

app.get(['/healthz', '/__proxy-local/healthz'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).send('ok');
});

app.use(unblocker);

app.get('/', (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (error) => {
    if (error) next(error);
  });
});

app.use((req, res) => {
  res.status(404).send('Not found');
});

const server = app.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
});

server.keepAliveTimeout = 30_000;
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.setTimeout(120_000);
server.maxRequestsPerSocket = 1_000;

const handleUpgrade = unblocker.onUpgrade.bind(unblocker);
server.on('upgrade', (req, socket, head) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  socket.setTimeout(0);

  try {
    req.url = repairProxyPath(req.url);

    if (!req.url.startsWith(PROXY_PREFIX)) {
      const refererOrigin = getOriginFromProxyReferer(req);
      const cookieOrigin = getOriginFromContextCookie(req);
      const upstreamOrigin = req.headers.referer ? refererOrigin : cookieOrigin;

      if (upstreamOrigin) {
        const target = new URL(req.url, `${upstreamOrigin}/`);
        if (isHttpOrigin(target)) {
          const originalUrl = req.url;
          req.url = `${PROXY_PREFIX}${target.href}`;
          console.info(JSON.stringify({
            type: 'websocket-relative-url-rewritten',
            originalUrl,
            target: target.href,
            proxyUrl: req.url
          }));
        }
      }
    }

    handleUpgrade(req, socket, head);
  } catch (error) {
    console.error(JSON.stringify({
      type: 'websocket-upgrade-error',
      message: error.message,
      url: req.url
    }));

    if (!socket.destroyed) {
      socket.write(
        'HTTP/1.1 502 Bad Gateway\r\n' +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        '\r\n' +
        'WebSocket proxy error'
      );
      socket.destroy();
    }
  }
});

function getOriginFromProxyReferer(req) {
  const referer = req.get('referer');
  const requestHost = req.get('host');
  if (!referer || !requestHost) return null;
  let refererUrl;
  try {
    refererUrl = new URL(referer);
  } catch {
    return null;
  }
  if (refererUrl.host !== requestHost || !refererUrl.pathname.startsWith(PROXY_PREFIX)) {
    return null;
  }
  const proxiedTargetText =
    refererUrl.pathname.slice(PROXY_PREFIX.length) + refererUrl.search;
  try {
    const proxiedTarget = new URL(proxiedTargetText);
    return isHttpOrigin(proxiedTarget) ? proxiedTarget.origin : null;
  } catch {
    return null;
  }
}

function getOriginFromContextCookie(req) {
  const encoded = parseCookies(req.headers.cookie)[CONTEXT_COOKIE];
  if (!encoded || encoded.length > 2048) return null;
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  try {
    const origin = new URL(decoded);
    return isHttpOrigin(origin) && origin.href === `${origin.origin}/`
      ? origin.origin
      : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

function appendSetCookie(headers, cookie) {
  const current = headers['set-cookie'];
  if (!current) headers['set-cookie'] = [cookie];
  else if (Array.isArray(current)) headers['set-cookie'] = current.concat(cookie);
  else headers['set-cookie'] = [current, cookie];
}

function isSecureClientRequest(request) {
  const forwarded = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded === 'https' || Boolean(request.socket?.encrypted);
}

function isHttpOrigin(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isLocalRoute(pathname) {
  return pathname === '/' ||
    pathname === '/healthz' ||
    pathname === '/__proxy-local/healthz';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  server.close(() => {
    httpAgent.destroy();
    httpsAgent.destroy();
    process.exit(0);
  });
  setTimeout(() => {
    httpAgent.destroy();
    httpsAgent.destroy();
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
