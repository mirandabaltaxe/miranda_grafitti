// graffiti.js
// Depends on: @supabase/supabase-js loaded via CDN (window.supabase)

// ─── Config ───────────────────────────────────────────────────────────────────
// Replace these two values after setting up your Supabase project.
const SUPABASE_URL     = 'https://idhviyaiaqlgsaduverv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkaHZpeWFpYXFsZ3NhZHV2ZXJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4ODcsImV4cCI6MjA5NjY4NTg4N30.4O7jlnprWNmtiFFZ5zjMj0g5xM4OGUIm47urg7Hblkw';

// How close (px) a click must land to a stroke segment to erase it.
const ERASE_RADIUS = 14;

// Colour options in the toolbar.
const PALETTE = [
  '#0a0a0a', '#ffffff', '#e63946', '#f4a261',
  '#e9c46a', '#2a9d8f', '#457b9d', '#9b5de5',
];

// ─── Page key ────────────────────────────────────────────────────────────────
// Normalise the URL path to a clean string used as the database partition key.
// "/" and "/index.html" both become "index"; "/work.html" becomes "work", etc.
function derivePageKey() {
  const path = window.location.pathname;
  if (path === '/' || path === '/index.html') return 'index';
  return path.replace(/^\//, '').replace(/\.html$/, '');
}
const PAGE_KEY = derivePageKey();

// ─── Admin mode ───────────────────────────────────────────────────────────────
// Visit any page with ?admin=<password> to unlock the "Clear page" button.
// This doesn't grant database-level privileges — it's just a UI convenience.
// For real access control, use Supabase Row Level Security with auth.
const IS_ADMIN = new URLSearchParams(window.location.search).has('admin');

// ─── Supabase client ──────────────────────────────────────────────────────────
const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── State ────────────────────────────────────────────────────────────────────
let strokes     = [];      // all persisted strokes for this page, in draw order
let isDrawing   = false;
let livePoints  = [];      // points being collected for the stroke in progress
let activeColor = PALETTE[0];
let activeWidth = 3;
let activeTool  = null;    // 'pen' | 'erase' | null (browse mode — default)

// ─── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.createElement('canvas');
canvas.id    = 'graffiti-canvas';
Object.assign(canvas.style, {
  position:      'absolute',
  top:           '0',
  left:          '0',
  zIndex:        '100',
  pointerEvents: 'none',  // browse mode until user picks a tool
  cursor:        'default',
});

// The body must be position:relative so the absolute canvas stays inside it.
document.documentElement.style.position = 'relative';
document.documentElement.appendChild(canvas);

const ctx = canvas.getContext('2d');

// Size the canvas to cover the full document, then redraw.
// Hide the canvas first so it doesn't inflate the measured dimensions.
function sizeCanvas() {
  canvas.style.display = 'none';
  const w = document.documentElement.scrollWidth;
  const h = document.documentElement.scrollHeight;
  canvas.style.display = '';
  canvas.width  = w;
  canvas.height = h;
  redraw();
}

window.addEventListener('load', sizeCanvas);
window.addEventListener('resize', debounce(sizeCanvas, 250));

// ─── Coordinate helpers ───────────────────────────────────────────────────────
// Store points as fractions (0–1) so strokes survive viewport/font changes.
const nx  = x => x / canvas.width;
const ny  = y => y / canvas.height;
const dnx = x => x * canvas.width;
const dny = y => y * canvas.height;

// Get document-relative position from a mouse or touch event.
// Canvas is anchored at (0,0) of <html>, so pageX/pageY map directly.
function docPos(e) {
  const src = e.touches?.[0] ?? e;
  return { x: src.pageX, y: src.pageY };
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────
function buildToolbar() {
  const el = document.getElementById('graffiti-toolbar');
  if (!el) return;

  el.innerHTML = `
    <div class="toolbar-row">
      <button data-tool="pen"               >Draw</button>
      <button data-tool="erase"             >Erase</button>
      <button data-tool="browse" class="active">Browse</button>
      ${IS_ADMIN ? '<button id="btn-clear">Clear</button>' : ''}
    </div>
    <div class="toolbar-row">
      <span class="toolbar-label">Color</span>
      <div class="swatches" id="swatches"></div>
      <label class="swatch-wheel" id="swatch-wheel" title="Custom colour" style="margin-left:0.35rem">
        <span class="wheel-icon"></span>
        <input type="color" id="color-custom" value="${activeColor}">
      </label>
    </div>
    <div class="toolbar-row">
      <span class="toolbar-label">Size</span>
      <select id="stroke-width">
        <option value="2">Thin</option>
        <option value="4" selected>Medium</option>
        <option value="9">Thick</option>
      </select>
    </div>
  `;

  // Palette swatches
  const swatchWrap = el.querySelector('#swatches');
  PALETTE.forEach(color => {
    const s = document.createElement('span');
    s.className = 'swatch' + (color === activeColor ? ' active' : '');
    s.style.background = color;
    if (color === '#ffffff') s.style.outline = '1px solid #e8e8e8';
    s.addEventListener('click', () => {
      activeColor = color;
      el.querySelector('#color-custom').value = color;
      el.querySelectorAll('.swatch').forEach(n => n.classList.remove('active'));
      el.querySelector('#swatch-wheel')?.classList.remove('active');
      s.classList.add('active');
    });
    swatchWrap.appendChild(s);
  });

  // Custom colour wheel picker
  el.querySelector('#color-custom').addEventListener('input', e => {
    activeColor = e.target.value;
    el.querySelectorAll('.swatch').forEach(n => n.classList.remove('active'));
    el.querySelector('#swatch-wheel').classList.add('active');
  });

  // Tool buttons
  el.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool === 'browse' ? null : btn.dataset.tool));
  });

  // Admin clear
  el.querySelector('#btn-clear')?.addEventListener('click', clearPage);

  // Stroke width
  el.querySelector('#stroke-width').addEventListener('change', e => {
    activeWidth = parseInt(e.target.value, 10);
  });
}

