// Applies the saved theme and text size before the first paint, so the page
// never flashes in the wrong colors. Loaded as a classic (blocking) script.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('duet:settings') || '{}');
    var d = document.documentElement;
    if (s.theme === 'light' || s.theme === 'dark') d.dataset.theme = s.theme;
    if (s.largeText) d.dataset.text = 'large';
  } catch (e) {}
})();
