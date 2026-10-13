/* ReinAgent 站点脚本：主题切换、移动端导航、代码复制、最新版本号（失败则用静态回退值）
   基于 Hetu 官方站脚本（Apache-2.0）改造，署名见 docs/ATTRIBUTION.md */
(function () {
  'use strict';

  var root = document.documentElement;
  var THEME_KEY = 'reinagent-site-theme';

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function applyTheme(theme) {
    if (theme) {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme');
    }
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      var dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      btn.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
      btn.setAttribute('title', dark ? '切换到浅色主题' : '切换到深色主题');
    }
  }

  applyTheme(storedTheme());

  document.addEventListener('click', function (event) {
    var themeBtn = event.target.closest('[data-theme-toggle]');
    if (themeBtn) {
      var dark = root.getAttribute('data-theme')
        ? root.getAttribute('data-theme') === 'dark'
        : window.matchMedia('(prefers-color-scheme: dark)').matches;
      var next = dark ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
      applyTheme(next);
      return;
    }

    var navBtn = event.target.closest('[data-nav-toggle]');
    if (navBtn) {
      var nav = document.querySelector('.site-nav');
      if (nav) {
        var open = nav.getAttribute('data-open') === 'true';
        nav.setAttribute('data-open', open ? 'false' : 'true');
        navBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
      }
      return;
    }

    var copyBtn = event.target.closest('.code .copy');
    if (copyBtn) {
      var block = copyBtn.closest('.code');
      var code = block && block.querySelector('code');
      if (!code) return;
      var text = code.innerText;
      var done = function () {
        copyBtn.setAttribute('data-copied', 'true');
        copyBtn.setAttribute('aria-label', '已复制');
        window.setTimeout(function () {
          copyBtn.removeAttribute('data-copied');
          copyBtn.setAttribute('aria-label', '复制代码');
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
        document.body.removeChild(area);
        done();
      }
        return;
      }

      /* 截图灯箱：缩略图看不清文字时点开看原图 */
      var shot = event.target.closest('.frame img, .gallery img');
      var box = document.querySelector('[data-lightbox]');
      if (!box) return;
      if (shot) {
        var big = box.querySelector('img');
        var caption = box.querySelector('.lightbox-caption');
        big.src = shot.getAttribute('src');
        big.alt = shot.getAttribute('alt') || '';
        if (caption) {
          var fig = shot.closest('figure');
          var cap = fig && fig.querySelector('figcaption');
          caption.textContent = cap ? cap.innerText : (shot.getAttribute('alt') || '');
        }
        box.setAttribute('data-open', 'true');
        box.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        return;
      }

      if (event.target.closest('[data-lightbox-close]') || event.target === box) {
        box.setAttribute('data-open', 'false');
        box.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      var box = document.querySelector('[data-lightbox][data-open="true"]');
      if (!box) return;
      box.setAttribute('data-open', 'false');
      box.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    });

  /* 侧栏当前页高亮（docs 页面在静态 HTML 里已标注，这里兜底处理相对路径差异） */
  var path = window.location.pathname.replace(/index\.html$/, '');
  var links = document.querySelectorAll('.docs-side a[href]');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href');
    if (!href) continue;
    var resolved = new URL(href, window.location.href).pathname.replace(/index\.html$/, '');
    if (resolved === path) links[i].setAttribute('aria-current', 'page');
  }

  /* 最新版本号：从 GitHub Releases 读取，失败就用 HTML 里的静态值 */
  var targets = document.querySelectorAll('[data-latest-version]');
  if (targets.length) {
    var timer = window.setTimeout(function () { /* 网络慢就不更新，保留静态值 */ }, 4000);
    fetch('https://api.github.com/repos/web3claw/ReinAgent/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (release) {
        window.clearTimeout(timer);
        if (!release || !release.tag_name) return;
        var tag = String(release.tag_name);
        for (var j = 0; j < targets.length; j++) targets[j].textContent = tag;
      })
      .catch(function () { window.clearTimeout(timer); });
  }

  /* 访问计数：匿名，无 Cookie；访客数用 localStorage 去重，浏览量按页面加载计。
     统计服务不可用时整块保持隐藏，页脚不会出现空白或 0。 */
  var counter = document.querySelector('[data-visit-counter]');
  if (counter) {
    var host = window.location.hostname;
    var offline = !host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
      window.location.protocol === 'file:';
    var api = 'https://abacus.jasoncameron.dev/';
    var scope = 'reinagent-docs/';
    var visitorFlag = 'reinagent.docs.visitor.v1';

    function readCount(key) {
      return fetch(api + 'get/' + scope + key, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { return data && typeof data.value === 'number' ? data.value : null; })
        .catch(function () { return null; });
    }

    function bumpCount(key) {
      return fetch(api + 'hit/' + scope + key, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { return data && typeof data.value === 'number' ? data.value : null; })
        .catch(function () { return null; });
    }

    /* 首次访问才计入访客数；本地预览不写数，避免污染线上统计。 */
    var seenVisitor = false;
    try { seenVisitor = window.localStorage.getItem(visitorFlag) === '1'; } catch (e) {}
    var visitorsJob;
    if (offline || seenVisitor) {
      visitorsJob = readCount('visitors');
    } else {
      visitorsJob = bumpCount('visitors').then(function (value) {
        if (typeof value === 'number') {
          try { window.localStorage.setItem(visitorFlag, '1'); } catch (e) {}
        }
        return value;
      });
    }
    var viewsJob = offline ? readCount('views') : bumpCount('views');

    function show(selector, segment, value) {
      var node = counter.querySelector(selector);
      var box = counter.querySelector('[data-visit-segment="' + segment + '"]');
      if (!node || !box || typeof value !== 'number') return false;
      node.textContent = value.toLocaleString();
      box.removeAttribute('hidden');
      return true;
    }

    Promise.all([visitorsJob, viewsJob]).then(function (values) {
      var showedVisitors = show('[data-visit-visitors]', 'visitors', values[0]);
      var showedViews = show('[data-visit-views]', 'views', values[1]);
      if (showedVisitors && showedViews) counter.querySelector('[data-visit-sep]').removeAttribute('hidden');
    });
  }
})();
