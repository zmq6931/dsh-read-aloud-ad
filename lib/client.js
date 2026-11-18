// dsh-read-aloud-ad — browser half.
//
// Loaded by dsh-client-modules at /plugins/dsh-read-aloud-ad/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load).
//
// Adds a play/pause button and a speed control to the action row of each
// finalized assistant reply (the row with copy / like / dislike / share),
// between the copy and branch buttons. Text is read from the Chat snapshot by
// message id, sent to this plugin's own loopback route, and voiced by
// Microsoft Edge's read-aloud service with Mandarin Xiaoxiao
// (zh-CN-XiaoxiaoNeural). Long replies are split into sentence-sized chunks so
// playback starts after the first chunk; the next chunk is fetched while the
// current one plays. Speed changes take effect immediately through
// HTMLMediaElement.playbackRate (pitch preserved).

window.__ModuleLoader__.load({
  id: 'dsh-read-aloud-ad',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    //#region constants
    /** Host route prefix (must match lib/index.js). */
    const API_PREFIX = '/read-aloud';
    /** Lowest, highest, and step of the selectable playback speeds. */
    const RATE_MIN = 0.75;
    const RATE_MAX = 3;
    const RATE_STEP = 0.25;
    /** Selectable speeds: 0.75x through 3x in 0.25x steps. */
    const RATES = Array.from(
      { length: Math.round((RATE_MAX - RATE_MIN) / RATE_STEP) + 1 },
      (_, index) => Number((RATE_MIN + index * RATE_STEP).toFixed(2)),
    );
    /** Speed used when the user has never chosen one. */
    const DEFAULT_RATE = 1;
    /** Per-origin storage key for the chosen speed. */
    const RATE_STORAGE_KEY = 'dsh-read-aloud:speed';
    /** Longest single synthesis request, in characters. */
    const CHUNK_CHARS = 320;
    /** How long a failure message stays on screen. */
    const ERROR_VISIBLE_MS = 8000;
    /** Estimated height of one speed-menu row, used to place the popover. */
    const MENU_ITEM_HEIGHT = 29;
    /** Estimated menu height outside its rows: padding, border, and the title. */
    const MENU_CHROME_HEIGHT = 46;
    /** Dictionary namespace owned by this plugin. */
    const NS = 'readAloud';
    //#endregion

    //#region locale fallback
    // The slot-supplied `t` is authoritative; these dictionaries only cover the
    // window before (or if) the locale service delivers the namespace.
    const ZH = {
      'action.play': '朗读这条回复',
      'action.pause': '暂停朗读',
      'action.resume': '继续朗读',
      'action.cancel': '取消朗读',
      'action.loading': '正在合成语音…',
      'speed.label': '语速',
      'speed.title': '调整朗读速度',
      'error.empty': '这条回复没有可朗读的文字',
      'error.failed': '语音合成失败，请重试',
      'error.playback': '浏览器无法播放这段语音',
      'error.long': '这条回复太长，无法整段朗读',
    };
    const EN = {
      'action.play': 'Read this reply aloud',
      'action.pause': 'Pause reading',
      'action.resume': 'Resume reading',
      'action.cancel': 'Cancel reading',
      'action.loading': 'Synthesizing speech…',
      'speed.label': 'Speed',
      'speed.title': 'Adjust reading speed',
      'error.empty': 'This reply has no readable text',
      'error.failed': 'Speech synthesis failed; try again',
      'error.playback': 'The browser could not play this audio',
      'error.long': 'This reply is too long to read aloud',
    };
    function fallbackTranslate(key) {
      return Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key;
    }

    /** Prefer the slot's locale seat, but never show a raw key when it is absent. */
    function translateFrom(seat) {
      if (typeof seat !== 'function') return fallbackTranslate;
      return (key) => {
        let value;
        try {
          value = seat(key);
        } catch {
          value = undefined;
        }
        return typeof value === 'string' && value !== key ? value : fallbackTranslate(key);
      };
    }

    /** Display form of one selectable rate: 1x reads as "1.0×", 2x as "2.0×". */
    function formatRate(rate) {
      return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}×`;
    }
    //#endregion

    //#region text extraction
    /** Chat snapshot -> plain reply text for one durable message id. */
    function assistantTextFor(snapshot, messageId) {
      const store = snapshot === null || snapshot === undefined ? undefined : snapshot.nodes;
      if (!store || typeof store.values !== 'function') return '';
      let values;
      try {
        values = store.values();
      } catch {
        return '';
      }
      if (!Array.isArray(values)) return '';
      for (const node of values) {
        if (node === null || node === undefined || node.kind !== 'assistant-step') continue;
        const data = node.data;
        if (!data || !data.finalNode || data.finalNode.messageId !== messageId) continue;
        const blocks = Array.isArray(data.blocks) ? data.blocks : [];
        let text = '';
        for (const block of blocks) {
          if (block && block.kind === 'text' && typeof block.text === 'string') text += block.text;
        }
        return text;
      }
      return '';
    }

    /** Markdown -> speakable prose (no syntax marks, no fenced code). */
    function toPlainText(markdown) {
      let text = String(markdown === null || markdown === undefined ? '' : markdown);
      text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
      text = text.replace(/```[\s\S]*?(?:```|$)/g, '\n');
      text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n');
      text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
      text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      text = text.replace(/<[^>\n]{1,200}>/g, ' ');
      text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
      text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
      text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '');
      text = text.replace(/`([^`\n]+)`/g, '$1');
      text = text.replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*$/gm, '');
      text = text.replace(/\|/g, ' ');
      text = text.replace(/^\s{0,3}>\s?/gm, '');
      text = text.replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1');
      text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');
      text = text.replace(/[ \t\u00A0]+/g, ' ');
      text = text.replace(/\n{2,}/g, '\n');
      return text.trim();
    }

    /** Split prose into request-sized chunks on sentence boundaries. */
    function splitForSpeech(text) {
      if (text.length <= CHUNK_CHARS) return text.length === 0 ? [] : [text];
      const pieces = text.split(/(?<=[。！？!?；;：:\n])/);
      const chunks = [];
      let current = '';
      const push = (value) => {
        const trimmed = value.trim();
        if (trimmed.length > 0) chunks.push(trimmed);
      };
      for (const piece of pieces) {
        let rest = piece;
        while (rest.length > CHUNK_CHARS) {
          const window = rest.slice(0, CHUNK_CHARS);
          const breakAt = Math.max(
            window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('、'),
            window.lastIndexOf(' '), window.lastIndexOf('\n'),
          );
          const cut = breakAt > CHUNK_CHARS * 0.4 ? breakAt + 1 : CHUNK_CHARS;
          push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        if (rest.length === 0) continue;
        if (current.length + rest.length > CHUNK_CHARS && current.length > 0) {
          push(current);
          current = '';
        }
        current += rest;
      }
      push(current);
      return chunks;
    }
    //#endregion

    //#region audio decode
    function base64ToBytes(encoded) {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    //#endregion

    //#region player
    function clampRate(value) {
      const number = Number(value);
      return RATES.indexOf(number) >= 0 ? number : DEFAULT_RATE;
    }

    function storedRate() {
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(RATE_STORAGE_KEY);
        return raw === null ? DEFAULT_RATE : clampRate(raw);
      } catch {
        return DEFAULT_RATE;
      }
    }

    function persistRate(rate) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(RATE_STORAGE_KEY, String(rate));
      } catch {
        /* storage unavailable */
      }
    }

    /** One shared player: only one reply speaks at a time, across all rows. */
    const player = {
      snapshot: { messageId: null, phase: 'idle', rate: storedRate(), error: null },
      listeners: new Set(),
      generation: 0,
      session: null,
      audio: null,
      errorTimer: null,
    };

    function emit(patch) {
      player.snapshot = { ...player.snapshot, ...patch };
      for (const listener of [...player.listeners]) {
        try {
          listener();
        } catch {
          /* a broken subscriber must not break playback */
        }
      }
    }

    function subscribePlayer(listener) {
      player.listeners.add(listener);
      return () => player.listeners.delete(listener);
    }

    function ensureAudio() {
      if (player.audio !== null) return player.audio;
      const audio = new Audio();
      audio.preload = 'auto';
      player.audio = audio;
      return audio;
    }

    function clearErrorTimer() {
      if (player.errorTimer !== null) {
        clearTimeout(player.errorTimer);
        player.errorTimer = null;
      }
    }

    function fail(code) {
      stopPlayback();
      emit({ phase: 'error', error: code });
      clearErrorTimer();
      player.errorTimer = setTimeout(() => {
        player.errorTimer = null;
        if (player.snapshot.phase === 'error') emit({ phase: 'idle', error: null, messageId: null });
      }, ERROR_VISIBLE_MS);
    }

    function releaseSession() {
      const session = player.session;
      player.session = null;
      if (session === null) return;
      for (const url of session.urls.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
      session.urls.clear();
      session.pending.clear();
    }

    function stopPlayback() {
      player.generation += 1;
      const audio = player.audio;
      if (audio !== null) {
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch {
          /* ignore */
        }
      }
      releaseSession();
    }

    function stop() {
      clearErrorTimer();
      stopPlayback();
      emit({ messageId: null, phase: 'idle', error: null });
    }

    async function requestAudio(text, generation) {
      const response = await fetch(`${API_PREFIX}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        credentials: 'same-origin',
      });
      let json = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      if (generation !== player.generation) throw new Error('cancelled');
      if (!response.ok || json === null || json.ok !== true) {
        const code = json && json.error && json.error.code ? json.error.code : `http-${response.status}`;
        throw new Error(code);
      }
      const bytes = base64ToBytes(json.audioBase64);
      return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    }

    function chunkUrl(session, index) {
      const existing = session.urls.get(index);
      if (existing !== undefined) return Promise.resolve(existing);
      const pending = session.pending.get(index);
      if (pending !== undefined) return pending;
      const generation = player.generation;
      const promise = requestAudio(session.chunks[index], generation).then((url) => {
        if (generation !== player.generation) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
          throw new Error('cancelled');
        }
        session.urls.set(index, url);
        session.pending.delete(index);
        return url;
      }, (error) => {
        session.pending.delete(index);
        throw error;
      });
      session.pending.set(index, promise);
      return promise;
    }

    function playUrl(url) {
      const audio = ensureAudio();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
        };
        const onEnded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('playback'));
        };
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);
        audio.src = url;
        audio.preservesPitch = true;
        audio.playbackRate = player.snapshot.rate;
        const started = audio.play();
        if (started && typeof started.catch === 'function') {
          started.catch((error) => {
            cleanup();
            reject(error);
          });
        }
      });
    }

    async function runSession(generation) {
      const session = player.session;
      if (session === null) return;
      for (let index = 0; index < session.chunks.length; index += 1) {
        const url = await chunkUrl(session, index);
        if (generation !== player.generation) return;
        emit({ phase: 'playing', error: null });
        const next = index + 1 < session.chunks.length ? chunkUrl(session, index + 1).catch(() => {}) : null;
        await playUrl(url);
        if (next !== null) await next;
        if (generation !== player.generation) return;
      }
      if (generation !== player.generation) return;
      stopPlayback();
      emit({ messageId: null, phase: 'idle', error: null });
    }

    function start(messageId, text) {
      const chunks = splitForSpeech(text);
      if (chunks.length === 0) {
        emit({ messageId, phase: 'error', error: 'empty' });
        return;
      }
      clearErrorTimer();
      stopPlayback();
      player.session = { messageId, chunks, urls: new Map(), pending: new Map() };
      const generation = player.generation;
      emit({ messageId, phase: 'loading', error: null });
      runSession(generation).catch((error) => {
        if (generation !== player.generation) return;
        const message = error && error.message ? error.message : '';
        fail(message === 'playback' ? 'playback' : 'failed');
      });
    }

    function pause() {
      const audio = player.audio;
      if (audio === null) return;
      audio.pause();
      emit({ phase: 'paused' });
    }

    function resume() {
      const audio = player.audio;
      if (audio === null) return;
      audio.playbackRate = player.snapshot.rate;
      const started = audio.play();
      if (started && typeof started.catch === 'function') started.catch(() => fail('playback'));
      emit({ phase: 'playing' });
    }

    function setRate(rate) {
      const next = clampRate(rate);
      persistRate(next);
      emit({ rate: next });
      const audio = player.audio;
      if (audio !== null) audio.playbackRate = next;
    }
    //#endregion

    //#region styles
    const STYLE_ID = 'dsh-read-aloud-style';
    let styleRefs = 0;
    const CSS = `
.dsh-ra-root{display:inline-flex;align-items:center;gap:2px}
.dsh-ra-btn{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-ra-btn svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));display:block}
@media (hover:hover){.dsh-ra-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.dsh-ra-btn[data-active="true"]{color:var(--dsw-alias-brand-primary)}
.dsh-ra-btn:disabled{cursor:default;opacity:.4}
.dsh-ra-spin{animation:dsh-ra-spin 1s linear infinite;transform-origin:50% 50%}
@keyframes dsh-ra-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.dsh-ra-speed{display:inline-flex;align-items:center;justify-content:center;height:calc(22px + var(--dsh-content-font-delta,0px));min-width:38px;padding:0 6px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer;opacity:.85}
@media (hover:hover){.dsh-ra-speed:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);opacity:1}}
.dsh-ra-speed[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);opacity:1}
.dsh-ra-menu{position:fixed;z-index:2147483000;min-width:112px;max-height:min(60vh,380px);overflow-y:auto;overscroll-behavior:contain;padding:6px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 28px rgba(0,0,0,.28)}
.dsh-ra-menu-title{padding:2px 8px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-ra-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:6px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
@media (hover:hover){.dsh-ra-item:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dsh-ra-item[data-active="true"]{color:var(--dsw-alias-brand-primary)}
.dsh-ra-check{font-size:11px}
.dsh-ra-error{padding-left:6px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px;white-space:nowrap}
`;

    function useStyle() {
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        styleRefs += 1;
        let node = document.getElementById(STYLE_ID);
        if (node === null) {
          node = document.createElement('style');
          node.id = STYLE_ID;
          node.textContent = CSS;
          document.head.appendChild(node);
        }
        return () => {
          styleRefs -= 1;
          if (styleRefs > 0) return;
          const current = document.getElementById(STYLE_ID);
          if (current !== null) current.remove();
        };
      }, []);
    }
    //#endregion

    //#region icons
    function Svg(props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        className: props.className,
      }, props.children);
    }

    function PlayIcon() {
      return h(Svg, null, h('path', { d: 'M8 5.5v13l11-6.5z', fill: 'currentColor', stroke: 'none' }));
    }

    function PauseIcon() {
      return h(Svg, null,
        h('rect', { x: 7, y: 5.5, width: 3.4, height: 13, rx: 1.1, fill: 'currentColor', stroke: 'none' }),
        h('rect', { x: 13.6, y: 5.5, width: 3.4, height: 13, rx: 1.1, fill: 'currentColor', stroke: 'none' }));
    }

    function StopIcon() {
      return h(Svg, null, h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.4, fill: 'currentColor', stroke: 'none' }));
    }

    function SpinnerIcon() {
      return h(Svg, { className: 'dsh-ra-spin' },
        h('path', { d: 'M12 3.5a8.5 8.5 0 1 0 8.5 8.5', strokeWidth: 2.2 }));
    }
    //#endregion

    //#region component
    function usePlayer() {
      const subscribe = React.useCallback(callback => subscribePlayer(callback), []);
      const getSnapshot = React.useCallback(() => player.snapshot, []);
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, getSnapshot);
      }
      const [state, setState] = React.useState(player.snapshot);
      React.useEffect(() => subscribePlayer(() => setState(player.snapshot)), []);
      return state;
    }

    function ReadAloudAction(props) {
      useStyle();
      const messageId = props.messageId;
      const t = translateFrom(props.t);
      const useChat = props.useChat;
      const text = typeof useChat === 'function'
        ? useChat(snapshot => assistantTextFor(snapshot, messageId))
        : '';
      const state = usePlayer();
      const [menu, setMenu] = React.useState(null);
      const buttonRef = React.useRef(null);
      const menuRef = React.useRef(null);

      const active = state.messageId === messageId && state.phase !== 'idle';
      const playing = active && state.phase === 'playing';
      const loading = active && state.phase === 'loading';
      const errored = state.messageId === messageId && state.phase === 'error';

      const label = loading
        ? t('action.cancel')
        : playing
          ? t('action.pause')
          : active && state.phase === 'paused'
            ? t('action.resume')
            : t('action.play');

      const onToggle = React.useCallback(() => {
        if (loading) {
          stop();
          return;
        }
        if (active && state.phase === 'playing') {
          pause();
          return;
        }
        if (active && state.phase === 'paused') {
          resume();
          return;
        }
        const plain = toPlainText(text);
        if (plain.trim().length === 0) {
          emit({ messageId, phase: 'error', error: 'empty' });
          clearErrorTimer();
          player.errorTimer = setTimeout(() => {
            player.errorTimer = null;
            if (player.snapshot.phase === 'error') emit({ phase: 'idle', error: null, messageId: null });
          }, ERROR_VISIBLE_MS);
          return;
        }
        start(messageId, plain);
      }, [active, loading, messageId, state.phase, text]);

      const openMenu = React.useCallback(() => {
        if (menu !== null) {
          setMenu(null);
          return;
        }
        const node = buttonRef.current;
        if (node === null) return;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        // The menu holds every 0.25x step up to 3x, so its height grows with
        // RATES: open above the row when that fits, otherwise below it, and
        // never let the panel run past the viewport edge.
        const estimatedHeight = MENU_CHROME_HEIGHT + RATES.length * MENU_ITEM_HEIGHT;
        const placeAbove = rect.top > estimatedHeight + 16;
        setMenu({
          left: rect.left,
          right: rect.right,
          bottom: placeAbove ? Math.max(8, window.innerHeight - rect.top + 6) : null,
          top: placeAbove
            ? null
            : Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - estimatedHeight - 8)),
        });
      }, [menu]);

      React.useEffect(() => {
        if (menu === null) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (menuRef.current !== null && menuRef.current.contains(target)) return;
          if (buttonRef.current !== null && buttonRef.current.contains(target)) return;
          setMenu(null);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenu(null);
        };
        const onViewportChange = () => setMenu(null);
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        // Deliberately no scroll listener: the transcript scrolls on its own
        // while a reply streams, which must not dismiss an open speed menu.
        window.addEventListener('resize', onViewportChange);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('resize', onViewportChange);
        };
      }, [menu]);

      const chooseRate = React.useCallback((rate) => {
        setRate(rate);
        setMenu(null);
      }, []);

      const icon = loading ? h(SpinnerIcon) : playing ? h(PauseIcon) : h(PlayIcon);
      const errorText = errored
        ? state.error === 'empty' ? t('error.empty') : state.error === 'playback' ? t('error.playback') : t('error.failed')
        : null;

      const menuNode = menu === null ? null : h('div', {
        ref: menuRef,
        className: 'dsh-ra-menu',
        role: 'menu',
        'aria-label': t('speed.title'),
        style: {
          left: `${Math.max(8, Math.min(menu.left, window.innerWidth - 128))}px`,
          ...(menu.bottom === null
            ? { top: `${menu.top}px` }
            : { bottom: `${menu.bottom}px` }),
        },
      },
      h('div', { className: 'dsh-ra-menu-title' }, t('speed.title')),
      RATES.map(rate => h('button', {
        key: String(rate),
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': rate === state.rate,
        className: 'dsh-ra-item',
        'data-active': rate === state.rate ? 'true' : undefined,
        onClick: () => chooseRate(rate),
      },
      h('span', null, formatRate(rate)),
      h('span', { className: 'dsh-ra-check' }, rate === state.rate ? '✓' : ''))));

      return h('span', { className: 'dsh-ra-root' },
        h('button', {
          ref: buttonRef,
          type: 'button',
          className: 'dsh-ra-btn',
          title: label,
          'aria-label': label,
          'aria-pressed': playing ? 'true' : 'false',
          'data-active': active ? 'true' : undefined,
          onClick: onToggle,
        }, icon),
        h('button', {
          type: 'button',
          className: 'dsh-ra-speed',
          title: t('speed.title'),
          'aria-label': `${t('speed.label')} ${formatRate(state.rate)}`,
          'aria-haspopup': 'menu',
          'aria-expanded': menu === null ? 'false' : 'true',
          onClick: openMenu,
        }, formatRate(state.rate)),
        errorText === null ? null : h('span', { className: 'dsh-ra-error', role: 'status' }, errorText),
        menuNode);
    }
    //#endregion

    //#region plugin
    /** Presence beacon: proves this bundle executed in the page. */
    function reportPresence() {
      try {
        fetch(`${API_PREFIX}/client-hello`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: '0.1.0',
            platform: typeof navigator !== 'undefined' && navigator.userAgent
              ? String(navigator.userAgent).slice(0, 120)
              : 'unknown',
          }),
          credentials: 'same-origin',
        }).catch(() => {});
      } catch {
        /* diagnostics only */
      }
    }

    /** Required services: the slot registry; the locale registry is optional. */
    const inject = ['slots'];

    function apply(ctx) {
      ctx.inject(['locale'], (scope) => {
        scope.effect(
          () => scope.locale.register(NS, { zh: ZH, en: EN }),
          'dsh-read-aloud-ad: dictionaries',
        );
      });

      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'read-aloud',
        order: 8,
        locale: NS,
        inject: () => ({}),
      }, ReadAloudAction));

      ctx.effect(() => {
        reportPresence();
        return () => {
          clearErrorTimer();
          stopPlayback();
          player.listeners.clear();
        };
      }, 'dsh-read-aloud-ad: player');
    }
    //#endregion

    module.exports = {
      name: 'dsh-read-aloud-ad',
      inject,
      apply,
      // Exported for offline tests / shell-console debugging.
      toPlainText,
      splitForSpeech,
      assistantTextFor,
      formatRate,
      RATES,
    };
    return module.exports;
  },
});
