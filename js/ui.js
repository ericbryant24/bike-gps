// DOM helpers and view renderers. Knows nothing about routing or GPS.

import { formatDistance } from './geo.js';
import { stepIcon } from './instructions.js';
import { TILE_SOURCES } from './map.js';
import { PROFILES } from './router.js';
import { GRADES, GRADE_ORDER } from './rating.js';
import { CROSSING_RULES } from './blocklist.js';

export const $ = (id) => document.getElementById(id);

/** Tiny element builder: el('div', { class: 'x', onclick: fn }, [children]) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') node[k] = !!v;
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
export function toast(message, { action, onAction, duration = 3500 } = {}) {
  const t = $('toast');
  t.replaceChildren(document.createTextNode(message));
  if (action) t.append(el('button', { text: action, onclick: () => { hideToast(); onAction?.(); } }));
  t.hidden = false;
  clearTimeout(toastTimer);
  if (duration > 0) toastTimer = setTimeout(hideToast, duration);
}
export function hideToast() {
  $('toast').hidden = true;
}

export function pill(text, { spinner = false } = {}) {
  const p = $('status-pill');
  p.replaceChildren();
  if (spinner) p.append(el('span', { class: 'spinner' }));
  p.append(document.createTextNode(text));
  p.hidden = false;
}
export function hidePill() {
  $('status-pill').hidden = true;
}

export function openModal(title, body) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(body);
  $('modal').hidden = false;
}
export function closeModal() {
  $('modal').hidden = true;
  $('modal-body').replaceChildren();
}

export function openDrawer() {
  $('drawer').hidden = false;
  $('scrim').hidden = false;
}
export function closeDrawer() {
  $('drawer').hidden = true;
  $('scrim').hidden = true;
}

export function positionMenu(menu, x, y) {
  menu.hidden = false;
  const pad = 8;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = `${Math.max(pad, Math.min(x - w / 2, vw - w - pad))}px`;
  menu.style.top = `${y + h + 24 > vh ? Math.max(pad, y - h - 12) : y + 12}px`;
}

/** Keep --sheet-h in sync so map controls and attribution float above the sheet. */
export function trackSheetHeight(...elements) {
  const update = () => {
    const h = elements.reduce((m, e) => (e && !e.hidden ? Math.max(m, e.offsetHeight) : m), 0);
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  };
  const ro = new ResizeObserver(update);
  for (const e of elements) if (e) ro.observe(e);
  const mo = new MutationObserver(update);
  for (const e of elements) if (e) mo.observe(e, { attributes: true, attributeFilter: ['hidden'] });
  update();
  return update;
}

export function renderSearchResults(list, results, onPick, { units = 'metric', numbered = false } = {}) {
  list.replaceChildren(
    ...results.map((r, i) =>
      el(
        'li',
        { tabindex: 0, role: 'option', onclick: () => onPick(r), onkeydown: (e) => e.key === 'Enter' && onPick(r) },
        [
          numbered ? el('span', { class: 'num', text: String(i + 1) }) : null,
          el('div', { class: 'body' }, [
            el('span', { class: 'name', text: r.label }),
            r.kind ? el('span', { class: 'kind', text: r.kind }) : null,
            el('span', { class: 'addr', text: r.address || '' }),
          ]),
          Number.isFinite(r.distance) ? el('span', { class: 'dist', text: formatDistance(r.distance, units) }) : null,
        ]
      )
    )
  );
  list.hidden = results.length === 0;
}

export function renderProfileChips(container, active, onPick) {
  container.replaceChildren(
    ...PROFILES.map((p) =>
      el('button', { class: `chip${p.id === active ? ' active' : ''}`, title: p.hint, text: p.label, onclick: () => onPick(p.id) })
    )
  );
}

