'use strict';

const MINECRAFT_DOWNLOAD_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';

  function upstreamPageUrl() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try {
      var url = new URL(raw);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch (error) {
      return null;
    }
  }

  function isMinecraftPage() {
    var upstream = upstreamPageUrl();
    if (!upstream) return false;
    var host = String(upstream.hostname || '').toLowerCase();
    return host === 'minecraft-mcworld.com' || host === 'www.minecraft-mcworld.com';
  }

  function downloadUrl(postid, type) {
    var target = new URL('https://minecraft-mcworld.com/dl/');
    target.searchParams.set('postid', String(postid));
    target.searchParams.set('type', String(type == null ? 0 : type));
    return PREFIX + target.href;
  }

  function parseInvocation(node) {
    var clickable = node && node.closest
      ? node.closest('[onclick*="download_bt_func"]')
      : null;
    if (!clickable) return null;
    var source = String(clickable.getAttribute('onclick') || '');
    var match = source.match(/download_bt_func\s*\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/);
    return match ? { postid: match[1], type: match[2] } : null;
  }

  // Capture phase runs before the page's inline onclick handler.
  document.addEventListener('click', function (event) {
    if (!isMinecraftPage()) return;
    var invocation = parseInvocation(event.target);
    if (!invocation) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    var destination = downloadUrl(invocation.postid, invocation.type);
    console.info('[proxy] Minecraft download navigation:', destination);
    window.location.assign(destination);
  }, true);

  // Also replace the global function for keyboard/programmatic invocations.
  var attempts = 0;
  function installFunctionPatch() {
    attempts += 1;
    if (!isMinecraftPage()) return;
    var original = window.download_bt_func;
    if (typeof original === 'function' && !original.__proxyDownloadPatched) {
      function patched(postid, type) {
        window.location.assign(downloadUrl(postid, type));
      }
      patched.__proxyDownloadPatched = true;
      patched.__proxyOriginal = original;
      window.download_bt_func = patched;
      return;
    }
    if (attempts < 300) window.setTimeout(installFunctionPatch, 100);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installFunctionPatch, { once: true });
  } else {
    installFunctionPatch();
  }
})();`;

module.exports = { MINECRAFT_DOWNLOAD_NAVIGATION_PATCH };
