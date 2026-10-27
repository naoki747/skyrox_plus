'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, YOUTUBE_TV_USER_AGENT, appendVary } = dependencies;

  // Relay YouTube TV account APIs directly. Unblocker normalizes a target like
  // https://www.youtube.com/... into a 307 Location containing https:/..., which
  // breaks POST-based device OAuth and account discovery in a redirect loop.
  app.use(PROXY_PREFIX, relayYouTubeTvAccountApi);
  function relayYouTubeTvAccountApi(req, res, next) {
    if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) return next();
    let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
    rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
    let target;
    try { target = new URL(rawTarget); } catch { return next(); }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || (host !== 'youtube.com' && host !== 'www.youtube.com')) return next();
    const allowed = target.pathname === '/o/oauth2/token' ||
      target.pathname.startsWith('/youtubei/v1/account/') ||
      target.pathname.startsWith('/api/lounge/');
    if (!allowed) return next();
    if (req.method === 'OPTIONS') {
      setYouTubeTvCors(req, res);
      return res.status(204).end();
    }
    const headers = Object.create(null);
    const forwarded = [
      'accept', 'accept-encoding', 'accept-language', 'authorization',
      'content-type', 'cookie', 'x-goog-request-time', 'x-goog-visitor-id',
      'x-youtube-client-name', 'x-youtube-client-version',
      'x-youtube-lava-device-context', 'x-youtube-page-cl', 'x-youtube-page-label'
    ];
    for (const name of forwarded) if (req.headers[name] != null) headers[name] = req.headers[name];
    headers.host = target.host;
    headers['user-agent'] = YOUTUBE_TV_USER_AGENT;
    headers.origin = 'https://www.youtube.com';
    headers.referer = 'https://www.youtube.com/tv';
    if (req.headers['content-length'] != null) headers['content-length'] = req.headers['content-length'];
    const upstream = https.request(target, {
      method: req.method,
      headers,
      agent: httpsAgent,
      timeout: 30_000
    }, (remote) => {
      const responseHeaders = { ...remote.headers };
      for (const name of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']) {
        delete responseHeaders[name];
      }
      // The browser talks to this proxy origin, so expose the API response there.
      const origin = req.get('origin');
      if (origin) {
        responseHeaders['access-control-allow-origin'] = origin;
        responseHeaders['access-control-allow-credentials'] = 'true';
        responseHeaders.vary = appendVary(responseHeaders.vary, 'Origin');
      }
      if (responseHeaders.location) {
        try {
          const redirected = new URL(responseHeaders.location, target);
          if (redirected.protocol === 'https:' &&
              (redirected.hostname === 'youtube.com' || redirected.hostname === 'www.youtube.com')) {
            responseHeaders.location = `${PROXY_PREFIX}${redirected.href}`;
          }
        } catch {}
      }
      res.writeHead(Number(remote.statusCode || 502), responseHeaders);
      remote.pipe(res);
    });
    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      console.error(JSON.stringify({ type: 'youtube-tv-account-api-error', code: error.code || 'ERROR', path: target.pathname }));
      if (!res.headersSent) res.status(502).send('Bad Gateway');
      else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
  function setYouTubeTvCors(req, res) {
    const origin = req.get('origin');
    if (origin) res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'content-type,authorization');
    res.set('Vary', 'Origin, Access-Control-Request-Headers');
  }
};
