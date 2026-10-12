// Runs in <head> before the page paints, so a saved theme shows with no flash of the default colours.
// theme.js writes the resolved CSS variables to localStorage; this just replays them.
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('knock.theme') || 'null');
    if (!t) return;
    if (t.auto) t = matchMedia('(prefers-color-scheme: dark)').matches ? t.auto.dark : t.auto.light;
    var s = document.documentElement.style;
    for (var k in t.vars) if (k.indexOf('--') === 0) s.setProperty(k, String(t.vars[k]));
    s.setProperty('color-scheme', t.scheme === 'dark' ? 'dark' : 'light');
  } catch (e) { /* storage blocked or bad data: keep the default look */ }
})();
