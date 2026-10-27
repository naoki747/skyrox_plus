'use strict';

const TYPINGERZ_FORCE_PROXY_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  var HOST_RE = /^(?:www\.)?typingerz\.com$/i;
  var ABSOLUTE_RE = /https?:\\?\/\\?\/(?:www\.)?typingerz\.com(?=[\\/"'\\s),]|$)/ig;

  function isTypingerPage() {
    var path = String(window.location.pathname || '');
    return path.indexOf(PREFIX + 'https://typingerz.com/') === 0 ||
      path.indexOf(PREFIX + 'https://www.typingerz.com/') === 0 ||
      path.indexOf(PREFIX + 'http://typingerz.com/') === 0 ||
      path.indexOf(PREFIX + 'http://www.typingerz.com/') === 0;
  }

  function proxyUrl(value) {
    if (value == null) return value;
    var raw = String(value);
    if (!raw || raw.indexOf(PREFIX) === 0 || /^(?:data|blob|javascript|mailto|tel):/i.test(raw)) return value;
    try {
      var url = new URL(raw, 'https://typingerz.com/');
      if (HOST_RE.test(url.hostname) && /^https?:$/.test(url.protocol)) return PREFIX + url.href;
    } catch (error) {}
    return value;
  }

  function proxyText(value) {
    if (value == null) return value;
    return String(value).replace(ABSOLUTE_RE, function (match, offset, whole) {
      if (offset >= PREFIX.length && whole.slice(offset - PREFIX.length, offset) === PREFIX) return match;
      return PREFIX + match.replace(/\\\\\//g, '/');
    });
  }

  if (!isTypingerPage()) return;

  var originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var key = String(name).toLowerCase();
    if (key === 'src' || key === 'href' || key === 'poster' || key === 'action' || key === 'formaction') {
      value = proxyUrl(value);
    } else if (key === 'srcset' || key === 'style') {
      value = proxyText(value);
    }
    return originalSetAttribute.call(this, name, value);
  };

  function patchUrlProperty(prototype, property) {
    if (!prototype) return;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(prototype, property); } catch (error) { return; }
    if (!descriptor || typeof descriptor.set !== 'function' || typeof descriptor.get !== 'function') return;
    try {
      Object.defineProperty(prototype, property, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) { return descriptor.set.call(this, proxyUrl(value)); }
      });
    } catch (error) {}
  }

  patchUrlProperty(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
  patchUrlProperty(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  patchUrlProperty(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'src');
  patchUrlProperty(window.HTMLSourceElement && HTMLSourceElement.prototype, 'src');
  patchUrlProperty(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href');
  patchUrlProperty(window.HTMLAnchorElement && HTMLAnchorElement.prototype, 'href');
  patchUrlProperty(window.HTMLFormElement && HTMLFormElement.prototype, 'action');

  if (window.CSSStyleDeclaration && CSSStyleDeclaration.prototype.setProperty) {
    var originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
      return originalSetProperty.call(this, name, proxyText(value), priority);
    };
  }

  function rewrite(root) {
    if (!root) return;
    var nodes = [];
    if (root.nodeType === 1) nodes.push(root);
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('[src],[href],[poster],[srcset],[style],form[action]')));
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var attrs = ['src', 'href', 'poster', 'action', 'formaction'];
      for (var j = 0; j < attrs.length; j += 1) {
        var attr = attrs[j];
        if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
        var before = node.getAttribute(attr);
        var after = proxyUrl(before);
        if (after !== before) originalSetAttribute.call(node, attr, after);
      }
      for (var k = 0; k < 2; k += 1) {
        var textAttr = k ? 'style' : 'srcset';
        if (!node.hasAttribute || !node.hasAttribute(textAttr)) continue;
        var textBefore = node.getAttribute(textAttr);
        var textAfter = proxyText(textBefore);
        if (textAfter !== textBefore) originalSetAttribute.call(node, textAttr, textAfter);
      }
    }
  }

  function start() {
    rewrite(document.documentElement);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === 'attributes') rewrite(records[i].target);
        for (var j = 0; j < records[i].addedNodes.length; j += 1) rewrite(records[i].addedNodes[j]);
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'poster', 'srcset', 'style', 'action', 'formaction']
    });
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

