// ==UserScript==
// @name         RanobeLib — озвучка главы
// @namespace    helper.ranobelib.tts
// @author       s0x7C5
// @license      MIT
// @version      1.0
// @description  Читает вслух текст главы на ranobelib.me (Web Speech API): подсветка абзаца, выбор голоса, скорость, автопереход к следующей главе.
// @match        https://ranobelib.me/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const synth = window.speechSynthesis;
  const STORE = 'rl-tts-settings';
  const MAX_CHUNK = 220; // Chrome обрывает длинные фразы — режем на куски

  const settings = Object.assign(
    { voice: '', rate: 1.0, pitch: 1.0, autoNext: true },
    load()
  );

  let paragraphs = [];
  let index = 0;
  let playing = false;
  let session = 0; // увеличивается при каждом stop/старте, чтобы гасить старые колбэки

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {}
  }

  // ---------- текст ----------
  function collectParagraphs() {
    const root = document.querySelector('.text-content');
    if (!root) return [];
    const list = [];
    const title = document.querySelector('h1');
    if (title && title.innerText.trim()) list.push(title);
    root.querySelectorAll('p, h2, h3, h4, blockquote').forEach((el) => {
      if (el.closest('blockquote') && el.tagName !== 'BLOCKQUOTE') return;
      if (el.innerText.trim()) list.push(el);
    });
    return list;
  }

  function prepare(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/[*~=_]{3,}/g, '. ')      // разделители сцен
      .replace(/—/g, ' — ')
      .trim();
  }

  function chunk(text) {
    if (text.length <= MAX_CHUNK) return [text];
    const sentences = text.match(/[^.!?…]+[.!?…]*["»”)]*\s*/g) || [text];
    const out = [];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > MAX_CHUNK && buf) { out.push(buf.trim()); buf = ''; }
      if (s.length > MAX_CHUNK) {
        s.split(/(?<=[,;:])\s+/).forEach((part) => {
          if ((buf + part).length > MAX_CHUNK && buf) { out.push(buf.trim()); buf = ''; }
          buf += part + ' ';
        });
      } else {
        buf += s;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  // ---------- голоса ----------
  function voices() {
    return synth.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('ru'));
  }
  function voiceScore(v) {
    const n = v.name.toLowerCase();
    let s = 0;
    if (n.includes('natural')) s += 10;   // Edge: Svetlana/Dmitry Online (Natural)
    if (n.includes('online')) s += 5;
    if (n.includes('google')) s += 3;
    return s;
  }
  function pickVoice() {
    const list = voices();
    return list.find((v) => v.name === settings.voice) ||
      list.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
  }

  // ---------- воспроизведение ----------
  function highlight(i) {
    paragraphs.forEach((p) => p.classList.remove('rl-tts-current'));
    const el = paragraphs[i];
    if (!el) return;
    el.classList.add('rl-tts-current');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function speakFrom(i) {
    const my = ++session;
    synth.cancel();
    paragraphs = collectParagraphs();
    if (!paragraphs.length) { status('Текст главы не найден'); return; }
    index = Math.max(0, Math.min(i, paragraphs.length - 1));
    playing = true;
    updateUI();
    speakParagraph(my);
  }

  function speakParagraph(my) {
    if (my !== session || !playing) return;
    if (index >= paragraphs.length) { finished(); return; }
    highlight(index);
    status(`Абзац ${index + 1} из ${paragraphs.length}`);
    const parts = chunk(prepare(paragraphs[index].innerText));
    const voice = pickVoice();
    let k = 0;
    const next = () => {
      if (my !== session || !playing) return;
      if (k >= parts.length) { index++; setTimeout(() => speakParagraph(my), 250); return; }
      const u = new SpeechSynthesisUtterance(parts[k++]);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : 'ru-RU';
      u.rate = settings.rate;
      u.pitch = settings.pitch;
      u.onend = next;
      u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(); };
      synth.speak(u);
    };
    next();
  }

  function finished() {
    playing = false;
    paragraphs.forEach((p) => p.classList.remove('rl-tts-current'));
    updateUI();
    if (!settings.autoNext) { status('Глава прочитана'); return; }
    const nextLink = [...document.querySelectorAll('a')].find((a) => a.innerText.trim() === 'Вперёд');
    if (!nextLink) { status('Следующая глава не найдена'); return; }
    status('Переход к следующей главе…');
    const oldUrl = location.href;
    nextLink.click();
    waitForNewChapter(oldUrl);
  }

  function waitForNewChapter(oldUrl) {
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = location.href !== oldUrl && collectParagraphs().length > 1;
      if (ready) { clearInterval(timer); setTimeout(() => speakFrom(0), 800); }
      else if (Date.now() - started > 20000) { clearInterval(timer); status('Не дождался загрузки главы'); }
    }, 500);
  }

  function togglePlay() {
    if (playing && !synth.paused) { synth.pause(); updateUI(true); return; }
    if (playing && synth.paused) { synth.resume(); updateUI(); return; }
    speakFrom(index || firstVisibleParagraph());
  }

  function stop() {
    session++;
    playing = false;
    synth.cancel();
    index = 0;
    paragraphs.forEach((p) => p.classList.remove('rl-tts-current'));
    status('Остановлено');
    updateUI();
  }

  function skip(delta) {
    if (!paragraphs.length) paragraphs = collectParagraphs();
    speakFrom(index + delta);
  }

  function firstVisibleParagraph() {
    const list = collectParagraphs();
    const i = list.findIndex((p) => p.getBoundingClientRect().bottom > 80);
    return i < 0 ? 0 : i;
  }

  // ---------- интерфейс ----------
  const css = `
    .rl-tts-current { background: rgba(255, 196, 0, .18) !important; border-radius: 4px; box-shadow: -6px 0 0 rgba(255,196,0,.6); }
    #rl-tts { position: fixed; right: 16px; bottom: 16px; z-index: 99999; font: 13px/1.3 system-ui, sans-serif;
      background: #1f1f23; color: #eee; border: 1px solid #3a3a40; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
    #rl-tts .row { display: flex; gap: 6px; align-items: center; padding: 8px 10px; }
    #rl-tts button { background: #2d2d33; color: #eee; border: 1px solid #44444b; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 14px; }
    #rl-tts button:hover { background: #3a3a42; }
    #rl-tts .main { background: #e0a400; color: #111; border-color: #e0a400; font-weight: 600; min-width: 44px; }
    #rl-tts .settings { display: none; flex-direction: column; gap: 8px; padding: 0 10px 10px; width: 260px; }
    #rl-tts.open .settings { display: flex; }
    #rl-tts select, #rl-tts input[type=range] { width: 100%; }
    #rl-tts select { background: #2d2d33; color: #eee; border: 1px solid #44444b; border-radius: 6px; padding: 4px; }
    #rl-tts .status { font-size: 11px; opacity: .7; padding: 0 10px 8px; }
    #rl-tts label { display: flex; flex-direction: column; gap: 3px; }
    #rl-tts label.check { flex-direction: row; align-items: center; gap: 6px; }
  `;

  let panel, btnPlay, statusEl, voiceSel;

  function buildUI() {
    if (document.getElementById('rl-tts')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'rl-tts';
    panel.innerHTML = `
      <div class="row">
        <button data-a="prev" title="Предыдущий абзац">⏮</button>
        <button data-a="play" class="main" title="Читать / пауза (Alt+R)">▶</button>
        <button data-a="next" title="Следующий абзац">⏭</button>
        <button data-a="stop" title="Стоп">⏹</button>
        <button data-a="cfg" title="Настройки">⚙</button>
      </div>
      <div class="settings">
        <label>Голос <select data-s="voice"></select></label>
        <label>Скорость: <span data-v="rate"></span><input data-s="rate" type="range" min="0.5" max="2.5" step="0.05"></label>
        <label>Тон: <span data-v="pitch"></span><input data-s="pitch" type="range" min="0.5" max="1.5" step="0.05"></label>
        <label class="check"><input data-s="autoNext" type="checkbox"> Автоматически читать следующую главу</label>
        <div style="font-size:11px;opacity:.6">Совет: клик по абзацу с зажатым Alt — читать с этого места.</div>
      </div>
      <div class="status"></div>`;
    document.body.appendChild(panel);

    btnPlay = panel.querySelector('[data-a=play]');
    statusEl = panel.querySelector('.status');
    voiceSel = panel.querySelector('[data-s=voice]');

    panel.addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'play') togglePlay();
      else if (a === 'stop') stop();
      else if (a === 'prev') skip(-1);
      else if (a === 'next') skip(1);
      else if (a === 'cfg') panel.classList.toggle('open');
    });

    const rate = panel.querySelector('[data-s=rate]');
    const pitch = panel.querySelector('[data-s=pitch]');
    const auto = panel.querySelector('[data-s=autoNext]');
    rate.value = settings.rate; pitch.value = settings.pitch; auto.checked = settings.autoNext;
    const showVals = () => {
      panel.querySelector('[data-v=rate]').textContent = Number(settings.rate).toFixed(2) + '×';
      panel.querySelector('[data-v=pitch]').textContent = Number(settings.pitch).toFixed(2);
    };
    showVals();
    const restartIfPlaying = () => { if (playing && !synth.paused) speakFrom(index); };
    rate.addEventListener('change', () => { settings.rate = +rate.value; save(); showVals(); restartIfPlaying(); });
    rate.addEventListener('input', () => { settings.rate = +rate.value; showVals(); });
    pitch.addEventListener('change', () => { settings.pitch = +pitch.value; save(); showVals(); restartIfPlaying(); });
    pitch.addEventListener('input', () => { settings.pitch = +pitch.value; showVals(); });
    auto.addEventListener('change', () => { settings.autoNext = auto.checked; save(); });
    voiceSel.addEventListener('change', () => { settings.voice = voiceSel.value; save(); restartIfPlaying(); });

    fillVoices();
    synth.addEventListener?.('voiceschanged', fillVoices);
    updateUI();
  }

  function fillVoices() {
    if (!voiceSel) return;
    const list = voices().sort((a, b) => voiceScore(b) - voiceScore(a));
    const current = pickVoice();
    voiceSel.innerHTML = list.length
      ? list.map((v) => `<option value="${v.name}">${v.name}</option>`).join('')
      : '<option value="">Русских голосов нет</option>';
    if (current) voiceSel.value = current.name;
  }

  function updateUI(paused) {
    if (!btnPlay) return;
    btnPlay.textContent = playing && !paused && !synth.paused ? '⏸' : '▶';
  }
  function status(t) { if (statusEl) statusEl.textContent = t; }

  // Alt+клик по абзацу — читать с него; Alt+R — play/pause
  document.addEventListener('click', (e) => {
    if (!e.altKey) return;
    const list = collectParagraphs();
    const i = list.findIndex((p) => p.contains(e.target));
    if (i >= 0) { e.preventDefault(); speakFrom(i); }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyR') { e.preventDefault(); togglePlay(); }
  });

  // Сайт — SPA: если пользователь сам ушёл на другую главу, останавливаемся
  let lastPath = location.pathname;
  setInterval(() => {
    if (!document.getElementById('rl-tts') && document.body) buildUI();
    if (location.pathname !== lastPath) {
      const auto = playing === false && statusEl?.textContent.startsWith('Переход');
      lastPath = location.pathname;
      if (!auto && playing) stop();
      index = 0;
    }
  }, 1000);

  window.addEventListener('beforeunload', () => synth.cancel());
  buildUI();
})();
