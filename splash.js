/* Launch splash: show the logo motion once per browser session. Kept external because the server CSP blocks inline scripts. */
(function () {
  try {
    if (sessionStorage.getItem('sq-splash')) document.documentElement.classList.add('no-splash');
    else sessionStorage.setItem('sq-splash', '1');
  } catch (e) {}
})();
