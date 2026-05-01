/**
 * Preview Renderer
 *
 * Renders a static preview of the card inside the HA card editor.
 * Shows the rainbow bar, sample chat bubbles, and a timer pill
 * so users can see the skin's appearance.
 */

import { getSkin, loadSkin } from '../skins/index.js';
import baseCSS from './preview.css';
import { t } from '../i18n/index.js';
import waveformPreviewCSS from '../skins/waveform-preview.css';
import lensFlaresPreviewCSS from '../skins/lens-flares-preview.css';

const PREVIEW_ONLY_SKINS = {
  waveform: {
    id: 'waveform',
    previewCSS: waveformPreviewCSS,
    overlayColor: null,
    defaultOpacity: 0.90,
  },
  'lens-flares': {
    id: 'lens-flares',
    previewCSS: lensFlaresPreviewCSS,
    overlayColor: [0, 0, 0],
    darkOverlayColor: [0, 0, 0],
    defaultOpacity: 1,
    darkDefaultOpacity: 1,
  },
};

/**
 * Detect whether this card element is inside the HA card editor preview.
 * @param {HTMLElement} el
 * @returns {boolean}
 */
export function isEditorPreview(el) {
  let node = el;
  for (let i = 0; i < 20 && node; i++) {
    const tag = node.tagName;
    // Legacy: <hui-card-preview>
    if (tag === 'HUI-CARD-PREVIEW') return true;
    // Modern: <hui-card preview=""> (attribute or property)
    if (tag === 'HUI-CARD' && (node.hasAttribute('preview') || node.preview)) return true;
    // Sections layout: <hui-dialog-edit-card>
    if (tag === 'HUI-DIALOG-EDIT-CARD') return true;
    // Fallback: any element with 'preview' in tagname
    if (tag && tag.includes('PREVIEW')) return true;
    node = node.parentElement || (node.getRootNode && node.getRootNode()).host;
  }
  return false;
}

/**
 * Build an inline SVG that draws sine-wave strands matching the real
 * waveform canvas.  Two copies are generated — one for dark, one for
 * light — and CSS shows the correct one via `.preview-waveform-dark` /
 * `.preview-waveform-light`.
 */
