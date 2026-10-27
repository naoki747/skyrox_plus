'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, sanitizeLocationValue } = dependencies;

  // MCPEDL loads many Nuxt chunks simultaneously. Relay only its static assets
  // directly and retry one safe GET/HEAD once on transient upstream failures.
  app.use(PROXY_PREFIX, relayMcpedlStaticAsset);

  function relayMcpedlStaticAsset(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let target;
    try {
      target = new URL(req.originalUrl.slice(PROXY_PREFIX.length));
    } catch {
      return next();
    }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || (host !== 'mcpedl.com' && host !== 'www.mcpedl.com')) return next();
    if (!target.pathname.startsWith('/_nuxt/') && !target.pathname.startsWith('/js/') && !target.pathname.startsWith('/web/')) return next();
    if (!/\.(?:js|mjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico)$/i.test(target.pathname)) return next();
    requestMcpedlStatic(target, req, res, Date.now(), 0);
  }

  function requestMcpedlStatic(target, req, res, startedAt, attempt) {
    if (res.headersSent || res.destroyed) return;
    const headers = Object.create(null);
    for (const name of ['accept','accept-encoding','accept-language','cache-control','if-modified-since','if-none-match','range','user-agent']) {
      if (req.headers[name] != null) headers[name] = req.headers[name];
    }
    headers.host = target.host;
    headers.referer = `${target.origin}/`;

    const upstream = https.request(target, { method: req.method, headers, agent: httpsAgent, timeout: 20_000 }, (remote) => {
      const status = Number(remote.statusCode || 502);
      if (attempt === 0 && [502, 503, 504].includes(status)) {
        remote.resume();
        remote.once('end', () => setTimeout(() => requestMcpedlStatic(target, req, res, startedAt, 1), 150));
        return;
      }
      const responseHeaders = { ...remote.headers };
      for (const name of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']) delete responseHeaders[name];
      if (responseHeaders.location != null) responseHeaders.location = sanitizeLocationValue(responseHeaders.location);
      res.writeHead(status, responseHeaders);
      if (req.method === 'HEAD') { remote.resume(); res.end(); } else remote.pipe(res);
      remote.once('end', () => console.log(JSON.stringify({ type:'mcpedl-static', status, attempt, elapsedMs:Date.now()-startedAt, path:target.pathname })));
    });
    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code:'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      if (attempt === 0 && !res.headersSent) {
        console.warn(JSON.stringify({ type:'mcpedl-static-retry', code:error.code || 'ERROR', path:target.pathname }));
        setTimeout(() => requestMcpedlStatic(target, req, res, startedAt, 1), 150);
      } else if (!res.headersSent) {
        console.error(JSON.stringify({ type:'mcpedl-static-error', code:error.code || 'ERROR', message:error.message, path:target.pathname }));
        res.status(502).send('Bad Gateway');
      } else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    upstream.end();
  }
};