function setTool(tool) {
  activeTool = tool;
  canvas.style.pointerEvents = tool ? 'auto' : 'none';
  canvas.style.cursor = tool === 'pen' ? 'crosshair' : tool === 'erase' ? 'cell' : 'default';
  document.body.style.userSelect = tool ? 'none' : '';

  document.querySelectorAll('#graffiti-toolbar [data-tool]').forEach(btn => {
    const match = tool === null ? btn.dataset.tool === 'browse' : btn.dataset.tool === tool;
    btn.classList.toggle('active', match);
  });
}

// ─── Drawing ──────────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown',  onDown);
canvas.addEventListener('mousemove',  onMove);
canvas.addEventListener('mouseup',    onUp);
canvas.addEventListener('mouseleave', onUp);
canvas.addEventListener('touchstart', e => { e.preventDefault(); onDown(e); }, { passive: false });
canvas.addEventListener('touchmove',  e => { e.preventDefault(); onMove(e); }, { passive: false });
canvas.addEventListener('touchend',   e => { e.preventDefault(); onUp(e);   }, { passive: false });

function onDown(e) {
  e.preventDefault();
  if (activeTool === 'erase') { handleErase(e); return; }
  if (activeTool !== 'pen') return;
  isDrawing = true;
  const p = docPos(e);
  livePoints = [{ x: nx(p.x), y: ny(p.y) }];
}

function onMove(e) {
  e.preventDefault();
  if (!isDrawing || activeTool !== 'pen') return;
  const p = docPos(e);
  livePoints.push({ x: nx(p.x), y: ny(p.y) });
  paintLive();
}

function onUp() {
  if (!isDrawing) return;
  isDrawing = false;
  if (livePoints.length < 2) { livePoints = []; return; }
  saveStroke({ page: PAGE_KEY, points: livePoints, color: activeColor, width: activeWidth });
  livePoints = [];
}

// Paint only the newest segment during a live stroke — fast, no full redraw.
function paintLive() {
  const pts = livePoints;
  if (pts.length < 2) return;

  ctx.beginPath();
  ctx.strokeStyle = activeColor;
  ctx.lineWidth   = activeWidth;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  if (pts.length === 2) {
    ctx.moveTo(dnx(pts[0].x), dny(pts[0].y));
    ctx.lineTo(dnx(pts[1].x), dny(pts[1].y));
  } else {
    const a = pts[pts.length - 3];
    const b = pts[pts.length - 2];
    const c = pts[pts.length - 1];
    const mx = (dnx(b.x) + dnx(c.x)) / 2;
    const my = (dny(b.y) + dny(c.y)) / 2;
    ctx.moveTo((dnx(a.x) + dnx(b.x)) / 2, (dny(a.y) + dny(b.y)) / 2);
    ctx.quadraticCurveTo(dnx(b.x), dny(b.y), mx, my);
  }

  ctx.stroke();
}