const TYPINGERZ_NETWORK_PATCH = String.raw`;(function () {
  'use strict';

  var PREFIX = '/proxy/';
  var TYPINGER_HOST_RE = /^(?:www\.)?typingerz\.com$/i;

  function getUpstreamPageUrl() {
    var pathname = String(window.location.pathname || '');
    if (pathname.indexOf(PREFIX) !== 0) return null;

    var raw = pathname.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');

    try {
      var url = new URL(raw);
      if (/^https?:$/.test(url.protocol) && TYPINGER_HOST_RE.test(url.hostname)) return url;
    } catch (error) {}
    return null;
  }

  function isAlreadyProxied(value) {
    var raw = String(value || '');
    return raw.indexOf(PREFIX) === 0 || raw.indexOf(window.location.origin + PREFIX) === 0;
  }

  function resolveUpstreamUrl(value) {
    if (value == null) return value;
    var raw = String(value);
    if (!raw || isAlreadyProxied(raw) || /^(?:data|blob|javascript|mailto|tel):/i.test(raw)) return value;

    var upstreamPage = getUpstreamPageUrl();
    if (!upstreamPage) return value;

    try {
      var parsed = new URL(raw, window.location.href);
      var resolved;

      if (parsed.origin === window.location.origin) {
        resolved = new URL(parsed.pathname + parsed.search + parsed.hash, upstreamPage.origin);
      } else {
        resolved = new URL(raw, upstreamPage);
      }

      if (!/^https?:$/.test(resolved.protocol)) return value;
      return PREFIX + resolved.href;
    } catch (error) {
      return value;
    }
  }

  function resolveWebSocketUrl(value) {
    if (value == null) return value;
    var raw = String(value);
    if (!raw) return value;

    if (raw.indexOf('ws://' + window.location.host + PREFIX) === 0 ||
        raw.indexOf('wss://' + window.location.host + PREFIX) === 0) {
      return value;
    }

    var upstreamPage = getUpstreamPageUrl();
    if (!upstreamPage) return value;

    try {
      var parsed;
      if (/^wss?:/i.test(raw)) {
        parsed = new URL(raw);
      } else {
        var websocketBase = upstreamPage.protocol === 'https:'
          ? 'wss://' + upstreamPage.host
          : 'ws://' + upstreamPage.host;
        parsed = new URL(raw, websocketBase);
      }

      if (parsed.host === window.location.host) {
        parsed.host = upstreamPage.host;
        parsed.protocol = upstreamPage.protocol === 'https:' ? 'wss:' : 'ws:';
      }

      var innerProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      var innerUrl = innerProtocol + '//' + parsed.host + parsed.pathname + parsed.search + parsed.hash;
      var proxyProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proxyProtocol + '//' + window.location.host + PREFIX + innerUrl;
    } catch (error) {
      return value;
    }
  }

  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          input = resolveUpstreamUrl(input);
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          var fixedRequestUrl = resolveUpstreamUrl(input.url);
          if (fixedRequestUrl !== input.url) input = new Request(fixedRequestUrl, input);
        }
      } catch (error) {
        console.warn('[proxy] fetch URL rewrite failed:', error);
      }
      return originalFetch.call(this, input, init);
    };
  }

  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var originalXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
      return originalXhrOpen.call(this, method, resolveUpstreamUrl(url), async !== false, user, password);
    };
  }

  if (typeof window.EventSource === 'function') {
    var OriginalEventSource = window.EventSource;
    function ProxyEventSource(url, options) {
      return new OriginalEventSource(resolveUpstreamUrl(url), options);
    }
    ProxyEventSource.prototype = OriginalEventSource.prototype;
    try { Object.setPrototypeOf(ProxyEventSource, OriginalEventSource); } catch (error) {}
    window.EventSource = ProxyEventSource;
  }

  if (window.navigator && typeof navigator.sendBeacon === 'function') {
    var originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return originalSendBeacon(resolveUpstreamUrl(url), data);
    };
  }

  if (typeof window.WebSocket === 'function') {
    var OriginalWebSocket = window.WebSocket;
    function ProxyWebSocket(url, protocols) {
      var fixedUrl = resolveWebSocketUrl(url);
      console.info('[proxy] WebSocket URL:', String(url), '->', String(fixedUrl));
      if (arguments.length >= 2 && protocols !== undefined) return new OriginalWebSocket(fixedUrl, protocols);
      return new OriginalWebSocket(fixedUrl);
    }
    ProxyWebSocket.prototype = OriginalWebSocket.prototype;
    try {
      Object.defineProperties(ProxyWebSocket, {
        CONNECTING: { value: OriginalWebSocket.CONNECTING },
        OPEN: { value: OriginalWebSocket.OPEN },
        CLOSING: { value: OriginalWebSocket.CLOSING },
        CLOSED: { value: OriginalWebSocket.CLOSED }
      });
      Object.setPrototypeOf(ProxyWebSocket, OriginalWebSocket);
    } catch (error) {}
    window.WebSocket = ProxyWebSocket;
  }

  console.info('[proxy] Typinger Z network patch installed');
})();`;

module.exports = { TYPINGERZ_FORCE_PROXY_PATCH, TYPINGERZ_NETWORK_PATCH };
