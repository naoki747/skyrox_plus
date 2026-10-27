'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, POKI_AUTH_HOSTS, POKI_WEB_ORIGIN, setRelayCors, applyRelayCors, stripHopByHopHeaders, parseCookies } = dependencies;

  // Relay Poki authentication directly. Keeping this endpoint out of the generic
  // HTML proxy avoids losing Set-Cookie headers and preserves the upstream request
  // method/body. Authentication is not bypassed: an anonymous whoami still returns 401.
  app.use(PROXY_PREFIX, relayPokiAuthApi);
  function relayPokiAuthApi(req, res, next) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return next();
    let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
    rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
    let target;
    try { target = new URL(rawTarget); } catch { return next(); }
    if (target.protocol !== 'https:' || !POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return next();

    if (req.method === 'OPTIONS') {
      setRelayCors(req, res);
      return res.status(204).end();
    }

    const headers = Object.create(null);
    for (const name of [
      'accept', 'accept-encoding', 'accept-language', 'authorization',
      'content-type', 'content-length', 'user-agent', 'x-csrf-token', 'x-xsrf-token'
    ]) {
      if (req.headers[name] != null) headers[name] = req.headers[name];
    }
    const upstreamCookie = decodePokiAuthCookies(req.headers.cookie);
    if (upstreamCookie) headers.cookie = upstreamCookie;
    headers.host = target.host;
    headers.origin = POKI_WEB_ORIGIN;
    headers.referer = `${POKI_WEB_ORIGIN}/`;

    const upstream = https.request(target, {
      method: req.method,
      headers,
      agent: httpsAgent,
      timeout: 30_000
    }, (remote) => {
      const responseHeaders = { ...remote.headers };
      stripHopByHopHeaders(responseHeaders);
      responseHeaders['cache-control'] = 'private, no-store, max-age=0';
      responseHeaders.pragma = 'no-cache';
      delete responseHeaders.expires;
      applyRelayCors(req, responseHeaders);

      const setCookies = remote.headers['set-cookie'];
      if (setCookies) {
        responseHeaders['set-cookie'] = (Array.isArray(setCookies) ? setCookies : [setCookies])
          .map(encodePokiAuthSetCookie);
      }
      if (responseHeaders.location) {
        try {
          responseHeaders.location = `${PROXY_PREFIX}${new URL(responseHeaders.location, target).href}`;
        } catch {}
      }
      res.writeHead(Number(remote.statusCode || 502), responseHeaders);
      if (req.method === 'HEAD') { remote.resume(); res.end(); }
      else remote.pipe(res);
    });
    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      console.error(JSON.stringify({ type: 'poki-auth-api-error', code: error.code || 'ERROR', path: target.pathname }));
      if (!res.headersSent) res.status(502).send('Bad Gateway');
      else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  const POKI_AUTH_COOKIE_PREFIX = '__poki_auth__';
  function encodePokiAuthSetCookie(cookie) {
    const parts = String(cookie).split(';');
    const first = parts.shift();
    const separator = first.indexOf('=');
    if (separator < 1) return cookie;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1);
    const attributes = parts
      .map((part) => part.trim())
      .filter((part) => !/^domain=/i.test(part) && !/^path=/i.test(part) && !/^samesite=/i.test(part));
    attributes.push('Path=/');
    attributes.push('SameSite=Lax');
    if (!attributes.some((part) => /^secure$/i.test(part))) attributes.push('Secure');
    return `${POKI_AUTH_COOKIE_PREFIX}${encodeURIComponent(name)}=${value}; ${attributes.join('; ')}`;
  }

  function decodePokiAuthCookies(header) {
    const cookies = parseCookies(header);
    const result = [];
    for (const [name, value] of Object.entries(cookies)) {
      if (!name.startsWith(POKI_AUTH_COOKIE_PREFIX)) continue;
      let upstreamName;
      try { upstreamName = decodeURIComponent(name.slice(POKI_AUTH_COOKIE_PREFIX.length)); }
      catch { continue; }
      if (upstreamName) result.push(`${upstreamName}=${value}`);
    }
    return result.join('; ');
  }
};
