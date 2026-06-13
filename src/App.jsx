import { useState, useEffect, useContext, useReducer, createContext, useMemo, useRef, Component } from "react";
import { supabase, cloudEnabled } from "./supabase";

const MAX_SYSTEMS = 5; // tope de sistemas por cuenta (también aplicado a invitados, y en la BD via trigger)

/* ================================================================
   UTILITIES
   ================================================================ */
function fluidValue(min, max, minVP, maxVP, cap) {
  const mn = Number(min), mx = Number(max), mnVP = Number(minVP), mxVP = Number(maxVP);
  // Guard: NaN / Infinity
  if (!isFinite(mn) || !isFinite(mx) || !isFinite(mnVP) || !isFinite(mxVP)) return (isFinite(mn) ? mn : 0) + "px";
  // Guard: viewport range inválido → fallback valor móvil
  if (mnVP >= mxVP) return mn + "px";
  // Guard: valores idénticos → estático, no hace falta clamp
  if (mn === mx) return mn + "px";
  // Guard: rango invertido (mobile > desktop) → swap para que lo < hi
  const lo = Math.min(mn, mx), hi = Math.max(mn, mx);
  const slope = (hi - lo) / (mxVP - mnVP);
  const intercept = lo - slope * mnVP;
  // Formato limpio: elimina trailing zeros y evita "-0.xx"
  const fmt = (n, dec) => {
    const r = Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
    return String(parseFloat((Math.abs(r) < 1e-9 ? 0 : r).toFixed(dec)));
  };
  const pref = fmt(intercept, 2) + "px + " + fmt(slope * 100, 4) + "vw";
  return cap ? "clamp(" + lo + "px, calc(" + pref + "), " + hi + "px)" : "max(" + lo + "px, calc(" + pref + "))";
}
function fl(min, max, s) { return fluidValue(min, max, s.minViewport, s.maxViewport, true); }
function flRem(min, max, s) {
  const clampPx = fl(min, max, s);
  return clampPx.replace(/(\d+(?:\.\d+)?)px/g, (_, p) => pxToRem(parseFloat(p)));
}
// Evalúa un valor fluido (mobile→desktop) a un viewport concreto, en px. Para el preview "device".
function sizeAtVP(min, max, s, vp) {
  const mn = Number(min) || 0, mx = Number(max) || 0;
  if (mn === mx) return mn;
  const lo = Math.min(mn, mx), hi = Math.max(mn, mx);
  const mnVP = Number(s.minViewport), mxVP = Number(s.maxViewport);
  if (!(mxVP > mnVP)) return mx;
  const tt = Math.max(0, Math.min(1, (vp - mnVP) / (mxVP - mnVP)));
  return Math.round(Math.max(lo, Math.min(hi, mn + (mx - mn) * tt)) * 100) / 100;
}
function slugify(str) { return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "color"; }
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))).toString(16).padStart(2, "0"); };
  return "#" + f(0) + f(8) + f(4);
}
function hexToHsl(hex) {
  let r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60; else if (mx === g) h = ((b - r) / d + 2) * 60; else h = ((r - g) / d + 4) * 60; }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function randId() { return Math.random().toString(36).slice(2, 8).padEnd(6, '0'); }
function hslStrToHex(str) {
  if (/^#[0-9a-f]{3,8}$/i.test(str || '')) return str; // ya es hex (variante personalizada)
  const m = (str || '').match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  return m ? hslToHex(+m[1], +m[2], +m[3]) : '#000000';
}
const toHexColor = (v) => (v && v.startsWith('#')) ? v : hslStrToHex(v);
function pxToRem(px) { return (px / 16).toFixed(3).replace(/\.?0+$/, '') + 'rem'; }

const SCALES = [
  { name: "Minor Second", value: 1.067 }, { name: "Major Second", value: 1.125 },
  { name: "Minor Third", value: 1.2 }, { name: "Major Third", value: 1.25 },
  { name: "Perfect Fourth", value: 1.333 }, { name: "Augmented Fourth", value: 1.414 },
  { name: "Perfect Fifth", value: 1.5 }, { name: "Golden Ratio", value: 1.618 },
];

const VARIANT_LIGHTNESS = [
  { key: "ultra-dark", l: 12 }, { key: "dark", l: 25 }, { key: "semi-dark", l: 37 },
  { key: "medium", l: null }, { key: "semi-light", l: 72 }, { key: "light", l: 87 }, { key: "ultra-light", l: 95 },
];

const SPACE_KEYS = ["xs", "s", "m", "l", "xl", "xxl"];
// Step exponents for modular scale (section is outside the scale)
const SPACE_STEPS = { xs: -2, s: -1, m: 0, l: 1, xl: 2, xxl: 3 };

/* ================================================================
   STATE
   ================================================================ */
const initSpaceVals = (baseMob, baseDesk, scale) => {
  const r = {};
  Object.entries(SPACE_STEPS).forEach(([k, step]) => {
    const mult = Math.pow(scale, step);
    r[k] = { mobile: Math.round(baseMob * mult), desktop: Math.round(baseDesk * mult) };
  });
  // Section spacing: outside the modular scale, ~5× base
  r.section = { mobile: Math.round(baseMob * 5), desktop: Math.round(baseDesk * 5) };
  return r;
};

const initHeadings = (baseMob, baseDesk, scale) => {
  const hs = {};
  const steps = { h1: 2, h2: 1, h3: 0, h4: -1, h5: -2, h6: -3 };
  Object.entries(steps).forEach(([k, exp]) => {
    hs[k] = { mobile: Math.round(baseMob * Math.pow(scale, exp)), desktop: Math.round(baseDesk * Math.pow(scale, exp)) };
  });
  return hs;
};

const TEXT_KEYS = ["xs", "s", "m", "l", "xl", "xxl"];
const TEXT_STEPS = { xs: -2, s: -1, m: 0, l: 1, xl: 2, xxl: 3 };

const initTexts = (baseMob, baseDesk, scale) => {
  const ts = {};
  TEXT_KEYS.forEach((k) => {
    const exp = TEXT_STEPS[k];
    ts[k] = { mobile: Math.round(baseMob * Math.pow(scale, exp)), desktop: Math.round(baseDesk * Math.pow(scale, exp)) };
  });
  return ts;
};

const RADIUS_KEYS = ["xs", "s", "m", "l", "xl"];
const RADIUS_MULTS = { xs: 0.25, s: 0.5, m: 1, l: 1.5, xl: 2.5 };

// Grids — valores estáticos por defecto: columnas (1–12) y ratios asimétricos.
// minmax(0, Nfr) evita el overflow por min-width:auto (las columnas pueden encogerse).
const GRID_COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const GRID_RATIOS = [
  ["1-2", "minmax(0, 1fr) minmax(0, 2fr)"], ["1-3", "minmax(0, 1fr) minmax(0, 3fr)"],
  ["2-3", "minmax(0, 2fr) minmax(0, 3fr)"], ["3-2", "minmax(0, 3fr) minmax(0, 2fr)"],
  ["2-1", "minmax(0, 2fr) minmax(0, 1fr)"], ["3-1", "minmax(0, 3fr) minmax(0, 1fr)"],
];
const gridValue = (n) => "repeat(" + n + ", minmax(0, 1fr))";

// Buttons — 5 tamaños. "default" es la base (.btn); el resto son modificadores BEM.
// Padding en em (escala con el font-size del botón) expuesto como variables --pad-btn-*.
const BTN_SIZES = [
  { key: "xs",      label: "Extra Small", cls: "btn--xs" },
  { key: "s",       label: "Small",       cls: "btn--s" },
  { key: "default", label: "Default",     cls: "" },
  { key: "l",       label: "Large",       cls: "btn--l" },
  { key: "xl",      label: "Extra Large", cls: "btn--xl" },
];
// Cada tamaño de botón usa su fuente homónima (.btn--xs → --text-xs). El default usa --text-m.
const BTN_SIZE_DEFAULTS = {
  xs:      { py: 0.4,  px: 0.85, font: "xs" },
  s:       { py: 0.45, px: 0.95, font: "s" },
  default: { py: 0.5,  px: 1.1,  font: "m" },
  l:       { py: 0.55, px: 1.2,  font: "l" },
  xl:      { py: 0.6,  px: 1.3,  font: "xl" },
};
// Migra button.sizes de la escala antigua (sm/md/lg) a la nueva (xs/s/default/l/xl)
function normalizeButtons(buttons) {
  if (!buttons) return buttons;
  const keys = BTN_SIZES.map((s) => s.key);
  const sizes = buttons.sizes || {};
  const hasAllNew = keys.every((k) => sizes[k]);
  const hasOld = sizes.sm || sizes.md || sizes.lg;
  if (hasAllNew && !hasOld) return buttons; // ya está en el esquema nuevo
  return { ...buttons, sizes: JSON.parse(JSON.stringify(BTN_SIZE_DEFAULTS)) };
}
const btnEnabled = (state, id) => state.buttons?.enabled?.[id] !== false; // por defecto activado
const btnContrast = (l) => (l > 60 ? "#18181b" : "#ffffff");
// Estilo inline de botón compartido (paso Buttons + Landing) → ambos previews idénticos.
// hover=true replica el :hover del CSS exportado (sólido oscurece 10%; outline se rellena).
function buttonInlineStyle(state, p, sizeKey, outline, hover) {
  const b = state.buttons || { sizes: BTN_SIZE_DEFAULTS, radiusKey: "m" };
  const sz = (b.sizes && b.sizes[sizeKey]) || BTN_SIZE_DEFAULTS[sizeKey] || BTN_SIZE_DEFAULTS.default;
  const fontKey = TEXT_KEYS.includes(sz.font) ? sz.font : "m"; // tolera claves antiguas (p.ej. "mm")
  const fontPx = state.typography.texts[fontKey]?.desktop || 16;
  const radiusPx = b.radiusKey === "circle" ? state.radius.circle : (state.radius.values[b.radiusKey] || 0);
  const ms = b.transitionMs ?? 150;
  const col = "hsl(" + p.hue + "," + p.saturation + "%," + p.lightness + "%)";
  const dark = "hsl(" + p.hue + "," + p.saturation + "%," + Math.max(0, p.lightness - 10) + "%)";
  const onCol = btnContrast(p.lightness);
  const base = { fontSize: fontPx, padding: sz.py + "em " + sz.px + "em", borderRadius: radiusPx, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", lineHeight: 1.2, whiteSpace: "nowrap", transition: "all " + ms + "ms" };
  if (outline) return hover
    ? { ...base, border: "1.5px solid " + col, background: col, color: onCol }
    : { ...base, border: "1.5px solid " + col, background: "transparent", color: col };
  return hover
    ? { ...base, border: "1.5px solid " + dark, background: dark, color: onCol }
    : { ...base, border: "1.5px solid " + col, background: col, color: onCol };
}

// Botón de preview con hover real (los estilos inline no soportan :hover)
function PreviewButton({ state, palette, sizeKey, outline, children }) {
  const [hover, setHover] = useState(false);
  return (
    <button style={buttonInlineStyle(state, palette, sizeKey, outline, hover)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {children || "Button"}
    </button>
  );
}

const initVariants = (h, s, l) => {
  const v = {};
  VARIANT_LIGHTNESS.forEach(({ key, l: vl }) => {
    v[key] = "hsl(" + h + ", " + s + "%, " + (vl === null ? l : vl) + "%)";
  });
  return v;
};

const initialState = {
  currentStep: 1,
  layoutMode: "", minViewport: 375, maxViewport: 1920,
  spacing: {
    baseMobile: 20, baseDesktop: 24, scale: 1.5,
    values: initSpaceVals(20, 24, 1.5),
  },
  sectionSpacing: {
    baseMobile: 100, baseDesktop: 120, scale: 1.5,
    values: initSpaceVals(100, 120, 1.5),
  },
  gutter: { mobile: 16, desktop: 64 },
  offset: 80,
  styles: { textColor: "var(--black)", headingColor: "var(--black)", textWeight: 400, headingWeight: 700 },
  typography: {
    useScale: true,
    headingScale: 1.25, headingBaseMob: 28, headingBaseDesk: 35,
    headings: initHeadings(28, 35, 1.25),
    textScale: 1.25, textBaseMob: 16, textBaseDesk: 18,
    texts: initTexts(16, 18, 1.25),
    lineHeightHeading: 1.2, lineHeightBody: 1.6,
  },
  colors: {
    palettes: [
      { id: 1, name: "Primary", hue: 210, saturation: 75, lightness: 50, showVariants: false, variants: initVariants(210, 75, 50), showTransparency: false },
    ],
    whiteTransparency: true, blackTransparency: true,
  },
  gaps: { gridGap: "var(--space-m)", contentGap: "var(--space-s)", containerGap: "var(--space-l)" },
  buttons: {
    outline: true,
    radiusKey: "m",
    transitionMs: 150,
    enabled: {},
    sizes: JSON.parse(JSON.stringify(BTN_SIZE_DEFAULTS)),
  },
  radius: { base: 8, values: {}, circle: 999 },
  varPrefix: "",
};

// Init radius
RADIUS_KEYS.forEach((k) => { initialState.radius.values[k] = Math.round(8 * RADIUS_MULTS[k]); });


/* ================================================================
   LIBRARY — múltiples sistemas de diseño guardados
   ================================================================ */
const LIB_KEY = "bricksmate-dsg-library";
const OLD_KEY = "bricksmate-dsg";
const SESSION_KEY = "bricksmate-dsg-session"; // id del sistema abierto → vuelve al editor tras refrescar
const nowISO = () => new Date().toISOString();
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}
function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (raw) {
      const lib = JSON.parse(raw);
      if (lib && Array.isArray(lib.systems)) return { autoSave: lib.autoSave !== false, systems: lib.systems };
    }
    // Migración desde la versión de documento único
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const doc = { ...initialState, ...JSON.parse(old) };
      const lib = { autoSave: true, systems: [{ id: "sys_" + randId(), name: "My first system", createdAt: nowISO(), updatedAt: nowISO(), doc }] };
      localStorage.setItem(LIB_KEY, JSON.stringify(lib));
      return lib;
    }
  } catch {}
  return { autoSave: true, systems: [] };
}
function persistLibrary(lib) { try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch {} }

// ===== Capa nube (Supabase) — mapea filas ↔ formato de la app =====
const rowToSys = (r) => ({ id: r.id, name: r.name, doc: r.doc, createdAt: r.created_at, updatedAt: r.updated_at });
async function cloudListSystems() {
  const { data, error } = await supabase.from("systems").select("*").order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToSys);
}
async function cloudInsertSystem(sys) {
  const { error } = await supabase.from("systems").insert({ id: sys.id, name: sys.name, doc: sys.doc, created_at: sys.createdAt, updated_at: sys.updatedAt });
  if (error) throw error;
}
async function cloudUpdateSystem(id, fields) {
  const { error } = await supabase.from("systems").update(fields).eq("id", id);
  if (error) throw error;
}
async function cloudDeleteSystem(id) {
  const { error } = await supabase.from("systems").delete().eq("id", id);
  if (error) throw error;
}
const isLimitError = (e) => !!e && (e.message || "").includes("SYSTEMS_LIMIT_REACHED");

function reducer(state, action) {
  switch (action.type) {
    case "LOAD_DOC": return { ...action.payload, buttons: normalizeButtons(action.payload.buttons) };
    case "SET_STEP": return { ...state, currentStep: action.payload };
    case "SET_LAYOUT_MODE": return { ...state, layoutMode: action.payload, maxViewport: action.payload === "fixed" ? 1280 : 1920 };
    case "SET_FIELD": return { ...state, [action.field]: action.value };
    case "SET_SPACE_VALUE": {
      const nv = { ...state.spacing.values, [action.key]: { ...state.spacing.values[action.key], [action.side]: action.value } };
      return { ...state, spacing: { ...state.spacing, values: nv } };
    }
    case "RECALC_SPACING": {
      const { baseMobile: bm, baseDesktop: bd } = action;
      const sc = action.scale ?? state.spacing.scale;
      const nv = initSpaceVals(bm, bd, sc);
      return { ...state, spacing: { ...state.spacing, baseMobile: bm, baseDesktop: bd, scale: sc, values: nv } };
    }
    case "SET_SECTION_SPACE_VALUE": {
      const nv = { ...state.sectionSpacing.values, [action.key]: { ...state.sectionSpacing.values[action.key], [action.side]: action.value } };
      return { ...state, sectionSpacing: { ...state.sectionSpacing, values: nv } };
    }
    case "RECALC_SECTION_SPACING": {
      const { baseMobile: bm, baseDesktop: bd } = action;
      const sc = action.scale ?? state.sectionSpacing.scale;
      const nv = initSpaceVals(bm, bd, sc);
      return { ...state, sectionSpacing: { ...state.sectionSpacing, baseMobile: bm, baseDesktop: bd, scale: sc, values: nv } };
    }
    case "SET_TYPO": return { ...state, typography: { ...state.typography, ...action.payload } };
    case "SET_HEADING_VAL": {
      const nh = { ...state.typography.headings, [action.key]: { ...state.typography.headings[action.key], [action.side]: action.value } };
      return { ...state, typography: { ...state.typography, headings: nh } };
    }
    case "SET_TEXT_VAL": {
      const nt = { ...state.typography.texts, [action.key]: { ...state.typography.texts[action.key], [action.side]: action.value } };
      return { ...state, typography: { ...state.typography, texts: nt } };
    }
    case "RECALC_HEADINGS": {
      const { baseMob, baseDesk, scale } = action;
      return { ...state, typography: { ...state.typography, headingBaseMob: baseMob, headingBaseDesk: baseDesk, headingScale: scale, headings: initHeadings(baseMob, baseDesk, scale) } };
    }
    case "RECALC_TEXTS": {
      const { baseMob, baseDesk, scale } = action;
      return { ...state, typography: { ...state.typography, textBaseMob: baseMob, textBaseDesk: baseDesk, textScale: scale, texts: initTexts(baseMob, baseDesk, scale) } };
    }
    case "UPDATE_PALETTE": {
      const ps = state.colors.palettes.map((p) => p.id === action.id ? { ...p, [action.field]: action.value } : p);
      return { ...state, colors: { ...state.colors, palettes: ps } };
    }
    case "UPDATE_PALETTE_VARIANT": {
      const ps = state.colors.palettes.map((p) => p.id === action.id ? { ...p, variants: { ...p.variants, [action.key]: action.value } } : p);
      return { ...state, colors: { ...state.colors, palettes: ps } };
    }
    case "ADD_PALETTE": {
      const nid = Math.max(...state.colors.palettes.map((p) => p.id), 0) + 1;
      return { ...state, colors: { ...state.colors, palettes: [...state.colors.palettes, { id: nid, name: "Color " + nid, hue: 210, saturation: 75, lightness: 50, showVariants: false, variants: initVariants(210, 75, 50), showTransparency: false }] } };
    }
    case "REMOVE_PALETTE": return { ...state, colors: { ...state.colors, palettes: state.colors.palettes.filter((p) => p.id !== action.id) } };
    case "SET_COLORS": return { ...state, colors: { ...state.colors, ...action.payload } };
    case "SET_GUTTER": return { ...state, gutter: { ...state.gutter, [action.side]: action.value } };
    case "SET_STYLE": return { ...state, styles: { ...state.styles, [action.field]: action.value } };
    case "SET_GAPS": return { ...state, gaps: { ...state.gaps, [action.field]: action.value } };
    case "SET_RADIUS": return { ...state, radius: { ...state.radius, ...action.payload } };
    case "SET_RADIUS_VAL": return { ...state, radius: { ...state.radius, values: { ...state.radius.values, [action.key]: action.value } } };
    case "RECALC_RADIUS": {
      const b = action.base;
      const nv = {}; RADIUS_KEYS.forEach((k) => { nv[k] = Math.round(b * RADIUS_MULTS[k]); });
      return { ...state, radius: { ...state.radius, base: b, values: nv } };
    }
    case "SET_BTN": return { ...state, buttons: { ...state.buttons, ...action.payload } };
    case "SET_BTN_SIZE": {
      const sizes = { ...state.buttons.sizes, [action.key]: { ...state.buttons.sizes[action.key], [action.field]: action.value } };
      return { ...state, buttons: { ...state.buttons, sizes } };
    }
    case "RESET_BTN_SIZES": return { ...state, buttons: { ...state.buttons, sizes: JSON.parse(JSON.stringify(BTN_SIZE_DEFAULTS)) } };
    case "TOGGLE_BTN_COLOR": {
      const cur = state.buttons.enabled?.[action.id] !== false;
      return { ...state, buttons: { ...state.buttons, enabled: { ...state.buttons.enabled, [action.id]: !cur } } };
    }
    default: return state;
  }
}

const DSContext = createContext();
function useDSContext() { return useContext(DSContext); }

/* ================================================================
   STEPS CONFIG
   ================================================================ */
const STEPS = [
  { id: 1, label: "Layout Mode", check: (s) => s.layoutMode !== "" },
  { id: 2, label: "Spacing", check: (s) => s.spacing.baseMobile > 0 },
  { id: 3, label: "Section Spacing", check: (s) => s.sectionSpacing.baseMobile > 0 },
  { id: 4, label: "Colors", check: (s) => s.colors.palettes.length > 0 },
  { id: 5, label: "Typography", check: (s) => s.typography.headingBaseMob > 0 },
  { id: 6, label: "Gaps & Grid", check: (s) => s.gaps.gridGap !== "" },
  { id: 7, label: "Border Radius", check: (s) => s.radius.base >= 0 },
  { id: 8, label: "Buttons", check: (s) => !!s.buttons },
  { id: 9, label: "Preview", check: () => false },
  { id: 10, label: "Export", check: () => false },
];
const DESCS = {
  1: "Choose layout approach and viewport range",
  2: "Define spacing scale (xs–xxl) with mobile and desktop values",
  3: "Define section spacing scale (xs–xxl) for large containers",
  4: "Build color palettes with variants and transparencies",
  5: "Configure typography scale for headings and text sizes",
  6: "Define gap variables and ready-to-use grid layouts",
  7: "Set border radius scale from a base value",
  8: "Generate button styles per color, size and outline variant",
  9: "Preview your complete design system",
  10: "Download your design system as CSS custom properties",
};

/* ================================================================
   STYLES
   ================================================================ */