// Paint a full persisted stroke using smooth quadratic curves.
function paintStroke(stroke) {
  const pts = stroke.points;
  if (!pts || pts.length < 2) return;

  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth   = stroke.width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  ctx.moveTo(dnx(pts[0].x), dny(pts[0].y));

  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (dnx(pts[i].x) + dnx(pts[i + 1].x)) / 2;
    const my = (dny(pts[i].y) + dny(pts[i + 1].y)) / 2;
    ctx.quadraticCurveTo(dnx(pts[i].x), dny(pts[i].y), mx, my);
  }

  const last = pts[pts.length - 1];
  ctx.lineTo(dnx(last.x), dny(last.y));
  ctx.stroke();
}

// Clear and repaint every stroke in order.
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  strokes.forEach(paintStroke);
}

// ─── Eraser ───────────────────────────────────────────────────────────────────
function handleErase(e) {
  const { x, y } = docPos(e);
  // Walk backwards so the topmost (most recently drawn) stroke is hit first.
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (hitTest(strokes[i], x, y)) {
      deleteStroke(strokes[i].id);
      return;
    }
  }
}

// Returns true if point (px, py) falls within ERASE_RADIUS of any segment.
function hitTest(stroke, px, py) {
  const pts = stroke.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = dnx(pts[i].x),     ay = dny(pts[i].y);
    const bx = dnx(pts[i+1].x),   by = dny(pts[i+1].y);
    if (segmentDist(px, py, ax, ay, bx, by) < ERASE_RADIUS + stroke.width / 2) {
      return true;
    }
  }
  return false;
}

// Minimum distance from point P to line segment AB.
function segmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ─── Supabase: read & write ───────────────────────────────────────────────────
async function loadStrokes() {
  const { data, error } = await db
    .from('strokes')
    .select('*')
    .eq('page', PAGE_KEY)
    .order('created_at', { ascending: true });

  if (error) { console.error('[graffiti] load:', error.message); return; }
  strokes = data ?? [];
  redraw();
}

async function saveStroke(stroke) {
  const { data, error } = await db
    .from('strokes')
    .insert(stroke)
    .select()
    .single();

  if (error) { console.error('[graffiti] save:', error.message); return; }

  // Add to local array now. The realtime INSERT event will also fire;
  // the subscription handler deduplicates by ID so we won't double-draw.
  strokes.push(data);
  // No redraw needed — the stroke is already painted from the live session.
}

async function deleteStroke(id) {
  const { error } = await db.from('strokes').delete().eq('id', id);
  if (error) console.error('[graffiti] delete:', error.message);
  // Optimistic local update: remove immediately, don't wait for realtime.
  strokes = strokes.filter(s => s.id !== id);
  redraw();
}

async function clearPage() {
  if (!confirm(`Clear all graffiti on "${PAGE_KEY}"?`)) return;
  const { error } = await db.from('strokes').delete().eq('page', PAGE_KEY);
  if (error) { console.error('[graffiti] clear:', error.message); return; }
  strokes = [];
  redraw();
}

// ─── Supabase: realtime ───────────────────────────────────────────────────────
function subscribeRealtime() {
  db.channel(`graffiti:${PAGE_KEY}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'strokes', filter: `page=eq.${PAGE_KEY}` },
      ({ new: row }) => {
        // Skip if we already added this stroke locally after saving.
        if (strokes.some(s => s.id === row.id)) return;
        strokes.push(row);
        paintStroke(row);   // append on top; no full redraw needed
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'strokes', filter: `page=eq.${PAGE_KEY}` },
      ({ old: row }) => {
        // Only act if we haven't already handled it locally (optimistic delete).
        if (!strokes.some(s => s.id === row.id)) return;
        strokes = strokes.filter(s => s.id !== row.id);
        redraw();
      }
    )
    .subscribe();
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
buildToolbar();
setTool(null);   // default: browse — canvas transparent to clicks
loadStrokes();
subscribeRealtime();