function buildWaveformSVG() {
  const PAD = 60; // vertical padding so blur isn't clipped
  const W = 600, INNER_H = 200, H = INNER_H + PAD * 2, CY = H / 2, PTS = 200, AMP = 45;
  const darkStrands = [
    { rgb: '30,10,140',   alpha: 0.25, width: 16, feather: 8,  phase: 0,   freqs: [1.2,2.0,5.0], weights: [0.55,0.30,0.15], amp: 1.3 },
    { rgb: '70,40,200',   alpha: 0.35, width: 10, feather: 6,  phase: 0.8, freqs: [1.5,3.0,6.0], weights: [0.50,0.30,0.20], amp: 1.2 },
    { rgb: '120,60,255',  alpha: 0.50, width: 5,  feather: 3.5,phase: 1.6, freqs: [2.0,3.5,7.0], weights: [0.45,0.35,0.20], amp: 1.1 },
    { rgb: '30,160,255',  alpha: 0.45, width: 6,  feather: 4,  phase: 2.8, freqs: [1.8,4.2,8.0], weights: [0.40,0.35,0.25], amp: 1.15 },
    { rgb: '160,80,255',  alpha: 0.65, width: 3.5,feather: 2,  phase: 0.4, freqs: [2.2,4.0,6.5], weights: [0.45,0.30,0.25], amp: 1.0 },
    { rgb: '140,170,255', alpha: 0.80, width: 2,  feather: 0.8,phase: 2.0, freqs: [1.6,3.2,5.5], weights: [0.40,0.35,0.25], amp: 0.9 },
    { rgb: '200,210,255', alpha: 0.95, width: 1.2,feather: 0,  phase: 0.3, freqs: [2.0,3.0,5.0], weights: [0.45,0.30,0.25], amp: 0.8 },
  ];
  const lightStrands = [
    { rgb: '20,0,100',    alpha: 0.30, width: 16, feather: 8,  phase: 0,   freqs: [1.2,2.0,5.0], weights: [0.55,0.30,0.15], amp: 1.3 },
    { rgb: '50,20,160',   alpha: 0.40, width: 10, feather: 6,  phase: 0.8, freqs: [1.5,3.0,6.0], weights: [0.50,0.30,0.20], amp: 1.2 },
    { rgb: '80,30,200',   alpha: 0.55, width: 5,  feather: 3.5,phase: 1.6, freqs: [2.0,3.5,7.0], weights: [0.45,0.35,0.20], amp: 1.1 },
    { rgb: '0,100,210',   alpha: 0.50, width: 6,  feather: 4,  phase: 2.8, freqs: [1.8,4.2,8.0], weights: [0.40,0.35,0.25], amp: 1.15 },
    { rgb: '120,40,200',  alpha: 0.70, width: 3.5,feather: 2,  phase: 0.4, freqs: [2.2,4.0,6.5], weights: [0.45,0.30,0.25], amp: 1.0 },
    { rgb: '60,50,180',   alpha: 0.85, width: 2,  feather: 0.8,phase: 2.0, freqs: [1.6,3.2,5.5], weights: [0.40,0.35,0.25], amp: 0.9 },
    { rgb: '40,30,140',   alpha: 0.95, width: 1.2,feather: 0,  phase: 0.3, freqs: [2.0,3.0,5.0], weights: [0.45,0.30,0.25], amp: 0.8 },
  ];

  function strandPath(s) {
    const points = [];
    for (let i = 0; i <= PTS; i++) {
      const n = i / PTS;
      const x = n * W;
      const env = Math.pow(Math.sin(n * Math.PI), 2.4);
      let val = 0;
      for (let f = 0; f < s.freqs.length; f++) {
        val += Math.sin(n * Math.PI * 2 * s.freqs[f] + s.phase) * s.weights[f];
      }
      points.push({ x, y: CY + val * env * AMP * s.amp });
    }
    let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L${points[i].x.toFixed(1)},${points[i].y.toFixed(1)}`;
    }
    return d;
  }

  function renderGroup(strands, cls) {
    let filters = '';
    let paths = '';
    strands.forEach((s, i) => {
      const fid = `${cls}-f${i}`;
      if (s.feather > 0) {
        filters += `<filter id="${fid}" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="${s.feather}"/></filter>`;
      }
      const d = strandPath(s);
      // Glow layer
      paths += `<path d="${d}" fill="none" stroke="rgba(${s.rgb},${s.alpha * 0.5})" stroke-width="${s.width * 2}" stroke-linecap="round"${s.feather > 0 ? ` filter="url(#${fid})"` : ''}/>`;
      // Core layer
      paths += `<path d="${d}" fill="none" stroke="rgba(${s.rgb},${s.alpha})" stroke-width="${s.width}" stroke-linecap="round"${s.feather > 0 ? ` filter="url(#${fid})"` : ''}/>`;
    });
    return `<g class="${cls}">${filters}${paths}</g>`;
  }

  // Generate scattered particles for both themes
  function renderParticles(strands, cls, count) {
    let circles = '';
    let seed = 42;
    function rand() { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; }
    for (let i = 0; i < count; i++) {
      const s = strands[Math.floor(rand() * strands.length)];
      const n = 0.08 + rand() * 0.84;
      const env = Math.pow(Math.sin(n * Math.PI), 2.4);
      let val = 0;
      for (let f = 0; f < s.freqs.length; f++) {
        val += Math.sin(n * Math.PI * 2 * s.freqs[f] + s.phase) * s.weights[f];
      }
      const baseY = CY + val * env * AMP * s.amp;
      const x = n * W + (rand() - 0.5) * 40;
      const y = baseY + (rand() - 0.5) * AMP * 1.2;
      const r = 2 + rand() * 4;
      const alpha = 0.4 + rand() * 0.45;
      circles += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="rgb(${s.rgb})" opacity="${alpha.toFixed(3)}" filter="url(#particle-blur)"/>`;
    }
    return `<g class="${cls}">${circles}</g>`;
  }

  return `<svg class="preview-waveform-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <defs><filter id="particle-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter></defs>
    ${renderGroup(darkStrands, 'preview-waveform-dark')}
    ${renderParticles(darkStrands, 'preview-waveform-dark', 25)}
    ${renderGroup(lightStrands, 'preview-waveform-light')}
    ${renderParticles(lightStrands, 'preview-waveform-light', 25)}
  </svg>`;
}

/**
 * Build an inline SVG of vertical anamorphic light streaks plus
 * scattered bokeh dots, blurred via SVG `feGaussianBlur` to mimic the
 * live canvas's multi-pass bloom. Positions are seeded so the preview
 * is stable across re-renders.
 */