const css_styles = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  :root {
    --ds-primary:hsl(240,5.9%,10%); --ds-primary-hover:hsl(240,5.9%,18%); --ds-primary-light:hsl(240,4.8%,95.9%);
    --ds-bg:hsl(0,0%,98%); --ds-bg-card:hsl(0,0%,100%);
    --ds-text:hsl(240,10%,3.9%); --ds-text-2:hsl(240,3.7%,46.1%); --ds-text-3:hsl(240,5%,64.9%);
    --ds-border:hsl(240,5.9%,90%); --ds-border-light:hsl(240,4.8%,95.5%);
    --ds-success:hsl(142,71%,38%); --ds-error:hsl(0,84%,55%);
    --ds-accent:hsl(250,88%,66%); --ds-accent-hover:hsl(250,88%,58%); --ds-accent-light:hsl(250,100%,97%); --ds-accent-ring:hsla(250,88%,66%,.20);
    --ds-radius:8px; --ds-radius-lg:12px;
    --ds-shadow:0 1px 2px rgba(0,0,0,.05);
    --ds-shadow-md:0 1px 3px rgba(0,0,0,.08),0 1px 2px -1px rgba(0,0,0,.05);
  }
  [data-theme="dark"] {
    /* Negro neutro (#000) + acento #765DF5 */
    --ds-primary:hsl(0,0%,98%); --ds-primary-hover:hsl(0,0%,88%); --ds-primary-light:hsl(0,0%,18%);
    --ds-bg:hsl(0,0%,7.35%); --ds-bg-card:hsl(0,0%,9%);
    --ds-text:hsl(0,0%,98%); --ds-text-2:hsl(0,0%,70%); --ds-text-3:hsl(0,0%,50%);
    --ds-border:hsl(0,0%,24%); --ds-border-light:hsl(0,0%,16%);
    --ds-success:hsl(142,69%,52%); --ds-error:hsl(0,84%,66%);
    --ds-accent:hsl(250,88%,66%); --ds-accent-hover:hsl(250,88%,73%); --ds-accent-light:hsl(250,40%,18%); --ds-accent-ring:hsla(250,88%,66%,.25);
    --ds-shadow:0 1px 2px rgba(0,0,0,.6);
    --ds-shadow-md:0 2px 4px rgba(0,0,0,.7),0 1px 2px rgba(0,0,0,.5);
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--ds-bg);color:var(--ds-text);line-height:1.6;-webkit-font-smoothing:antialiased}
  .ds-app{display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .ds-header{background:var(--ds-bg-card);border-bottom:1px solid var(--ds-border-light);padding:0 24px;height:54px;display:flex;align-items:center;gap:12px;box-shadow:var(--ds-shadow)}
  .ds-header-icon{width:30px;height:30px;border-radius:var(--ds-radius);flex-shrink:0;display:block}
  .ds-header h1{font-size:14px;font-weight:600;letter-spacing:-.01em} .ds-header p{font-size:11px;color:var(--ds-text-2);margin-top:1px}
  .ds-main{display:flex;flex:1;overflow:hidden}
  .ds-sidebar{width:200px;background:var(--ds-bg-card);border-right:1px solid var(--ds-border-light);padding:12px 8px;overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column}
  .ds-sidebar-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.7px;color:var(--ds-text-3);padding:0 10px;margin-bottom:6px}
  .ds-step-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--ds-radius);cursor:pointer;transition:all .15s;margin-bottom:1px;position:relative}
  .ds-step-item::before{content:'';position:absolute;left:0;top:18%;bottom:18%;width:2px;border-radius:2px;background:transparent;transition:background .15s}
  .ds-step-item:hover{background:var(--ds-bg)}
  .ds-step-item.active{background:var(--ds-bg)} .ds-step-item.active::before{background:var(--ds-primary)}
  .ds-step-num{font-size:12px;font-weight:500;color:var(--ds-text-3);width:16px;flex-shrink:0;text-align:center}
  .ds-step-item.active .ds-step-num{color:var(--ds-primary)}
  .ds-step-label{font-size:13px;font-weight:400;flex:1;color:var(--ds-text-2)} .ds-step-item.active .ds-step-label{color:var(--ds-text);font-weight:500}
  .ds-step-check{width:14px;height:14px;border-radius:50%;background:var(--ds-success);color:var(--ds-bg);font-size:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .ds-content{flex:1;display:flex;flex-direction:column;overflow:hidden}
  .ds-content-header{background:var(--ds-bg-card);padding:14px 24px;border-bottom:1px solid var(--ds-border-light)}
  .ds-content-header h2{font-size:17px;font-weight:600;letter-spacing:-.02em} .ds-content-header p{font-size:13px;color:var(--ds-text-2);margin-top:3px}
  .ds-content-body{flex:1;padding:24px;overflow-y:auto}
  .ds-footer{background:var(--ds-bg-card);border-top:1px solid var(--ds-border-light);padding:10px 24px;display:flex;justify-content:space-between;align-items:center}
  .ds-footer-info{font-size:12px;color:var(--ds-text-3)} .ds-footer-actions{display:flex;gap:8px}
  .ds-btn{padding:7px 14px;border:1px solid var(--ds-border);background:var(--ds-bg-card);color:var(--ds-text);border-radius:var(--ds-radius);font-size:13px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .15s;font-family:inherit;box-shadow:var(--ds-shadow)}
  .ds-btn:hover:not(:disabled){background:var(--ds-bg)} .ds-btn:active:not(:disabled){transform:scale(.99)} .ds-btn:disabled{opacity:.45;cursor:not-allowed}
  .ds-btn-primary{background:var(--ds-primary);color:hsl(0,0%,98%);border-color:var(--ds-primary);box-shadow:0 1px 2px rgba(0,0,0,.1)} .ds-btn-primary:hover:not(:disabled){background:var(--ds-primary-hover);border-color:var(--ds-primary-hover)}
  [data-theme="dark"] .ds-btn-primary,[data-theme="dark"] .ds-download-btn{color:hsl(0,0%,4%)}
  [data-theme="dark"] .ds-input:focus{box-shadow:0 0 0 3px rgba(255,255,255,.1)}
  [data-theme="dark"] .ds-space-input:focus{box-shadow:0 0 0 3px rgba(255,255,255,.1)}
  [data-theme="dark"] .ds-input-error{box-shadow:0 0 0 3px rgba(239,68,68,.2)!important}
  [data-theme="dark"] .ds-space-row.alt{background:hsl(0,0%,11%)}
  .ds-btn-sm{padding:5px 10px;font-size:12px} .ds-btn-danger{color:var(--ds-error);border-color:var(--ds-error)} .ds-btn-danger:hover:not(:disabled){background:rgba(239,68,68,.06)}
  .ds-input{width:100%;padding:7px 11px;border:1px solid var(--ds-border);border-radius:var(--ds-radius);font-size:14px;font-family:inherit;color:var(--ds-text);background:var(--ds-bg-card);transition:all .15s;box-shadow:var(--ds-shadow)}
  .ds-input:hover{border-color:var(--ds-border)}
  .ds-input:focus{outline:none;border-color:var(--ds-primary);box-shadow:0 0 0 3px rgba(0,0,0,.08)}
  .ds-input::placeholder{color:var(--ds-text-3);opacity:1}
  .ds-input-sm{padding:6px 10px;font-size:13px}
  .ds-input-error{border-color:var(--ds-error)!important;box-shadow:0 0 0 3px rgba(239,68,68,.1)!important}
  .ds-helper{font-size:12px;color:var(--ds-text-3);margin-top:5px}
  .ds-form-group{margin-bottom:18px} .ds-form-group label{display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:var(--ds-text)}
  .ds-card{background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);padding:18px;margin-bottom:16px;box-shadow:var(--ds-shadow)} .ds-card h4{font-size:13px;font-weight:600;margin-bottom:12px}
  .ds-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px} .ds-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
  .ds-mode-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px}
  .ds-mode-card{position:relative;background:var(--ds-bg-card);border:1.5px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);padding:20px;cursor:pointer;transition:all .2s;text-align:center;box-shadow:var(--ds-shadow)}
  .ds-mode-card:hover{border-color:var(--ds-border);box-shadow:var(--ds-shadow-md)} .ds-mode-card.selected{border-color:var(--ds-accent);background:var(--ds-accent-light);box-shadow:0 0 0 3px var(--ds-accent-ring)}
  .ds-mode-cards.has-sel .ds-mode-card:not(.selected){opacity:.5} .ds-mode-cards.has-sel .ds-mode-card:not(.selected):hover{opacity:1}
  .ds-mode-check{position:absolute;top:10px;right:10px;width:20px;height:20px;border-radius:50%;background:var(--ds-accent);color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;line-height:1}
  .ds-mode-card.selected .ds-mode-check{display:flex}
  .ds-mode-icon{margin-bottom:12px;display:flex;justify-content:center;color:var(--ds-text-3)} .ds-mode-card.selected .ds-mode-icon{color:var(--ds-accent)}
  .ds-mode-info{background:var(--ds-accent-light);border:1px solid var(--ds-accent-ring);border-radius:var(--ds-radius);padding:11px 14px;font-size:12.5px;line-height:1.55;color:var(--ds-text-2);margin-bottom:18px}
  .ds-mode-info strong{color:var(--ds-text)}
  .ds-mode-info .sub{display:block;margin-top:6px;color:var(--ds-text-3);font-size:11.5px}
  .ds-mode-card h3{font-size:14px;font-weight:600;margin-bottom:4px} .ds-mode-card p{font-size:12px;color:var(--ds-text-2);line-height:1.5}
  .ds-viewport-config{background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);padding:18px;margin-bottom:16px;box-shadow:var(--ds-shadow)} .ds-viewport-config h4{font-size:13px;font-weight:600;margin-bottom:14px}
  .ds-viewport-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
  .ds-toggle-row{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--ds-bg);border-radius:var(--ds-radius);border:1px solid var(--ds-border-light);cursor:pointer;user-select:none;margin-bottom:10px;transition:border-color .15s}
  .ds-toggle-row:hover{border-color:var(--ds-border)}
  .ds-toggle-track{width:32px;height:18px;border-radius:9px;background:var(--ds-border);position:relative;transition:background .2s;flex-shrink:0}
  .ds-toggle-track.on{background:var(--ds-primary)} .ds-toggle-thumb{width:14px;height:14px;border-radius:50%;background:var(--ds-bg-card);position:absolute;top:2px;left:2px;transition:transform .2s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
  .ds-toggle-track.on .ds-toggle-thumb{transform:translateX(14px)} .ds-toggle-text{flex:1} .ds-toggle-text strong{font-size:13px;font-weight:500;display:block} .ds-toggle-text span{font-size:12px;color:var(--ds-text-2)}
  .ds-space-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:var(--ds-radius);margin-bottom:4px;background:var(--ds-bg-card);border:1px solid var(--ds-border-light)}
  .ds-space-row.alt{background:var(--ds-bg)}
  .ds-space-name{min-width:160px;font-size:12px;font-weight:500;color:var(--ds-text-2);font-family:'SF Mono',Consolas,monospace}
  .ds-space-inputs{display:flex;gap:8px;flex:1}
  .ds-space-input{width:68px;padding:5px 8px;border:1px solid var(--ds-border);border-radius:var(--ds-radius);font-size:13px;text-align:center;background:var(--ds-bg-card);font-family:inherit;color:var(--ds-text);transition:all .15s;box-shadow:var(--ds-shadow)}
  .ds-space-input:hover{border-color:var(--ds-border)} .ds-space-input:focus{outline:none;border-color:var(--ds-primary);box-shadow:0 0 0 3px rgba(0,0,0,.08)}
  .ds-space-bar{height:16px;border-radius:4px;background:var(--ds-text-3);border:1px solid var(--ds-border);transition:width .3s;min-width:4px}
  .ds-space-label{font-size:10px;color:var(--ds-text-3);text-align:center;margin-top:2px}
  .ds-palette-card{background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);padding:18px;margin-bottom:14px;box-shadow:var(--ds-shadow)}
  .ds-palette-header{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .ds-palette-header input[type="text"]{flex:1;border:none;border-bottom:1.5px solid var(--ds-border-light);font-size:14px;font-weight:600;padding:0 0 4px;background:transparent;color:var(--ds-text);outline:none;transition:border-color .15s;cursor:text;min-width:0;font-family:inherit}
  .ds-palette-header input[type="text"]:hover{border-bottom-color:var(--ds-border)}
  .ds-palette-header input[type="text"]:focus{border-bottom-color:var(--ds-primary)}
  .ds-color-picker-row{display:flex;align-items:flex-start;gap:14px;margin-bottom:14px}
  .ds-color-swatch{width:60px;height:60px;border-radius:var(--ds-radius);border:1px solid var(--ds-border);overflow:hidden;flex-shrink:0;position:relative;cursor:pointer;box-shadow:var(--ds-shadow-md)}
  .ds-color-swatch input[type="color"]{position:absolute;inset:-8px;width:calc(100% + 16px);height:calc(100% + 16px);border:none;cursor:pointer}
  .ds-variants-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-top:12px;align-items:stretch}
  .ds-variant-item{text-align:center;display:flex;flex-direction:column}
  .ds-variant-box{height:44px;border-radius:5px;border:1px solid var(--ds-border-light);position:relative;overflow:hidden;cursor:pointer}
  .ds-variant-box input[type=color]{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:none;padding:0;margin:0;cursor:pointer}
  .ds-variant-label{font-size:10px;color:var(--ds-text-3);margin-top:3px;font-family:monospace;flex:1}
  .ds-variant-input{width:100%;padding:4px 6px;border:1px solid var(--ds-border);border-radius:4px;font-size:11px;text-align:center;font-family:monospace;margin-top:3px;background:var(--ds-bg-card);color:var(--ds-text);transition:border-color .15s}
  .ds-variant-input:focus{outline:none;border-color:var(--ds-primary)}
  .ds-transparency-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:5px;margin-top:8px}
  .ds-trans-box{height:40px;border-radius:5px;background-image:linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%);background-size:10px 10px;background-position:0 0,0 5px,5px -5px,-5px 0;position:relative;overflow:hidden}
  [data-theme="dark"] .ds-trans-box{background-image:linear-gradient(45deg,#555 25%,transparent 25%),linear-gradient(-45deg,#555 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#555 75%),linear-gradient(-45deg,transparent 75%,#555 75%)}
  .ds-trans-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--ds-text);text-shadow:0 1px 2px rgba(0,0,0,.3)}
  .ds-preview-section{margin-bottom:24px} .ds-preview-section-title{font-size:14px;font-weight:600;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--ds-border-light)}
  .ds-export-card{background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);padding:22px;box-shadow:var(--ds-shadow)}
  .ds-download-btn{width:100%;padding:11px 24px;background:var(--ds-primary);color:hsl(0,0%,98%);border:none;border-radius:var(--ds-radius);font-size:14px;font-weight:500;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:8px;font-family:inherit;box-shadow:0 1px 2px rgba(0,0,0,.1)}
  .ds-download-btn:hover:not(:disabled){background:var(--ds-primary-hover)} .ds-download-btn:disabled{opacity:.45;cursor:not-allowed}
  .ds-warning{padding:10px 14px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.25);border-radius:var(--ds-radius);font-size:13px;color:var(--ds-error);margin-bottom:14px;cursor:pointer}
  .ds-status{padding:10px 14px;border-radius:var(--ds-radius);font-size:13px;margin-top:14px} .ds-status.ok{background:rgba(34,197,94,.07);color:var(--ds-success);border:1px solid rgba(34,197,94,.2)}
  .ds-export-grid{display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));gap:14px;margin-bottom:18px}
  .ds-export-file-card{background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);padding:18px;display:flex;flex-direction:column;box-shadow:var(--ds-shadow)}
  .ds-export-file-card h4{font-size:14px;font-weight:600;margin-bottom:4px}
  .ds-export-file-card>p{font-size:12px;color:var(--ds-text-2);margin-bottom:14px;line-height:1.5}
  .ds-export-file-card .ds-download-btn{font-size:13px;padding:9px 14px;margin-top:auto}
  .ds-resize-handle{position:absolute;top:0;bottom:0;right:-18px;width:18px;display:flex;align-items:center;justify-content:center;cursor:ew-resize;touch-action:none}
  .ds-resize-handle::before{content:'';width:5px;height:46px;border-radius:3px;background:var(--ds-border);transition:background .15s}
  .ds-resize-handle:hover::before{background:var(--ds-primary)}
  .ds-btn-sizes{display:flex;flex-direction:column;gap:8px}
  .ds-btn-sizes-head,.ds-btn-sizes-row{display:grid;grid-template-columns:1.3fr 1fr 1fr 1.1fr;gap:10px;align-items:center}
  .ds-btn-sizes-head{font-size:11px;color:var(--ds-text-3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:0 2px 2px}
  .ds-btn-size-label{font-size:13px;font-weight:500}
  .ds-btn-size-label em{font-style:normal;color:var(--ds-text-3);font-family:'SF Mono',Consolas,monospace;font-size:11px}
  .ds-grid-chip{padding:11px 10px;text-align:center;font-size:13px;font-weight:500;color:var(--ds-text);background:var(--ds-bg);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius);font-family:'SF Mono',Consolas,monospace;cursor:default;transition:border-color .15s}
  .ds-grid-chip:hover{border-color:var(--ds-border)}
  .ds-view-toggle{display:inline-flex;gap:2px;padding:3px;background:var(--ds-border-light);border-radius:var(--ds-radius);margin-bottom:20px}
  .ds-view-btn{padding:6px 16px;font-size:13px;font-weight:500;border:none;background:transparent;color:var(--ds-text-2);border-radius:6px;cursor:pointer;transition:all .15s;font-family:inherit}
  .ds-view-btn.active{background:var(--ds-bg-card);color:var(--ds-text);box-shadow:var(--ds-shadow)} .ds-view-btn:hover:not(.active){color:var(--ds-text)}
  .ds-header-reset{padding:5px 11px;border:1px solid var(--ds-border);border-radius:var(--ds-radius);font-size:12px;background:var(--ds-bg-card);color:var(--ds-text-2);cursor:pointer;transition:all .15s;white-space:nowrap;font-family:inherit;box-shadow:var(--ds-shadow)}
  .ds-header-reset:hover{background:var(--ds-bg);color:var(--ds-text)}
  .ds-header-theme{width:30px;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--ds-border);border-radius:var(--ds-radius);background:var(--ds-bg-card);color:var(--ds-text-2);cursor:pointer;transition:all .15s;box-shadow:var(--ds-shadow)}
  .ds-header-theme:hover{background:var(--ds-bg);color:var(--ds-text)}
  .ds-header-theme svg{display:block}
  .ds-header-back{width:30px;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px solid var(--ds-border);border-radius:var(--ds-radius);font-size:16px;background:var(--ds-bg-card);color:var(--ds-text);cursor:pointer;transition:all .15s;box-shadow:var(--ds-shadow)}
  .ds-header-back:hover{background:var(--ds-bg)}
  .ds-autosave{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none;font-size:12px;color:var(--ds-text-2);white-space:nowrap}
  /* Dashboard */
  .ds-dash{flex:1;overflow-y:auto;padding:28px 32px}
  .ds-dash-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:24px;max-width:1100px;margin-left:auto;margin-right:auto}
  .ds-dash-title{font-size:20px;font-weight:700;letter-spacing:-.02em}
  .ds-dash-sub{font-size:13px;color:var(--ds-text-2);margin-top:3px}
  .ds-dash-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:16px;max-width:1100px;margin:0 auto}
  .ds-dash-empty{text-align:center;padding:64px 20px;max-width:420px;margin:40px auto;border:1px dashed var(--ds-border);border-radius:var(--ds-radius-lg)}
  .ds-sys-card{background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);overflow:hidden;box-shadow:var(--ds-shadow);transition:box-shadow .15s,border-color .15s;display:flex;flex-direction:column}
  .ds-sys-card:hover{box-shadow:var(--ds-shadow-md);border-color:var(--ds-border)}
  .ds-sys-swatches{display:flex;height:56px;cursor:pointer}
  .ds-sys-swatches>div{flex:1}
  .ds-sys-body{padding:14px 16px 10px}
  .ds-sys-name{font-size:15px;font-weight:600;letter-spacing:-.01em;cursor:text;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ds-sys-meta{font-size:11.5px;color:var(--ds-text-3);margin-top:4px}
  .ds-sys-actions{display:flex;gap:6px;padding:10px 16px 14px;margin-top:auto}
  .ds-sys-actions .ds-btn-primary{flex:1}
  .ds-validation-block{margin-bottom:14px;display:flex;flex-direction:column;gap:5px}
  .ds-val-item{padding:8px 11px;border-radius:var(--ds-radius);font-size:12px;display:flex;align-items:flex-start;gap:8px;line-height:1.4}
  .ds-val-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;margin-top:4px}
  .ds-val-warn{background:rgba(234,179,8,.07);color:hsl(38,92%,28%);border:1px solid rgba(234,179,8,.25)} .ds-val-warn .ds-val-dot{background:hsl(38,92%,48%)}
  [data-theme="dark"] .ds-val-warn{background:rgba(234,179,8,.1);color:hsl(38,92%,68%)}
  .ds-val-error{background:rgba(239,68,68,.06);color:var(--ds-error);border:1px solid rgba(239,68,68,.2)} .ds-val-error .ds-val-dot{background:var(--ds-error)}
  .ds-val-info{background:var(--ds-border-light);color:var(--ds-text);border:1px solid var(--ds-border)} .ds-val-info .ds-val-dot{background:var(--ds-text-2)}
  ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:var(--ds-border-light);border-radius:3px}

  /* ===== Accent (violeta, contenido) ===== */
  .ds-step-item.active::before{background:var(--ds-accent)}
  .ds-step-item.active .ds-step-num{color:var(--ds-accent)}
  .ds-input:focus,.ds-space-input:focus,.ds-variant-input:focus{border-color:var(--ds-accent);box-shadow:0 0 0 3px var(--ds-accent-ring)}
  [data-theme="dark"] .ds-input:focus,[data-theme="dark"] .ds-space-input:focus{box-shadow:0 0 0 3px var(--ds-accent-ring)}
  .ds-input-error:focus{border-color:var(--ds-error)!important;box-shadow:0 0 0 3px rgba(239,68,68,.18)!important}
  .ds-toggle-track.on{background:var(--ds-accent)}
  .ds-palette-header input[type="text"]:focus{border-bottom-color:var(--ds-accent)}

  /* ===== Tier 1: motion & micro-interacciones ===== */
  @keyframes ds-step-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .ds-step-anim{animation:ds-step-in .3s cubic-bezier(.16,1,.3,1)}
  @keyframes ds-check-pop{0%{transform:scale(0);opacity:0}60%{transform:scale(1.25)}100%{transform:scale(1);opacity:1}}
  .ds-step-check{animation:ds-check-pop .32s cubic-bezier(.34,1.56,.64,1)}
  .ds-mode-card,.ds-export-file-card,.ds-sys-card{transition:transform .18s cubic-bezier(.16,1,.3,1),box-shadow .18s,border-color .18s}
  .ds-mode-card:hover,.ds-export-file-card:hover,.ds-sys-card:hover{transform:translateY(-3px)}
  .ds-grid-chip{transition:transform .15s,border-color .15s,color .15s}
  .ds-grid-chip:hover{transform:translateY(-1px);border-color:var(--ds-accent);color:var(--ds-accent)}
  .ds-btn:active:not(:disabled),.ds-btn-primary:active:not(:disabled),.ds-download-btn:active:not(:disabled){transform:scale(.97)}
  .ds-step-item{transition:background .15s,transform .12s} .ds-step-item:active{transform:translateX(1px)}

  /* ===== Progress bar ===== */
  .ds-progress{height:3px;background:var(--ds-border-light);flex-shrink:0;overflow:hidden}
  .ds-progress-bar{height:100%;background:var(--ds-accent);border-radius:0 3px 3px 0;transition:width .4s cubic-bezier(.16,1,.3,1)}

  /* ===== Toasts ===== */
  .ds-toasts{position:fixed;top:72px;right:18px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
  @keyframes ds-toast-in{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
  .ds-toast{display:flex;align-items:center;gap:9px;background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius);padding:10px 14px;font-size:13px;font-weight:500;color:var(--ds-text);box-shadow:var(--ds-shadow-md);animation:ds-toast-in .28s cubic-bezier(.16,1,.3,1);pointer-events:auto;min-width:200px}
  .ds-toast-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .ds-toast.ok .ds-toast-dot{background:var(--ds-success)} .ds-toast.info .ds-toast-dot{background:var(--ds-accent)} .ds-toast.err .ds-toast-dot{background:var(--ds-error)}

  /* ===== Tier 2: profundidad & pulido ===== */
  .ds-sys-swatches{position:relative}
  .ds-sys-swatches::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(0,0,0,.14));pointer-events:none}
  .ds-mode-card:hover,.ds-export-file-card:hover,.ds-sys-card:hover{border-color:var(--ds-accent)}
  .ds-card,.ds-palette-card,.ds-viewport-config{transition:border-color .18s,box-shadow .18s}
  select.ds-input{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;padding-right:30px;cursor:pointer}
  .ds-content-header,.ds-footer,.ds-sidebar{position:relative;z-index:1}
  .ds-header{position:relative;z-index:20}
  /* Export success */
  .ds-dl-done{background:var(--ds-success)!important;color:#fff!important;animation:ds-dl-pop .4s}
  @keyframes ds-dl-pop{0%{transform:scale(1)}40%{transform:scale(1.05)}100%{transform:scale(1)}}
  /* Tooltips (debajo del elemento) */
  [data-tip]{position:relative}
  [data-tip]:hover::after{content:attr(data-tip);position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);background:var(--ds-text);color:var(--ds-bg);font-size:11px;font-weight:500;line-height:1.3;padding:5px 9px;border-radius:6px;white-space:nowrap;z-index:1000;pointer-events:none;box-shadow:var(--ds-shadow-md);animation:ds-tip .14s ease-out}
  [data-tip]:hover::before{content:'';position:absolute;top:calc(100% + 3px);left:50%;transform:translateX(-50%);border:5px solid transparent;border-bottom-color:var(--ds-text);z-index:1000;pointer-events:none}
  @keyframes ds-tip{from{opacity:0;transform:translateX(-50%) translateY(-3px)}to{opacity:1}}
  /* Number steppers (+/−) */
  .ds-stepper{display:flex;align-items:stretch;border:1px solid var(--ds-border);border-radius:var(--ds-radius);background:var(--ds-bg-card);box-shadow:var(--ds-shadow);overflow:hidden;transition:border-color .15s,box-shadow .15s}
  .ds-stepper:focus-within{border-color:var(--ds-accent);box-shadow:0 0 0 3px var(--ds-accent-ring)}
  .ds-stepper-btn{width:30px;flex-shrink:0;border:none;background:transparent;color:var(--ds-text-2);font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s;font-family:inherit}
  .ds-stepper-btn:hover{background:var(--ds-bg);color:var(--ds-accent)} .ds-stepper-btn:active{transform:scale(.9)}
  .ds-stepper-input{flex:1;min-width:0;width:100%;border:none;background:transparent;text-align:center;font-size:14px;color:var(--ds-text);font-family:inherit;padding:7px 2px;outline:none;-moz-appearance:textfield}
  .ds-stepper-input::-webkit-outer-spin-button,.ds-stepper-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  /* Color field (text/heading color) */
  .ds-color-field{display:flex;align-items:center;gap:10px;border:1px solid var(--ds-border);border-radius:var(--ds-radius);padding:5px 10px;background:var(--ds-bg-card);box-shadow:var(--ds-shadow);transition:border-color .15s}
  .ds-color-field:focus-within{border-color:var(--ds-accent);box-shadow:0 0 0 3px var(--ds-accent-ring)}
  .ds-color-field input[type=color]{width:28px;height:28px;border:none;border-radius:6px;background:transparent;cursor:pointer;padding:0;flex-shrink:0}
  .ds-color-field input[type=color]::-webkit-color-swatch-wrapper{padding:0}
  .ds-color-field input[type=color]::-webkit-color-swatch{border:1px solid var(--ds-border);border-radius:6px}
  .ds-color-field span{font-family:'SF Mono',Consolas,monospace;font-size:12px;color:var(--ds-text-2)}
  .ds-cvar{display:flex;align-items:center;gap:10px}
  .ds-cvar-sw{width:30px;height:30px;border-radius:8px;border:1px solid var(--ds-border);flex-shrink:0;box-shadow:var(--ds-shadow)}
  .ds-cvar select{flex:1;min-width:0}
  /* Color sliders (HSL visual) */
  .ds-cslider{margin-bottom:11px} .ds-cslider:last-child{margin-bottom:0}
  .ds-cslider-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
  .ds-cslider-head label{font-size:11px;color:var(--ds-text-2);font-weight:500}
  .ds-cslider-val{font-size:11px;color:var(--ds-text-3);font-family:'SF Mono',Consolas,monospace}
  .ds-cslider-track{position:relative;height:14px;border-radius:7px;border:1px solid var(--ds-border-light);box-shadow:inset 0 0 0 1px rgba(0,0,0,.04)}
  .ds-cslider input[type=range]{position:absolute;inset:0;width:100%;height:100%;margin:0;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer}
  .ds-cslider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,.3);box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:grab;transition:transform .12s}
  .ds-cslider input[type=range]:active::-webkit-slider-thumb{transform:scale(1.15);cursor:grabbing}
  .ds-cslider input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,.3);box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:grab}
  .ds-cslider input[type=range]:focus{outline:none} .ds-cslider input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px var(--ds-accent-ring),0 1px 3px rgba(0,0,0,.35)}

  /* ===== Auth / cuenta ===== */
  .ds-auth-loading{display:flex;align-items:center;justify-content:center;min-height:60vh;color:var(--ds-text-3);font-size:14px}
  .ds-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;animation:ds-toast-in .2s}
  .ds-modal{position:relative;width:100%;max-width:380px;background:var(--ds-bg-card);border:1px solid var(--ds-border);border-radius:var(--ds-radius-lg);padding:24px;box-shadow:var(--ds-shadow-md)}
  .ds-modal h3{font-size:16px;font-weight:650;margin:0 0 8px}
  .ds-modal p{font-size:13px;color:var(--ds-text-2);line-height:1.5;margin:0 0 14px}
  .ds-modal-x{position:absolute;top:12px;right:12px;width:26px;height:26px;border:none;background:transparent;color:var(--ds-text-3);font-size:14px;cursor:pointer;border-radius:6px}
  .ds-modal-x:hover{background:var(--ds-bg);color:var(--ds-text)}
  .ds-auth-chip{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ds-text-2)}
  .ds-auth-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
  .ds-auth-out{border:1px solid var(--ds-border);background:var(--ds-bg-card);color:var(--ds-text-2);border-radius:var(--ds-radius);font-size:11px;padding:4px 8px;cursor:pointer;font-family:inherit;transition:all .15s;box-shadow:var(--ds-shadow)}
  .ds-auth-out:hover{background:var(--ds-bg);color:var(--ds-text)}
  .ds-guest-banner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:var(--ds-accent-light);border:1px solid var(--ds-accent-ring);border-radius:var(--ds-radius);padding:10px 14px;font-size:12.5px;margin-bottom:16px}
  .ds-guest-banner span{flex:1;min-width:200px;line-height:1.45;color:var(--ds-text-2)}
  .ds-guest-banner .ds-btn{flex-shrink:0}
  /* ===== Cross-promo (marca personal) ===== */
  .ds-spromo{margin:auto 4px 2px;padding-top:14px;border-top:1px solid var(--ds-border-light);display:flex;flex-direction:column;gap:9px}
  .ds-spromo-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--ds-radius);border:1px solid var(--ds-accent-ring);display:block}
  .ds-spromo-txt{font-size:11.5px;line-height:1.4;color:var(--ds-text-3)}
  .ds-spromo-txt strong{display:block;color:var(--ds-text);font-weight:600;font-size:12.5px;margin-bottom:2px}
  .ds-spromo-cta{display:flex;gap:6px;text-decoration:none}
  .ds-spromo-label{flex:1;display:flex;align-items:center;justify-content:center;background:var(--ds-bg);border:1px solid var(--ds-border);border-radius:var(--ds-radius);font-size:11.5px;font-weight:600;color:var(--ds-text);padding:8px 10px;transition:all .15s}
  .ds-spromo-arrow{width:36px;display:flex;align-items:center;justify-content:center;background:var(--ds-accent);color:#fff;border-radius:var(--ds-radius);font-size:14px;flex-shrink:0;transition:background .15s}
  .ds-spromo-cta:hover .ds-spromo-label{border-color:var(--ds-accent)} .ds-spromo-cta:hover .ds-spromo-arrow{background:var(--ds-accent-hover)}
  .ds-credit{margin-top:28px;text-align:center;font-size:12px;color:var(--ds-text-3)}
  .ds-credit a{color:var(--ds-accent);text-decoration:none;font-weight:500}
  .ds-credit a:hover{text-decoration:underline}
  .ds-modal-wide{max-width:460px}
  .ds-migrate-list{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow:auto;margin:4px 0 14px}
  .ds-migrate-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--ds-border-light);border-radius:var(--ds-radius);cursor:pointer;transition:all .12s}
  .ds-migrate-item:hover{border-color:var(--ds-border)}
  .ds-migrate-item.sel{border-color:var(--ds-accent);background:var(--ds-accent-light)}
  .ds-migrate-item.dis{opacity:.45;cursor:not-allowed}
  .ds-migrate-item input{flex-shrink:0;cursor:inherit}
  .ds-migrate-name{font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ds-migrate-meta{font-size:11px;color:var(--ds-text-3);white-space:nowrap}
  .ds-migrate-foot{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--ds-text-2)}
  .ds-admin-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#fff;background:var(--ds-accent);padding:2px 7px;border-radius:999px}
  .ds-admin-table{width:100%;border-collapse:collapse;background:var(--ds-bg-card);border:1px solid var(--ds-border-light);border-radius:var(--ds-radius-lg);overflow:hidden}
  .ds-admin-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--ds-text-3);padding:12px 16px;border-bottom:1px solid var(--ds-border-light);font-weight:600}
  .ds-admin-table td{padding:12px 16px;font-size:13px;border-bottom:1px solid var(--ds-border-light);color:var(--ds-text);vertical-align:middle}
  .ds-admin-table tr:last-child td{border-bottom:none}
  .ds-admin-limit{display:flex;align-items:center;gap:10px}
  .ds-admin-inf{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--ds-text-2);cursor:pointer;user-select:none}
  .ds-optin{display:flex;align-items:flex-start;gap:8px;margin:12px 0;cursor:pointer}
  .ds-optin input{margin-top:2px;flex-shrink:0;cursor:pointer}
  .ds-optin span{font-size:11.5px;line-height:1.45;color:var(--ds-text-3)}
  .ds-auth-switch{margin-top:14px;text-align:center;font-size:12px;color:var(--ds-text-3)}
  .ds-auth-switch button{background:none;border:none;color:var(--ds-accent);font-weight:600;cursor:pointer;font-size:12px;font-family:inherit;padding:0}
  .ds-auth-switch button:hover{text-decoration:underline}
  /* Acciones de auth + avatar */
  .ds-auth-actions{display:flex;align-items:center;gap:8px}
  .ds-auth-link{background:none;border:none;color:var(--ds-text-2);font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;padding:6px 4px}
  .ds-auth-link:hover{color:var(--ds-text)}
  .ds-auth-user{display:flex;align-items:center;gap:7px;background:none;border:none;cursor:pointer;font-family:inherit;padding:3px 6px;border-radius:var(--ds-radius)}
  .ds-auth-user:hover{background:var(--ds-bg)}
  .ds-auth-name{font-size:12.5px;color:var(--ds-text);font-weight:500;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ds-avatar{border-radius:50%;object-fit:cover;display:inline-block;flex-shrink:0}
  .ds-avatar-ini{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:600;line-height:1}
  /* Selector de país (dropdown con buscador + banderas) */
  .ds-cs{position:relative}
  .ds-cs-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;cursor:pointer;text-align:left}
  .ds-cs-val{display:flex;align-items:center;gap:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ds-cs-ph{color:var(--ds-text-3)}
  .ds-cs-flag{width:20px;height:15px;border-radius:2px;object-fit:cover;flex-shrink:0;box-shadow:0 0 0 1px rgba(0,0,0,.1);display:inline-block}
  .ds-cs-caret{color:var(--ds-text-3);font-size:10px;flex-shrink:0}
  .ds-cs-panel{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:60;background:var(--ds-bg-card);border:1px solid var(--ds-border);border-radius:var(--ds-radius);box-shadow:var(--ds-shadow-md);padding:6px;max-height:240px;display:flex;flex-direction:column}
  .ds-cs-search{margin-bottom:6px}
  .ds-cs-list{overflow-y:auto}
  .ds-cs-opt{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--ds-text)}
  .ds-cs-opt:hover{background:var(--ds-bg)} .ds-cs-opt.sel{background:var(--ds-accent-light)}
  .ds-cs-empty{padding:12px;text-align:center;color:var(--ds-text-3);font-size:12px}
  /* Panel de cuenta */
  .ds-account{max-width:480px;margin:0 auto}
  .ds-account-head{display:flex;align-items:center;gap:14px;margin-bottom:22px}
  .ds-account-name{font-size:16px;font-weight:600;color:var(--ds-text)}
  .ds-account-email{font-size:13px;color:var(--ds-text-3)}

  @media (prefers-reduced-motion:reduce){.ds-step-anim,.ds-step-check,.ds-toast{animation:none}*{transition-duration:.01ms!important}}
