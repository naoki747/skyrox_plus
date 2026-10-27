'use strict';

const GLOBAL_PROXIED_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';

  function upstreamPageUrl() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '') + String(window.location.hash || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try {
      var url = new URL(raw);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch (error) {
      return null;
    }
  }

  function unwrapDuckDuckGoRedirect(url) {
    var host = String(url.hostname || '').toLowerCase();
    if (host !== 'duckduckgo.com' && host !== 'www.duckduckgo.com' && host !== 'links.duckduckgo.com') return url;
    var encoded = url.searchParams.get('uddg');
    if (!encoded) return url;
    try {
      var destination = new URL(encoded);
      if (/^https?:$/.test(destination.protocol)) return destination;
    } catch (error) {}
    return url;
  }

  function proxiedHref(anchor) {
    if (!anchor || !anchor.getAttribute) return null;
    var raw = anchor.getAttribute('href');
    if (!raw || raw.charAt(0) === '#' || /^(?:javascript|mailto|tel|data|blob):/i.test(raw)) return null;
    if (raw.indexOf(PREFIX) === 0) return null;

    var upstream = upstreamPageUrl();
    if (!upstream) return null;

    var target;
    try {
      target = new URL(raw, upstream);
    } catch (error) {
      return null;
    }
    if (!/^https?:$/.test(target.protocol)) return null;
    if (target.origin === window.location.origin && target.pathname.indexOf(PREFIX) === 0) return null;
    target = unwrapDuckDuckGoRedirect(target);
    return PREFIX + target.href;
  }

  function rewriteAnchor(event) {
    var node = event.target;
    var anchor = node && node.closest ? node.closest('a[href]') : null;
    if (!anchor) return;
    var fixed = proxiedHref(anchor);
    if (fixed) anchor.setAttribute('href', fixed);
  }

  // pointerdown/mousedown makes middle-click, Ctrl/Cmd-click and context-menu
  // "open in new tab" see the rewritten href before the browser navigates.
  document.addEventListener('pointerdown', rewriteAnchor, true);
  document.addEventListener('mousedown', rewriteAnchor, true);
  document.addEventListener('contextmenu', rewriteAnchor, true);
  document.addEventListener('click', rewriteAnchor, true);
  document.addEventListener('auxclick', rewriteAnchor, true);

  function rewriteForm(form) {
    if (!form || !form.getAttribute) return;
    var raw = form.getAttribute('action') || window.location.href;
    var fixed = proxiedHref({ getAttribute: function () { return raw; } });
    if (fixed) form.setAttribute('action', fixed);
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    rewriteForm(form);
  }, true);

  if (window.HTMLFormElement && window.HTMLFormElement.prototype.submit) {
    var originalSubmit = window.HTMLFormElement.prototype.submit;
    window.HTMLFormElement.prototype.submit = function () {
      rewriteForm(this);
      return originalSubmit.call(this);
    };
  }

  if (typeof window.open === 'function') {
    var originalOpen = window.open;
    window.open = function (url, target, features) {
      var fixed = proxiedHref({ getAttribute: function () { return url; } });
      return originalOpen.call(window, fixed || url, target, features);
    };
  }

  if (window.navigation && window.navigation.addEventListener) {
    window.navigation.addEventListener('navigate', function (event) {
      if (!event.canIntercept || !event.destination) return;
      var fixed = proxiedHref({
        getAttribute: function () { return event.destination.url; }
      });
      if (!fixed) return;
      event.intercept({
        handler: function () {
          window.location.assign(fixed);
        }
      });
    });
  }

  if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker.getRegistrations()
      .then(function (registrations) {
        return Promise.all(registrations.map(function (registration) {
          var workers = [registration.active, registration.waiting, registration.installing];
          var isProxyWorker = workers.some(function (worker) {
            if (!worker) return false;
            var workerUrl = new URL(worker.scriptURL);
            return workerUrl.origin === window.location.origin &&
              workerUrl.pathname === '/proxy-service-worker.js';
          });
          return isProxyWorker ? registration.unregister() : Promise.resolve();
        }));
      })
      .then(function () {
        if (!navigator.serviceWorker.controller) return;
        var reloadKey = '__skyrox_proxy_sw_cleanup_reload';
        try {
          if (sessionStorage.getItem(reloadKey)) return;
          sessionStorage.setItem(reloadKey, '1');
          window.location.reload();
        } catch (error) {
          console.warn('[proxy] Could not reload after service worker cleanup:', error);
        }
      })
      .catch(function (error) {
        console.warn('[proxy] Service worker cleanup failed:', error);
      });
  }
})();`;

module.exports = { GLOBAL_PROXIED_NAVIGATION_PATCH };
