'use strict';

const BLOXD_RELATIVE_RESOURCE_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  function upstream() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try { return new URL(raw); } catch (error) { return null; }
  }
  function fix(value) {
    if (typeof value !== 'string' || value.charAt(0) !== '/' || value.indexOf('//') === 0 || value.indexOf(PREFIX) === 0) return value;
    var base = upstream();
    if (!base) return value;
    try { return PREFIX + new URL(value, base.origin).href; } catch (error) { return value; }
  }
  function rewrite(root) {
    if (!root || root.nodeType !== 1) return;
    var nodes = [root];
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('[src],[href],[poster]')));
    for (var i = 0; i < nodes.length; i += 1) {
      for (var j = 0; j < 3; j += 1) {
        var attr = ['src', 'href', 'poster'][j];
        if (!nodes[i].hasAttribute || !nodes[i].hasAttribute(attr)) continue;
        var before = nodes[i].getAttribute(attr);
        var after = fix(before);
        if (after !== before) nodes[i].setAttribute(attr, after);
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
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster'] });
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

module.exports = { BLOXD_RELATIVE_RESOURCE_PATCH };