export function renderSteps(list, steps, units) {
  list.replaceChildren(
    ...steps.map((s) =>
      el('li', {}, [
        el('span', { class: 'ico', text: stepIcon(s) }),
        el('div', { class: 'txt' }, [
          el('div', { text: s.text }),
          s.rating
            ? el('div', { class: 'road-rating' }, [
                el('span', { class: 'grade', style: `background:${GRADES[s.rating.grade].color}`, text: s.rating.grade, title: GRADES[s.rating.grade].label }),
                el('span', { class: 'kind', text: [s.rating.kind, ...s.rating.notes].join(' · ') }),
                s.rating.signals || s.rating.stops
                  ? el('span', { class: 'stops', text: [s.rating.signals ? `${s.rating.signals} ${s.rating.signals === 1 ? 'light' : 'lights'}` : null, s.rating.stops ? `${s.rating.stops} ${s.rating.stops === 1 ? 'stop' : 'stops'}` : null].filter(Boolean).join(', ') })
                  : null,
              ])
            : null,
        ]),
        el('span', { class: 'd', text: s.kind === 'arrive' ? '' : formatDistance(s.distToNext, units) }),
      ])
    )
  );
}

/** Stacked bar of the route by grade, with the overall grade and a legend. */
export function renderComposition(container, comp, units) {
  if (!comp || !comp.total) {
    container.hidden = true;
    return;
  }
  const bar = el(
    'div',
    { class: 'comp-bar', role: 'img', 'aria-label': 'Route by road type' },
    GRADE_ORDER.filter((g) => comp.byGrade[g] > 0).map((g) =>
      el('span', { style: `flex:${comp.byGrade[g]};background:${GRADES[g].color}`, title: `${GRADES[g].label}: ${formatDistance(comp.byGrade[g], units)}` })
    )
  );
  const legend = el(
    'div',
    { class: 'comp-legend' },
    GRADE_ORDER.filter((g) => comp.byGrade[g] > 0).map((g) =>
      el('span', {}, [el('i', { style: `background:${GRADES[g].color}` }), `${GRADES[g].label} ${Math.round((100 * comp.byGrade[g]) / comp.total)}%`])
    )
  );
  container.replaceChildren(
    el('div', { class: 'row between comp-head' }, [
      el('span', {}, [el('span', { class: 'grade', style: `background:${GRADES[comp.grade].color}`, text: comp.grade }), ` Bike-friendliness`]),
      el('span', { class: 'sub', text: `${Math.round(comp.friendlyShare * 100)}% on paths & quiet streets` }),
    ]),
    bar,
    legend
  );
  container.hidden = false;
}