`;

/* ================================================================
   SHELL COMPONENTS
   ================================================================ */
// Icono del toggle de tema (SVG con currentColor → se adapta al tema)
function ThemeIcon({ dark }) {
  return dark
    ? (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>)
    : (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>);
}
const COUNTRIES = [
  { n: "Spain", c: "es" }, { n: "Mexico", c: "mx" }, { n: "Argentina", c: "ar" }, { n: "Colombia", c: "co" }, { n: "Chile", c: "cl" },
  { n: "Peru", c: "pe" }, { n: "Venezuela", c: "ve" }, { n: "Ecuador", c: "ec" }, { n: "Guatemala", c: "gt" }, { n: "Cuba", c: "cu" },
  { n: "Bolivia", c: "bo" }, { n: "Dominican Republic", c: "do" }, { n: "Honduras", c: "hn" }, { n: "Paraguay", c: "py" }, { n: "El Salvador", c: "sv" },
  { n: "Nicaragua", c: "ni" }, { n: "Costa Rica", c: "cr" }, { n: "Panama", c: "pa" }, { n: "Uruguay", c: "uy" }, { n: "Puerto Rico", c: "pr" },
  { n: "United States", c: "us" }, { n: "Canada", c: "ca" }, { n: "United Kingdom", c: "gb" }, { n: "Ireland", c: "ie" }, { n: "Portugal", c: "pt" },
  { n: "France", c: "fr" }, { n: "Germany", c: "de" }, { n: "Italy", c: "it" }, { n: "Netherlands", c: "nl" }, { n: "Belgium", c: "be" },
  { n: "Switzerland", c: "ch" }, { n: "Austria", c: "at" }, { n: "Sweden", c: "se" }, { n: "Norway", c: "no" }, { n: "Denmark", c: "dk" },
  { n: "Finland", c: "fi" }, { n: "Poland", c: "pl" }, { n: "Czechia", c: "cz" }, { n: "Romania", c: "ro" }, { n: "Greece", c: "gr" },
  { n: "Hungary", c: "hu" }, { n: "Ukraine", c: "ua" }, { n: "Russia", c: "ru" }, { n: "Turkey", c: "tr" }, { n: "Morocco", c: "ma" },
  { n: "Algeria", c: "dz" }, { n: "Tunisia", c: "tn" }, { n: "Egypt", c: "eg" }, { n: "Nigeria", c: "ng" }, { n: "South Africa", c: "za" },
  { n: "Kenya", c: "ke" }, { n: "Ghana", c: "gh" }, { n: "Brazil", c: "br" }, { n: "Australia", c: "au" }, { n: "New Zealand", c: "nz" },
  { n: "India", c: "in" }, { n: "Pakistan", c: "pk" }, { n: "Bangladesh", c: "bd" }, { n: "Indonesia", c: "id" }, { n: "Philippines", c: "ph" },
  { n: "Vietnam", c: "vn" }, { n: "Thailand", c: "th" }, { n: "Malaysia", c: "my" }, { n: "Singapore", c: "sg" }, { n: "Japan", c: "jp" },
  { n: "South Korea", c: "kr" }, { n: "China", c: "cn" }, { n: "Hong Kong", c: "hk" }, { n: "Taiwan", c: "tw" }, { n: "United Arab Emirates", c: "ae" },
  { n: "Saudi Arabia", c: "sa" }, { n: "Israel", c: "il" }, { n: "Qatar", c: "qa" }, { n: "Other", c: "" },
];
const flagUrl = (code) => "https://flagcdn.com/20x15/" + code + ".png";

// Selector de país con buscador + banderas (dropdown personalizado, consistente en todos los SO)
function CountrySelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const sel = COUNTRIES.find((c) => c.n === value);
  const filtered = COUNTRIES.filter((c) => c.n.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="ds-cs" ref={ref}>
      <button type="button" className="ds-input ds-cs-btn" onClick={() => setOpen((o) => !o)}>
        {sel ? <span className="ds-cs-val">{sel.c && <img className="ds-cs-flag" src={flagUrl(sel.c)} alt="" />}{sel.n}</span> : <span className="ds-cs-ph">Country…</span>}
        <span className="ds-cs-caret">▾</span>
      </button>
      {open && (
        <div className="ds-cs-panel">
          <input className="ds-input ds-cs-search" placeholder="Search country…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="ds-cs-list">
            {filtered.map((c) => (
              <div key={c.n} className={"ds-cs-opt" + (c.n === value ? " sel" : "")} onClick={() => { onChange(c.n); setOpen(false); setQ(""); }}>
                {c.c ? <img className="ds-cs-flag" src={flagUrl(c.c)} alt="" loading="lazy" /> : <span className="ds-cs-flag" />}{c.n}
              </div>
            ))}
            {!filtered.length && <div className="ds-cs-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Modal de auth: Sign up (datos básicos) ↔ Sign in (magic link). Ambos usan OTP por email.
function AuthModal({ onClose, addToast, initialMode }) {
  const [mode, setMode] = useState(initialMode || "signup"); // signup | signin
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [country, setCountry] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSignup = mode === "signup";

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || busy || !supabase) return;
    if (isSignup && (!firstName.trim() || !country)) { addToast?.("Please complete name and country", "err"); return; }
    setBusy(true);
    try {
      try { localStorage.setItem("dsg-optin", optIn ? "1" : "0"); } catch {}
      const options = { emailRedirectTo: window.location.origin };
      if (isSignup) options.data = { first_name: firstName.trim(), last_name: lastName.trim(), country, marketing_opt_in: optIn };
      else options.shouldCreateUser = false; // sign in solo para cuentas existentes
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options });
      if (error) {
        if (!isSignup && /signups?\s+not\s+allowed|not\s*found|no\s*user/i.test(error.message || "")) {
          addToast?.("No account with that email — create one first.", "err");
          setMode("signup"); setBusy(false); return;
        }
        throw error;
      }
      setSent(true);
    } catch (err) { addToast?.("Could not send link: " + (err.message || "error"), "err"); }
    setBusy(false);
  };

  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <button className="ds-modal-x" onClick={onClose} aria-label="Close">✕</button>
        {sent ? (<>
          <h3>Check your email</h3>
          <p>We sent a magic link to <strong>{email}</strong>. Open it on this device to {isSignup ? "finish creating your account" : "sign in"}.</p>
          <button className="ds-btn ds-btn-primary" style={{ width: "100%" }} onClick={onClose}>Done</button>
        </>) : (
          <form onSubmit={submit}>
            <h3>{isSignup ? "Create your account" : "Sign in"}</h3>
            <p>{isSignup
              ? "Save your design systems in the cloud and keep them safe across devices. No password — we'll email you a magic link."
              : "Welcome back. Enter your email and we'll send you a magic link."}</p>
            {isSignup && (
              <div className="ds-grid-2" style={{ marginBottom: 10 }}>
                <input className="ds-input" placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required autoFocus />
                <input className="ds-input" placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>
            )}
            <input className="ds-input" type="email" required placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: isSignup ? 10 : 0 }} autoFocus={!isSignup} />
            {isSignup && <CountrySelect value={country} onChange={setCountry} />}
            {isSignup && <label className="ds-optin"><input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} /><span>I want to receive occasional tips &amp; updates from Samir Haddad. No spam, unsubscribe anytime.</span></label>}
            <button className="ds-btn ds-btn-primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: isSignup ? 4 : 10 }}>{busy ? "Sending…" : (isSignup ? "Create account" : "Send magic link")}</button>
            <div className="ds-auth-switch">
              {isSignup
                ? <>Already have an account? <button type="button" onClick={() => setMode("signin")}>Sign in</button></>
                : <>New here? <button type="button" onClick={() => setMode("signup")}>Create an account</button></>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
// Modal para elegir qué sistemas locales subir a la nube (cuando hay más que huecos)
function SelectMigrateModal({ prompt, onConfirm, onClose }) {
  const { candidates, slots } = prompt;
  const [sel, setSel] = useState([]);
  const toggle = (id) => setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : (s.length < slots ? [...s, id] : s));
  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal ds-modal-wide" onClick={(e) => e.stopPropagation()}>
        <button className="ds-modal-x" onClick={onClose} aria-label="Close">✕</button>
        <h3>Choose what to sync to the cloud</h3>
        <p>You have {candidates.length} systems on this device but only {slots} cloud slot{slots === 1 ? "" : "s"} free. Pick up to {slots} — the rest stay safe on this device.</p>
        <div className="ds-migrate-list">
          {candidates.map((c) => {
            const checked = sel.includes(c.id);
            const disabled = !checked && sel.length >= slots;
            return (
              <label key={c.id} className={"ds-migrate-item" + (checked ? " sel" : "") + (disabled ? " dis" : "")}>
                <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(c.id)} />
                <span className="ds-migrate-name">{c.name}</span>
                <span className="ds-migrate-meta">{(c.doc?.colors?.palettes?.length) || 0} colors · {fmtDate(c.updatedAt)}</span>
              </label>
            );
          })}
        </div>
        <div className="ds-migrate-foot">
          <span>{sel.length} / {slots} selected</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ds-btn ds-btn-sm" onClick={onClose}>Skip for now</button>
            <button className="ds-btn ds-btn-primary ds-btn-sm" onClick={() => onConfirm(candidates.filter((c) => sel.includes(c.id)))} disabled={!sel.length}>Sync selected</button>
          </div>
        </div>
      </div>
    </div>
  );
}
// Nombre visible del usuario (nombre + apellido, o email)
function userDisplayName(user) {
  const m = user?.user_metadata || {};
  const name = [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
  return name || user?.email || "Account";
}
async function emailHash(email) {
  const data = new TextEncoder().encode((email || "").trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function avatarColor(str) {
  let h = 0; for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return "hsl(" + (h % 360) + ",52%,45%)";
}
// Avatar: Gravatar si existe (por el email), si no iniciales sobre color determinista
function Avatar({ user, size = 32 }) {
  const m = user?.user_metadata || {};
  const initials = (((m.first_name || "")[0] || "") + ((m.last_name || "")[0] || "") || (user?.email || "?")[0] || "?").toUpperCase();
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    if (user?.email && crypto?.subtle) emailHash(user.email).then((h) => { if (active) setSrc("https://gravatar.com/avatar/" + h + "?d=404&s=" + (size * 2)); }).catch(() => {});
    return () => { active = false; };
  }, [user?.email, size]);
  if (src) return <img className="ds-avatar" src={src} width={size} height={size} alt="" onError={() => setSrc(null)} />;
  return <span className="ds-avatar ds-avatar-ini" style={{ width: size, height: size, background: avatarColor((m.first_name || "") + (m.last_name || "") + (user?.email || "")), fontSize: Math.round(size * 0.42) }}>{initials}</span>;
}

// Control de cuenta en cabecera
function AuthControl({ user, isAdmin, onAuth, onSignOut, onAccount }) {
  if (!cloudEnabled) return null;
  if (user) return (
    <div className="ds-auth-chip">
      {isAdmin && <span className="ds-admin-badge">Admin</span>}
      <button className="ds-auth-user" onClick={onAccount} title="Account settings"><Avatar user={user} size={24} /><span className="ds-auth-name">{userDisplayName(user)}</span></button>
      <button className="ds-auth-out" onClick={onSignOut}>Sign out</button>
    </div>
  );
  return (
    <div className="ds-auth-actions">
      <button className="ds-auth-link" onClick={() => onAuth("signin")}>Sign in</button>
      <button className="ds-btn ds-btn-sm" onClick={() => onAuth("signup")} data-tip="Create an account to save in the cloud">Sign up</button>
    </div>
  );
}
// Aviso de modo invitado
function GuestBanner({ onSignIn }) {
  if (!cloudEnabled) return null;
  return (
    <div className="ds-guest-banner">
      <span><strong>Guest mode</strong> — your systems are saved only in this browser and can be lost. Create an account to keep them safe in the cloud.</span>
      <button className="ds-btn ds-btn-sm" onClick={onSignIn}>Sign up</button>
    </div>
  );
}
function EditorHeader({ name, onRename, onBack, autoSave, onToggleAutoSave, dirty, onSave, darkMode, toggleDark, user, onAuth, onAccount, onSignOut, isAdmin }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  useEffect(() => { setVal(name); }, [name]);
  const commit = () => { const n = val.trim() || name; setEditing(false); if (n !== name) onRename(n); };
  return (<header className="ds-header">
    <button className="ds-header-back" onClick={onBack} data-tip="Back to my systems">←</button>
    <BrandMark />
    {editing
      ? <input className="ds-input ds-input-sm" style={{ maxWidth: 240 }} autoFocus value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setVal(name); setEditing(false); } }} />
      : <div><h1 onClick={() => setEditing(true)} style={{ cursor: "text" }} data-tip="Click to rename">{name}</h1><p>Design system editor</p></div>}
    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
      <div className="ds-autosave" onClick={onToggleAutoSave} data-tip="Save changes automatically on every edit">
        <div className={"ds-toggle-track" + (autoSave ? " on" : "")}><div className="ds-toggle-thumb" /></div>
        <span>Auto-save</span>
      </div>
      <button className="ds-btn ds-btn-primary ds-btn-sm" onClick={onSave} disabled={autoSave || !dirty} data-tip="Save changes (⌘/Ctrl + S)">
        {autoSave ? "✓ Auto-saved" : (dirty ? "Save changes" : "✓ Saved")}
      </button>
      <AuthControl user={user} isAdmin={isAdmin} onAuth={onAuth} onAccount={onAccount} onSignOut={onSignOut} />
      <button className="ds-header-theme" onClick={toggleDark} data-tip="Toggle light / dark theme"><ThemeIcon dark={darkMode} /></button>
    </div>
  </header>);
}
function Sidebar() {
  const { state, dispatch } = useDSContext();
  return (<nav className="ds-sidebar"><div className="ds-sidebar-title">Steps</div>{STEPS.map((s) => (
    <div key={s.id} className={"ds-step-item" + (state.currentStep === s.id ? " active" : "")} onClick={() => dispatch({ type: "SET_STEP", payload: s.id })}>
      <div className="ds-step-num">{s.id}</div><span className="ds-step-label">{s.label}</span>{s.check(state) && <div className="ds-step-check">✓</div>}
    </div>))}
    <SidebarPromo />
  </nav>);
}
function Footer() {
  const { state, dispatch } = useDSContext();
  return (<footer className="ds-footer"><div className="ds-footer-info">Step {state.currentStep} of 10</div><div className="ds-footer-actions">
    <button className="ds-btn" disabled={state.currentStep === 1} onClick={() => dispatch({ type: "SET_STEP", payload: state.currentStep - 1 })}>← Previous</button>
    <button className="ds-btn ds-btn-primary" disabled={state.currentStep === 10} onClick={() => dispatch({ type: "SET_STEP", payload: state.currentStep + 1 })}>Next →</button>
  </div></footer>);
}

function ValidationAlert({ items }) {
  if (!items || !items.length) return null;
  return (<div className="ds-validation-block">
    {items.map((item, i) => (
      <div key={i} className={"ds-val-item ds-val-" + item.type}>
        <span className="ds-val-dot" />
        {item.msg}
      </div>
    ))}
  </div>);
}

// Input numérico con botones +/− (steppers)
function NumStepper({ value, set, min, max, step = 1 }) {
  const norm = (n) => (step < 1 ? Math.round(n * 100) / 100 : Math.round(n));
  const clamp = (n) => { if (min != null) n = Math.max(min, n); if (max != null) n = Math.min(max, n); return n; };
  const change = (d) => set(clamp(norm((parseFloat(value) || 0) + d)));
  const onType = (e) => { const v = e.target.value; if (v === "") { set(min != null ? min : 0); return; } set(clamp(step < 1 ? (parseFloat(v) || 0) : (parseInt(v) || 0))); };
  return (<div className="ds-stepper">
    <button type="button" className="ds-stepper-btn" tabIndex={-1} onClick={() => change(-step)} aria-label="Decrease">−</button>
    <input type="number" className="ds-stepper-input" value={value} min={min} max={max} step={step} onChange={onType} />
    <button type="button" className="ds-stepper-btn" tabIndex={-1} onClick={() => change(step)} aria-label="Increase">+</button>
  </div>);
}

/* ================================================================
   STEP 1: LAYOUT MODE
   ================================================================ */
// Marca de la app: token grid 2×2 sobre badge de acento (igual que el favicon)
function BrandMark() {
  return (
    <svg className="ds-header-icon" viewBox="0 0 56 56" aria-hidden="true">
      <defs><linearGradient id="bm-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8b76f7" /><stop offset="1" stopColor="#5d44e0" /></linearGradient></defs>
      <rect width="56" height="56" rx="14" fill="url(#bm-grad)" />
      <rect x="13" y="13" width="14" height="14" rx="4" fill="#fff" />
      <rect x="29" y="13" width="14" height="14" rx="4" fill="#fff" opacity=".68" />
      <rect x="13" y="29" width="14" height="14" rx="4" fill="#fff" opacity=".45" />
      <rect x="29" y="29" width="14" height="14" rx="4" fill="#fff" opacity=".26" />
    </svg>
  );
}

function LayoutIcon({ mode }) {
  // Fixed: guías punteadas juntas hacia el centro, contenido estrecho.
  // Full: guías separadas y pegadas al borde, contenido casi a todo el ancho.
  const fixed = mode === "fixed";
  const gL = fixed ? 26 : 12, gR = fixed ? 62 : 76;
  const cX = gL + 5, cW = gR - gL - 10;
  return (
    <svg viewBox="0 0 88 64" width="92" height="67" fill="none" aria-hidden="true">
      {/* marco navegador */}
      <rect x="2" y="2" width="84" height="60" rx="7" stroke="currentColor" strokeWidth="2" opacity=".9" />
      <line x1="2" y1="16" x2="86" y2="16" stroke="currentColor" strokeWidth="2" opacity=".5" />
      <circle cx="9" cy="9" r="1.6" fill="currentColor" opacity=".5" />
      <circle cx="15" cy="9" r="1.6" fill="currentColor" opacity=".5" />
      <circle cx="21" cy="9" r="1.6" fill="currentColor" opacity=".5" />
      {/* guías de margen (único elemento en acento) */}
      <line x1={gL} y1="20" x2={gL} y2="58" stroke="var(--ds-accent)" strokeWidth="2" strokeDasharray="3 3" />
      <line x1={gR} y1="20" x2={gR} y2="58" stroke="var(--ds-accent)" strokeWidth="2" strokeDasharray="3 3" />
      {/* contenido */}
      <rect x={cX} y="27" width={cW} height="2.6" rx="1.3" fill="currentColor" opacity=".7" />
      <rect x={cX} y="34" width={cW} height="2.6" rx="1.3" fill="currentColor" opacity=".45" />
      <rect x={cX} y="41" width={Math.round(cW * 0.68)} height="2.6" rx="1.3" fill="currentColor" opacity=".45" />
    </svg>
  );
}

function StepLayout() {
  const { state, dispatch } = useDSContext();
  const { layoutMode, minViewport, maxViewport } = state;
  const warns = [];
  if (layoutMode) {
    if (minViewport >= maxViewport) warns.push({ type: "error", msg: "Min viewport ≥ max viewport — clamp() fallback to static values, fluid scaling won't work" });
    else if ((maxViewport - minViewport) < 300) warns.push({ type: "warn", msg: "Viewport range below 300px — fluid values will barely scale" });
  }
  return (<div>
    <div className={"ds-mode-cards" + (layoutMode ? " has-sel" : "")}>
      <div className={"ds-mode-card" + (layoutMode === "fullwidth" ? " selected" : "")} onClick={() => dispatch({ type: "SET_LAYOUT_MODE", payload: "fullwidth" })}><span className="ds-mode-check">✓</span><span className="ds-mode-icon"><LayoutIcon mode="fullwidth" /></span><h3>Full-width (100%)</h3><p>Content spans entire viewport</p></div>
      <div className={"ds-mode-card" + (layoutMode === "fixed" ? " selected" : "")} onClick={() => dispatch({ type: "SET_LAYOUT_MODE", payload: "fixed" })}><span className="ds-mode-check">✓</span><span className="ds-mode-icon"><LayoutIcon mode="fixed" /></span><h3>Fixed-width</h3><p>Content constrained to max-width</p></div>
    </div>
    {layoutMode && (<div className="ds-mode-info">
      <strong>{layoutMode === "fixed" ? "Fixed-width" : "Full-width"}</strong> — {layoutMode === "fixed"
        ? "content is capped to a max width and centered. Fluid tokens (type, spacing, gaps…) reach their largest values at that max width and stop growing — wider screens just add side margins."
        : "content spans the full screen (100%). Fluid tokens (type, spacing, gaps…) keep scaling across the whole viewport, up to your max viewport."}
      <span className="sub">Both modes use the same fields below — the layout mode only changes how those fluid values are calculated (the max viewport caps fluid growth).</span>
    </div>)}
    {layoutMode && (<div className="ds-viewport-config"><h4>Viewport range</h4>
      <ValidationAlert items={warns} />
      <div className="ds-viewport-row" style={{ marginBottom: 0 }}>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Min viewport (px)</label><NumStepper value={minViewport} set={(n) => dispatch({ type: "SET_FIELD", field: "minViewport", value: Math.max(0, n) })} min={0} step={5} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Max viewport (px)</label><NumStepper value={maxViewport} set={(n) => dispatch({ type: "SET_FIELD", field: "maxViewport", value: Math.max(0, n) })} min={0} step={10} /></div>
      </div>
    </div>)}
    {layoutMode && (<div className="ds-viewport-config" style={{ marginTop: 14 }}><h4>Header &amp; structure</h4>
      <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Header offset (px) <span style={{ fontWeight: 400, color: "var(--ds-text-3)", fontSize: 12 }}>— --offset, for anchor scroll</span></label><NumStepper value={state.offset ?? 80} set={(n) => dispatch({ type: "SET_FIELD", field: "offset", value: Math.max(0, n) })} min={0} step={4} /><div className="ds-helper">Sticky header height. Anchored sections offset by --offset so they don't hide under it.</div></div>
    </div>)}
  </div>);
}

/* ================================================================
   STEP 2: SPACING (component values: xs–xxl)
   ================================================================ */
function StepSpacing() {
  const { state, dispatch } = useDSContext();
  const sp = state.spacing;
  const recalc = (bm, bd, sc) => dispatch({ type: "RECALC_SPACING", baseMobile: bm, baseDesktop: bd, scale: sc ?? sp.scale });
  const warns = [];
  if (sp.baseMobile > sp.baseDesktop) warns.push({ type: "warn", msg: "Mobile base larger than desktop — spacing scale decreases on larger screens" });
  const invKeys = SPACE_KEYS.filter(k => k !== "section" && (sp.values[k]?.mobile || 0) > (sp.values[k]?.desktop || 0));
  if (invKeys.length) warns.push({ type: "warn", msg: (invKeys.length === 1 ? "1 value is" : invKeys.length + " values are") + " larger on mobile than desktop: " + invKeys.map(k => "--space-" + k).join(", ") });
  return (<div>
    <div className="ds-card"><h4>Base space</h4>
      <div className="ds-grid-3">
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Mobile</label><NumStepper value={sp.baseMobile} set={(n) => recalc(n, sp.baseDesktop)} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Desktop</label><NumStepper value={sp.baseDesktop} set={(n) => recalc(sp.baseMobile, n)} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Scale</label><NumStepper value={sp.scale} set={(n) => recalc(sp.baseMobile, sp.baseDesktop, n)} min={1} step={0.05} /></div>
      </div>
    </div>
    <ValidationAlert items={warns} />
    {SPACE_KEYS.filter(k => k !== "section").map((k, i) => (<div key={k} className={"ds-space-row" + (i % 2 ? " alt" : "")}>
      <div className="ds-space-name">--space-{k}</div>
      <div className="ds-space-inputs">
        <div><input className="ds-space-input" type="number" value={sp.values[k]?.mobile || 0} onChange={(e) => dispatch({ type: "SET_SPACE_VALUE", key: k, side: "mobile", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Mobile</div></div>
        <div><input className="ds-space-input" type="number" value={sp.values[k]?.desktop || 0} onChange={(e) => dispatch({ type: "SET_SPACE_VALUE", key: k, side: "desktop", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Desktop</div></div>
      </div>
      <div className="ds-space-bar" style={{ width: Math.min(120, (sp.values[k]?.desktop || 0) * 1.2) }} />
    </div>))}
  </div>);
}

/* ================================================================
   STEP 3: SECTION SPACING (scalable: xs–xxl)
   ================================================================ */
function StepSectionSpacing() {
  const { state, dispatch } = useDSContext();
  const ss = state.sectionSpacing;
  const gut = state.gutter || { mobile: 16, desktop: 64 };
  const recalc = (bm, bd, sc) => dispatch({ type: "RECALC_SECTION_SPACING", baseMobile: bm, baseDesktop: bd, scale: sc ?? ss.scale });
  const warns = [];
  if (ss.baseMobile > ss.baseDesktop) warns.push({ type: "warn", msg: "Mobile base larger than desktop — section spacing scale decreases on larger screens" });
  const invKeys = SPACE_KEYS.filter(k => (ss.values[k]?.mobile || 0) > (ss.values[k]?.desktop || 0));
  if (invKeys.length) warns.push({ type: "warn", msg: (invKeys.length === 1 ? "1 value is" : invKeys.length + " values are") + " larger on mobile than desktop: " + invKeys.map(k => "--section-space-" + k).join(", ") });
  return (<div>
    <div className="ds-card"><h4>Base section space</h4>
      <div className="ds-grid-3">
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Mobile</label><NumStepper value={ss.baseMobile} set={(n) => recalc(n, ss.baseDesktop)} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Desktop</label><NumStepper value={ss.baseDesktop} set={(n) => recalc(ss.baseMobile, n)} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Scale</label><NumStepper value={ss.scale} set={(n) => recalc(ss.baseMobile, ss.baseDesktop, n)} min={1} step={0.05} /></div>
      </div>
    </div>
    <ValidationAlert items={warns} />
    {SPACE_KEYS.map((k, i) => (<div key={k} className={"ds-space-row" + (i % 2 ? " alt" : "")}>
      <div className="ds-space-name">--section-space-{k}</div>
      <div className="ds-space-inputs">
        <div><input className="ds-space-input" type="number" value={ss.values[k]?.mobile || 0} onChange={(e) => dispatch({ type: "SET_SECTION_SPACE_VALUE", key: k, side: "mobile", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Mobile</div></div>
        <div><input className="ds-space-input" type="number" value={ss.values[k]?.desktop || 0} onChange={(e) => dispatch({ type: "SET_SECTION_SPACE_VALUE", key: k, side: "desktop", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Desktop</div></div>
      </div>
      <div className="ds-space-bar" style={{ width: Math.min(120, (ss.values[k]?.desktop || 0) * 1.2) }} />
    </div>))}
    <div className="ds-card" style={{ marginTop: 16 }}>
      <h4>Gutter <span style={{ fontWeight: 400, color: "var(--ds-text-3)", fontSize: 12 }}>— --gutter</span></h4>
      <div className="ds-helper" style={{ marginBottom: 14 }}>Horizontal padding that keeps content off the screen edges. Fluid between viewports, so it adapts to the selected layout ({state.layoutMode === "fixed" ? "fixed, max " + state.maxViewport + "px" : "full-width"}).</div>
      <div className="ds-grid-2">
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Mobile (px)</label><NumStepper value={gut.mobile} set={(n) => dispatch({ type: "SET_GUTTER", side: "mobile", value: n })} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Desktop (px)</label><NumStepper value={gut.desktop} set={(n) => dispatch({ type: "SET_GUTTER", side: "desktop", value: n })} min={0} /></div>
      </div>
      <div style={{ marginTop: 12, padding: "9px 12px", background: "var(--ds-bg)", border: "1px solid var(--ds-border-light)", borderRadius: "var(--ds-radius)", fontFamily: "'SF Mono',Consolas,monospace", fontSize: 12, color: "var(--ds-text-2)", overflowX: "auto", whiteSpace: "nowrap" }}>--gutter: {flRem(gut.mobile, gut.desktop, state)};</div>
    </div>
  </div>);
}

/* ================================================================
   STEP 4: TYPOGRAPHY
   ================================================================ */
// Opciones de color = variables ya creadas en el sistema (paletas + variantes + transparencias + b/n)
const TRANS_STEPS = [90, 80, 70, 60, 50, 40, 30, 20, 10];
function buildColorVarOptions(state) {
  const opts = [];
  (state.colors?.palettes || []).forEach((p) => {
    const slug = slugify(p.name);
    opts.push({ group: p.name, label: "Base", value: "var(--" + slug + ")", color: hslToHex(p.hue, p.saturation, p.lightness) });
    if (p.showVariants) VARIANT_LIGHTNESS.forEach(({ key }) => {
      if (key === "medium" || !p.variants[key]) return;
      opts.push({ group: p.name, label: key, value: "var(--" + slug + "-" + key + ")", color: p.variants[key] });
    });
    if (p.showTransparency) TRANS_STEPS.forEach((o) => {
      opts.push({ group: p.name, label: p.name + " " + o + "%", value: "var(--" + slug + "-trans-" + o + ")", color: "hsla(" + p.hue + "," + p.saturation + "%," + p.lightness + "%," + (o / 100) + ")" });
    });
  });
  if (state.colors?.whiteTransparency) {
    opts.push({ group: "Black & White", label: "White", value: "var(--white)", color: "#ffffff" });
    TRANS_STEPS.forEach((o) => opts.push({ group: "Black & White", label: "White " + o + "%", value: "var(--white-trans-" + o + ")", color: "rgba(255,255,255," + (o / 100) + ")" }));
  }
  if (state.colors?.blackTransparency) {
    opts.push({ group: "Black & White", label: "Black", value: "var(--black)", color: "#000000" });
    TRANS_STEPS.forEach((o) => opts.push({ group: "Black & White", label: "Black " + o + "%", value: "var(--black-trans-" + o + ")", color: "rgba(0,0,0," + (o / 100) + ")" }));
  }
  return opts;
}

function ColorVarPicker({ value, onChange, opts }) {
  const known = opts.find((o) => o.value === value);
  const swatch = known ? known.color : (value && value.startsWith("#") ? value : null);
  const groups = [];
  opts.forEach((o) => { let g = groups.find((x) => x.name === o.group); if (!g) { g = { name: o.group, items: [] }; groups.push(g); } g.items.push(o); });
  return (
    <div className="ds-cvar">
      <span className="ds-cvar-sw" style={swatch
        ? { backgroundImage: `linear-gradient(${swatch},${swatch}), conic-gradient(#c4c4c4 0 25%, #fff 0 50%, #c4c4c4 0 75%, #fff 0)`, backgroundSize: "100% 100%, 9px 9px" }
        : { background: "var(--ds-border)" }} />
      <select className="ds-input" value={known ? value : "__custom"} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value="__custom">Custom: {value}</option>}
        {groups.map((g) => (
          <optgroup key={g.name} label={g.name}>
            {g.items.map((o) => <option key={o.value} value={o.value}>{o.label} · {o.value}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function StepTypography() {
  const { state, dispatch } = useDSContext();
  const t = state.typography;
  const st = state.styles || { textColor: "#1f2937", headingColor: "#111827", textWeight: 400, headingWeight: 700 };
  const colorOpts = buildColorVarOptions(state);
  const WEIGHTS = [300, 400, 500, 600, 700, 800];
  const hDesk = ["h1","h2","h3","h4","h5","h6"].map(h => t.headings[h]?.desktop || 0);
  const warns = [];
  if (hDesk.some(v => v > 0 && v < 12)) warns.push({ type: "error", msg: "Heading below 12px on desktop — WCAG accessibility minimum" });
  if (hDesk.every(v => v > 0) && !hDesk.every((v, i) => i === 0 || v <= hDesk[i - 1])) warns.push({ type: "warn", msg: "Headings not in descending order — h1 should be the largest" });
  if ((t.texts?.m?.desktop || 0) > 0 && t.texts.m.desktop < 14) warns.push({ type: "warn", msg: "text-m below 14px on desktop — consider 14–18px for readable body text" });
  return (<div>
    <div className="ds-toggle-row" onClick={() => dispatch({ type: "SET_TYPO", payload: { useScale: !t.useScale } })}>
      <div className={"ds-toggle-track" + (t.useScale ? " on" : "")}><div className="ds-toggle-thumb" /></div>
      <div className="ds-toggle-text"><strong>Use typographic scale</strong><span>{t.useScale ? "Values auto-calculated from base + scale" : "Enter all values manually"}</span></div>
    </div>
    <ValidationAlert items={warns} />
    {/* HEADINGS */}
    <div className="ds-card"><h4>Headings (base: h3)</h4>
      {t.useScale && (<div className="ds-grid-3" style={{ marginBottom: 16 }}>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>h3 Mobile</label><NumStepper value={t.headingBaseMob} set={(n) => dispatch({ type: "RECALC_HEADINGS", baseMob: n, baseDesk: t.headingBaseDesk, scale: t.headingScale })} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>h3 Desktop</label><NumStepper value={t.headingBaseDesk} set={(n) => dispatch({ type: "RECALC_HEADINGS", baseMob: t.headingBaseMob, baseDesk: n, scale: t.headingScale })} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Scale</label>
          <select className="ds-input" value={t.headingScale} onChange={(e) => dispatch({ type: "RECALC_HEADINGS", baseMob: t.headingBaseMob, baseDesk: t.headingBaseDesk, scale: parseFloat(e.target.value) })}>
            {SCALES.map((s) => <option key={s.value} value={s.value}>{s.name} ({s.value})</option>)}
          </select>
        </div>
      </div>)}
      {["h1","h2","h3","h4","h5","h6"].map((h) => (<div key={h} className="ds-space-row" style={{ marginBottom: 6 }}>
        <div className="ds-space-name">--{h}</div>
        <div className="ds-space-inputs" style={{ flexGrow: 0 }}>
          <div><input className="ds-space-input" type="number" value={t.headings[h]?.mobile || 0} onChange={(e) => dispatch({ type: "SET_HEADING_VAL", key: h, side: "mobile", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Mobile</div></div>
          <div><input className="ds-space-input" type="number" value={t.headings[h]?.desktop || 0} onChange={(e) => dispatch({ type: "SET_HEADING_VAL", key: h, side: "desktop", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Desktop</div></div>
        </div>
        <div style={{ flex: 1, minWidth: 0, textAlign: "left", paddingLeft: 12, fontSize: t.headings[h]?.desktop || 16, fontWeight: 700, lineHeight: t.lineHeightHeading, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Heading</div>
      </div>))}
    </div>
    {/* TEXT SIZES */}
    <div className="ds-card"><h4>Text sizes (base: text-m)</h4>
      {t.useScale && (<div className="ds-grid-3" style={{ marginBottom: 16 }}>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>text-m Mobile</label><NumStepper value={t.textBaseMob} set={(n) => dispatch({ type: "RECALC_TEXTS", baseMob: n, baseDesk: t.textBaseDesk, scale: t.textScale })} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>text-m Desktop</label><NumStepper value={t.textBaseDesk} set={(n) => dispatch({ type: "RECALC_TEXTS", baseMob: t.textBaseMob, baseDesk: n, scale: t.textScale })} min={0} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label style={{ fontSize: 12 }}>Scale</label>
          <select className="ds-input" value={t.textScale} onChange={(e) => dispatch({ type: "RECALC_TEXTS", baseMob: t.textBaseMob, baseDesk: t.textBaseDesk, scale: parseFloat(e.target.value) })}>
            {SCALES.map((s) => <option key={s.value} value={s.value}>{s.name} ({s.value})</option>)}
          </select>
        </div>
      </div>)}
      {TEXT_KEYS.map((k) => (<div key={k} className="ds-space-row" style={{ marginBottom: 6 }}>
        <div className="ds-space-name">--text-{k}</div>
        <div className="ds-space-inputs" style={{ flexGrow: 0 }}>
          <div><input className="ds-space-input" type="number" value={t.texts[k]?.mobile || 0} onChange={(e) => dispatch({ type: "SET_TEXT_VAL", key: k, side: "mobile", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Mobile</div></div>
          <div><input className="ds-space-input" type="number" value={t.texts[k]?.desktop || 0} onChange={(e) => dispatch({ type: "SET_TEXT_VAL", key: k, side: "desktop", value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">Desktop</div></div>
        </div>
        <div style={{ flex: 1, minWidth: 0, textAlign: "left", paddingLeft: 12, fontSize: t.texts[k]?.desktop || 14, lineHeight: t.lineHeightBody, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Sample</div>
      </div>))}
    </div>
    <div className="ds-card"><h4>Text &amp; heading styles</h4>
      <div className="ds-grid-2" style={{ marginBottom: 14 }}>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Body line height</label><NumStepper value={t.lineHeightBody} set={(n) => dispatch({ type: "SET_TYPO", payload: { lineHeightBody: n || 1 } })} min={0.8} step={0.05} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Heading line height</label><NumStepper value={t.lineHeightHeading} set={(n) => dispatch({ type: "SET_TYPO", payload: { lineHeightHeading: n || 1 } })} min={0.8} step={0.05} /></div>
      </div>
      <div className="ds-grid-2" style={{ marginBottom: 14 }}>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Text weight</label>
          <select className="ds-input" value={st.textWeight} onChange={(e) => dispatch({ type: "SET_STYLE", field: "textWeight", value: parseInt(e.target.value) })}>{WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}</select></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Heading weight</label>
          <select className="ds-input" value={st.headingWeight} onChange={(e) => dispatch({ type: "SET_STYLE", field: "headingWeight", value: parseInt(e.target.value) })}>{WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}</select></div>
      </div>
      <div className="ds-grid-2">
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Text color</label>
          <ColorVarPicker value={st.textColor} opts={colorOpts} onChange={(val) => dispatch({ type: "SET_STYLE", field: "textColor", value: val })} /></div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}><label>Heading color</label>
          <ColorVarPicker value={st.headingColor} opts={colorOpts} onChange={(val) => dispatch({ type: "SET_STYLE", field: "headingColor", value: val })} /></div>
      </div>
      <div className="ds-helper" style={{ marginTop: 8 }}>Pick a color from your design system (palettes &amp; variants). Set in Step 4 → Colors.</div>
    </div>
  </div>);
}

/* ================================================================
   STEP 5: COLORS
   ================================================================ */
function PaletteCard({ palette }) {
  const { state, dispatch } = useDSContext();
  const { id, name, hue, saturation, lightness, showVariants, variants, showTransparency } = palette;
  const canDel = state.colors.palettes.length > 1;
  const hexVal = hslToHex(hue, saturation, lightness);
  const upd = (f, v) => dispatch({ type: "UPDATE_PALETTE", id, field: f, value: v });
  const onPick = (hex) => { const { h, s, l } = hexToHsl(hex); upd("hue", h); setTimeout(() => { upd("saturation", s); upd("lightness", l); upd("variants", initVariants(h, s, l)); }, 0); };
  const recalcVariants = () => upd("variants", initVariants(hue, saturation, lightness));

  const hueGrad = "linear-gradient(90deg,hsl(0,100%,50%),hsl(60,100%,50%),hsl(120,100%,50%),hsl(180,100%,50%),hsl(240,100%,50%),hsl(300,100%,50%),hsl(360,100%,50%))";
  const satGrad = "linear-gradient(90deg,hsl(" + hue + ",0%," + lightness + "%),hsl(" + hue + ",100%," + lightness + "%))";
  const lightGrad = "linear-gradient(90deg,hsl(" + hue + "," + saturation + "%,0%),hsl(" + hue + "," + saturation + "%,50%),hsl(" + hue + "," + saturation + "%,100%))";
  const Slider = (label, val, max, grad, field, unit) => (
    <div className="ds-cslider">
      <div className="ds-cslider-head"><label>{label}</label><span className="ds-cslider-val">{val}{unit}</span></div>
      <div className="ds-cslider-track" style={{ background: grad }}>
        <input type="range" min={0} max={max} value={val} onChange={(e) => upd(field, parseInt(e.target.value))} />
      </div>
    </div>
  );

  return (<div className="ds-palette-card">
    <div className="ds-palette-header"><input type="text" value={name} placeholder="Color name" onChange={(e) => upd("name", e.target.value)} />{canDel && <button className="ds-btn ds-btn-sm ds-btn-danger" onClick={() => dispatch({ type: "REMOVE_PALETTE", id })}>Remove</button>}</div>
    <div className="ds-color-picker-row">
      <div className="ds-color-swatch"><input type="color" value={hexVal} onChange={(e) => onPick(e.target.value)} /></div>
      <div style={{ flex: 1 }}>
        {Slider("Hue", hue, 360, hueGrad, "hue", "°")}
        {Slider("Saturation", saturation, 100, satGrad, "saturation", "%")}
        {Slider("Lightness", lightness, 100, lightGrad, "lightness", "%")}
      </div>
    </div>
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      <div className="ds-toggle-row" style={{ flex: 1, marginBottom: 0 }} onClick={() => upd("showTransparency", !showTransparency)}>
        <div className={"ds-toggle-track" + (showTransparency ? " on" : "")}><div className="ds-toggle-thumb" /></div>
        <div className="ds-toggle-text"><strong>Transparencies</strong></div>
      </div>
      <div className="ds-toggle-row" style={{ flex: 1, marginBottom: 0 }} onClick={() => { if (!showVariants) recalcVariants(); upd("showVariants", !showVariants); }}>
        <div className={"ds-toggle-track" + (showVariants ? " on" : "")}><div className="ds-toggle-thumb" /></div>
        <div className="ds-toggle-text"><strong>Expand Palette</strong></div>
      </div>
    </div>
    {showVariants && (<div className="ds-variants-grid">
      {VARIANT_LIGHTNESS.map(({ key }) => (<div key={key} className="ds-variant-item">
        <div className="ds-variant-box" style={{ backgroundColor: variants[key] || hexVal }} title="Pick a color">
          <input type="color" value={toHexColor(variants[key] || hexVal)} onChange={(e) => dispatch({ type: "UPDATE_PALETTE_VARIANT", id, key, value: e.target.value })} />
        </div>
        <div className="ds-variant-label">--{slugify(name)}-{key}</div>
        <input className="ds-variant-input" value={variants[key] || ""} onChange={(e) => dispatch({ type: "UPDATE_PALETTE_VARIANT", id, key, value: e.target.value })} />
      </div>))}
    </div>)}
    {showTransparency && (<div className="ds-transparency-grid">
      {[90,80,70,60,50,40,30,20,10].map((o) => (<div key={o} className="ds-trans-box"><div className="ds-trans-overlay" style={{ backgroundColor: "hsla(" + hue + "," + saturation + "%," + lightness + "%," + (o / 100) + ")" }}>{o}%</div></div>))}
    </div>)}
  </div>);
}

function TransparencySection({ label, color, bgColor, field }) {
  const { state, dispatch } = useDSContext();
  const show = state.colors[field];
  return (<div className="ds-card">
    <div className="ds-toggle-row" style={{ marginBottom: show ? 12 : 0 }} onClick={() => dispatch({ type: "SET_COLORS", payload: { [field]: !show } })}>
      <div className={"ds-toggle-track" + (show ? " on" : "")}><div className="ds-toggle-thumb" /></div>
      <div className="ds-toggle-text"><strong>{label} Transparencies</strong></div>
    </div>
    {show && (<>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 6, backgroundColor: bgColor, border: "0.5px solid var(--ds-border)" }} />
        <span style={{ fontFamily: "monospace", fontSize: 13 }}>{color}</span>
        <span style={{ fontSize: 12, color: "var(--ds-text-3)" }}>--{label.toLowerCase()}</span>
      </div>
      <div className="ds-transparency-grid">
        {[90,80,70,60,50,40,30,20,10].map((o) => (<div key={o} className="ds-trans-box"><div className="ds-trans-overlay" style={{ backgroundColor: label === "White" ? "rgba(255,255,255," + (o / 100) + ")" : "rgba(0,0,0," + (o / 100) + ")", color: label === "White" ? "#18181b" : "#fafafa", textShadow: "none" }}>{o}%</div></div>))}
      </div>
    </>)}
  </div>);
}

function StepColors() {
  const { state, dispatch } = useDSContext();
  return (<div>
    <div style={{ marginBottom: 16 }}><button className="ds-btn ds-btn-primary" onClick={() => dispatch({ type: "ADD_PALETTE" })}>+ Add palette</button></div>
    {state.colors.palettes.map((p) => <PaletteCard key={p.id} palette={p} />)}
    <TransparencySection label="White" color="#ffffff" bgColor="#ffffff" field="whiteTransparency" />
    <TransparencySection label="Black" color="#000000" bgColor="#000000" field="blackTransparency" />
  </div>);
}

/* ================================================================
   STEP 6: GAPS
   ================================================================ */
function StepGaps() {
  const { state, dispatch } = useDSContext();
  const g = state.gaps;
  const isValidGap = (v) => !v || /^\d+(\.\d+)?$/.test(v.trim()) || /^var\(--[\w-]+\)$/.test(v.trim());
  const fields = [
    { key: "gridGap",      label: "--grid-gap",      helper: "Gap between grid items" },
    { key: "contentGap",   label: "--content-gap",   helper: "Gap between content blocks" },
    { key: "containerGap", label: "--container-gap", helper: "Padding inside containers" },
  ];
  const warns = [];
  const bad = fields.filter(f => !isValidGap(g[f.key]));
  if (bad.length) warns.push({ type: "warn", msg: "Invalid format for " + bad.map(f => f.label).join(", ") + ". Use a number (e.g. 16) or var(--name)" });
  return (<div>
    <div className="ds-card">
      <h4>Gaps</h4>
      <div className="ds-helper" style={{ marginBottom: 16 }}>Enter a pixel value (e.g. 16) or a variable reference (e.g. var(--space-m))</div>
      <ValidationAlert items={warns} />
      {fields.map((f) => (<div key={f.key} className="ds-form-group" style={{ marginBottom: 12 }}>
        <label>{f.label}</label>
        <input className={"ds-input" + (!isValidGap(g[f.key]) ? " ds-input-error" : "")} value={g[f.key]} onChange={(e) => dispatch({ type: "SET_GAPS", field: f.key, value: e.target.value })} placeholder="var(--space-m) or 16" />
        <div className="ds-helper">{f.helper}</div>
      </div>))}
    </div>
    <div className="ds-card">
      <h4>Grid <span style={{ fontWeight: 400, color: "var(--ds-text-3)", fontSize: 12 }}>— default variables (not editable)</span></h4>
      <div className="ds-helper" style={{ marginBottom: 12 }}>Ready-to-use column and ratio grids, e.g. <code>grid-template-columns: var(--grid-3)</code>. Hover to see each value.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
        {GRID_COLS.map((n) => <div key={n} className="ds-grid-chip" title={"--grid-" + n + ": " + gridValue(n)}>{n}</div>)}
        {GRID_RATIOS.map(([name, value]) => <div key={name} className="ds-grid-chip" title={"--grid-" + name + ": " + value}>{name}</div>)}
      </div>
    </div>
  </div>);
}

/* ================================================================
   STEP 7: BORDER RADIUS
   ================================================================ */
function StepRadius() {
  const { state, dispatch } = useDSContext();
  const r = state.radius;
  return (<div>
    <div className="ds-card"><h4>Base radius</h4>
      <div className="ds-form-group"><label>Base value (px) — maps to --radius-m</label>
        <NumStepper value={r.base} set={(n) => dispatch({ type: "RECALC_RADIUS", base: n })} min={0} />
      </div>
    </div>
    {RADIUS_KEYS.map((k, i) => (<div key={k} className={"ds-space-row" + (i % 2 ? " alt" : "")}>
      <div className="ds-space-name">--radius-{k}</div>
      <div><input className="ds-space-input" type="number" value={r.values[k] || 0} onChange={(e) => dispatch({ type: "SET_RADIUS_VAL", key: k, value: parseInt(e.target.value) || 0 })} /><div className="ds-space-label">px</div></div>
      <div style={{ width: 60, height: 40, background: "var(--ds-border-light)", border: "0.5px solid var(--ds-text-3)", borderRadius: r.values[k] || 0 }} />
    </div>))}
    <div className="ds-space-row alt" style={{ marginTop: 6 }}>
      <div className="ds-space-name">--radius-circle</div>
      <div><input className="ds-space-input" type="number" value={r.circle} onChange={(e) => dispatch({ type: "SET_RADIUS", payload: { circle: parseInt(e.target.value) || 0 } })} /><div className="ds-space-label">px</div></div>
      <div style={{ width: 40, height: 40, background: "var(--ds-border-light)", border: "0.5px solid var(--ds-text-3)", borderRadius: r.circle }} />
    </div>
  </div>);
}

/* ================================================================
   STEP 8: BUTTONS
   ================================================================ */
function StepButtons() {
  const { state, dispatch } = useDSContext();
  const b = state.buttons;
  const palettes = state.colors.palettes;
  const enabledPalettes = palettes.filter((p) => btnEnabled(state, p.id));

  return (<div>
    {/* SIZES */}
    <div className="ds-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <h4 style={{ margin: 0 }}>Sizes <span style={{ fontWeight: 400, color: "var(--ds-text-3)", fontSize: 12 }}>— padding in em, font from your type scale</span></h4>
        <button className="ds-btn ds-btn-sm" onClick={() => dispatch({ type: "RESET_BTN_SIZES" })} data-tip="Restore the default (gentle) size scale">↺ Reset to defaults</button>
      </div>
      <div className="ds-btn-sizes">
        <div className="ds-btn-sizes-head"><span>Size</span><span>Padding Y</span><span>Padding X</span><span>Font</span></div>
        {BTN_SIZES.map((s) => { const sz = b.sizes[s.key] || BTN_SIZE_DEFAULTS[s.key]; return (
          <div key={s.key} className="ds-btn-sizes-row">
            <span className="ds-btn-size-label">{s.label} <em>{s.cls ? "." + s.cls : ".btn"}</em></span>
            <input className="ds-input ds-input-sm" type="number" step="0.05" min="0" value={sz.py} onChange={(e) => dispatch({ type: "SET_BTN_SIZE", key: s.key, field: "py", value: parseFloat(e.target.value) || 0 })} />
            <input className="ds-input ds-input-sm" type="number" step="0.05" min="0" value={sz.px} onChange={(e) => dispatch({ type: "SET_BTN_SIZE", key: s.key, field: "px", value: parseFloat(e.target.value) || 0 })} />
            <select className="ds-input ds-input-sm" value={sz.font} onChange={(e) => dispatch({ type: "SET_BTN_SIZE", key: s.key, field: "font", value: e.target.value })}>
              {TEXT_KEYS.map((k) => <option key={k} value={k}>text-{k}</option>)}
            </select>
          </div>
        ); })}
      </div>
    </div>

    {/* OPTIONS */}
    <div className="ds-card">
      <h4>Options</h4>
      <div className="ds-toggle-row" onClick={() => dispatch({ type: "SET_BTN", payload: { outline: !b.outline } })}>
        <div className={"ds-toggle-track" + (b.outline ? " on" : "")}><div className="ds-toggle-thumb" /></div>
        <div className="ds-toggle-text"><strong>Include outline variants</strong><span>Adds a .btn--outline modifier for each enabled color</span></div>
      </div>
      <div className="ds-grid-2" style={{ marginTop: 12 }}>
        <div className="ds-form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontSize: 12 }}>Border radius</label>
          <select className="ds-input" value={b.radiusKey} onChange={(e) => dispatch({ type: "SET_BTN", payload: { radiusKey: e.target.value } })}>
            {RADIUS_KEYS.map((k) => <option key={k} value={k}>--radius-{k}</option>)}
            <option value="circle">--radius-circle</option>
          </select>
        </div>
        <div className="ds-form-group" style={{ marginBottom: 0 }}>
          <label style={{ fontSize: 12 }}>Hover transition (ms) <span style={{ fontWeight: 400, color: "var(--ds-text-3)" }}>— --btn-transition</span></label>
          <NumStepper value={b.transitionMs ?? 150} set={(n) => dispatch({ type: "SET_BTN", payload: { transitionMs: Math.max(0, n) } })} min={0} step={25} />
        </div>
      </div>
      <div className="ds-helper" style={{ marginTop: 8 }}>Hover a button in the preview below to see the transition.</div>
    </div>

    {/* COLORS */}
    <div className="ds-card">
      <h4>Colors <span style={{ fontWeight: 400, color: "var(--ds-text-3)", fontSize: 12 }}>— choose which palette colors generate button styles</span></h4>
      {palettes.map((p) => { const on = btnEnabled(state, p.id); const slug = slugify(p.name); return (
        <div key={p.id} className="ds-toggle-row" onClick={() => dispatch({ type: "TOGGLE_BTN_COLOR", id: p.id })}>
          <div className={"ds-toggle-track" + (on ? " on" : "")}><div className="ds-toggle-thumb" /></div>
          <div style={{ width: 18, height: 18, borderRadius: 4, flexShrink: 0, background: "hsl(" + p.hue + "," + p.saturation + "%," + p.lightness + "%)", border: "1px solid var(--ds-border)" }} />
          <div className="ds-toggle-text"><strong>{p.name}</strong><span style={{ fontFamily: "monospace" }}>.btn--{slug}{b.outline ? " · .btn--" + slug + ".btn--outline" : ""}</span></div>
        </div>
      ); })}
    </div>

    {/* PREVIEW */}
    <div className="ds-card">
      <h4>Preview</h4>
      {enabledPalettes.length === 0
        ? <div className="ds-helper">No colors enabled. Toggle a color above to preview its buttons.</div>
        : enabledPalettes.map((p) => (
          <div key={p.id} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ds-text-2)", marginBottom: 8 }}>{p.name}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: b.outline ? 10 : 0 }}>
              {BTN_SIZES.map((s) => <PreviewButton key={s.key} state={state} palette={p} sizeKey={s.key} outline={false} />)}
            </div>
            {b.outline && <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              {BTN_SIZES.map((s) => <PreviewButton key={s.key} state={state} palette={p} sizeKey={s.key} outline={true} />)}
            </div>}
          </div>
        ))}
    </div>
  </div>);
}

/* ================================================================
   CSS GENERATORS
   ================================================================ */
const gapVal = (v) => /^\d+$/.test(v) ? v + "px" : v;

function generateVariablesJSON(state) {
  const prefix = state.varPrefix ? state.varPrefix + '-' : '';
  const pn = (n) => prefix + n;
  const pv = (val) => prefix ? val.replace(/var\(--([\w-]+)/g, (_, n) => 'var(--' + prefix + n) : val;
  const catIds = {};
  ['Spacing','SectionSpacing','Texts','Headings','Gaps','Grid','Buttons','Radius','Styles'].forEach(n => { catIds[n] = randId(); });
  const mk = (name, value, cat) => ({ name: pn(name), value: pv(value), id: randId(), category: catIds[cat] });
  const vars = [];

  // Spacing (fluid clamp, rem)
  SPACE_KEYS.forEach(k => {
    const sv = state.spacing.values[k]; if (!sv) return;
    vars.push(mk('space-' + k, flRem(sv.mobile, sv.desktop, state), 'Spacing'));
  });
  // Section Spacing (fluid clamp, rem)
  SPACE_KEYS.forEach(k => {
    const sv = state.sectionSpacing.values[k]; if (!sv) return;
    vars.push(mk('section-space-' + k, flRem(sv.mobile, sv.desktop, state), 'SectionSpacing'));
  });
  // Texts (fluid clamp, rem)
  TEXT_KEYS.forEach(k => { const tv = state.typography.texts[k]; if (!tv) return; vars.push(mk('text-' + k, flRem(tv.mobile, tv.desktop, state), 'Texts')); });
  // Headings (fluid clamp, rem)
  ['h1','h2','h3','h4','h5','h6'].forEach(h => { const hv = state.typography.headings[h]; if (!hv) return; vars.push(mk(h, flRem(hv.mobile, hv.desktop, state), 'Headings')); });
  // Gaps
  vars.push(mk('grid-gap', gapVal(state.gaps.gridGap), 'Gaps'));
  vars.push(mk('content-gap', gapVal(state.gaps.contentGap), 'Gaps'));
  vars.push(mk('container-gap', gapVal(state.gaps.containerGap), 'Gaps'));
  // Gutter (fluido, rem) — protege el contenido de los bordes
  { const g = state.gutter || { mobile: 16, desktop: 64 }; vars.push(mk('gutter', flRem(g.mobile, g.desktop, state), 'Gaps')); }
  // Grid (columnas 1–12 + ratios asimétricos) — valores estáticos, sin prefijo en el value
  GRID_COLS.forEach(n => { vars.push({ name: pn('grid-' + n), value: gridValue(n), id: randId(), category: catIds['Grid'] }); });
  GRID_RATIOS.forEach(([name, value]) => { vars.push({ name: pn('grid-' + name), value, id: randId(), category: catIds['Grid'] }); });
  // Buttons — padding en em por tamaño
  if (state.buttons) {
    BTN_SIZES.forEach(s => {
      const sz = state.buttons.sizes[s.key]; if (!sz) return;
      vars.push({ name: pn('pad-btn-y-' + s.key), value: sz.py + 'em', id: randId(), category: catIds['Buttons'] });
      vars.push({ name: pn('pad-btn-x-' + s.key), value: sz.px + 'em', id: randId(), category: catIds['Buttons'] });
    });
    vars.push({ name: pn('btn-transition'), value: (state.buttons.transitionMs ?? 150) + 'ms', id: randId(), category: catIds['Buttons'] });
  }
  // Radius
  RADIUS_KEYS.forEach(k => { vars.push(mk('radius-' + k, (state.radius.values[k] || 0) + 'px', 'Radius')); });
  vars.push(mk('radius-circle', state.radius.circle + 'px', 'Radius'));
  // Styles
  vars.push(mk('line-height-heading', String(state.typography.lineHeightHeading), 'Styles'));
  vars.push(mk('line-height-body', String(state.typography.lineHeightBody), 'Styles'));
  { const st = state.styles || {};
    vars.push(mk('text-color', st.textColor || '#1f2937', 'Styles'));
    vars.push(mk('heading-color', st.headingColor || '#111827', 'Styles'));
    vars.push(mk('text-weight', String(st.textWeight || 400), 'Styles'));
    vars.push(mk('heading-weight', String(st.headingWeight || 700), 'Styles'));
    vars.push(mk('offset', (state.offset ?? 80) + 'px', 'Styles'));
  }

  // Categorías con metadata de escala para que Bricks muestre el escalado visual
  const sp = state.spacing;
  const ss = state.sectionSpacing;
  const ty = state.typography;
  const categories = [
    {
      id: catIds['Spacing'], name: 'Spacing',
      scale: {
        scaleScope: 'spacing', scaleType: 'custom',
        scaleNames: ['xs','s','m','l','xl','xxl'],
        prefix: pn('space-'),
        minFontSize: sp.baseMobile, minScaleRatio: sp.scale, minScaleRatioSelect: sp.scale,
        maxFontSize: sp.baseDesktop, maxScaleRatio: sp.scale, maxScaleRatioSelect: sp.scale,
        baseline: 'm',
        manualValues: ['xs','s','m','l','xl','xxl'].map(k => ({
          name: pn('space-' + k),
          min: (sp.values[k]?.mobile || 0) + 'px',
          max: (sp.values[k]?.desktop || 0) + 'px',
        })),
        isManual: true,
      }
    },
    {
      id: catIds['SectionSpacing'], name: 'SectionSpacing',
      scale: {
        scaleScope: 'spacing', scaleType: 'custom',
        scaleNames: ['xs','s','m','l','xl','xxl'],
        prefix: pn('section-space-'),
        minFontSize: ss.baseMobile, minScaleRatio: ss.scale, minScaleRatioSelect: ss.scale,
        maxFontSize: ss.baseDesktop, maxScaleRatio: ss.scale, maxScaleRatioSelect: ss.scale,
        baseline: 'm',
        manualValues: ['xs','s','m','l','xl','xxl'].map(k => ({
          name: pn('section-space-' + k),
          min: (ss.values[k]?.mobile || 0) + 'px',
          max: (ss.values[k]?.desktop || 0) + 'px',
        })),
        isManual: true,
      }
    },
    {
      id: catIds['Texts'], name: 'Texts',
      scale: {
        scaleScope: 'typography', scaleType: 'custom',
        scaleNames: ['xs','s','m','l','xl','xxl'],
        prefix: pn('text-'),
        minFontSize: ty.textBaseMob, minScaleRatio: ty.textScale, minScaleRatioSelect: ty.textScale,
        maxFontSize: ty.textBaseDesk, maxScaleRatio: ty.textScale, maxScaleRatioSelect: ty.textScale,
        baseline: 'm',
        manualValues: TEXT_KEYS.map(k => ({
          name: pn('text-' + k),
          min: (ty.texts[k]?.mobile || 0) + 'px',
          max: (ty.texts[k]?.desktop || 0) + 'px',
        })),
        isManual: true,
      }
    },
    {
      id: catIds['Headings'], name: 'Headings',
      scale: {
        scaleScope: 'typography', scaleType: 'custom',
        scaleNames: ['1','2','3','4','5','6'],
        prefix: pn('h'),
        minFontSize: ty.headingBaseMob, minScaleRatio: ty.headingScale, minScaleRatioSelect: ty.headingScale,
        maxFontSize: ty.headingBaseDesk, maxScaleRatio: ty.headingScale, maxScaleRatioSelect: ty.headingScale,
        baseline: '3',
        manualValues: ['h1','h2','h3','h4','h5','h6'].map(h => ({
          name: pn(h),
          min: (ty.headings[h]?.mobile || 0) + 'px',
          max: (ty.headings[h]?.desktop || 0) + 'px',
        })),
        isManual: true,
      }
    },
    { id: catIds['Gaps'], name: 'Gaps' },
    { id: catIds['Grid'], name: 'Grid' },
    { id: catIds['Buttons'], name: 'Buttons' },
    { id: catIds['Radius'], name: 'Radius' },
    { id: catIds['Styles'], name: 'Styles' },
  ];
  return JSON.stringify({ variables: vars, categories }, null, 2);
}

// Clases (global classes de Bricks) — solo nombres; el estilo lo aplica el Framework CSS.
// Categoría = nombre del sistema de diseño.
function generateClassesJSON(state, systemName) {
  const catId = randId();
  const catName = (systemName && systemName.trim()) || "Design system";
  const names = ["btn"];
  BTN_SIZES.forEach((s) => { if (s.cls) names.push(s.cls); }); // btn--sm/md/lg/xl
  state.colors.palettes.filter((p) => btnEnabled(state, p.id)).forEach((p) => names.push("btn--" + slugify(p.name)));
  if (state.buttons?.outline) names.push("btn--outline");
  names.push("no-scroll");
  const classes = names.map((name) => ({
    id: randId(),
    name,
    settings: {},
    category: catId,
    _categoryData: { id: catId, name: catName },
  }));
  return JSON.stringify(classes, null, 2);
}

function generateColorPaletteJSON(state) {
  const prefix = state.varPrefix ? state.varPrefix + '-' : '';
  const vr = (n) => 'var(--' + prefix + n + ')';
  const colors = [];
  state.colors.palettes.forEach(p => {
    const slug = slugify(p.name);
    const hex = hslToHex(p.hue, p.saturation, p.lightness);
    const rootId = randId();
    colors.push({ raw: vr(slug), id: rootId, name: p.name, light: hex });
    if (p.showVariants) {
      ['ultra-dark','dark','semi-dark'].forEach((key, idx) => { if (p.variants[key]) colors.push({ id: randId(), type: 'dark', raw: vr(slug + '-' + key), index: idx, parent: rootId, light: hslStrToHex(p.variants[key]) }); });
      ['semi-light','light','ultra-light'].forEach((key, idx) => { if (p.variants[key]) colors.push({ id: randId(), type: 'light', raw: vr(slug + '-' + key), index: idx, parent: rootId, light: hslStrToHex(p.variants[key]) }); });
    }
    if (p.showTransparency) { [90,80,70,60,50,40,30,20,10].forEach((o, idx) => { colors.push({ id: randId(), type: 'transparent', raw: vr(slug + '-trans-' + o), index: idx, parent: rootId, light: 'hsla(' + p.hue + ', ' + p.saturation + '%, ' + p.lightness + '%, ' + (o/100) + ')' }); }); }
  });
  if (state.colors.whiteTransparency) { const wId = randId(); colors.push({ raw: vr('white'), id: wId, name: 'White', light: '#ffffff' }); [90,80,70,60,50,40,30,20,10].forEach((o, idx) => colors.push({ id: randId(), type: 'transparent', raw: vr('white-trans-' + o), index: idx, parent: wId, light: 'rgba(255, 255, 255, ' + (o/100) + ')' })); }
  if (state.colors.blackTransparency) { const bId = randId(); colors.push({ raw: vr('black'), id: bId, name: 'Black', light: '#000000' }); [90,80,70,60,50,40,30,20,10].forEach((o, idx) => colors.push({ id: randId(), type: 'transparent', raw: vr('black-trans-' + o), index: idx, parent: bId, light: 'rgba(0, 0, 0, ' + (o/100) + ')' })); }
  return JSON.stringify({ id: randId(), name: 'BricksMate', colors, default: true }, null, 2);
}

// Botones en BEM. Compose: <a class="btn btn--primary btn--lg">
function generateButtonsCSS(state, v) {
  const b = state.buttons;
  if (!b) return "";
  const palettes = state.colors.palettes.filter((pl) => btnEnabled(state, pl.id));
  const rad = b.radiusKey === "circle" ? v("radius-circle") : v("radius-" + b.radiusKey);
  const d = b.sizes.default;
  const fk = (f) => TEXT_KEYS.includes(f) ? f : "m"; // tolera claves antiguas (p.ej. "mm")
  let css = "\n/* ================================================\n * BUTTONS (BEM) — compose: class=\"btn btn--primary btn--lg\"\n * ================================================ */\n";
  css += ".btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 0.5em;\n";
  css += "  padding: " + v("pad-btn-y-default") + " " + v("pad-btn-x-default") + ";\n";
  css += "  font-size: " + v("text-" + fk(d.font)) + ";\n  font-weight: 600;\n  line-height: 1.2;\n  text-decoration: none;\n  cursor: pointer;\n  border: 1.5px solid transparent;\n";
  css += "  border-radius: " + rad + ";\n  transition: background-color " + v("btn-transition") + ", color " + v("btn-transition") + ", border-color " + v("btn-transition") + ";\n}\n";
  BTN_SIZES.filter((s) => s.cls).forEach((s) => {
    const sz = b.sizes[s.key];
    css += "." + s.cls + " {\n  padding: " + v("pad-btn-y-" + s.key) + " " + v("pad-btn-x-" + s.key) + ";\n  font-size: " + v("text-" + fk(sz.font)) + ";\n}\n";
  });
  palettes.forEach((pl) => {
    const slug = slugify(pl.name);
    const col = v(slug);
    const dark = "hsl(" + pl.hue + ", " + pl.saturation + "%, " + Math.max(0, pl.lightness - 10) + "%)";
    const onCol = btnContrast(pl.lightness);
    css += "\n.btn--" + slug + " {\n  background-color: " + col + ";\n  border-color: " + col + ";\n  color: " + onCol + ";\n}\n";
    css += ".btn--" + slug + ":hover {\n  background-color: " + dark + ";\n  border-color: " + dark + ";\n}\n";
    if (b.outline) {
      css += ".btn--" + slug + ".btn--outline {\n  background-color: transparent;\n  border-color: " + col + ";\n  color: " + col + ";\n}\n";
      css += ".btn--" + slug + ".btn--outline:hover {\n  background-color: " + col + ";\n  color: " + onCol + ";\n}\n";
    }
  });
  return css;
}

function generateFrameworkCSS(state) {
  const p = state.varPrefix ? '--' + state.varPrefix + '-' : '--';
  const v = (n) => 'var(' + p + n + ')';
  const ts = new Date().toLocaleString();
  const primary = v(slugify(state.colors.palettes[0]?.name || 'primary'));
  let css = "/* ================================================\n * BRICKSMATE FRAMEWORK BASE CSS\n * Apply tokens to HTML elements globally\n * Paste into: Bricks → Settings → Custom Code → CSS\n * Generated: " + ts + "\n * ================================================ */\n\n";

  css += "/* — Base & smooth scroll ————————————————— */\n";
  css += "html {\n  scroll-behavior: smooth;\n}\n";
  css += "[id] {\n  scroll-margin-top: calc(" + v('offset') + " / 1.6);\n}\n";
  css += "ul {\n  margin: 0;\n  padding: 0;\n}\n\n";

  css += "/* — Accessibility (keyboard focus) ——————— */\n";
  css += "body.bricks-is-frontend :focus {\n  outline: none;\n}\n";
  css += "body.bricks-is-frontend :focus-visible {\n  outline: 2px solid " + primary + ";\n  outline-offset: 4px;\n  transition: outline-color .2s;\n}\n\n";

  css += "/* — Text ———————————————————————————————— */\n";
  css += "body {\n  font-size: " + v('text-m') + ";\n  line-height: " + v('line-height-body') + ";\n  color: " + v('text-color') + ";\n  font-weight: " + v('text-weight') + ";\n}\n\n";
  css += "/* — Headings —————————————————————————————— */\n";
  css += "h1, h2, h3, h4, h5, h6 {\n  line-height: " + v('line-height-heading') + ";\n  color: " + v('heading-color') + ";\n  font-weight: " + v('heading-weight') + ";\n}\n";
  ['h1','h2','h3','h4','h5','h6'].forEach(h => { css += h + " { font-size: " + v(h) + "; }\n"; });

  css += "\n/* — Sections —————————————————————————————— */\n";
  css += ":where(section:not(section section)) {\n  padding: " + v('section-space-m') + " " + v('gutter') + ";\n}\n";
  css += "section:where(:not(.bricks-shape-divider)) {\n  gap: " + v('container-gap') + ";\n}\n";
  css += ":where(.brxe-container) > .brxe-block,\n:where(.brxe-container) {\n  gap: " + v('content-gap') + ";\n}\n\n";

  css += "/* — Content links ———————————————————————— */\n";
  css += "body .brxe-post-content a:not([class]),\nbody .brxe-text a:not([class]),\nbody label a {\n  text-decoration-line: underline;\n  text-decoration-color: " + primary + ";\n  text-underline-offset: .2em;\n  text-decoration-thickness: 1px;\n  transition: all .3s;\n}\n";
  css += "body .brxe-post-content a:hover:not([class]),\nbody .brxe-text a:hover:not([class]),\nbody label a:hover {\n  color: " + primary + ";\n}\n\n";

  css += "/* — Overflow fix & utilities ————————————— */\n";
  css += ".bricks-is-frontend header {\n  max-width: 100vw;\n}\n";
  css += "body.bricks-is-frontend {\n  overflow-x: clip;\n}\n";
  css += "body.bricks-is-frontend.no-scroll {\n  overflow: hidden !important;\n}\n";

  css += generateButtonsCSS(state, v);
  return css;
}

/* ================================================================
   STEP 8: PREVIEW
   ================================================================ */
/* Landing de muestra: aplica los tokens reales (clamp/rem) a una web ficticia.
   Lienzo neutro fijo (independiente del dark mode de la app) para ver los colores como en una web real. */
function LandingPreview({ state }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(null); // px arrastrado, o null = ancho completo
  const [maxW, setMaxW] = useState(null);   // ancho máximo del panel (full) para mapear a viewport
  useEffect(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const update = () => setMaxW(el.clientWidth - 18);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const startDrag = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wrapRef.current.offsetWidth;
    const maxW = (wrapRef.current.parentElement?.clientWidth || 9999) - 18;
    const onMove = (ev) => setWidth(Math.max(300, Math.min(maxW, startW + (ev.clientX - startX))));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); document.body.style.userSelect = ""; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
  };
  const t = state.typography, sp = state.spacing, ss = state.sectionSpacing, r = state.radius;
  const p = state.colors.palettes[0] || { hue: 210, saturation: 75, lightness: 50 };
  const primary = "hsl(" + p.hue + "," + p.saturation + "%," + p.lightness + "%)";
  const primaryTint = "hsl(" + p.hue + "," + Math.min(90, p.saturation) + "%,96%)";
  const onPrimary = p.lightness > 60 ? "#18181b" : "#ffffff";
  // El lienzo simula un viewport: full = maxViewport (desktop), arrastrado al mínimo = minViewport (mobile).
  // Los tamaños fluidos se evalúan a ese viewport simulado para que el preview respete lo configurado.
  const fullW = (maxW && maxW > 300) ? maxW : null;
  const boxW = width != null ? width : (fullW || state.maxViewport);
  const ratio = fullW ? Math.max(0, Math.min(1, (boxW - 300) / (fullW - 300))) : 1;
  const simVP = Math.round(state.minViewport + ratio * (state.maxViewport - state.minViewport));
  const at = (m, d) => sizeAtVP(m, d, state, simVP) + "px";
  const h = (k) => at(t.headings[k]?.mobile, t.headings[k]?.desktop);
  const tx = (k) => at(t.texts[k]?.mobile, t.texts[k]?.desktop);
  const spc = (k) => at(sp.values[k]?.mobile, sp.values[k]?.desktop);

  const vars = {
    "--h1": h("h1"), "--h2": h("h2"), "--h3": h("h3"), "--h4": h("h4"),
    "--tl": tx("l"), "--tm": tx("m"), "--ts": tx("s"),
    "--secM": at(ss.values.m?.mobile || 80, ss.values.m?.desktop || 100),
    "--secL": at(ss.values.l?.mobile || 120, ss.values.l?.desktop || 150),
    "--gut": at((state.gutter || {}).mobile || 16, (state.gutter || {}).desktop || 64),
    "--spS": spc("s"), "--spM": spc("m"), "--spL": spc("l"), "--spXL": spc("xl"),
    "--rm": (r.values.m || 8) + "px", "--rl": (r.values.l || 12) + "px", "--rc": (r.circle || 999) + "px",
    "--lhh": t.lineHeightHeading, "--lhb": t.lineHeightBody,
    "--cp": primary, "--cpt": primaryTint, "--cop": onPrimary,
    "--cbg": "#ffffff", "--ctext": "#1a1a1a", "--cmut": "#5f6b7a", "--cbd": "#e5e7eb", "--cfoot": "#f3f4f6",
  };

  // Layout mode → contenedor de las secciones
  const isFixed = state.layoutMode === "fixed";
  const maxVp = state.maxViewport;
  // Fixed: contenido centrado con ancho máximo (boxed). Full-width: 100%.
  const container = isFixed ? "min(" + maxVp + "px, 92%)" : "100%";
  // Breakpoints según el viewport simulado → la landing es responsive de verdad
  const mobile = simVP < 768;
  const tablet = simVP < 1024;

  // Botones reales del sistema (mismo helper que el paso Buttons) → tamaño, padding em, radius y color configurados
  const linkBtn = { background: "transparent", color: "var(--ctext)", border: "none", fontSize: "var(--ts)", fontWeight: 500, cursor: "pointer", fontFamily: "inherit" };

  const logoMark = (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" style={{ flexShrink: 0 }}>
      <path d="M4 7a3 3 0 0 1 3-3h8l7 7v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="var(--cp)" />
      <path d="M15 4v6h6" stroke="var(--cbg)" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
    </svg>
  );

  const heroArt = (
    <svg viewBox="0 0 360 320" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: "100%", height: "auto", maxWidth: 360 }}>
      <ellipse cx="190" cy="165" rx="150" ry="120" strokeDasharray="3 9" opacity="0.35" />
      <path d="M70 282 h188 l20 20 H50 z" />
      <rect x="88" y="184" width="166" height="98" rx="6" />
      <line x1="122" y1="260" x2="122" y2="234" />
      <line x1="150" y1="260" x2="150" y2="216" />
      <line x1="178" y1="260" x2="178" y2="242" />
      <line x1="206" y1="260" x2="206" y2="224" />
      <path d="M196 152 q26 -14 44 6 l10 60 -64 0 z" fill="currentColor" stroke="none" />
      <circle cx="222" cy="130" r="18" />
      <path d="M236 152 l36 -36" />
      <circle cx="280" cy="110" r="12" />
      <path d="M275 122 h10" />
      <path d="M268 254 h36 l-5 40 h-26 z" />
      <path d="M304 262 q14 6 0 20" />
    </svg>
  );

  const supportArt = (
    <svg viewBox="0 0 340 300" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: "100%", height: "auto", maxWidth: 320 }}>
      <circle cx="170" cy="150" r="78" strokeDasharray="5 11" />
      <circle cx="170" cy="150" r="54" />
      <circle cx="90" cy="82" r="34" />
      <circle cx="250" cy="98" r="28" />
      <circle cx="232" cy="226" r="32" />
      <circle cx="90" cy="72" r="11" fill="currentColor" stroke="none" />
      <path d="M70 102 q20 -18 40 0 z" fill="currentColor" stroke="none" />
      <circle cx="170" cy="138" r="14" fill="currentColor" stroke="none" />
      <path d="M146 178 q24 -22 48 0 z" fill="currentColor" stroke="none" />
      <circle cx="232" cy="218" r="11" fill="currentColor" stroke="none" />
      <path d="M212 248 q20 -16 40 0 z" fill="currentColor" stroke="none" />
    </svg>
  );

  const features = [
    { t: "Seamless integration", d: "Integrate seamlessly with your existing systems and processes, ensuring a smooth transition to our software." },
    { t: "User-friendly interface", d: "Our intuitive user interface ensures your team can hit the ground running with minimal training." },
    { t: "Real-time analytics", d: "Gain access to real-time data and analytics, enabling you to make informed decisions and stay ahead." },
    { t: "Mobile accessibility", d: "Access your data and tools from anywhere with mobile compatibility, keeping your team connected." },
    { t: "Customization options", d: "Tailor the platform to your unique business needs with extensive customization options." },
    { t: "Scalability", d: "Whether you're a small startup or a large enterprise, our solutions scale with your business as it grows." },
    { t: "Robust security", d: "Your data is our top priority. Benefit from state-of-the-art security measures to keep it safe." },
    { t: "Ongoing support", d: "Count on our dedicated support team for training, troubleshooting, and continuous improvement." },
  ];
  const footerCols = [
    { h: "Quick Links", links: ["Home", "Features", "Pricing", "About Us", "Contact Us"] },
    { h: "Legal", links: ["Privacy policy", "Terms of service", "Cookie policy"] },
    { h: "Stay Connected", links: ["LinkedIn", "Facebook", "Twitter"] },
  ];

  return (<div className="ds-landing">
    {/* Toolbar: layout badge + ancho actual + reset */}
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: "var(--ds-radius)", background: "var(--ds-primary)", color: "var(--ds-bg)" }}>
        {isFixed ? "Fixed-width · max " + maxVp + "px" : "Full-width · 100%"}
      </span>
      <span style={{ fontSize: 11.5, color: "var(--ds-text-3)" }}>↔ Drag to resize — simulating ≈{simVP}px viewport{ratio >= 0.999 ? " (desktop)" : ratio <= 0.001 ? " (mobile)" : ""}</span>
      {width && <button className="ds-btn ds-btn-sm" onClick={() => setWidth(null)} style={{ marginLeft: "auto" }}>Reset width</button>}
    </div>
    {/* Área redimensionable (cqw responde a este contenedor) */}
    <div style={{ position: "relative", paddingRight: 18 }}>
      <div ref={wrapRef} style={{ ...vars, position: "relative", width: width ? width + "px" : "100%", maxWidth: "100%", containerType: "inline-size" }}>
        <div style={{ background: "var(--cbg)", color: "var(--ctext)", fontFamily: "'Inter',system-ui,sans-serif", borderRadius: "var(--ds-radius-lg)", overflow: "hidden", border: "1px solid var(--ds-border-light)" }}>

      {/* NAV */}
      <header style={{ borderBottom: "1px solid var(--cbd)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--spM)", padding: "var(--spM) var(--gut)", maxWidth: container, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {logoMark}
            <span style={{ fontWeight: 700, fontSize: "var(--tl)", color: "var(--ctext)" }}>Zephtor</span>
          </div>
          {!mobile && <nav style={{ display: "flex", gap: "var(--spM)", alignItems: "center" }}>
            {["Home", "Features", "Pricing", "About Us", "Contact"].map((x) => <span key={x} style={{ fontSize: "var(--ts)", color: "var(--ctext)", cursor: "pointer", whiteSpace: "nowrap" }}>{x}</span>)}
          </nav>}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--spM)" }}>
            {mobile
              ? <span style={{ fontSize: "var(--tl)", color: "var(--ctext)", cursor: "pointer", lineHeight: 1 }}>☰</span>
              : <><PreviewButton state={state} palette={p} sizeKey="s" outline={false}>Sign up</PreviewButton><button style={linkBtn}>Login</button></>}
          </div>
        </div>
      </header>

      {/* HERO */}
      <section style={{ padding: "var(--secL) var(--gut)" }}>
        <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1.05fr 0.95fr", gap: "var(--spXL)", alignItems: "center", maxWidth: container, margin: "0 auto" }}>
          <div>
            <h1 style={{ fontSize: "var(--h1)", lineHeight: "var(--lhh)", color: "var(--ctext)", fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 var(--spM)", overflowWrap: "break-word" }}>Your digital transformation begins here</h1>
            <p style={{ fontSize: "var(--tm)", lineHeight: "var(--lhb)", color: "var(--cmut)", margin: "0 0 var(--spL)", maxWidth: 420 }}>Unlock the full potential of your business. Start your journey today and watch your operations transform to fit your needs like a glove.</p>
            <div style={{ display: "flex", gap: "var(--spS)", flexWrap: "wrap" }}>
              <PreviewButton state={state} palette={p} sizeKey="l" outline={false}>Learn more</PreviewButton>
              <PreviewButton state={state} palette={p} sizeKey="l" outline={true}>Watch demo</PreviewButton>
            </div>
          </div>
          {!mobile && <div style={{ color: "var(--ctext)", display: "flex", justifyContent: "center" }}>{heroArt}</div>}
        </div>
      </section>

      {/* SUPPORT — sección alterna (imagen izquierda / texto derecha) */}
      <section style={{ padding: "var(--secM) var(--gut)" }}>
        <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "0.95fr 1.05fr", gap: "var(--spXL)", alignItems: "center", maxWidth: container, margin: "0 auto" }}>
          {!mobile && <div style={{ color: "var(--ctext)", display: "flex", justifyContent: "center" }}>{supportArt}</div>}
          <div>
            <h2 style={{ fontSize: "var(--h2)", lineHeight: "var(--lhh)", color: "var(--ctext)", fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 var(--spM)" }}>Dedicated support</h2>
            <p style={{ fontSize: "var(--tm)", lineHeight: "var(--lhb)", color: "var(--cmut)", margin: "0 0 var(--spL)" }}>Zephtor provides ongoing support and training to ensure you maximize the value of our software. Our experts are here to assist you at every step of your digital transformation journey.</p>
            <PreviewButton state={state} palette={p} sizeKey="default" outline={false}>Learn more</PreviewButton>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section style={{ padding: "var(--secM) var(--gut)" }}>
        <div style={{ textAlign: "center", maxWidth: 640, margin: "0 auto var(--spXL)" }}>
          <h2 style={{ fontSize: "var(--h2)", lineHeight: "var(--lhh)", color: "var(--ctext)", fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 var(--spS)" }}>Discover what sets Zephtor apart</h2>
          <p style={{ fontSize: "var(--tm)", lineHeight: "var(--lhb)", color: "var(--cmut)", margin: 0 }}>Our suite of SaaS solutions is packed with powerful features.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(" + (mobile ? 1 : tablet ? 2 : 4) + ",1fr)", gap: "var(--spL)", maxWidth: container, margin: "0 auto" }}>
          {features.map((f) => (
            <div key={f.t}>
              <h3 style={{ fontSize: "var(--tl)", lineHeight: "var(--lhh)", color: "var(--ctext)", fontWeight: 700, margin: "0 0 var(--spS)" }}>{f.t}</h3>
              <p style={{ fontSize: "var(--ts)", lineHeight: "var(--lhb)", color: "var(--cmut)", margin: 0 }}>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ background: "var(--cfoot)", padding: "var(--spXL) var(--gut)" }}>
        <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "1.6fr 1fr 1fr 1fr", gap: "var(--spL)", maxWidth: container, margin: "0 auto" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "var(--spS)" }}>
              {logoMark}
              <span style={{ fontWeight: 700, fontSize: "var(--tl)", color: "var(--ctext)" }}>Zephtor</span>
            </div>
            <p style={{ fontSize: "var(--ts)", lineHeight: "var(--lhb)", color: "var(--cmut)", margin: 0 }}>Your digital transformation partner.</p>
          </div>
          {footerCols.map((col) => (
            <div key={col.h}>
              <div style={{ fontSize: "var(--ts)", fontWeight: 700, color: "var(--ctext)", marginBottom: "var(--spM)" }}>{col.h}</div>
              {col.links.map((l) => (
                <div key={l} style={{ fontSize: "var(--ts)", lineHeight: 1.4, color: "var(--cmut)", marginBottom: "var(--spS)", textDecoration: "underline", cursor: "pointer" }}>{l}</div>
              ))}
            </div>
          ))}
        </div>
      </footer>
        </div>
        <div className="ds-resize-handle" onMouseDown={startDrag} title="Drag to resize" />
      </div>
    </div>
  </div>);
}

function StepPreview() {
  const { state } = useDSContext();
  const [view, setView] = useState("tokens");
  const t = state.typography;
  const sp = state.spacing;
  const r = state.radius;

  return (<div>
    <div className="ds-view-toggle">
      <button className={"ds-view-btn" + (view === "tokens" ? " active" : "")} onClick={() => setView("tokens")}>Tokens</button>
      <button className={"ds-view-btn" + (view === "landing" ? " active" : "")} onClick={() => setView("landing")}>Landing</button>
    </div>
    {view === "landing" ? <LandingPreview state={state} /> : <>

    {/* COLORS — todas las paletas + variantes + transparencias */}
    <div className="ds-preview-section">
      <div className="ds-preview-section-title">Colors</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 12 }}>
        {state.colors.palettes.map((p) => (
          <div key={p.id} style={{ background: "var(--ds-bg-card)", border: "0.5px solid var(--ds-border-light)", borderRadius: "var(--ds-radius-lg)", padding: 14 }}>
            <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--ds-text-3)", marginBottom: 6 }}>--{slugify(p.name)}</div>
            <div style={{ height: 44, borderRadius: 6, backgroundColor: "hsl(" + p.hue + "," + p.saturation + "%," + p.lightness + "%)", marginBottom: (p.showVariants || p.showTransparency) ? 8 : 0, display: "flex", alignItems: "center", justifyContent: "center", color: p.lightness > 55 ? "var(--ds-bg)" : "var(--ds-text)", fontSize: 12, fontWeight: 500 }}>{p.name}</div>
            {p.showVariants && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3, marginBottom: p.showTransparency ? 8 : 0 }}>
                {VARIANT_LIGHTNESS.map(({ key }) => (
                  <div key={key} title={key} style={{ height: 22, borderRadius: 3, backgroundColor: p.variants[key], border: "0.5px solid var(--ds-border)" }} />
                ))}
              </div>
            )}
            {p.showTransparency && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(9,1fr)", gap: 2 }}>
                {[90,80,70,60,50,40,30,20,10].map(o => (
                  <div key={o} title={o + "%"} style={{ height: 18, borderRadius: 3, backgroundImage: "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)", backgroundSize: "8px 8px", backgroundPosition: "0 0,0 4px,4px -4px,-4px 0", position: "relative" }}>
                    <div style={{ position: "absolute", inset: 0, borderRadius: 3, backgroundColor: "hsla(" + p.hue + "," + p.saturation + "%," + p.lightness + "%," + (o / 100) + ")" }} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {(state.colors.whiteTransparency || state.colors.blackTransparency) && (
          <div style={{ background: "var(--ds-bg-card)", border: "0.5px solid var(--ds-border-light)", borderRadius: "var(--ds-radius-lg)", padding: 14 }}>
            <div style={{ fontSize: 11, color: "var(--ds-text-3)", marginBottom: 6 }}>B&W transparencies</div>
            {state.colors.whiteTransparency && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(9,1fr)", gap: 2, marginBottom: state.colors.blackTransparency ? 6 : 0 }}>
                {[90,80,70,60,50,40,30,20,10].map(o => (
                  <div key={o} title={"white " + o + "%"} style={{ height: 18, borderRadius: 3, background: "#9ca3af", position: "relative" }}>
                    <div style={{ position: "absolute", inset: 0, borderRadius: 3, backgroundColor: "rgba(255,255,255," + (o / 100) + ")" }} />
                  </div>
                ))}
              </div>
            )}
            {state.colors.blackTransparency && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(9,1fr)", gap: 2 }}>
                {[90,80,70,60,50,40,30,20,10].map(o => (
                  <div key={o} title={"black " + o + "%"} style={{ height: 18, borderRadius: 3, background: "#9ca3af", position: "relative" }}>
                    <div style={{ position: "absolute", inset: 0, borderRadius: 3, backgroundColor: "rgba(0,0,0," + (o / 100) + ")" }} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    {/* TYPOGRAPHY — headings + text sizes */}
    <div className="ds-preview-section">
      <div className="ds-preview-section-title">Typography</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ background: "var(--ds-bg-card)", padding: 20, borderRadius: "var(--ds-radius-lg)", border: "0.5px solid var(--ds-border-light)" }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--ds-text-3)", marginBottom: 12 }}>Headings</div>
          {["h1","h2","h3","h4","h5","h6"].map((h) => (
            <div key={h} style={{ fontSize: Math.min(t.headings[h]?.desktop || 16, 52), fontWeight: 700, lineHeight: t.lineHeightHeading, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {h.toUpperCase()} — {t.headings[h]?.desktop}px
            </div>
          ))}
        </div>
        <div style={{ background: "var(--ds-bg-card)", padding: 20, borderRadius: "var(--ds-radius-lg)", border: "0.5px solid var(--ds-border-light)" }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--ds-text-3)", marginBottom: 12 }}>Text sizes</div>
          {TEXT_KEYS.map((k) => (
            <div key={k} style={{ fontSize: Math.min(t.texts[k]?.desktop || 14, 22), lineHeight: t.lineHeightBody, marginBottom: 3, color: k === "m" ? "var(--ds-text)" : "var(--ds-text-2)" }}>
              text-{k}: {t.texts[k]?.desktop}px
            </div>
          ))}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--ds-border-light)", fontSize: 11, color: "var(--ds-text-3)" }}>
            LH heading: {t.lineHeightHeading} · body: {t.lineHeightBody}
          </div>
        </div>
      </div>
    </div>

    {/* SPACING */}
    <div className="ds-preview-section">
      <div className="ds-preview-section-title">Spacing</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap", background: "var(--ds-bg-card)", padding: 20, borderRadius: "var(--ds-radius-lg)", border: "0.5px solid var(--ds-border-light)" }}>
        {SPACE_KEYS.map((k) => (<div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div style={{ width: 40, height: Math.max(6, (sp.values[k]?.desktop || 0) * 1.4), background: "var(--ds-border)", border: "0.5px dashed var(--ds-text-3)", borderRadius: 4 }} />
          <div style={{ fontSize: 10, color: "var(--ds-text-3)" }}>{k === "section" ? "sect." : k}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ds-primary)" }}>{sp.values[k]?.desktop}px</div>
        </div>))}
      </div>
    </div>

    {/* GAPS */}
    <div className="ds-preview-section">
      <div className="ds-preview-section-title">Gaps</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
        {[["--grid-gap", state.gaps.gridGap], ["--content-gap", state.gaps.contentGap], ["--container-gap", state.gaps.containerGap]].map(([vn, val]) => (
          <div key={vn} style={{ background: "var(--ds-bg-card)", border: "0.5px solid var(--ds-border-light)", borderRadius: "var(--ds-radius)", padding: "12px 14px" }}>
            <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--ds-primary)", marginBottom: 4 }}>{vn}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ds-text)" }}>{val || "—"}</div>
          </div>
        ))}
      </div>
    </div>

    {/* BORDER RADIUS */}
    <div className="ds-preview-section">
      <div className="ds-preview-section-title">Border Radius</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", background: "var(--ds-bg-card)", padding: 20, borderRadius: "var(--ds-radius-lg)", border: "0.5px solid var(--ds-border-light)" }}>
        {RADIUS_KEYS.map((k) => (
          <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <div style={{ width: 60, height: 40, background: "var(--ds-border-light)", border: "0.5px solid var(--ds-text-3)", borderRadius: r.values[k] || 0 }} />
            <div style={{ fontSize: 10, color: "var(--ds-text-3)" }}>{k}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ds-primary)" }}>{r.values[k]}px</div>
          </div>
        ))}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div style={{ width: 40, height: 40, background: "var(--ds-border-light)", border: "0.5px solid var(--ds-text-3)", borderRadius: r.circle }} />
          <div style={{ fontSize: 10, color: "var(--ds-text-3)" }}>circle</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ds-primary)" }}>{r.circle}px</div>
        </div>
      </div>
    </div>

    </>}
  </div>);
}

/* ================================================================
   STEP 9: EXPORT
   ================================================================ */
// Cross-promo de marca personal (Samir Haddad) → genera leads de servicios
const CAL_URL = "https://cal.com/samirh";
function SidebarPromo() {
  return (
    <div className="ds-spromo">
      <img className="ds-spromo-img" src="/samirh.png" alt="Samir Haddad" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      <div className="ds-spromo-txt"><strong>Websites that sell</strong>Custom Bricks sites &amp; design systems.</div>
      <a className="ds-spromo-cta" href={CAL_URL} target="_blank" rel="noopener noreferrer">
        <span className="ds-spromo-label">Work with me</span>
        <span className="ds-spromo-arrow">→</span>
      </a>
    </div>
  );
}

function StepExport() {
  const { state, dispatch, addToast, systemName, user, openAuth } = useDSContext();
  const [status, setStatus] = useState(null);
  const [done, setDone] = useState(null);
  const warnings = [];
  if (!state.layoutMode) warnings.push({ msg: "Select a layout mode in Step 1", step: 1 });
  if (!state.colors.palettes.length) warnings.push({ msg: "Add at least one color palette in Step 4", step: 4 });

  const baseName = slugify(systemName || "design-system");

  const dl = (generator, filename, mime, key) => {
    try {
      const content = generator(state);
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus({ type: "ok", file: filename }); setTimeout(() => setStatus(null), 4000);
      setDone(key); setTimeout(() => setDone((d) => d === key ? null : d), 1600);
      addToast?.(filename + " downloaded", "ok");
    } catch (e) { setStatus({ type: "error", msg: e.message }); addToast?.("Export failed", "err"); }
  };

  const CARDS = [
    {
      id: "variables", suffix: "variables.json", title: "Variables JSON",
      desc: "Todos los tokens: spacing, tipografía, gaps y radius.",
      sub: "Bricks → Style Manager → Variables → Import",
      gen: generateVariablesJSON, mime: "application/json", label: "↓ Variables JSON",
    },
    {
      id: "palette", suffix: "palette.json", title: "Color Palette JSON",
      desc: "Swatches de color para el selector de colores del editor.",
      sub: "Bricks → Style Manager → Color Palettes → Import",
      gen: generateColorPaletteJSON, mime: "application/json", label: "↓ Palette JSON",
      disabled: !state.colors.palettes.length,
    },
    {
      id: "classes", suffix: "classes.json", title: "Bricks Classes JSON",
      desc: "Clases (.btn, .btn--s, .btn--l…) para que aparezcan en el editor. Categoría = nombre del sistema.",
      sub: "Bricks → Style Manager → Classes → Import",
      gen: (s) => generateClassesJSON(s, systemName), mime: "application/json", label: "↓ Classes JSON",
    },
    {
      id: "framework", suffix: "framework.css", title: "Framework CSS",
      desc: "CSS base: aplica variables a body, headings y sections.",
      sub: "Bricks → Settings → Custom Code → CSS (head)",
      gen: generateFrameworkCSS, mime: "text/css", label: "↓ Framework CSS",
    },
  ];

  return (<div>
    {!user && <GuestBanner onSignIn={() => openAuth("signup")} />}
    {warnings.map((w, i) => <div key={i} className="ds-warning" onClick={() => dispatch({ type: "SET_STEP", payload: w.step })}>⚠ {w.msg}</div>)}
    <div className="ds-form-group" style={{ marginBottom: 20 }}>
      <label>Variable prefix <span style={{ fontWeight: 400, color: "var(--ds-text-3)" }}>(optional)</span></label>
      <input className={"ds-input" + (state.varPrefix && !/^[a-z][a-z0-9-]*$/.test(state.varPrefix) ? " ds-input-error" : "")} value={state.varPrefix} placeholder="e.g. ds, brand, acme" onChange={(e) => dispatch({ type: "SET_FIELD", field: "varPrefix", value: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
      <div className="ds-helper">{state.varPrefix ? "--" + state.varPrefix + "-space-m, --" + state.varPrefix + "-primary, ..." : "Leave empty for default naming: --space-m, --primary, ..."}</div>
    </div>
    <div className="ds-export-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
      {CARDS.map(c => {
        const filename = baseName + "-" + c.suffix;
        return (
        <div key={c.id} className="ds-export-file-card">
          <h4>{c.title}</h4>
          <p>{c.desc}</p>
          <div style={{ fontSize: 11, color: "var(--ds-text-3)", marginBottom: 8, fontFamily: "monospace" }}>{c.sub}</div>
          <div style={{ fontSize: 12, color: "var(--ds-text-2)", marginBottom: 14, fontFamily: "monospace", padding: "7px 10px", background: "var(--ds-bg)", border: "1px solid var(--ds-border-light)", borderRadius: "var(--ds-radius)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename}</div>
          <button className={"ds-download-btn" + (done === c.id ? " ds-dl-done" : "")} onClick={() => dl(c.gen, filename, c.mime, c.id)} disabled={warnings.length > 0 || c.disabled} style={{ marginTop: "auto" }}>{done === c.id ? "✓ Downloaded!" : c.label}</button>
        </div>
        );
      })}
    </div>
    {status?.type === "ok"    && <div className="ds-status ok">✓ {status.file} descargado correctamente</div>}
    {status?.type === "error" && <div className="ds-status" style={{ background: "rgba(220,53,69,.08)", color: "var(--ds-error)", border: "1px solid var(--ds-error)" }}>⚠ Error: {status.msg}</div>}
  </div>);
}

/* ================================================================
   ROUTER + APP
   ================================================================ */
// Red de seguridad: un fallo de render no deja la app en blanco (ni hace perder datos)
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) return (
      <div className="ds-auth-loading" style={{ flexDirection: "column", gap: 12, textAlign: "center", padding: 24 }}>
        <div style={{ fontWeight: 600 }}>Something went wrong rendering this view.</div>
        <div style={{ fontSize: 12, color: "var(--ds-text-3)" }}>Your data is safe. Go to another step or reload.</div>
        <button className="ds-btn" onClick={() => this.setState({ err: null })}>Try again</button>
      </div>
    );
    return this.props.children;
  }
}

function StepContent() {
  const { state } = useDSContext();
  const step = STEPS.find((s) => s.id === state.currentStep);
  const C = [null, StepLayout, StepSpacing, StepSectionSpacing, StepColors, StepTypography, StepGaps, StepRadius, StepButtons, StepPreview, StepExport][state.currentStep];
  return (<div className="ds-content">
    <div className="ds-content-header"><h2>{step.label}</h2><p>{DESCS[step.id]}</p></div>
    <div className="ds-content-body"><div key={state.currentStep} className="ds-step-anim">{C && <C />}</div></div>
  </div>);
}

function ProgressBar() {
  const { state } = useDSContext();
  const pct = Math.round((state.currentStep / STEPS.length) * 100);
  return (<div className="ds-progress" title={"Step " + state.currentStep + " of " + STEPS.length}><div className="ds-progress-bar" style={{ width: pct + "%" }} /></div>);
}

function ToastHost({ toasts }) {
  if (!toasts.length) return null;
  return (<div className="ds-toasts">
    {toasts.map((t) => <div key={t.id} className={"ds-toast " + (t.type || "info")}><span className="ds-toast-dot" />{t.msg}</div>)}
  </div>);
}

function SystemCard({ sys, onOpen, onDuplicate, onDelete, onRename }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sys.name);
  useEffect(() => { setName(sys.name); }, [sys.name]);
  const doc = sys.doc || {};
  const palettes = doc.colors?.palettes || [];
  const commit = () => { const n = name.trim() || sys.name; setName(n); setEditing(false); if (n !== sys.name) onRename(sys.id, n); };
  return (<div className="ds-sys-card">
    <div className="ds-sys-swatches" onClick={() => onOpen(sys.id)}>
      {palettes.length ? palettes.slice(0, 8).map((p, i) => <div key={i} style={{ background: "hsl(" + p.hue + "," + p.saturation + "%," + p.lightness + "%)" }} />) : <div style={{ background: "var(--ds-border)" }} />}
    </div>
    <div className="ds-sys-body">
      {editing
        ? <input className="ds-input ds-input-sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setName(sys.name); setEditing(false); } }} />
        : <h3 className="ds-sys-name" onClick={() => setEditing(true)} title="Click to rename">{sys.name}</h3>}
      <div className="ds-sys-meta">{palettes.length} color{palettes.length === 1 ? "" : "s"} · scale {doc.typography?.headingScale ?? "—"} · {fmtDate(sys.updatedAt)}</div>
    </div>
    <div className="ds-sys-actions">
      <button className="ds-btn ds-btn-primary ds-btn-sm" onClick={() => onOpen(sys.id)}>Open</button>
      <button className="ds-btn ds-btn-sm" onClick={() => onDuplicate(sys.id)}>Duplicate</button>
      <button className="ds-btn ds-btn-sm ds-btn-danger" onClick={() => onDelete(sys.id)} title="Delete">✕</button>
    </div>
  </div>);
}

function Dashboard({ library, darkMode, toggleDark, onOpen, onNew, onDuplicate, onDelete, onRename, user, onAuth, onAccount, onSignOut, limit, isAdmin, onOpenAdmin }) {
  const systems = library.systems;
  const atMax = !!user && limit != null && systems.length >= limit;
  return (<>
    <header className="ds-header">
      <BrandMark />
      <div><h1>Design System Generator for Bricks Builder</h1><p>Your saved design systems</p></div>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
        {isAdmin && <button className="ds-btn ds-btn-sm" onClick={onOpenAdmin} data-tip="Manage users">Users</button>}
        <AuthControl user={user} isAdmin={isAdmin} onAuth={onAuth} onAccount={onAccount} onSignOut={onSignOut} />
        <button className="ds-header-theme" onClick={toggleDark} title="Toggle dark mode"><ThemeIcon dark={darkMode} /></button>
      </div>
    </header>
    <div className="ds-dash">
      {!user && <GuestBanner onSignIn={() => onAuth("signup")} />}
      <div className="ds-dash-head">
        <div><h2 className="ds-dash-title">My design systems</h2><p className="ds-dash-sub">{user ? systems.length + " / " + (limit == null ? "∞" : limit) + " in cloud" : systems.length + " system" + (systems.length === 1 ? "" : "s") + " on this device"}</p></div>
        <button className="ds-btn ds-btn-primary" onClick={onNew} disabled={atMax} data-tip={atMax ? "Cloud limit reached (" + limit + ")" : undefined}>+ New system</button>
      </div>
      {systems.length === 0
        ? <div className="ds-dash-empty">
            <div style={{ fontSize: 34, marginBottom: 10, color: "var(--ds-text-3)" }}>✦</div>
            <h3 style={{ fontSize: 16, marginBottom: 4 }}>No systems yet</h3>
            <p style={{ fontSize: 13, color: "var(--ds-text-2)", marginBottom: 16 }}>Create your first design system to get started.</p>
            <button className="ds-btn ds-btn-primary" onClick={onNew}>+ New system</button>
          </div>
        : <div className="ds-dash-grid">
            {systems.map((s) => <SystemCard key={s.id} sys={s} onOpen={onOpen} onDuplicate={onDuplicate} onDelete={onDelete} onRename={onRename} />)}
          </div>}
      <div className="ds-credit">A free tool by <a href={CAL_URL} target="_blank" rel="noopener noreferrer">Samir Haddad</a> — design &amp; development for Bricks.</div>
    </div>
  </>);
}

// Página de administración: listado de usuarios + límite editable (solo admin; gate real en la BD)
function AdminUsers({ onBack, darkMode, toggleDark, addToast, selfId }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let active = true;
    (async () => {
      try { const { data, error } = await supabase.rpc("admin_list_users"); if (error) throw error; if (active) setRows(data || []); }
      catch (e) { if (active) setErr(e.message || "Could not load users"); }
    })();
    return () => { active = false; };
  }, []);
  const setLimit = async (id, value) => {
    try {
      const { error } = await supabase.rpc("admin_set_limit", { target: id, new_limit: value });
      if (error) throw error;
      setRows((rs) => rs.map((r) => r.id === id ? { ...r, system_limit: value } : r));
      addToast("Limit updated", "ok");
    } catch (e) { addToast("Could not update limit", "err"); }
  };
  const removeUser = async (id, email) => {
    if (!window.confirm('Delete user "' + email + '"?\nThis permanently removes their account and all their design systems. This cannot be undone.')) return;
    try {
      const { error } = await supabase.rpc("admin_delete_user", { target: id });
      if (error) throw error;
      setRows((rs) => rs.filter((r) => r.id !== id));
      addToast("User deleted", "info");
    } catch (e) { addToast(/CANNOT_DELETE_SELF/.test(e.message || "") ? "You can't delete your own account here" : "Could not delete user", "err"); }
  };
  return (<>
    <header className="ds-header">
      <button className="ds-header-back" onClick={onBack} data-tip="Back to my systems">←</button>
      <BrandMark />
      <div><h1>Users</h1><p>Admin · manage limits &amp; accounts</p></div>
      <button className="ds-header-theme" onClick={toggleDark} title="Toggle dark mode" style={{ marginLeft: "auto" }}><ThemeIcon dark={darkMode} /></button>
    </header>
    <div className="ds-dash">
      {err ? <div className="ds-warning">⚠ {err}</div>
        : rows == null ? <div className="ds-auth-loading">Loading users…</div>
        : rows.length === 0 ? <p className="ds-dash-sub">No users yet.</p>
        : (<table className="ds-admin-table">
            <thead><tr><th>Name</th><th>Email</th><th>Country</th><th>Systems</th><th>Cloud limit</th><th></th></tr></thead>
            <tbody>{rows.map((r) => <AdminUserRow key={r.id} row={r} onSetLimit={setLimit} onDelete={removeUser} isSelf={r.id === selfId} />)}</tbody>
          </table>)}
    </div>
  </>);
}
function AdminUserRow({ row, onSetLimit, onDelete, isSelf }) {
  const [val, setVal] = useState(row.system_limit == null ? "" : String(row.system_limit));
  const [inf, setInf] = useState(row.system_limit == null);
  useEffect(() => { const u = row.system_limit == null; setInf(u); setVal(u ? "" : String(row.system_limit)); }, [row.system_limit]);
  const save = () => {
    const next = inf ? null : Math.max(0, parseInt(val, 10) || 0);
    if (next === row.system_limit) return;
    onSetLimit(row.id, next);
  };
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ");
  const cc = COUNTRIES.find((c) => c.n === row.country)?.c;
  return (
    <tr>
      <td>{fullName || <span style={{ color: "var(--ds-text-3)" }}>—</span>}{row.is_admin && <span className="ds-admin-badge" style={{ marginLeft: 8 }}>Admin</span>}</td>
      <td>{row.email}</td>
      <td>{row.country ? <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>{cc && <img className="ds-cs-flag" src={flagUrl(cc)} alt="" />}{row.country}</span> : <span style={{ color: "var(--ds-text-3)" }}>—</span>}</td>
      <td>{row.systems_count}</td>
      <td>
        <div className="ds-admin-limit">
          <label className="ds-admin-inf"><input type="checkbox" checked={inf} onChange={(e) => { const c = e.target.checked; setInf(c); if (!c && !val) setVal("5"); }} /> ∞</label>
          <input className="ds-input ds-input-sm" type="number" min="0" style={{ width: 70 }} value={inf ? "" : val} disabled={inf} placeholder="—" onChange={(e) => setVal(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          <button className="ds-btn ds-btn-sm" onClick={save}>Save</button>
        </div>
      </td>
      <td style={{ textAlign: "right" }}>
        <button className="ds-btn ds-btn-sm ds-btn-danger" onClick={() => onDelete(row.id, row.email)} disabled={isSelf} data-tip={isSelf ? "You can't delete your own account" : "Delete user"} title={isSelf ? "You can't delete your own account" : "Delete user"}>✕</button>
      </td>
    </tr>
  );
}

// Panel de usuario: editar nombre/apellidos/país (vía updateUser → solo el propio usuario)
function AccountView({ user, onBack, darkMode, toggleDark, addToast, onSignOut }) {
  const m = user?.user_metadata || {};
  const [firstName, setFirstName] = useState(m.first_name || "");
  const [lastName, setLastName] = useState(m.last_name || "");
  const [country, setCountry] = useState(m.country || "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ data: { ...m, first_name: firstName.trim(), last_name: lastName.trim(), country } });
      if (error) throw error;
      addToast("Profile updated", "ok");
    } catch (e) { addToast("Could not update profile", "err"); }
    setBusy(false);
  };
  return (<>
    <header className="ds-header">
      <button className="ds-header-back" onClick={onBack} data-tip="Back to my systems">←</button>
      <BrandMark />
      <div><h1>Account</h1><p>Your profile</p></div>
      <button className="ds-header-theme" onClick={toggleDark} title="Toggle dark mode" style={{ marginLeft: "auto" }}><ThemeIcon dark={darkMode} /></button>
    </header>
    <div className="ds-dash">
      <div className="ds-account">
        <div className="ds-account-head"><Avatar user={user} size={64} /><div><div className="ds-account-name">{userDisplayName(user)}</div><div className="ds-account-email">{user.email}</div></div></div>
        <div className="ds-grid-2">
          <div className="ds-form-group"><label>First name</label><input className="ds-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
          <div className="ds-form-group"><label>Last name</label><input className="ds-input" value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
        </div>
        <div className="ds-form-group"><label>Country</label><CountrySelect value={country} onChange={setCountry} /></div>
        <div className="ds-form-group"><label>Email</label><input className="ds-input" value={user.email} disabled /><div className="ds-helper">This is your login email address.</div></div>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button className="ds-btn ds-btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
          <button className="ds-btn" onClick={onSignOut}>Sign out</button>
        </div>
        <div className="ds-helper" style={{ marginTop: 16 }}>Profile photo: we use your <a href="https://gravatar.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--ds-accent)" }}>Gravatar</a> if you have one, otherwise your initials.</div>
      </div>
    </div>
  </>);
}

export default function App() {
  const [darkMode, setDarkMode] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const toggleDark = () => setDarkMode((d) => !d);
  const [library, setLibrary] = useState(loadLibrary);
  const [view, setView] = useState("dashboard");
  const [currentId, setCurrentId] = useState(null);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [dirty, setDirty] = useState(false);
  const skipSave = useRef(false);
  const savedToastTimer = useRef(null);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);
  const addToast = (msg, type = "info") => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2800);
  };
  // ── Auth / nube ──
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!cloudEnabled); // sin nube → listo al instante
  const [authOpen, setAuthOpen] = useState(false);           // modal de auth
  const [authMode, setAuthMode] = useState("signup");        // signup | signin
  const [migratePrompt, setMigratePrompt] = useState(null);  // { candidates, slots } → modal de selección
  const [isAdmin, setIsAdmin] = useState(false);
  const [userLimit, setUserLimit] = useState(MAX_SYSTEMS);   // null = ilimitado
  const cloudMode = !!user;
  const cloudSaveTimer = useRef(null);
  const cloudSavePending = useRef(null);
  const restoredRef = useRef(false);
  const loadedUserRef = useRef(null);
  const openAuth = (mode = "signup") => { setAuthMode(mode); setAuthOpen(true); };

  // Reabre el último sistema editado (una vez por carga)
  const restoreSession = (systems) => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const sid = localStorage.getItem(SESSION_KEY);
      if (!sid) return;
      const sys = systems.find((s) => s.id === sid);
      if (sys) { skipSave.current = true; dispatch({ type: "LOAD_DOC", payload: { ...initialState, ...sys.doc } }); setCurrentId(sid); setView("editor"); setDirty(false); }
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
  };

  const readLocalSystems = () => {
    try { const l = JSON.parse(localStorage.getItem(LIB_KEY) || "null"); return (l && Array.isArray(l.systems)) ? l.systems : []; }
    catch { return []; }
  };
  // Quita de localStorage los sistemas ya migrados (los no elegidos se quedan en el dispositivo)
  const removeLocalSystems = (ids) => {
    try {
      const l = JSON.parse(localStorage.getItem(LIB_KEY) || "null") || { autoSave: true, systems: [] };
      l.systems = (l.systems || []).filter((s) => !ids.includes(s.id));
      localStorage.setItem(LIB_KEY, JSON.stringify(l));
    } catch {}
  };
  // Sube una lista concreta de sistemas a la nube, limpia local y refresca la biblioteca
  const migrateThese = async (list) => {
    const done = [];
    for (const s of list) {
      try { await cloudInsertSystem(s); done.push(s.id); }
      catch (e) { if (isLimitError(e)) break; }
    }
    if (done.length) {
      removeLocalSystems(done);
      addToast(done.length + " system" + (done.length === 1 ? "" : "s") + " synced to your account", "ok");
      try { const systems = await cloudListSystems(); setLibrary({ autoSave: true, systems }); } catch {}
    }
  };

  const handleSignedIn = async (u) => {
    if (loadedUserRef.current === u.id) return;
    loadedUserRef.current = u.id;
    try {
      // Perfil: admin + límite personalizado (null = ilimitado)
      let lim = MAX_SYSTEMS;
      try {
        const { data: prof } = await supabase.from("profiles").select("is_admin, system_limit").eq("id", u.id).single();
        if (prof) { setIsAdmin(!!prof.is_admin); lim = prof.system_limit; setUserLimit(prof.system_limit); }
      } catch {}
      // Opt-in de marketing → sincroniza con Acumbamail (Edge Function). Solo si dio consentimiento.
      try {
        const opted = (localStorage.getItem("dsg-optin") === "1") || u.user_metadata?.marketing_opt_in;
        if (opted) supabase.functions.invoke("subscribe").catch(() => {});
        localStorage.removeItem("dsg-optin");
      } catch {}
      const existing = await cloudListSystems();
      setLibrary({ autoSave: true, systems: existing });
      restoreSession(existing);
      // Migración de locales (slots según el límite del usuario; null = ilimitado)
      const existingIds = new Set(existing.map((s) => s.id));
      const candidates = readLocalSystems().filter((s) => !existingIds.has(s.id));
      if (!candidates.length) return;
      const slots = (lim == null) ? candidates.length : (lim - existing.length);
      if (slots <= 0) { addToast("Cloud is full — local systems kept on this device", "info"); return; }
      if (candidates.length <= slots) await migrateThese(candidates);
      else setMigratePrompt({ candidates, slots }); // hay que elegir
    } catch (e) { addToast("Could not load your cloud systems", "err"); }
  };
  const handleSignedOut = () => {
    loadedUserRef.current = null;
    setIsAdmin(false); setUserLimit(MAX_SYSTEMS);
    setLibrary(loadLibrary());
    setView("dashboard"); setCurrentId(null); setDirty(false);
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  };

  const scheduleCloudSave = (id, fields, immediate) => {
    cloudSavePending.current = { id, fields };
    const flush = () => { const p = cloudSavePending.current; cloudSavePending.current = null; if (p && supabase) cloudUpdateSystem(p.id, p.fields).catch(() => addToast("Cloud save failed", "err")); };
    if (cloudSaveTimer.current) clearTimeout(cloudSaveTimer.current);
    if (immediate) flush(); else cloudSaveTimer.current = setTimeout(flush, 800);
  };

  // Suscripción a la sesión de Supabase
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      const u = data.session?.user ?? null;
      setUser(u);
      if (u) await handleSignedIn(u);
      else restoreSession(library.systems);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) handleSignedIn(u);
      else handleSignedOut();
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const signOut = async () => { try { await supabase?.auth.signOut(); } catch {} };

  useEffect(() => { document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light"); }, [darkMode]);

  // Al montar (solo build sin nube): restaura la sesión local. Con nube lo hace el efecto de auth.
  useEffect(() => { if (!cloudEnabled) restoreSession(library.systems); }, []);

  // Guardado del documento activo en su entrada de la biblioteca
  const saveDoc = (announce) => {
    const updatedAt = nowISO();
    setLibrary((prev) => {
      const lib = { ...prev, systems: prev.systems.map((s) => s.id === currentId ? { ...s, doc: state, updatedAt } : s) };
      if (cloudMode) scheduleCloudSave(currentId, { doc: state, updated_at: updatedAt }, announce);
      else persistLibrary(lib);
      return lib;
    });
    setDirty(false);
    if (announce) addToast("Changes saved", "ok");
  };

  // Reacciona a cambios del doc activo: auto-guarda o marca como "sin guardar"
  useEffect(() => {
    if (view !== "editor" || currentId == null) return;
    if (skipSave.current) { skipSave.current = false; return; }
    if (library.autoSave) {
      saveDoc(); // persiste al instante
      // Toast con debounce: una sola confirmación cuando paras de editar
      if (savedToastTimer.current) clearTimeout(savedToastTimer.current);
      savedToastTimer.current = setTimeout(() => { addToast("Changes saved", "ok"); }, 700);
    } else {
      setDirty(true);
    }
  }, [state]);

  const openSystem = (id) => {
    const sys = library.systems.find((s) => s.id === id);
    if (!sys) return;
    skipSave.current = true;
    // Merge con initialState → rellena campos nuevos (buttons, etc.) en docs antiguos
    dispatch({ type: "LOAD_DOC", payload: { ...initialState, ...sys.doc } });
    setCurrentId(id); setView("editor"); setDirty(false);
    try { localStorage.setItem(SESSION_KEY, id); } catch {}
  };
  const atLimit = () => {
    // El tope solo aplica en la nube y si el usuario tiene un límite (null = ilimitado).
    if (cloudMode && userLimit != null && library.systems.length >= userLimit) {
      addToast("Cloud limit reached: " + userLimit + " max. Delete one to add another.", "err");
      return true;
    }
    return false;
  };
  const createSystem = async () => {
    if (atLimit()) return;
    const doc = JSON.parse(JSON.stringify(initialState));
    const sys = { id: "sys_" + randId(), name: "Design system " + (library.systems.length + 1), createdAt: nowISO(), updatedAt: nowISO(), doc };
    if (cloudMode) {
      try { await cloudInsertSystem(sys); }
      catch (e) { addToast(isLimitError(e) ? "Cloud limit reached" + (userLimit != null ? ": " + userLimit + " max" : "") : "Could not create system", "err"); return; }
    }
    const lib = { ...library, systems: [...library.systems, sys] };
    setLibrary(lib); if (!cloudMode) persistLibrary(lib);
    skipSave.current = true;
    dispatch({ type: "LOAD_DOC", payload: doc });
    setCurrentId(sys.id); setView("editor"); setDirty(false);
    try { localStorage.setItem(SESSION_KEY, sys.id); } catch {}
  };
  const duplicateSystem = async (id) => {
    const sys = library.systems.find((s) => s.id === id);
    if (!sys) return;
    if (atLimit()) return;
    const copy = { id: "sys_" + randId(), name: sys.name + " (copy)", createdAt: nowISO(), updatedAt: nowISO(), doc: JSON.parse(JSON.stringify(sys.doc)) };
    if (cloudMode) {
      try { await cloudInsertSystem(copy); }
      catch (e) { addToast(isLimitError(e) ? "Cloud limit reached" + (userLimit != null ? ": " + userLimit + " max" : "") : "Could not duplicate", "err"); return; }
    }
    const lib = { ...library, systems: [...library.systems, copy] };
    setLibrary(lib); if (!cloudMode) persistLibrary(lib);
    addToast("System duplicated", "ok");
  };
  const deleteSystem = async (id) => {
    const sys = library.systems.find((s) => s.id === id);
    if (!sys || !window.confirm('Delete "' + sys.name + '"? This cannot be undone.')) return;
    if (cloudMode) { try { await cloudDeleteSystem(id); } catch { addToast("Could not delete", "err"); return; } }
    const lib = { ...library, systems: library.systems.filter((s) => s.id !== id) };
    setLibrary(lib); if (!cloudMode) persistLibrary(lib);
    addToast("System deleted", "info");
  };
  const renameSystem = (id, name) => {
    const updatedAt = nowISO();
    const lib = { ...library, systems: library.systems.map((s) => s.id === id ? { ...s, name, updatedAt } : s) };
    setLibrary(lib);
    if (cloudMode) cloudUpdateSystem(id, { name, updated_at: updatedAt }).catch(() => addToast("Rename not synced", "err"));
    else persistLibrary(lib);
  };
  const toggleAutoSave = () => {
    const next = !library.autoSave;
    setLibrary((prev) => { const lib = { ...prev, autoSave: next }; if (!cloudMode) persistLibrary(lib); return lib; });
    if (next && dirty) saveDoc(); // al activar, guarda lo pendiente
  };
  const backToDashboard = () => {
    if (!library.autoSave && dirty) {
      const r = window.confirm("You have unsaved changes. Save before leaving?");
      if (r) saveDoc();
    }
    setView("dashboard"); setCurrentId(null); setDirty(false);
    if (savedToastTimer.current) clearTimeout(savedToastTimer.current);
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  };

  // Atajos de teclado: Cmd/Ctrl+S guarda · ←/→ navega entre pasos
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (view === "editor") saveDoc(true);
        return;
      }
      if (view !== "editor") return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || e.target.isContentEditable) return;
      if (e.key === "ArrowRight" && state.currentStep < STEPS.length) dispatch({ type: "SET_STEP", payload: state.currentStep + 1 });
      else if (e.key === "ArrowLeft" && state.currentStep > 1) dispatch({ type: "SET_STEP", payload: state.currentStep - 1 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, state, currentId, library.autoSave]);

  const currentSystem = library.systems.find((s) => s.id === currentId);
  const systemName = currentSystem?.name;
  const value = useMemo(() => ({ state, dispatch, darkMode, toggleDark, addToast, systemName, user, openAuth }), [state, darkMode, systemName, user]);

  return (<DSContext.Provider value={value}>
    <style>{css_styles}</style>
    <div className="ds-app" data-theme={darkMode ? "dark" : "light"}>
      {!authReady
        ? <div className="ds-auth-loading">Loading…</div>
        : view === "admin"
        ? <AdminUsers onBack={() => setView("dashboard")} darkMode={darkMode} toggleDark={toggleDark} addToast={addToast} myLimit={userLimit} selfId={user?.id} />
        : view === "account"
        ? <AccountView user={user} onBack={() => setView("dashboard")} darkMode={darkMode} toggleDark={toggleDark} addToast={addToast} onSignOut={signOut} />
        : view === "dashboard"
        ? <Dashboard library={library} darkMode={darkMode} toggleDark={toggleDark} onOpen={openSystem} onNew={createSystem} onDuplicate={duplicateSystem} onDelete={deleteSystem} onRename={renameSystem} user={user} onAuth={openAuth} onAccount={() => setView("account")} onSignOut={signOut} limit={userLimit} isAdmin={isAdmin} onOpenAdmin={() => setView("admin")} />
        : <>
            <EditorHeader name={currentSystem?.name || "Untitled"} onRename={(n) => renameSystem(currentId, n)} onBack={backToDashboard} autoSave={library.autoSave} onToggleAutoSave={toggleAutoSave} dirty={dirty} onSave={() => saveDoc(true)} darkMode={darkMode} toggleDark={toggleDark} user={user} onAuth={openAuth} onAccount={() => setView("account")} onSignOut={signOut} isAdmin={isAdmin} />
            <ProgressBar />
            <div className="ds-main"><Sidebar /><ErrorBoundary resetKey={state.currentStep}><StepContent /></ErrorBoundary></div>
            <Footer />
          </>}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} addToast={addToast} initialMode={authMode} />}
      {migratePrompt && <SelectMigrateModal prompt={migratePrompt} onClose={() => setMigratePrompt(null)} onConfirm={async (sel) => { setMigratePrompt(null); await migrateThese(sel); }} />}
      <ToastHost toasts={toasts} />
    </div>
  </DSContext.Provider>);
}
