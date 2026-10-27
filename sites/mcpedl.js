'use strict';

const MCPEDL_CLIENT_RECOVERY = String.raw`;(function () {
  'use strict';

  if (window.location.pathname.toLowerCase().indexOf('mcpedl.com') === -1) return;

  var tries = 0;
  var maxTries = 80;
  var running = false;
  var completed = false;

  function hasFrontpage(store) {
    var submission = store && store.state && store.state.submission;
    var value = submission && submission.frontpageV2;
    return !!(value && value.shelves);
  }

  function recover() {
    if (completed || running) return;
    tries += 1;

    var nuxt = window.$nuxt;
    var store = nuxt && nuxt.$store;
    if (!store || typeof store.dispatch !== 'function') {
      if (tries < maxTries) window.setTimeout(recover, 250);
      return;
    }

    if (hasFrontpage(store)) {
      completed = true;
      return;
    }

    running = true;
    Promise.resolve(store.dispatch('submission/fetchFrontpageV2'))
      .then(function () {
        running = false;
        if (hasFrontpage(store)) {
          completed = true;
          console.info('[proxy] MCPEDL front page recovered');
          return;
        }
        if (tries < maxTries) window.setTimeout(recover, 750);
      })
      .catch(function (error) {
        running = false;
        console.warn('[proxy] MCPEDL front page retry failed', error);
        if (tries < maxTries) window.setTimeout(recover, 1000);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', recover, { once: true });
  } else {
    recover();
  }
})();`;

module.exports = { MCPEDL_CLIENT_RECOVERY };