function buildLensFlaresSVG() {
  const W = 600, H = 400;
  let seed = 11;
  function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

  const blueHues = ['30,80,220', '80,160,255', '180,220,255'];
  const warmHues = ['200,60,110', '255,100,140', '255,170,190'];

  const streaks = [];
  // Blue streaks
  const N_BLUE = 14;
  for (let i = 0; i < N_BLUE; i++) {
    const t = (i + 0.5) / N_BLUE + (rand() - 0.5) * (0.3 / N_BLUE);
    const w = 14 + rand() * 80;
    const h = H * (0.55 + rand() * 0.40);
    const yOff = (rand() - 0.5) * H * 0.18;
    const cx = t * W;
    const cy = H * 0.5 + yOff;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const color = blueHues[Math.floor(rand() * blueHues.length)];
    const a = 0.45 + rand() * 0.45;
    streaks.push({ x, y, w, h, cx, cy, color, a, isCore: rand() < 0.45 });
  }
  // Warm accent streaks
  const N_WARM = 4;
  for (let i = 0; i < N_WARM; i++) {
    const t = rand();
    const w = 10 + rand() * 35;
    const h = H * (0.45 + rand() * 0.45);
    const yOff = (rand() - 0.5) * H * 0.20;
    const cx = t * W;
    const cy = H * 0.5 + yOff;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const color = warmHues[Math.floor(rand() * warmHues.length)];
    const a = 0.50 + rand() * 0.40;
    streaks.push({ x, y, w, h, cx, cy, color, a, isCore: rand() < 0.6, isWarm: true });
  }

  const bokeh = [];
  const N_BOKEH = 28;
  for (let i = 0; i < N_BOKEH; i++) {
    const isWarm = rand() < 0.22;
    bokeh.push({
      cx: rand() * W,
      cy: rand() * H,
      r: 8 + rand() * 38,
      color: isWarm ? warmHues[Math.floor(rand() * warmHues.length)]
                    : blueHues[Math.floor(rand() * blueHues.length)],
      a: 0.20 + rand() * 0.45,
    });
  }

  let streakSvg = '';
  for (const s of streaks) {
    streakSvg += `<defs><linearGradient id="lf-s-${s.x.toFixed(0)}-${s.y.toFixed(0)}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="rgba(${s.color},0)"/>
      <stop offset="18%" stop-color="rgba(${s.color},${(s.a * 0.45).toFixed(2)})"/>
      <stop offset="50%" stop-color="rgba(${s.color},${s.a.toFixed(2)})"/>
      <stop offset="82%" stop-color="rgba(${s.color},${(s.a * 0.45).toFixed(2)})"/>
      <stop offset="100%" stop-color="rgba(${s.color},0)"/>
    </linearGradient></defs>`;
    streakSvg += `<rect x="${s.x.toFixed(1)}" y="${s.y.toFixed(1)}" width="${s.w.toFixed(1)}" height="${s.h.toFixed(1)}" fill="url(#lf-s-${s.x.toFixed(0)}-${s.y.toFixed(0)})"/>`;
    if (s.isCore) {
      const coreColor = s.isWarm ? '255,170,190' : '220,240,255';
      const coreW = Math.min(s.w * 0.18, 4);
      const coreX = s.cx - coreW / 2;
      streakSvg += `<rect x="${coreX.toFixed(1)}" y="${s.y.toFixed(1)}" width="${coreW.toFixed(2)}" height="${s.h.toFixed(1)}" fill="rgba(${coreColor},${(s.a * 0.85).toFixed(2)})"/>`;
    }
  }

  let bokehSvg = '';
  for (const b of bokeh) {
    bokehSvg += `<defs><radialGradient id="lf-b-${b.cx.toFixed(0)}-${b.cy.toFixed(0)}">
      <stop offset="0%" stop-color="rgba(${b.color},${b.a.toFixed(2)})"/>
      <stop offset="45%" stop-color="rgba(${b.color},${(b.a * 0.40).toFixed(2)})"/>
      <stop offset="100%" stop-color="rgba(${b.color},0)"/>
    </radialGradient></defs>`;
    bokehSvg += `<circle cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" r="${b.r.toFixed(1)}" fill="url(#lf-b-${b.cx.toFixed(0)}-${b.cy.toFixed(0)})"/>`;
  }

  return `<svg class="preview-lens-flares-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="lf-bloom-wide" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
      <filter id="lf-bloom-mid" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id="lf-bloom-tight" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="#000"/>
    <g style="mix-blend-mode:screen" filter="url(#lf-bloom-wide)" opacity="0.6">${streakSvg}${bokehSvg}</g>
    <g style="mix-blend-mode:screen" filter="url(#lf-bloom-mid)" opacity="0.7">${streakSvg}${bokehSvg}</g>
    <g style="mix-blend-mode:screen" filter="url(#lf-bloom-tight)" opacity="0.8">${streakSvg}${bokehSvg}</g>
  </svg>`;
}

