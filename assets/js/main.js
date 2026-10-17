(() => {
  'use strict';

  const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- Languages: English is in the HTML, others come from assets/i18n/<code>.json ---------- */

  const LANGS = [['en', 'English'], ['ru', 'Русский'], ['es', 'Español'], ['pt', 'Português (Brasil)'], ['fr', 'Français'],
    ['de', 'Deutsch'], ['it', 'Italiano'], ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'],
    ['tr', 'Türkçe'], ['id', 'Bahasa Indonesia']];
  const AVAILABLE = (document.documentElement.dataset.langs || 'en,ru').split(',');
  const strings = { en: {} };
  let loaderTpl = 'Loading {n}%';

  // remember the English text that is already in the page
  document.querySelectorAll('[data-i18n]').forEach((el) => { strings.en[el.dataset.i18n] = el.innerHTML; });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const [attr, key] = el.dataset.i18nAttr.split(':');
    strings.en[key] = el.getAttribute(attr);
  });

  function detectLang() {
    const q = new URLSearchParams(location.search).get('lang');
    if (q && AVAILABLE.includes(q)) return q;
    try { const s = localStorage.getItem('wa-lang'); if (s && AVAILABLE.includes(s)) return s; } catch (e) { /* private mode */ }
    for (const raw of navigator.languages || [navigator.language || 'en']) {
      const l = String(raw).toLowerCase();
      const code = l.startsWith('zh') ? (/hant|-tw|-hk|-mo/.test(l) ? 'zh-Hant' : 'zh-Hans') : l.split('-')[0] === 'in' ? 'id' : l.split('-')[0];
      if (AVAILABLE.includes(code)) return code;
    }
    return 'en';
  }

  async function setLang(code) {
    if (!strings[code]) {
      try { strings[code] = await (await fetch(`assets/i18n/${code}.json`)).json(); } catch (e) { code = 'en'; }
    }
    const t = Object.assign({}, strings.en, strings[code]);
    document.documentElement.lang = code === 'pt' ? 'pt-BR' : code;
    document.querySelectorAll('[data-i18n]').forEach((el) => { const v = t[el.dataset.i18n]; if (v != null) el.innerHTML = v; });
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      const [attr, key] = el.dataset.i18nAttr.split(':');
      if (t[key] != null) el.setAttribute(attr, t[key]);
    });
    loaderTpl = t.loader || 'Loading {n}%';
    if (typeof updateLoader === 'function') updateLoader();
    const sel = document.querySelector('[data-lang]');
    if (sel) sel.value = code;
    try { localStorage.setItem('wa-lang', code); } catch (e) { /* private mode */ }
  }

  const langSel = document.querySelector('[data-lang]');
  if (langSel) {
    langSel.innerHTML = LANGS.filter(([c]) => AVAILABLE.includes(c)).map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
    langSel.addEventListener('change', () => setLang(langSel.value));
  }
  strings.en.loader = 'Loading {n}%';
  let updateLoader = null;

  /* ---------- Scroll animation over the video frames (kept from the original page) ---------- */

  const section = document.querySelector('[data-journey]');
  const header = document.querySelector('[data-header]');

  if (section) {
    const canvas = section.querySelector('[data-canvas]');
    const ctx = canvas.getContext('2d');
    const hint = section.querySelector('[data-hint]');
    const bar = section.querySelector('[data-progress]');
    const loader = section.querySelector('[data-loader]');

    const FRAME_COUNT = parseInt(section.dataset.frames, 10);
    const PATH = section.dataset.path;
    const VIDEO_END = parseFloat(section.dataset.videoEnd || '1');
    // "scroll:frame" pairs; between them the video is scrubbed linearly (default: whole video by VIDEO_END)
    const VIDEO_MAP = (section.dataset.videoMap || `0:0 ${VIDEO_END}:${FRAME_COUNT - 1}`)
      .trim().split(/\s+/).map((pair) => pair.split(':').map(Number));
    const FADE = parseFloat(section.dataset.fade || '0.035');   // chapter fade in/out, share of the scroll
    const SMOOTHING = 0.14;    // inertia of following the scroll (0..1 at 60 fps)
    const CONCURRENCY = 6;

    const chapters = [...section.querySelectorAll('[data-chapter]')].map((el) => ({
      el,
      start: parseFloat(el.dataset.start),
      end: parseFloat(el.dataset.end),
      opacity: -1,
      y: NaN,
      on: false,
    }));

    // wide — 16:9 for landscape screens, tall — 3:4 crop for portrait
    const sets = { wide: new Array(FRAME_COUNT), tall: new Array(FRAME_COUNT) };
    const loaded = { wide: 0, tall: 0 };
    const started = {};
    const pickSet = () => (window.innerWidth / window.innerHeight < 1 ? 'tall' : 'wide');
    let activeSet = pickSet();

    let target = 0;
    let smooth = 0;
    let lastTime = 0;
    let lastImg = null;
    let dirty = true;
    let ticking = false;

    const frameSrc = (set, i) =>
      PATH.replace('{set}', set).replace('{index}', String(i + 1).padStart(4, '0'));

    // First and last frame first, then every 32nd, 16th … so the animation works at once and gets smoother.
    function loadOrder() {
      const order = [0, FRAME_COUNT - 1];
      const seen = new Set(order);
      for (let step = 32; step >= 1; step /= 2) {
        for (let i = 0; i < FRAME_COUNT; i += step) {
          if (!seen.has(i)) {
            seen.add(i);
            order.push(i);
          }
        }
      }
      return order;
    }

    function load(set) {
      if (started[set]) return;
      started[set] = true;
      const order = loadOrder();
      let next = 0;

      const worker = async () => {
        while (next < order.length) {
          const i = order[next++];
          const img = new Image();
          img.src = frameSrc(set, i);
          try {
            await img.decode();
            sets[set][i] = img;
          } catch (err) {
            // a frame failed to load — the nearest neighbour takes its place
          }
          loaded[set]++;
          updateLoader();
          requestTick();
        }
      };

      for (let k = 0; k < CONCURRENCY; k++) worker();
    }

    updateLoader = function () {
      const share = loaded[activeSet] / FRAME_COUNT;
      loader.textContent = loaderTpl.replace('{n}', Math.round(share * 100));
      loader.classList.toggle('is-done', share >= 1);
    };

    function frameAt(p) {
      if (p <= VIDEO_MAP[0][0]) return VIDEO_MAP[0][1];
      for (let k = 1; k < VIDEO_MAP.length; k++) {
        const [p0, f0] = VIDEO_MAP[k - 1];
        const [p1, f1] = VIDEO_MAP[k];
        if (p <= p1) return f0 + (f1 - f0) * (p - p0) / (p1 - p0);
      }
      return VIDEO_MAP[VIDEO_MAP.length - 1][1];
    }

    function nearest(frames, i) {
      for (let d = 0; d < FRAME_COUNT; d++) {
        if (frames[i - d]) return frames[i - d];
        if (frames[i + d]) return frames[i + d];
      }
      return null;
    }

    function pickFrame(i) {
      const fallback = activeSet === 'wide' ? 'tall' : 'wide';
      return nearest(sets[activeSet], i) || nearest(sets[fallback], i);
    }

    // object-fit: cover for the canvas
    function draw(img) {
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    }

    function updateChapters(p) {
      const shift = reduceMotion.matches ? 0 : 40;
      for (const c of chapters) {
        const fadeIn = c.start <= 0 ? 1 : smoothstep(clamp((p - c.start) / FADE));
        const fadeOut = c.end >= 1 ? 1 : smoothstep(clamp((c.end - p) / FADE));
        const opacity = Math.round(Math.min(fadeIn, fadeOut) * 1000) / 1000;
        const y = Math.round(((1 - fadeIn) - (1 - fadeOut)) * shift * 10) / 10;
        // pieces of a chapter spring out once it shows up, and are reset when it is gone
        if (!c.on && opacity > 0.2) { c.on = true; c.el.classList.add('is-in'); }
        else if (c.on && opacity === 0) { c.on = false; c.el.classList.remove('is-in'); }
        if (opacity === c.opacity && y === c.y) continue;
        c.opacity = opacity;
        c.y = y;
        c.el.style.opacity = opacity;
        c.el.style.transform = y ? `translate3d(0, ${y}px, 0)` : '';
        c.el.style.visibility = opacity > 0 ? 'visible' : 'hidden';
      }
    }

    function tick(now = performance.now()) {
      ticking = false;

      const rect = section.getBoundingClientRect();
      const distance = rect.height - window.innerHeight;
      target = distance > 0 ? clamp(-rect.top / distance) : 0;

      // inertia does not depend on the refresh rate (60/120 Hz)
      const dt = lastTime ? Math.min(now - lastTime, 100) : 16.7;
      lastTime = now;
      const k = reduceMotion.matches ? 1 : 1 - Math.pow(1 - SMOOTHING, dt / 16.7);
      smooth += (target - smooth) * k;
      if (Math.abs(target - smooth) < 0.0002) smooth = target;

      const frame = Math.round(clamp(frameAt(smooth), 0, FRAME_COUNT - 1));
      const img = pickFrame(frame);
      if (img && (img !== lastImg || dirty)) {
        draw(img);
        lastImg = img;
        dirty = false;
      }

      updateChapters(smooth);
      hint.style.opacity = 1 - clamp(smooth / 0.03);
      bar.style.transform = `scaleY(${smooth})`;
      header.classList.toggle('is-solid', rect.bottom <= header.offsetHeight);

      if (smooth !== target) requestTick();
      else lastTime = 0;
    }

    function requestTick() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(tick);
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.imageSmoothingQuality = 'high';
        dirty = true;
      }
      const next = pickSet();
      if (next !== activeSet) {
        activeSet = next;
        dirty = true;
        load(activeSet);
        updateLoader();
      }
      tick(); // draw right away so the cleared canvas does not flash
    }

    // menu links go to a chapter inside the scroll scene
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const id = a.getAttribute('href').slice(1);
      const c = chapters.find((ch) => ch.el.id === id);
      if (!c && id !== 'top') return;
      e.preventDefault();
      const share = !c || c.start <= 0 ? 0 : c.start + FADE * 1.5;
      const top = section.offsetTop + share * (section.offsetHeight - window.innerHeight);
      window.scrollTo({ top, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    });

    window.addEventListener('scroll', requestTick, { passive: true });
    window.addEventListener('resize', resize);
    resize();
    load(activeSet);
  } else if (header) {
    const solid = () => header.classList.toggle('is-solid', window.scrollY > 8);
    window.addEventListener('scroll', solid, { passive: true });
    solid();
  }

  setLang(detectLang());
})();
