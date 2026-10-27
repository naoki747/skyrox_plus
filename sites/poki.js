'use strict';

const POKI_CLEAN_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  function cleanPokiUrl(value) {
    if (!value) return null;
    var raw = String(value);
    if (raw.indexOf(PREFIX) === 0) raw = raw.slice(PREFIX.length);
    try {
      var url = new URL(raw, 'https://poki.com');
      var host = String(url.hostname || '').toLowerCase();
      if ((host === 'poki.com' || host === 'www.poki.com') &&
          (url.pathname === '/jp' || url.pathname.indexOf('/jp/') === 0)) {
        return url.pathname + url.search + url.hash;
      }
    } catch (error) {}
    return null;
  }
  function rewrite(root) {
    if (!root) return;
    var nodes = [];
    if (root.nodeType === 1 && root.matches && root.matches('a[href]')) nodes.push(root);
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('a[href]')));
    for (var i = 0; i < nodes.length; i += 1) {
      var clean = cleanPokiUrl(nodes[i].getAttribute('href'));
      if (clean) nodes[i].setAttribute('href', clean);
    }
  }
  function start() {
    rewrite(document.documentElement);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === 'attributes') rewrite(records[i].target);
        for (var j = 0; j < records[i].addedNodes.length; j += 1) rewrite(records[i].addedNodes[j]);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
  }
  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href], [data-tile-url]') : null;
    if (!anchor) return;
    var clean = cleanPokiUrl(anchor.getAttribute('href') || anchor.getAttribute('data-tile-url'));
    if (!clean) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.location.assign(clean);
  }, true);
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

module.exports = { POKI_CLEAN_NAVIGATION_PATCH };
