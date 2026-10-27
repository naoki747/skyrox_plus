'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, setRelayCors, applyRelayCors, stripHopByHopHeaders } = dependencies;

  // Relay selected Bloxd backend APIs directly. On Cloud Shell, allowing
  // Unblocker to answer an OPTIONS request with a redirect makes the browser reject
  // the preflight. A direct relay keeps the request on this origin and returns CORS
  // headers without attempting to bypass any upstream authentication or challenge.
  app.use(PROXY_PREFIX, relayBloxdBackendApi);
  function relayBloxdBackendApi(req, res, next) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return next();
    let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
    rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');

    let target;
    try { target = new URL(rawTarget); } catch { return next(); }

    const hostname = target.hostname.toLowerCase();
    const allowedHosts = new Set([
      'firebaseinstallations.googleapis.com',
      'identitytoolkit.googleapis.com',
      'securetoken.googleapis.com',
      'firebaseremoteconfig.googleapis.com'
    ]);
    if (target.protocol !== 'https:' || !allowedHosts.has(hostname)) return next();

    if (req.method === 'OPTIONS') {
      setRelayCors(req, res);
      return res.status(204).end();
    }

    const headers = Object.create(null);
    const blockedRequestHeaders = new Set([
      'host', 'connection', 'proxy-connection', 'keep-alive',
      'transfer-encoding', 'upgrade', 'origin', 'referer'
    ]);
    for (const [name, value] of Object.entries(req.headers)) {
      if (!blockedRequestHeaders.has(name.toLowerCase()) && value != null) headers[name] = value;
    }
    headers.host = target.host;
    headers.origin = 'https://bloxd.io';
    headers.referer = 'https://bloxd.io/';

    const upstream = https.request(target, {
      method: req.method,
      headers,
      agent: httpsAgent,
      timeout: 30_000
    }, (remote) => {
      const responseHeaders = { ...remote.headers };
      stripHopByHopHeaders(responseHeaders);
      applyRelayCors(req, responseHeaders);
      if (responseHeaders.location) {
        try {
          const redirected = new URL(responseHeaders.location, target);
          if (redirected.protocol === 'https:' && allowedHosts.has(redirected.hostname.toLowerCase())) {
            responseHeaders.location = `${PROXY_PREFIX}${redirected.href}`;
          }
        } catch {}
      }
      res.writeHead(Number(remote.statusCode || 502), responseHeaders);
      if (req.method === 'HEAD') {
        remote.resume();
        res.end();
      } else {
        remote.pipe(res);
      }
    });

    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      console.error(JSON.stringify({
        type: 'bloxd-backend-api-error',
        host: hostname,
        code: error.code || 'ERROR',
        path: target.pathname
      }));
      if (!res.headersSent) res.status(502).send('Bad Gateway');
      else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
};