function toggle(checked, onChange) {
  const input = el('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return el('label', { class: 'switch' }, [input, el('span')]);
}

function setting(label, desc, control) {
  return el('div', { class: 'setting' }, [el('div', {}, [el('label', { text: label }), desc ? el('span', { class: 'desc', text: desc }) : null]), control]);
}

export function renderSettings(settings, onChange, { onClearTiles, onCheckUpdate, version } = {}) {
  const select = (key, options) =>
    el(
      'select',
      { onchange: (e) => onChange(key, e.target.value) },
      options.map(([v, label]) => el('option', { value: v, selected: settings[key] === v, text: label }))
    );
  return el('div', {}, [
    setting('Units', null, select('units', [['metric', 'Metric (km)'], ['imperial', 'Imperial (mi)']])),
    setting('Voice guidance', 'Spoken turn prompts', toggle(settings.voice, (v) => onChange('voice', v))),
    setting('Map style', '3D styles rotate and tilt while navigating', select('tiles', Object.entries(TILE_SOURCES).map(([k, v]) => [k, v.label]))),
    setting('Navigation view', 'Tap the compass while riding to switch', select('navView', [['3d', '3D, heading up'], ['north', 'Flat, north up']])),
    setting('Crossing blocked roads', 'Default for new blocks; editable per road', select('crossing', Object.entries(CROSSING_RULES))),
    setting('Street names in directions', 'Looks up road names from OpenStreetMap after each route', toggle(settings.streetNames, (v) => onChange('streetNames', v))),
    setting('Auto-reroute', 'Recalculate when you leave the route', toggle(settings.autoReroute, (v) => onChange('autoReroute', v))),
    setting(
      'Off-route distance',
      'Metres from the line before rerouting',
      select('offRouteMeters', [['25', '25 m (strict)'], ['40', '40 m'], ['60', '60 m'], ['100', '100 m (relaxed)']])
    ),
    setting('Keep screen on', 'While navigating', toggle(settings.keepAwake, (v) => onChange('keepAwake', v))),
    setting(
      'Routing server',
      'BRouter-compatible endpoint',
      el('input', { type: 'url', value: settings.endpoint, onchange: (e) => onChange('endpoint', e.target.value.trim()) })
    ),
    setting(
      'Mapbox search token',
      'Optional. Google-quality place search. Free tier covers personal use; create a public token (pk.…) at account.mapbox.com and restrict it to this site\u2019s URL. Leave empty to use the free OpenStreetMap geocoders.',
      el('input', { type: 'text', placeholder: 'pk.…', value: settings.mapboxToken || '', autocomplete: 'off', spellcheck: 'false', onchange: (e) => onChange('mapboxToken', e.target.value.trim()) })
    ),
    setting('Cached map tiles', 'Free up storage', el('button', { class: 'secondary', text: 'Clear', onclick: onClearTiles })),
    setting('App version', version ? `Bike GPS ${version}` : 'Bike GPS', el('button', { class: 'secondary', text: 'Check for updates', onclick: onCheckUpdate })),
  ]);
}

export function renderBlocklist(entries, units, { onToggle, onEdit, onShow, onDelete, onClear, onExport, onImport }) {
  const ico = { point: '📍', stretch: '✂️', road: '🛣️' };
  if (!entries.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'big', text: '⛔' }),
      el('div', { text: 'No blocked roads yet.' }),
      el('p', { class: 'hint', text: 'Long-press a road on the map, or tap ⛔ to enter block mode. Blocked roads are never used when routing, but you can still cross them.' }),
      el('div', { class: 'row gap', style: 'justify-content:center;margin-top:12px' }, [el('button', { class: 'secondary', text: 'Import…', onclick: onImport })]),
    ]);
  }
  return el('div', {}, [
    ...entries.map((e) =>
      el('div', { class: `entry${e.enabled ? '' : ' disabled'}` }, [
        el('span', { class: 'ico', text: ico[e.kind] || '⛔' }),
        el('div', { class: 'info', onclick: () => onEdit(e) }, [
          el('div', { class: 'name', text: e.name }),
          el('div', {
            class: 'meta',
            text:
              e.kind === 'point'
                ? `Spot · ${Math.round(e.radius)} m radius`
                : `${e.kind === 'road' ? 'Whole road' : 'Stretch'} · ${formatDistance(e.length || 0, units)} · ${(e.crossing || 'signals') === 'signals' ? 'cross at lights' : 'cross anywhere'}`,
          }),
        ]),
        el('button', { class: 'icon-btn', title: 'Show on map', text: '🗺', onclick: () => onShow(e) }),
        toggle(e.enabled, (v) => onToggle(e, v)),
      ])
    ),
    el('div', { class: 'row gap', style: 'margin-top:16px;flex-wrap:wrap' }, [
      el('button', { class: 'secondary', text: 'Export', onclick: onExport }),
      el('button', { class: 'secondary', text: 'Import…', onclick: onImport }),
      el('button', { class: 'text-btn', style: 'margin-left:auto;color:var(--danger)', text: 'Delete all', onclick: onClear }),
    ]),
  ]);
}