/**
 * Render a static preview inside the given shadow root.
 * All visual values are baked into the CSS - no config-driven styling needed.
 * @param {ShadowRoot} shadowRoot
 * @param {object} config
 */
export function renderPreview(shadowRoot, config) {
  const hass = shadowRoot.host?._hass;
  const tt = (key, fallback) => t(hass, key, fallback);
  const skinId = config.skin || 'default';
  const previewOnlySkin = PREVIEW_ONLY_SKINS[skinId] || null;
  const skin = previewOnlySkin || getSkin(skinId);
  // Lazy-load non-default skins; re-render once loaded.
  // Waveform is special: importing the live skin module has runtime
  // side effects, so the preview uses a static preview-only definition.
  if (!previewOnlySkin) {
    loadSkin(skinId).then((loaded) => {
      if (loaded !== skin) renderPreview(shadowRoot, config);
    });
  }
  // @font-face rules must live at document level (shadow DOM support varies).
  // Always update content because on first render for non-default skins,
  // `skin` is the default fallback — the async re-render has the real skin.
  const previewFontCSS = skin.previewCSS || '';
  const fontFaceRules = previewFontCSS.match(/@font-face\s*\{[^}]+\}/g);
  if (fontFaceRules) {
    const fontStyleId = `vs-preview-font-${skinId}`;
    let fs = document.getElementById(fontStyleId);
    if (!fs) {
      fs = document.createElement('style');
      fs.id = fontStyleId;
      document.head.appendChild(fs);
    }
    fs.textContent = fontFaceRules.join('\n');
  }
  // @property rules must live at document level (shadow DOM ignores them)
  if (skinId === 'siri' && !document.querySelector('#vs-siri-preview-prop')) {
    const s = document.createElement('style');
    s.id = 'vs-siri-preview-prop';
    s.textContent = '@property --siri-preview-angle{syntax:"<angle>";inherits:true;initial-value:0deg}';
    document.head.appendChild(s);
  }
  const scale = (config.text_scale || 100) / 100;
  const themeMode = config.theme_mode || 'auto';
  const isDark = themeMode === 'dark' ? true : themeMode === 'light' ? false : hass?.themes?.darkMode !== false;
  const defOpacity = (isDark && skin.darkDefaultOpacity != null) ? skin.darkDefaultOpacity : (skin.defaultOpacity ?? 1);
  const skinDefault = Math.round(defOpacity * 100);
  const bgOpacity = (config.background_opacity ?? skinDefault) / 100;
  const overlayColor = (isDark && skin.darkOverlayColor) || skin.overlayColor;
  const overlayStyle = overlayColor
    ? `background:rgba(${overlayColor[0]},${overlayColor[1]},${overlayColor[2]},${bgOpacity})`
    : '';
  const themeClass = isDark ? 'wf-dark' : 'wf-light';
  const forcedClass = themeMode !== 'auto' ? ' wf-forced' : '';
  shadowRoot.innerHTML = `
    <style>
      ${baseCSS}
      ${skin.previewCSS || ''}
    </style>
    <div class="preview-background"></div>
    <div class="preview-container ${themeClass}${forcedClass}" style="--vs-text-scale:${scale}">
      <div class="preview-label">${tt('editor.preview.label', 'Preview')}</div>
      <div class="preview-blur" style="${overlayStyle}"></div>
      ${skinId === 'waveform' ? `<div class="preview-waveform">${buildWaveformSVG()}</div>` : ''}
      ${skinId === 'lens-flares' ? `<div class="preview-lens-flares">${buildLensFlaresSVG()}</div>` : ''}
      <div class="preview-bar${config.reactive_bar !== false ? ' reactive' : ''}"></div>
      <div class="preview-chat">
        <div class="preview-msg user">${tt('editor.preview.user_question', "What's the temperature outside?")}</div>
        <div class="preview-msg assistant">${tt('editor.preview.assistant_answer', "It's currently 75°F and sunny.")}</div>
      </div>
      <div class="preview-timer">
        <div class="preview-timer-progress"></div>
        <div class="preview-timer-content">
          <span>\u23F1</span>
          <span class="preview-timer-time">00:04:32</span>
        </div>
      </div>
      ${skinId === 'waveform' ? `<div class="preview-notice">${tt('editor.preview.waveform_notice', 'This skin is GPU-intensive. Not recommended for low-end devices.')}</div>` : ''}
    </div>
  `;
}
