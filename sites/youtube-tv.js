'use strict';

const YOUTUBE_TV_WATERMARK_PATCH = String.raw`;(function () {
  'use strict';
  // Keep the post-login /tv return URL on the proxy origin. YouTube may use an
  // absolute top-level navigation which cannot be fixed by response headers.
  function proxyYouTubeTvUrl(value) {
    try {
      var url = new URL(String(value), 'https://www.youtube.com');
      if ((url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') &&
          (url.pathname === '/tv' || url.pathname.indexOf('/tv/') === 0)) {
        return '/proxy/' + url.href;
      }
    } catch (error) {}
    return value;
  }
  document.addEventListener('click', function (event) {
    var element = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!element) return;
    var fixed = proxyYouTubeTvUrl(element.getAttribute('href'));
    if (fixed !== element.getAttribute('href')) element.setAttribute('href', fixed);
  }, true);
  function isYouTubeTvPage() {
    var path = String(window.location.pathname || '').toLowerCase();
    return path.indexOf('/proxy/https://www.youtube.com/tv') === 0 ||
      path.indexOf('/proxy/https://youtube.com/tv') === 0;
  }
  if (!isYouTubeTvPage()) return;
  function removeDebugWatermarks(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.matches && root.matches('yt-debug-watermark')) {
      root.remove();
      return;
    }
    if (!root.querySelectorAll) return;
    var nodes = root.querySelectorAll('yt-debug-watermark');
    for (var i = 0; i < nodes.length; i += 1) nodes[i].remove();
  }
  function start() {
    removeDebugWatermarks(document);
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j += 1) removeDebugWatermarks(added[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

module.exports = { YOUTUBE_TV_WATERMARK_PATCH };