export function renderEntryEditor(entry, units, { onSave, onDelete, onShow }) {
  const name = el('input', { type: 'text', value: entry.name, style: 'width:100%;max-width:100%' });
  let radius = null;
  let crossing = null;
  if (entry.kind === 'point') radius = el('input', { type: 'number', min: 5, max: 500, step: 5, value: Math.round(entry.radius) });
  else {
    crossing = el(
      'select',
      {},
      Object.entries(CROSSING_RULES).map(([v, label]) => el('option', { value: v, selected: (entry.crossing || 'signals') === v, text: label }))
    );
  }
  const lights = entry.signals?.length || 0;
  return el('div', {}, [
    setting('Name', null, name),
    radius ? setting('Radius (m)', 'Everything inside is avoided, including crossings', radius) : null,
    crossing
      ? setting(
          'Crossing allowed',
          entry.signalsKnown === false
            ? 'Traffic-light data could not be loaded — junctions stay open under the lights rule'
            : lights
              ? `${lights} traffic ${lights === 1 ? 'light' : 'lights'} found on this road`
              : 'No traffic lights found on this road',
          crossing
        )
      : null,
    entry.kind !== 'point'
      ? el('p', { class: 'hint', text: `${formatDistance(entry.length || 0, units)} of road. Riding along it is never allowed; crossing follows the rule above.` })
      : null,
    el('div', { class: 'row gap', style: 'margin-top:16px' }, [
      el('button', {
        class: 'primary grow',
        text: 'Save',
        onclick: () => onSave({ name: name.value.trim() || entry.name, radius: radius ? Number(radius.value) : undefined, crossing: crossing ? crossing.value : undefined }),
      }),
      el('button', { class: 'secondary', text: 'Show', onclick: onShow }),
      el('button', { class: 'danger', text: 'Delete', onclick: onDelete }),
    ]),
  ]);
}

export function renderAbout(version) {
  return el('div', {}, [
    el('p', { html: `<strong>Bike GPS</strong>${version ? ` <span class="muted">v${version}</span>` : ''} is a turn-by-turn bicycle navigator that lets you block roads you never want to be routed down.` }),
    el('h4', { text: 'How blocking works' }),
    el('p', {
      text: 'Blocked roads are sent to the router as no-go zones. A blocked road or stretch is fenced with short barriers between junctions, so the router can never travel along it but you can still cross it at intersections. A blocked spot is a circle that nothing may pass through.',
    }),
    el('h4', { text: 'Tips' }),
    el('ul', {}, [
      el('li', { text: 'Long-press anywhere on the map to route there, start there, or block the road under your finger.' }),
      el('li', { text: 'While navigating, tap "Avoid this road" to block the road you are on and reroute instantly.' }),
      el('li', { text: 'Use "Simulate" on a planned route to preview the guidance without riding.' }),
      el('li', { text: 'Install the app to your home screen for full-screen use and offline map tiles you have already viewed.' }),
    ]),
    el('h4', { text: 'Data & services' }),
    el('p', {
      html:
        'Routing by <a href="https://brouter.de" target="_blank" rel="noopener">BRouter</a>. Search by <a href="https://nominatim.org" target="_blank" rel="noopener">Nominatim</a>. Road data via the <a href="https://overpass-api.de" target="_blank" rel="noopener">Overpass API</a>. Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. These are free community services — please be considerate.',
    }),
    el('p', { class: 'hint', text: 'Your location and blocked roads never leave your device except as part of routing requests.' }),
  ]);
}

/** Step-by-step install instructions for platforms without an install prompt (iOS). */
export function renderInstallHelp({ ios, safari }) {
  const steps = ios
    ? [
        safari ? null : el('li', { html: 'Open this page in <b>Safari</b> (other iPhone browsers can install too, but Safari is the most reliable).' }),
        el('li', { html: 'Tap the <span class="glyph share"></span> <b>Share</b> button — at the bottom of Safari, or in the address bar on iPad.' }),
        el('li', { html: 'Scroll the sheet and tap <span class="glyph add"></span> <b>Add to Home Screen</b>.' }),
        el('li', { html: 'Tap <b>Add</b>. Bike GPS opens full-screen from your Home Screen, keeps the map tiles you have viewed for offline use, and updates itself.' }),
      ]
    : [
        el('li', { html: 'Open the browser menu (⋮ or the address bar) and choose <b>Install app</b> or <b>Add to Home screen</b>.' }),
        el('li', { html: 'Confirm. Bike GPS opens full-screen and updates itself.' }),
      ];
  return el('div', {}, [
    el('p', { text: ios ? 'iPhone and iPad don’t offer install pop-ups for web apps, so it takes two taps in the Share menu:' : 'Install Bike GPS for a full-screen, offline-capable app:' }),
    el('ol', { class: 'install-how' }, steps),
    el('p', { class: 'hint', text: 'Location, voice guidance and keep-screen-on all work from the Home Screen app. Allow location when asked.' }),
  ]);
}
