// Pace demo. The grade and the per-day share follow the plugin's own code
// (scripts/pace.js windowStats + dailyQuota) with the default config:
// redAt 90, yellowMargin 10, no 7d floors.
(function () {
  var T = window.TS_TEXT;
  var $ = function (id) { return document.getElementById(id); };
  var el = $('el'), us = $('us');
  var COLOR = { green: 'var(--green)', yellow: 'var(--yellow)', red: 'var(--red)' };

  function grade(u, e) {
    if (u >= 90 || u > e + 10) return 'red';
    if (u > e) return 'yellow';
    return 'green';
  }
  function quota(u, e) {
    var daysLeft = 7 * (1 - e / 100);
    var q = Math.max(0, 100 - u) / Math.max(daysLeft, 1);
    return (Math.round(q * 10) / 10).toString();
  }
  function draw() {
    var e = +el.value, u = +us.value, g = grade(u, e), c = COLOR[g];
    $('elv').textContent = e + '%';
    $('usv').textContent = u + '%';
    $('sl-used').textContent = u + '%';
    $('sl-today').textContent = quota(u, e) + '%';
    document.querySelectorAll('.gdot').forEach(function (d) { d.style.background = c; });
    $('bar').style.width = u + '%';
    $('bar').style.background = c;
    $('tick').style.left = 'calc(' + e + '% - 1px)';
    var v = $('verdict');
    v.style.color = c;
    v.textContent = T.name[g] + '. ' + T.verdict[g](u, e);
    $('acts').innerHTML = T.acts[g].map(function (a) {
      return '<li>' + (a[0] ? '<span class="tag">' + a[0] + '</span>' : '') + '<span>' + a[1] + '</span></li>';
    }).join('');
  }
  el.addEventListener('input', draw);
  us.addEventListener('input', draw);
  draw();

  document.querySelectorAll('.cmd button').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.previousElementSibling.textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () {
        b.textContent = T.copied; setTimeout(function () { b.textContent = T.copy; }, 1400);
      }, function () { b.textContent = T.select; });
    });
  });
})();
