/* ================================================================
   HELPERS
================================================================ */
const $ = id => document.getElementById(id);
const esc = s => { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; };
const uid = () => 'w'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const pad2 = n => String(n).padStart(2,'0');
const toLocal = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const COLORS = ['#3b82f6','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316'];

function fmtDuration(minutes) {
  if (typeof minutes !== 'number' || minutes === 0) return '0м';
  const h=Math.floor(minutes/60), m=Math.round(minutes%60);
  if (h > 0 && m > 0) return `${h}ч ${m}м`;
  if (h > 0) return `${h}ч`;
  return `${m}м`;
}

function fmtDurationSec(sec) {
  if (typeof sec !== 'number' || sec === 0) return '0с';
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.round(sec%60);
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${s}с`;
  return `${s}с`;
}

function fmtNum(n) {
  return typeof n === 'number' ? (Number.isInteger(n) ? n.toString() : n.toFixed(2)) : String(n);
}

function findKey(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

// Try specific statistics key first, fall back to generic value (v/Value)
// This handles the new simplified API format: [{"t":"...","v":30.54}]
function findStatVal(obj, specificKeys) {
  const v = findKey(obj, specificKeys);
  if (v !== undefined) return v;
  return findKey(obj, K_VALUE);
}

// Detect if data only has time + value fields (new simplified format)
function isSimpleFormat(arr) {
  if (!arr || !arr.length) return false;
  const keys = Object.keys(arr[0]);
  return keys.length <= 2 && keys.every(k => k === 't' || k === 'v');
}

function parseTimeStr(s) {
  if (!s) return null;
  // Handle space-separated timestamps like "2026-05-11 16:57:01" (replace space with T)
  let str = String(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:/.test(str)) str = str.replace(' ', 'T');
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function fmtTime(s) {
  if (!s) return '';
  let str = String(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:/.test(str)) str = str.replace(' ', 'T');
  const d = new Date(str);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleString('ru', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

// Field key aliases — covers PascalCase (Go/ASP.NET), snake_case, camelCase
// HISTORY: Timestamp, TagId, Value, Id
// STATISTICS: Id, CalculationTime, TagId, AverageValue, RuntimeMinutes, TotalPeriodMinutes, PeriodStart
const K_TIME   = ['Timestamp','t','datetime','date','time','ts','timestamp','CalculationTime','PeriodStart','dt'];
const K_VALUE  = ['Value','value','val','v'];
const K_TAGID  = ['TagId','tagid','tag_id','id','Id'];
const K_AVG    = ['AverageValue','avg_value','avgValue','avg','value','Value'];
const K_WORK   = ['RuntimeMinutes','work_time','workTime','work','wt'];
const K_PERIOD = ['TotalPeriodMinutes','period_time','periodTime','period','pt'];
const K_DATE   = ['CalculationTime','PeriodStart','t','date','dt','datetime'];
const K_ID     = ['Id','id'];

/* ================================================================
   STATE
================================================================ */
const LS_KEY = 'sensor_dashboard_v2';

let S = {
  serverUrl: 'http://127.0.0.1:8085/api/',
  stepCoefficient: 4,   // шаг за 1 час (3600/2/4 ≈ 450 точек)
  refreshInterval: 0,
  printCols: 3,
  widgets: [],
  zCounter: 10
};

let charts = {};   // id -> Chart
let refreshTmr = null;
let editId = null;  // null=add, string=edit
let lastData = {};  // id -> raw response (for CSV export)
let schema = null;  // api/schema response: { tables, columns, ... }
let toSecOverride = null;  // seconds override for "to" timestamp (e.g. 59 for 19:59:59)

/* ================================================================
   INIT
================================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  setDefaultDates();
  loadSchema();            // Fetch schema from server (non-blocking)
  renderLayout();          // Render widgets immediately (no data)
  startRefresh();

  // Delayed data loading — stagger each widget
  S.widgets.forEach((w, i) => {
    setTimeout(() => fetchData(w), 300 + i * 200);
  });

  $('sServerUrl').value = S.serverUrl;
  $('sStepCoeff').value = S.stepCoefficient;
  $('sRefresh').value = S.refreshInterval;
  $('sPrintCols').value = S.printCols;

  // Modal close on overlay
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('active'); });
  });

  // Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
      closeCtxMenu();
    }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveToLS(); }
  });

  // Click to close context menu
  document.addEventListener('click', e => {
    if (!e.target.closest('.ctx-menu')) closeCtxMenu();
  });

  // Clear seconds override when user manually edits the "По" field
  $('globalTo').addEventListener('change', () => { toSecOverride = null; });

  updateStatus();
});

function setDefaultDates() {
  const now = new Date();
  const hr = new Date(now.getTime() - 3600000);
  $('globalFrom').value = toLocal(hr);
  $('globalTo').value = toLocal(now);
  $('fFrom').value = toLocal(hr);
  $('fTo').value = toLocal(now);
}

function setPeriod(hours) {
  // Use current "По" value instead of "now" — shift the window backward
  let toStr = $('globalTo').value;
  if (!toStr) {
    const now = new Date();
    $('globalTo').value = toLocal(now);
    toStr = toLocal(now);
  }
  const to = new Date(toStr);
  const from = new Date(to.getTime() - hours * 3600000);
  $('globalFrom').value = toLocal(from);
  // Don't change globalTo — keep whatever is already there
  toSecOverride = null;  // clear seconds override when using period buttons
  applyGlobalRange();
}

// Set "По" time to a specific HH:MM or HH:MM:SS (e.g. 19:59:59 or 07:59:59)
// Buttons show 19:59 and 07:59, but internally store :59 seconds for API calls
function setTimePreset(timeStr) {
  const parts = timeStr.split(':');
  const hhmm = parts.slice(0, 2).join(':');
  const ss = parts[2] ? parseInt(parts[2]) : null;
  const cur = $('globalTo').value;
  const datePart = cur ? cur.split('T')[0] : toLocal(new Date()).split('T')[0];
  $('globalTo').value = datePart + 'T' + hhmm;
  toSecOverride = ss;
  applyGlobalRange();
}

// Get "to" timestamp with seconds appended (for API calls)
// datetime-local input only supports HH:MM, so we store seconds separately
function getToTimestamp(inputVal) {
  let ts = inputVal;
  if (toSecOverride !== null && !/\d{2}:\d{2}:\d{2}/.test(ts)) {
    ts += ':' + pad2(toSecOverride);
  }
  return ts;
}

// Auto-calculate step from time range
// Base: 1 hour → step = stepCoefficient (4) → ~450 points
// 2 hours → step = 8, etc.
function autoStep(fromStr, toStr) {
  const from = new Date(fromStr);
  const to = new Date(toStr);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return S.stepCoefficient;
  const hours = Math.max(0.5, (to - from) / 3600000);
  return Math.max(1, Math.ceil(hours * S.stepCoefficient));
}

/* ================================================================
   CONFIG
================================================================ */
async function loadConfig() {
  // 1) localStorage
  let raw = localStorage.getItem(LS_KEY);
  if (raw) {
    try { applyCfg(JSON.parse(raw)); console.log('Config: localStorage'); return; }
    catch(e) { console.warn('LS parse err', e); }
  }
  // 2) chart.json
  try {
    const r = await fetch('chart.json');
    if (r.ok) { applyCfg(await r.json()); console.log('Config: chart.json'); return; }
  } catch(e) {}
  // 3) Empty
  console.log('Config: empty');
}

function applyCfg(c) {
  if (c.serverUrl) S.serverUrl = c.serverUrl;
  if (c.stepCoefficient) S.stepCoefficient = c.stepCoefficient;
  if (c.defaultStep) S.stepCoefficient = c.defaultStep; // backward compat
  if (c.refreshInterval != null) S.refreshInterval = c.refreshInterval;
  if (c.printCols) S.printCols = c.printCols;
  if (c.widgets) {
    // Strip dateFrom/dateTo/step from saved widgets — always use globals
    S.widgets = c.widgets.map(w => {
      const { dateFrom, dateTo, step, ...rest } = w;
      return rest;
    });
  }
  if (c.zCounter) S.zCounter = c.zCounter;
}

function getCfg() {
  // Save ONLY layout — no dates, no step
  const widgetsClean = S.widgets.map(w => {
    const { dateFrom, dateTo, step, ...rest } = w;
    return rest;
  });
  return { serverUrl:S.serverUrl, stepCoefficient:S.stepCoefficient, refreshInterval:S.refreshInterval,
           printCols:S.printCols, widgets:widgetsClean, zCounter:S.zCounter };
}

function saveToLS() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(getCfg())); toast('Сохранено в LocalStorage','success'); }
  catch(e) { toast('Ошибка: '+e.message,'error'); }
}

function silentSave() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(getCfg())); } catch(e) {}
}

function exportConfig() {
  const b = new Blob([JSON.stringify(getCfg(),null,2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(b);
  a.download = 'chart.json'; a.click();
  toast('Конфигурация экспортирована','success');
}

function importConfig(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = e => {
    try { applyCfg(JSON.parse(e.target.result)); renderAll(); saveToLS(); toast('Импортировано','success'); }
    catch(err) { toast('Ошибка: '+err.message,'error'); }
  };
  r.readAsText(f); ev.target.value = '';
}

/* ================================================================
   WIDGET CRUD
================================================================ */
function openAddModal() {
  editId = null;
  $('addModalTitle').textContent = 'Добавить виджет';
  $('addModalSave').textContent = 'Добавить';
  $('fType').value = 'line-chart';
  $('fTagId').value = '';
  $('fTagIdSelect').value = '';
  $('fTitle').value = '';
  $('fFrom').value = $('globalFrom').value;
  $('fTo').value = $('globalTo').value;
  $('fWidth').value = 500;
  $('fHeight').value = 340;
  // Auto-calculate step from current global date range
  $('fStep').value = autoStep($('globalFrom').value, $('globalTo').value);
  $('fSource').value = 'history';
  $('fMetric').value = 'all';
  $('fTableName').value = '';
  populateSchemaDropdowns();
  onTypeChange();
  openModal('addModal');
}

function openEditModal(id) {
  const w = S.widgets.find(x => x.id === id); if (!w) return;
  editId = id;
  $('addModalTitle').textContent = 'Редактировать виджет';
  $('addModalSave').textContent = 'Сохранить';
  $('fType').value = w.type;
  $('fTagId').value = w.tagId;
  $('fTagIdSelect').value = '';
  // Try to match tagId with a schema column
  if (schema && schema.columns) {
    const col = schema.columns.find(c => String(c.id) === String(w.tagId));
    if (col) $('fTagIdSelect').value = col.id;
  }
  $('fTitle').value = w.title;
  // Use global dates (widget-local overrides are transient)
  $('fFrom').value = w.dateFrom || $('globalFrom').value;
  $('fTo').value = w.dateTo || $('globalTo').value;
  $('fWidth').value = w.width || 500;
  $('fHeight').value = w.height || 340;
  $('fStep').value = w.step || autoStep($('globalFrom').value, $('globalTo').value);
  if (w.source) $('fSource').value = w.source;
  if (w.metric) $('fMetric').value = w.metric;
  $('fTableName').value = w.tableName || '';
  populateSchemaDropdowns();
  onTypeChange();
  openModal('addModal');
}

function onTypeChange() {
  const t = $('fType').value;
  $('fSourceGroup').style.display = (t==='table'||t==='bar-chart') ? '' : 'none';
  // Show "table name" field when statistics source is used
  const usesStats = t==='pie-chart'
    || (t==='bar-chart' && $('fSource').value==='statistics')
    || (t==='table' && $('fSource').value==='statistics');
  $('fTableGroup').style.display = usesStats ? '' : 'none';
  // Auto-select tableName based on widget type
  if (usesStats && !$('fTableName').value) {
    if (t === 'pie-chart' && schema && schema.tables) {
      // Pie chart defaults to WorkTime for work/idle display
      const wt = schema.tables.find(t => t.toLowerCase().includes('work'));
      if (wt) $('fTableName').value = wt;
    } else if ((t==='bar-chart' || t==='table') && schema && schema.tables) {
      const avg = schema.tables.find(t => t.toLowerCase().includes('avg'));
      if (avg) $('fTableName').value = avg;
    }
  }
  // Show metric selector for bar-chart (stats source) or pie-chart
  const showMetric = t==='bar-chart' || t==='pie-chart';
  if (t==='bar-chart') {
    const src = $('fSource').value;
    $('fMetricGroup').style.display = (src==='statistics') ? '' : 'none';
  } else {
    $('fMetricGroup').style.display = showMetric ? '' : 'none';
  }
  // Toggle option visibility
  const isBar = t==='bar-chart';
  $('fMetric').querySelectorAll('.opt-bar').forEach(o => o.style.display = isBar ? '' : 'none');
  $('fMetric').querySelectorAll('.opt-pie').forEach(o => o.style.display = isBar ? 'none' : '');
  // Reset to default metric based on table type
  const tbl = $('fTableName').value;
  if (isBar) {
    if ($('fMetric').value.startsWith('work-')) $('fMetric').value = isWorkTimeTable(tbl) ? 'work' : 'avg';
  } else {
    if (!['work-idle','work-by-period','avg-by-period'].includes($('fMetric').value)) {
      $('fMetric').value = isWorkTimeTable(tbl) ? 'work-idle' : 'avg-by-period';
    }
  }
}

// Also toggle metric when source or tableName changes
$('fSource').addEventListener('change', onTypeChange);
$('fTableName').addEventListener('change', onTypeChange);

function saveWidget() {
  const type=$('fType').value, tagId=$('fTagId').value.trim(),
        title=$('fTitle').value.trim()||autoTitle(type,tagId),
        dateFrom=$('fFrom').value, dateTo=$('fTo').value,
        width=Math.max(300,parseInt($('fWidth').value)||500),
        height=Math.max(220,parseInt($('fHeight').value)||340),
        step=parseInt($('fStep').value)||autoStep(dateFrom, dateTo),
        source=$('fSource').value;

  const metric=$('fMetric').value;
  const tableName=$('fTableName').value.trim();

  if (!tagId) { toast('Укажите ID тега','error'); return; }

  if (editId) {
    const w = S.widgets.find(x=>x.id===editId);
    if (w) {
      Object.assign(w, {type,tagId,title,dateFrom,dateTo,width,height,step});
      if (type==='table'||type==='bar-chart') w.source=source;
      if (type==='bar-chart'||type==='pie-chart') w.metric=metric;
      w.tableName = tableName || undefined;
      renderWidget(w, true);
      fetchData(w);
    }
    toast('Виджет обновлён','success');
  } else {
    const area = $('dashboardArea');
    const col = state_widgets_count() % 3;
    const row = Math.floor(state_widgets_count() / 3);
    const w = {
      id:uid(), type, tagId, title, dateFrom, dateTo, width, height, step,
      source: (type==='table'||type==='bar-chart') ? source : undefined,
      metric: (type==='bar-chart'||type==='pie-chart') ? metric : undefined,
      tableName: tableName || undefined,
      x: 16 + col * (width + 16),
      y: 16 + row * (height + 16),
      z: S.zCounter++, collapsed: false
    };
    S.widgets.push(w);
    renderWidget(w);
    fetchData(w);
    toast('Виджет добавлен','success');
  }
  closeModal('addModal');
  silentSave();
  updateEmpty();
  updateStatus();
}

function state_widgets_count() { return S.widgets.length; }

function deleteWidget(id) {
  if (!confirm('Удалить виджет?')) return;
  destroyChart(id);
  const el = $(id); if (el) el.remove();
  S.widgets = S.widgets.filter(w=>w.id!==id);
  delete lastData[id];
  silentSave(); updateEmpty(); updateStatus();
  toast('Удалено','info');
}

function duplicateWidget(id) {
  const src = S.widgets.find(w=>w.id===id); if (!src) return;
  const w = {...src, id:uid(), title:src.title+' (копия)',
    x:src.x+30, y:src.y+30, z:S.zCounter++};
  delete w.collapsed;
  S.widgets.push(w);
  renderWidget(w);
  fetchData(w);
  silentSave(); updateEmpty(); updateStatus();
  toast('Виджет дублирован','success');
}

function toggleCollapse(id) {
  const w = S.widgets.find(x=>x.id===id); if (!w) return;
  w.collapsed = !w.collapsed;
  const el = $(id);
  if (el) el.classList.toggle('collapsed', w.collapsed);
  silentSave();
}

function autoTitle(type, tagId) {
  const m = {'line-chart':'График','pie-chart':'Диаграмма','bar-chart':'Столбчатая','table':'Таблица'};
  // Try to get header from schema column
  let header = null;
  if (schema && schema.columns) {
    const col = schema.columns.find(c => String(c.id) === String(tagId));
    if (col && col.header) header = col.header;
  }
  return header ? `${m[type]||type} — ${header}` : `${m[type]||type} — Тег ${tagId}`;
}

function typeIcon(type) {
  const svgs = {
    'line-chart': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 5-9"/></svg>',
    'pie-chart': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
    'bar-chart': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>',
    'table': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>'
  };
  return svgs[type]||'';
}

/* ================================================================
   RENDERING
================================================================ */
function renderAll() {
  const c = $('widgetsContainer'); c.innerHTML = '';
  Object.keys(charts).forEach(k => { charts[k].destroy(); delete charts[k]; });
  Object.keys(lastData).forEach(k => delete lastData[k]);
  S.widgets.forEach(w => renderWidget(w));
  // Stagger data loading
  S.widgets.forEach((w, i) => {
    setTimeout(() => fetchData(w), 200 + i * 250);
  });
  updateEmpty(); updateStatus();
}

// Render layout only (no data fetch) — for initial page load
function renderLayout() {
  const c = $('widgetsContainer'); c.innerHTML = '';
  S.widgets.forEach(w => renderWidget(w));
  updateEmpty(); updateStatus();
}

function renderWidget(w, isUpdate) {
  let el = $(w.id);
  if (!el) {
    el = document.createElement('div'); el.id = w.id; el.className = 'widget';
    $('widgetsContainer').appendChild(el);
  }
  el.style.cssText = `left:${w.x}px;top:${w.y}px;width:${w.width}px;height:${w.collapsed?'auto':w.height+'px'};z-index:${w.z||1}`;
  if (w.collapsed) el.classList.add('collapsed'); else el.classList.remove('collapsed');

  el.innerHTML = `
    <div class="widget-header" data-wid="${w.id}">
      <span class="widget-type-icon">${typeIcon(w.type)}</span>
      <span class="widget-title">${esc(w.title)}</span>
      <span class="widget-badge">ID:${esc(w.tagId)}${w.tableName ? ' / '+esc(w.tableName) : ''}</span>
      <div class="widget-actions">
        <button title="Свернуть" onclick="toggleCollapse('${w.id}')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="${w.collapsed?'4 8 12 16 20 8':'4 16 12 8 20 16'}"/></svg>
        </button>
        <button title="Обновить данные" onclick="fetchData(S.widgets.find(x=>x.id==='${w.id}'))">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button title="Редактировать" onclick="openEditModal('${w.id}')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="act-del" title="Удалить" onclick="deleteWidget('${w.id}')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
    <div class="widget-body" id="body-${w.id}">
      <div class="loading"><div class="spinner"></div></div>
    </div>
    <div class="resize-handle" data-wid="${w.id}"></div>
  `;

  // Set data attributes for print layout (colspan/rowspan)
  el.setAttribute('data-colspan', calcColSpan(w));
  el.setAttribute('data-rowspan', calcRowSpan(w));
  initDrag(el, w.id);
  initResize(el, w.id);
  el.addEventListener('mousedown', () => bringFront(w.id));
  el.addEventListener('contextmenu', e => showCtxMenu(e, w.id));
}

function updateEmpty() { $('emptyState').style.display = S.widgets.length ? 'none' : ''; }
function updateStatus() {
  $('widgetCount').textContent = `${S.widgets.length} виджет${S.widgets.length===1?'':'ов'}`;
  $('serverDisplay').textContent = S.serverUrl;
}

/* ================================================================
   DRAG
================================================================ */
function initDrag(el, wid) {
  const hdr = el.querySelector('.widget-header');
  hdr.addEventListener('mousedown', e => {
    if (e.target.closest('.widget-actions')) return;
    e.preventDefault();
    const w = S.widgets.find(x=>x.id===wid); if (!w) return;
    const sx=e.clientX, sy=e.clientY, ox=w.x, oy=w.y;
    el.classList.add('dragging'); bringFront(wid);

    const move = ev => { w.x=Math.max(0,ox+ev.clientX-sx); w.y=Math.max(0,oy+ev.clientY-sy); el.style.left=w.x+'px'; el.style.top=w.y+'px'; };
    const up = () => { el.classList.remove('dragging'); document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); silentSave(); };
    document.addEventListener('mousemove',move);
    document.addEventListener('mouseup',up);
  });
}

/* ================================================================
   RESIZE
================================================================ */
function initResize(el, wid) {
  const h = el.querySelector('.resize-handle');
  h.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    const w = S.widgets.find(x=>x.id===wid); if (!w) return;
    const sx=e.clientX, sy=e.clientY, ow=w.width, oh=w.height;
    el.classList.add('resizing'); bringFront(wid);

    const move = ev => {
      w.width = Math.max(300, ow+ev.clientX-sx);
      w.height = Math.max(220, oh+ev.clientY-sy);
      el.style.width = w.width+'px'; el.style.height = w.height+'px';
      if (charts[wid]) charts[wid].resize();
    };
    const up = () => {
      el.classList.remove('resizing');
      document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up);
      if (charts[wid]) charts[wid].resize();
      silentSave();
    };
    document.addEventListener('mousemove',move);
    document.addEventListener('mouseup',up);
  });
}

function bringFront(wid) {
  const w = S.widgets.find(x=>x.id===wid); if (!w) return;
  w.z = S.zCounter++;
  const el = $(wid); if (el) el.style.zIndex = w.z;
}

/* ================================================================
   CONTEXT MENU
================================================================ */
let activeCtx = null;
function showCtxMenu(e, wid) {
  e.preventDefault(); closeCtxMenu();
  const w = S.widgets.find(x=>x.id===wid); if (!w) return;
  const menu = document.createElement('div'); menu.className = 'ctx-menu';
  menu.innerHTML = `
    <button onclick="fetchData(S.widgets.find(x=>x.id==='${wid}'))">🔄 Обновить данные</button>
    <button onclick="openEditModal('${wid}')">✏️ Редактировать</button>
    <button onclick="duplicateWidget('${wid}')">📋 Дублировать</button>
    <button onclick="exportWidgetCSV('${wid}')">💾 Экспорт CSV</button>
    <button onclick="toggleCollapse('${wid}')">${w.collapsed?'🔽 Развернуть':'🔼 Свернуть'}</button>
    <div class="ctx-sep"></div>
    <button class="danger" onclick="deleteWidget('${wid}')">🗑 Удалить</button>
  `;
  menu.style.left = Math.min(e.clientX, window.innerWidth-180)+'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight-250)+'px';
  document.body.appendChild(menu);
  activeCtx = menu;
}

function closeCtxMenu() {
  if (activeCtx) { activeCtx.remove(); activeCtx = null; }
}

/* ================================================================
   CSV EXPORT
================================================================ */
function exportWidgetCSV(wid) {
  closeCtxMenu();
  const data = lastData[wid];
  if (!data || !data.length) { toast('Нет данных для экспорта','error'); return; }
  const arr = Array.isArray(data) ? data : [data];
  const keys = Object.keys(arr[0]);
  const csv = [keys.join(';'), ...arr.map(r => keys.map(k => {
    const v = r[k];
    return typeof v === 'string' && v.includes(';') ? '"'+v+'"' : v;
  }).join(';'))].join('\n');
  const BOM = '\uFEFF';
  const b = new Blob([BOM+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = `widget_${wid}.csv`; a.click();
  toast('CSV экспортирован','success');
}

/* ================================================================
   API
================================================================ */
async function apiFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Build statistics API URL with optional &table= parameter
function statsUrl(tagId, from, to, tableName) {
  let url = `${S.serverUrl}statistics?id=${encodeURIComponent(tagId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (tableName) url += `&table=${encodeURIComponent(tableName)}`;
  return url;
}

/* ================================================================
   SCHEMA
================================================================ */
async function loadSchema() {
  try {
    const r = await fetch(S.serverUrl + 'schema');
    if (r.ok) {
      schema = await r.json();
      console.log('[Dashboard] Schema loaded:', schema);
      populateSchemaDropdowns();
    }
  } catch(e) {
    console.warn('[Dashboard] Schema fetch failed:', e.message);
  }
}

function populateSchemaDropdowns() {
  if (!schema) return;
  // Populate table selector
  const tableSel = $('fTableName');
  if (tableSel && schema.tables) {
    const curVal = tableSel.value;
    tableSel.innerHTML = '<option value="">-- авто --</option>';
    schema.tables.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      tableSel.appendChild(opt);
    });
    tableSel.value = curVal; // restore selection
  }
  // Populate column (tag ID) selector
  const colSel = $('fTagIdSelect');
  if (colSel && schema.columns) {
    const curVal = colSel.value;
    colSel.innerHTML = '<option value="">-- выбрать --</option>';
    schema.columns.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.header ? `${c.header} (ID:${c.id})` : `ID:${c.id}`;
      colSel.appendChild(opt);
    });
    colSel.value = curVal;
  }
}

function onTagIdSelectChange() {
  const sel = $('fTagIdSelect');
  const input = $('fTagId');
  if (sel.value) {
    input.value = sel.value;
    // Auto-fill title from schema column header
    if (schema && schema.columns) {
      const col = schema.columns.find(c => String(c.id) === String(sel.value));
      if (col && col.header) {
        const titleInput = $('fTitle');
        if (!titleInput.value.trim()) {
          titleInput.value = col.header;
        }
      }
    }
  }
}

// Determine if a table name represents work time data (seconds)
function isWorkTimeTable(tableName) {
  if (!tableName) return false;
  const lower = tableName.toLowerCase();
  return lower.includes('work') || lower.includes('runtime') || lower.includes('uptime');
}

// Determine if a table name represents average/value data
function isAvgTable(tableName) {
  if (!tableName) return false;
  const lower = tableName.toLowerCase();
  return lower.includes('avg') || lower.includes('average') || lower.includes('mean');
}

async function fetchData(w) {
  const body = $('body-'+w.id); if (!body) return;
  body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const from = w.dateFrom || $('globalFrom').value;
    const to = w.dateTo ? w.dateTo : getToTimestamp($('globalTo').value);
    // step=0 means "auto" — calculate from time range
    const step = (w.step && w.step > 0) ? w.step : autoStep(from, $('globalTo').value);
    let data;

    if (w.type === 'line-chart') {
      // Support multiple tag IDs
      const ids = w.tagId.split(',').map(s=>s.trim()).filter(Boolean);
      if (ids.length > 1) {
        data = await fetchMultiHistory(ids, from, to, step);
      } else {
        data = await apiFetch(`${S.serverUrl}history?id=${encodeURIComponent(w.tagId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&step=${step}`);
      }
      lastData[w.id] = data;
      console.log(`[Dashboard] line-chart "${w.title}" data:`, data, 'sample keys:', data?.length ? Object.keys(data[0]) : 'empty');
      renderLineChart(w, data, ids);
    } else if (w.type === 'pie-chart') {
      data = await apiFetch(statsUrl(w.tagId, from, to, w.tableName));
      lastData[w.id] = data;
      console.log(`[Dashboard] pie-chart "${w.title}" data:`, data, 'sample keys:', data?.length ? Object.keys(data[0]) : 'empty');
      renderPieChart(w, data);
    } else if (w.type === 'bar-chart') {
      const src = w.source || 'statistics';
      if (src === 'statistics') {
        data = await apiFetch(statsUrl(w.tagId, from, to, w.tableName));
      } else {
        data = await apiFetch(`${S.serverUrl}history?id=${encodeURIComponent(w.tagId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&step=${step}`);
      }
      lastData[w.id] = data;
      console.log(`[Dashboard] bar-chart "${w.title}" data:`, data, 'sample keys:', data?.length ? Object.keys(data[0]) : 'empty');
      renderBarChart(w, data, src);
    } else if (w.type === 'table') {
      const src = w.source || 'history';
      if (src === 'statistics') {
        data = await apiFetch(statsUrl(w.tagId, from, to, w.tableName));
      } else {
        data = await apiFetch(`${S.serverUrl}history?id=${encodeURIComponent(w.tagId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&step=${step}`);
      }
      lastData[w.id] = data;
      console.log(`[Dashboard] table "${w.title}" data:`, data, 'sample keys:', data?.length ? Object.keys(data[0]) : 'empty');
      renderTable(w, data, src);
    }
    setConn(true);
  } catch(err) {
    body.innerHTML = `<div class="error-msg">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><br>
      ${esc(err.message)}</div>`;
    setConn(false);
  }
}

async function fetchMultiHistory(ids, from, to, step) {
  const results = await Promise.all(ids.map(id =>
    apiFetch(`${S.serverUrl}history?id=${encodeURIComponent(id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&step=${step}`)
      .catch(() => [])
  ));
  // Return object with per-ID data
  return { _multi: true, ids, data: results };
}

function setConn(ok) {
  $('statusDot').className = 'status-dot '+(ok?'ok':'err');
  $('statusText').textContent = ok?'Подключено':'Ошибка';
  if (ok) $('lastRefresh').textContent = 'Обновлено: '+new Date().toLocaleTimeString('ru');
}

/* ================================================================
   LINE CHART
================================================================ */
function renderLineChart(w, data, tagIds) {
  const body = $('body-'+w.id); if (!body) return;
  if (!data || (Array.isArray(data) && !data.length)) {
    body.innerHTML = '<div class="no-data"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 5-9"/></svg><br>Нет данных за период</div>';
    return;
  }
  destroyChart(w.id);

  const canvas = document.createElement('canvas');
  body.innerHTML = ''; body.appendChild(canvas);

  let datasets = [];

  if (data._multi) {
    // Multiple series
    data.ids.forEach((id, i) => {
      const arr = Array.isArray(data.data[i]) ? data.data[i] : [];
      const color = COLORS[i % COLORS.length];
      datasets.push({
        label: 'Тег '+id,
        data: arr.map(d => ({
          x: parseTimeStr(findKey(d,K_TIME)),
          y: findKey(d,K_VALUE) ?? 0
        })).filter(p => p.x),
        borderColor: color,
        backgroundColor: color+'18',
        borderWidth: 2, pointRadius: arr.length>300?0:1.5, pointHoverRadius:4,
        fill: false, tension:.15
      });
    });
  } else {
    const arr = Array.isArray(data) ? data : [data];
    const color = COLORS[S.widgets.indexOf(w) % COLORS.length];
    datasets.push({
      label: w.title,
      data: arr.map(d => ({
        x: parseTimeStr(findKey(d,K_TIME)),
        y: findKey(d,K_VALUE) ?? 0
      })).filter(p => p.x),
      borderColor: color,
      backgroundColor: color+'18',
      borderWidth: 2, pointRadius: arr.length>300?0:1.5, pointHoverRadius:4,
      fill: true, tension:.15
    });
  }

  charts[w.id] = new Chart(canvas.getContext('2d'), {
    type:'line',
    data: { datasets },
    options: {
      responsive:true, maintainAspectRatio:false,
      animation:{duration:300},
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:datasets.length>1, labels:{color:'#94a3b8',font:{size:11},usePointStyle:true,padding:10}},
        tooltip:{
          backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
          borderColor:'#334155', borderWidth:1,
          callbacks:{ title: items => items[0]?.raw.x ? new Date(items[0].raw.x).toLocaleString('ru') : '' }
        }
      },
      scales:{
        x:{type:'time', time:{tooltipFormat:'dd.MM.yyyy HH:mm:ss', displayFormats:{minute:'HH:mm',hour:'HH:mm',day:'dd.MM'}},
            ticks:{color:'#64748b',font:{size:10},maxTicksLimit:8}, grid:{color:'rgba(51,65,85,.25)'}},
        y:{ticks:{color:'#64748b',font:{size:10}}, grid:{color:'rgba(51,65,85,.25)'}}
      }
    }
  });
}

/* ================================================================
   PIE CHART
================================================================ */
function renderPieChart(w, data) {
  const body = $('body-'+w.id); if (!body) return;
  if (!data || (Array.isArray(data) && !data.length)) {
    body.innerHTML = '<div class="no-data"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/></svg><br>Нет данных</div>';
    return;
  }
  destroyChart(w.id);

  const arr = Array.isArray(data) ? data : [data];
  const simple = isSimpleFormat(arr);
  const isWork = isWorkTimeTable(w.tableName);
  const isAvg  = isAvgTable(w.tableName);
  const metric = w.metric || (isWork ? 'work-idle' : 'avg-by-period');

  // Build metric selector — options depend on table type
  let toolbarHtml;
  if (isWork || (!isAvg && simple)) {
    // WorkTime or unknown simple format — show work-related options
    toolbarHtml = `<div class="metric-toolbar">
      <select class="metric-select" onchange="switchPieMetric('${w.id}', this.value)">
        <option value="work-idle" ${metric==='work-idle'?'selected':''}>Работа / Простой</option>
        <option value="work-by-period" ${metric==='work-by-period'?'selected':''}>Работа по периодам</option>
      </select>
    </div>`;
  } else {
    // AvgData or full format — show value-based + work options
    toolbarHtml = `<div class="metric-toolbar">
      <select class="metric-select" onchange="switchPieMetric('${w.id}', this.value)">
        <option value="avg-by-period" ${metric==='avg-by-period'?'selected':''}>Значения по периодам</option>
        <option value="work-idle" ${metric==='work-idle'?'selected':''}>Работа / Простой</option>
        <option value="work-by-period" ${metric==='work-by-period'?'selected':''}>Работа по периодам</option>
      </select>
    </div>`;
  }

  body.innerHTML = toolbarHtml;
  const canvas = document.createElement('canvas');
  body.appendChild(canvas);

  if (metric === 'work-idle') {
    if (simple && isWork) {
      // Simple format {t,v} from WorkTime: v = work time in seconds, each period = 43200 sec (12h)
      let totalWorkSec = 0;
      arr.forEach(d => { totalWorkSec += findStatVal(d, K_WORK) ?? 0; });
      const totalPeriodSec = arr.length * 43200; // each object = 12 hours
      const totalIdleSec = Math.max(0, totalPeriodSec - totalWorkSec);

      charts[w.id] = new Chart(canvas.getContext('2d'), {
        type:'doughnut',
        data:{
          labels:['Время работы','Простой'],
          datasets:[{data:[totalWorkSec,totalIdleSec], backgroundColor:['#22c55e','#ef4444'], borderColor:['#16a34a','#dc2626'], borderWidth:2, hoverOffset:6}]
        },
        options:{
          responsive:true, maintainAspectRatio:false, cutout:'55%', animation:{duration:300},
          plugins:{
            legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:11},padding:12,usePointStyle:true}},
            tooltip:{
              backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
              borderColor:'#334155', borderWidth:1,
              callbacks:{ label: ctx => { const t=ctx.dataset.data.reduce((a,b)=>a+b,0); return `${ctx.label}: ${fmtDurationSec(ctx.parsed)} (${t?((ctx.parsed/t)*100).toFixed(1):0}%)`; }}
            }
          }
        }
      });
      // Summary line
      const info = document.createElement('div');
      info.style.cssText = 'text-align:center;font-size:11px;color:var(--text-muted);padding-top:4px;';
      info.textContent = `Работа: ${fmtDurationSec(totalWorkSec)} | Простой: ${fmtDurationSec(totalIdleSec)} | Период: ${fmtDurationSec(totalPeriodSec)}`;
      body.appendChild(info);
    } else if (simple && !isWork) {
      // Simple format but NOT WorkTime — show values by period instead of work/idle
      const labels = arr.map(d => fmtTime(findKey(d,K_DATE)));
      const values = arr.map(d => findStatVal(d,K_VALUE) ?? 0);
      const colors = arr.map((_,i) => COLORS[i % COLORS.length]);

      charts[w.id] = new Chart(canvas.getContext('2d'), {
        type:'pie',
        data:{
          labels,
          datasets:[{data:values, backgroundColor:colors.map(c=>c+'cc'), borderColor:colors, borderWidth:1, hoverOffset:6}]
        },
        options:{
          responsive:true, maintainAspectRatio:false, animation:{duration:300},
          plugins:{
            legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:10},padding:8,usePointStyle:true}},
            tooltip:{
              backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
              borderColor:'#334155', borderWidth:1,
              callbacks:{ label: ctx => `${ctx.label}: ${fmtNum(ctx.parsed)}` }
            }
          }
        }
      });
    } else {
      // Classic format: total work vs idle (values in minutes)
      let totalWork=0, totalPeriod=0;
      arr.forEach(d => {
        totalWork += findStatVal(d,K_WORK) ?? 0;
        totalPeriod += findStatVal(d,K_PERIOD) ?? 0;
      });
      const totalIdle = Math.max(0, totalPeriod - totalWork);

      charts[w.id] = new Chart(canvas.getContext('2d'), {
        type:'doughnut',
        data:{
          labels:['Время работы','Простой'],
          datasets:[{data:[totalWork,totalIdle], backgroundColor:['#22c55e','#ef4444'], borderColor:['#16a34a','#dc2626'], borderWidth:2, hoverOffset:6}]
        },
        options:{
          responsive:true, maintainAspectRatio:false, cutout:'55%', animation:{duration:300},
          plugins:{
            legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:11},padding:12,usePointStyle:true}},
            tooltip:{
              backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
              borderColor:'#334155', borderWidth:1,
              callbacks:{ label: ctx => { const t=ctx.dataset.data.reduce((a,b)=>a+b,0); return `${ctx.label}: ${fmtDuration(ctx.parsed)} (${t?((ctx.parsed/t)*100).toFixed(1):0}%)`; }}
            }
          }
        }
      });
      // Summary
      const info = document.createElement('div');
      info.style.cssText = 'text-align:center;font-size:11px;color:var(--text-muted);padding-top:4px;';
      info.textContent = `Работа: ${fmtDuration(totalWork)} | Простой: ${fmtDuration(totalIdle)} | Период: ${fmtDuration(totalPeriod)}`;
      body.appendChild(info);
    }

  } else if (metric === 'work-by-period') {
    // Work time per period as pie slices
    const labels = arr.map(d => fmtTime(findKey(d,K_DATE)));
    const values = arr.map(d => findStatVal(d,K_WORK) ?? 0);
    const colors = arr.map((_,i) => COLORS[i % COLORS.length]);

    charts[w.id] = new Chart(canvas.getContext('2d'), {
      type:'pie',
      data:{
        labels,
        datasets:[{data:values, backgroundColor:colors.map(c=>c+'cc'), borderColor:colors, borderWidth:1, hoverOffset:6}]
      },
      options:{
        responsive:true, maintainAspectRatio:false, animation:{duration:300},
        plugins:{
          legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:10},padding:8,usePointStyle:true}},
          tooltip:{
            backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
            borderColor:'#334155', borderWidth:1,
            callbacks:{ label: ctx => simple ? `${ctx.label}: ${fmtDurationSec(ctx.parsed)}` : `${ctx.label}: ${fmtDuration(ctx.parsed)}` }
          }
        }
      }
    });

  } else if (metric === 'avg-by-period') {
    // Average/value per period as pie slices — works for both simple and full format
    const labels = arr.map(d => fmtTime(findKey(d,K_DATE)));
    const values = simple ? arr.map(d => findStatVal(d,K_VALUE) ?? 0) : arr.map(d => findStatVal(d,K_AVG) ?? 0);
    const colors = arr.map((_,i) => COLORS[i % COLORS.length]);

    charts[w.id] = new Chart(canvas.getContext('2d'), {
      type:'pie',
      data:{
        labels,
        datasets:[{data:values, backgroundColor:colors.map(c=>c+'cc'), borderColor:colors, borderWidth:1, hoverOffset:6}]
      },
      options:{
        responsive:true, maintainAspectRatio:false, animation:{duration:300},
        plugins:{
          legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:10},padding:8,usePointStyle:true}},
          tooltip:{
            backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
            borderColor:'#334155', borderWidth:1,
            callbacks:{ label: ctx => `${ctx.label}: ${fmtNum(ctx.parsed)}` }
          }
        }
      }
    });
  }
}

function switchPieMetric(wid, metric) {
  const w = S.widgets.find(x=>x.id===wid); if (!w) return;
  w.metric = metric;
  if (lastData[wid]) renderPieChart(w, lastData[wid]);
  silentSave();
}

/* ================================================================
   BAR CHART
================================================================ */
const METRIC_DEFS = {
  avg:    {label:'Среднее значение',  color:'#3b82f6', key:K_AVG,    unit:'',      fmt: v => fmtNum(v)},
  work:   {label:'Время работы',      color:'#22c55e', key:K_WORK,   unit:' мин',  fmt: v => fmtDuration(v)},
  period: {label:'Период',            color:'#f59e0b', key:K_PERIOD, unit:' мин',  fmt: v => fmtDuration(v)},
  uptime: {label:'Коэфф. работы (%)', color:'#8b5cf6', key:null,     unit:'%',     fmt: v => v.toFixed(1)+'%'}
};

function buildBarDatasets(arr, metric) {
  if (metric === 'all') {
    return ['avg','work','period'].map((m, i) => {
      const def = METRIC_DEFS[m];
      return {
        label: def.label,
        data: arr.map(d => findStatVal(d, def.key) ?? 0),
        backgroundColor: def.color + 'cc',
        borderColor: def.color,
        borderWidth: 1,
        borderRadius: 4
      };
    });
  }
  const def = METRIC_DEFS[metric];
  if (!def) return [];
  if (metric === 'uptime') {
    return [{
      label: def.label,
      data: arr.map(d => {
        const wt = findStatVal(d, K_WORK) ?? 0;
        const pt = findStatVal(d, K_PERIOD) ?? 0;
        return pt > 0 ? (wt / pt * 100) : 0;
      }),
      backgroundColor: arr.map(d => {
        const wt = findStatVal(d, K_WORK) ?? 0;
        const pt = findStatVal(d, K_PERIOD) ?? 0;
        const pct = pt > 0 ? (wt / pt * 100) : 0;
        return pct >= 95 ? '#22c55ecc' : pct >= 70 ? '#f59e0bcc' : '#ef4444cc';
      }),
      borderColor: arr.map(d => {
        const wt = findStatVal(d, K_WORK) ?? 0;
        const pt = findStatVal(d, K_PERIOD) ?? 0;
        const pct = pt > 0 ? (wt / pt * 100) : 0;
        return pct >= 95 ? '#22c55e' : pct >= 70 ? '#f59e0b' : '#ef4444';
      }),
      borderWidth: 1,
      borderRadius: 4
    }];
  }
  return [{
    label: def.label + (def.unit ? ` (${def.unit.trim()})` : ''),
    data: arr.map(d => findStatVal(d, def.key) ?? 0),
    backgroundColor: def.color + 'cc',
    borderColor: def.color,
    borderWidth: 1,
    borderRadius: 4
  }];
}

function renderBarChart(w, data, source) {
  const body = $('body-'+w.id); if (!body) return;
  if (!data || (Array.isArray(data) && !data.length)) {
    body.innerHTML = '<div class="no-data">Нет данных</div>'; return;
  }
  destroyChart(w.id);

  const arr = Array.isArray(data) ? data : [data];
  const simple = isSimpleFormat(arr);
  const isWork = isWorkTimeTable(w.tableName);
  const isAvg  = isAvgTable(w.tableName);
  const metric = w.metric || (isWork ? 'work' : simple ? 'value' : 'all');

  // Build metric selector toolbar — options depend on table type
  let toolbarHtml = '';
  if (source === 'statistics') {
    if (simple && isWork) {
      toolbarHtml = `<div class="metric-toolbar">
        <select class="metric-select" onchange="switchBarMetric('${w.id}', this.value)">
          <option value="work" ${metric==='work'?'selected':''}>Время работы (сек)</option>
          <option value="uptime" ${metric==='uptime'?'selected':''}>Коэфф. работы (%)</option>
        </select>
      </div>`;
    } else if (simple && isAvg) {
      toolbarHtml = `<div class="metric-toolbar">
        <select class="metric-select" onchange="switchBarMetric('${w.id}', this.value)">
          <option value="value" ${metric==='value'?'selected':''}>Среднее значение</option>
        </select>
      </div>`;
    } else if (simple) {
      // Unknown simple format — offer both options
      toolbarHtml = `<div class="metric-toolbar">
        <select class="metric-select" onchange="switchBarMetric('${w.id}', this.value)">
          <option value="value" ${metric==='value'?'selected':''}>Значение</option>
          <option value="work" ${metric==='work'?'selected':''}>Время работы (сек)</option>
          <option value="uptime" ${metric==='uptime'?'selected':''}>Коэфф. работы (%)</option>
        </select>
      </div>`;
    } else {
      toolbarHtml = `<div class="metric-toolbar">
        <select class="metric-select" onchange="switchBarMetric('${w.id}', this.value)">
          <option value="all" ${metric==='all'?'selected':''}>Все вместе</option>
          <option value="avg" ${metric==='avg'?'selected':''}>Среднее значение</option>
          <option value="work" ${metric==='work'?'selected':''}>Время работы</option>
          <option value="period" ${metric==='period'?'selected':''}>Период</option>
          <option value="uptime" ${metric==='uptime'?'selected':''}>Коэфф. работы (%)</option>
        </select>
      </div>`;
    }
  }

  body.innerHTML = toolbarHtml;
  const canvas = document.createElement('canvas');
  body.appendChild(canvas);

  if (source === 'statistics' && simple && isWork) {
    // Simple format {t,v} from WorkTime: v = work time in seconds
    const labels = arr.map(d => fmtTime(findKey(d, K_DATE)));
    const values = arr.map(d => findStatVal(d, K_WORK) ?? 0);

    if (metric === 'uptime') {
      // Show uptime percentage bars
      const periodSec = 43200;
      const pctValues = values.map(v => periodSec > 0 ? (v / periodSec * 100) : 0);
      charts[w.id] = new Chart(canvas.getContext('2d'), {
        type:'bar',
        data:{ labels,
          datasets:[{label:'Коэфф. работы', data:pctValues,
            backgroundColor: pctValues.map(p => p >= 95 ? '#22c55ecc' : p >= 70 ? '#f59e0bcc' : '#ef4444cc'),
            borderColor: pctValues.map(p => p >= 95 ? '#22c55e' : p >= 70 ? '#f59e0b' : '#ef4444'),
            borderWidth:1, borderRadius:4}]
        },
        options:{
          responsive:true, maintainAspectRatio:false, animation:{duration:300},
          plugins:{
            legend:{display:false},
            tooltip:{
              backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
              borderColor:'#334155', borderWidth:1,
              callbacks:{ label: ctx => `Коэфф.: ${ctx.parsed.y.toFixed(1)}%` }
            }
          },
          scales:{
            x:{ticks:{color:'#64748b',font:{size:10},maxRotation:45},grid:{color:'rgba(51,65,85,.25)'}},
            y:{max:100, ticks:{color:'#64748b',font:{size:10},callback: v => v+'%'},grid:{color:'rgba(51,65,85,.25)'}}
          }
        }
      });
    } else {
      charts[w.id] = new Chart(canvas.getContext('2d'), {
        type:'bar',
        data:{ labels,
          datasets:[{label:'Время работы', data:values, backgroundColor:'#3b82f6cc', borderColor:'#3b82f6', borderWidth:1, borderRadius:4}]
        },
        options:{
          responsive:true, maintainAspectRatio:false, animation:{duration:300},
          plugins:{
            legend:{display:false},
            tooltip:{
              backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
              borderColor:'#334155', borderWidth:1,
              callbacks:{ label: ctx => `Работа: ${fmtDurationSec(ctx.parsed.y)}` }
            }
          },
          scales:{
            x:{ticks:{color:'#64748b',font:{size:10},maxRotation:45},grid:{color:'rgba(51,65,85,.25)'}},
            y:{ticks:{color:'#64748b',font:{size:10},callback: v => fmtDurationSec(v)},grid:{color:'rgba(51,65,85,.25)'}}
          }
        }
      });
    }

  } else if (source === 'statistics' && simple) {
    // Simple format {t,v} from AvgData or other non-WorkTime: v = value (not seconds)
    const labels = arr.map(d => fmtTime(findKey(d, K_DATE)));
    const values = arr.map(d => findStatVal(d, K_VALUE) ?? 0);

    charts[w.id] = new Chart(canvas.getContext('2d'), {
      type:'bar',
      data:{ labels,
        datasets:[{label:'Значение', data:values, backgroundColor:'#3b82f6cc', borderColor:'#3b82f6', borderWidth:1, borderRadius:4}]
      },
      options:{
        responsive:true, maintainAspectRatio:false, animation:{duration:300},
        plugins:{
          legend:{display:false},
          tooltip:{
            backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
            borderColor:'#334155', borderWidth:1,
            callbacks:{ label: ctx => `Значение: ${fmtNum(ctx.parsed.y)}` }
          }
        },
        scales:{
          x:{ticks:{color:'#64748b',font:{size:10},maxRotation:45},grid:{color:'rgba(51,65,85,.25)'}},
          y:{ticks:{color:'#64748b',font:{size:10}},grid:{color:'rgba(51,65,85,.25)'}}
        }
      }
    });

  } else if (source === 'statistics') {
    const labels = arr.map(d => fmtTime(findKey(d, K_DATE)));
    const datasets = buildBarDatasets(arr, metric);

    // Compute nice y-axis label
    let yTitle = '';
    if (metric === 'avg') yTitle = 'Значение';
    else if (metric === 'work') yTitle = 'Минуты';
    else if (metric === 'period') yTitle = 'Минуты';
    else if (metric === 'uptime') yTitle = '%';
    else yTitle = ''; // all — mixed units, no single axis label

    charts[w.id] = new Chart(canvas.getContext('2d'), {
      type:'bar',
      data:{ labels, datasets },
      options:{
        responsive:true, maintainAspectRatio:false, animation:{duration:300},
        plugins:{
          legend:{display: metric==='all', labels:{color:'#94a3b8',font:{size:11},usePointStyle:true,padding:10}},
          tooltip:{
            backgroundColor:'#1e293b', titleColor:'#f1f5f9', bodyColor:'#94a3b8',
            borderColor:'#334155', borderWidth:1,
            callbacks: metric === 'uptime' ? {
              label: ctx => `Коэфф. работы: ${ctx.parsed.y.toFixed(1)}%`
            } : metric === 'work' ? {
              label: ctx => `Время работы: ${fmtDuration(ctx.parsed.y)}`
            } : metric === 'period' ? {
              label: ctx => `Период: ${fmtDuration(ctx.parsed.y)}`
            } : undefined
          }
        },
        scales:{
          x:{ticks:{color:'#64748b',font:{size:10},maxRotation:45},grid:{color:'rgba(51,65,85,.25)'}},
          y:{
            title: yTitle ? {display:true, text:yTitle, color:'#64748b', font:{size:10}} : {display:false},
            ticks:{color:'#64748b',font:{size:10},
              callback: metric==='uptime' ? v => v+'%' : metric==='work'||metric==='period' ? v => v+'м' : undefined
            },
            grid:{color:'rgba(51,65,85,.25)'},
            max: metric==='uptime' ? 100 : undefined
          }
        }
      }
    });
  } else {
    // History source — simple value bars
    const labels = arr.map(d => fmtTime(findKey(d, K_TIME)));
    charts[w.id] = new Chart(canvas.getContext('2d'), {
      type:'bar',
      data:{
        labels,
        datasets:[{label:'Значение', data:arr.map(d=>findKey(d,K_VALUE)??0), backgroundColor:'#3b82f6cc', borderColor:'#3b82f6', borderWidth:1, borderRadius:2}]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{backgroundColor:'#1e293b',borderColor:'#334155',borderWidth:1}},
        scales:{
          x:{ticks:{color:'#64748b',font:{size:10},maxTicksLimit:12,maxRotation:45},grid:{color:'rgba(51,65,85,.25)'}},
          y:{ticks:{color:'#64748b',font:{size:10}},grid:{color:'rgba(51,65,85,.25)'}}
        }
      }
    });
  }
}

function switchBarMetric(wid, metric) {
  const w = S.widgets.find(x=>x.id===wid); if (!w) return;
  w.metric = metric;
  // Re-render using cached data
  if (lastData[wid]) {
    const src = w.source || 'statistics';
    renderBarChart(w, lastData[wid], src);
  }
  silentSave();
}

/* ================================================================
   TABLE
================================================================ */
function renderTable(w, data, source) {
  const body = $('body-'+w.id); if (!body) return;
  if (!data || (Array.isArray(data) && !data.length)) {
    body.innerHTML = '<div class="no-data">Нет данных</div>'; return;
  }
  const arr = Array.isArray(data) ? data : [data];
  const maxRows = 500;
  const show = arr.slice(0, maxRows);
  const simple = isSimpleFormat(arr);

  let html;
  if (source === 'statistics' && simple && isWorkTimeTable(w.tableName)) {
    // Simple format {t,v} from WorkTime: v = work time in seconds, show time + duration table
    const periodSec = 43200; // 12 hours per period
    html = `<table class="data-table"><thead><tr><th>Дата/Время</th><th>Работа</th><th>Простой</th><th>Коэфф.</th></tr></thead><tbody>`;
    show.forEach(r => {
      const workSec = findStatVal(r, K_WORK) ?? 0;
      const idleSec = Math.max(0, periodSec - workSec);
      const coeff = periodSec > 0 ? ((workSec / periodSec) * 100).toFixed(1) + '%' : '—';
      html += `<tr><td>${esc(fmtTime(findKey(r,K_DATE)))}</td><td>${fmtDurationSec(workSec)}</td><td>${fmtDurationSec(idleSec)}</td><td>${coeff}</td></tr>`;
    });
    html += '</tbody></table>';
  } else if (source === 'statistics' && simple) {
    // Simple format {t,v} from AvgData or other: v = value, show time + value table
    html = `<table class="data-table"><thead><tr><th>Дата/Время</th><th>Значение</th></tr></thead><tbody>`;
    show.forEach(r => {
      const val = findStatVal(r, K_VALUE) ?? 0;
      html += `<tr><td>${esc(fmtTime(findKey(r,K_DATE)))}</td><td>${fmtNum(val)}</td></tr>`;
    });
    html += '</tbody></table>';
  } else if (source === 'statistics') {
    html = `<table class="data-table"><thead><tr><th>Дата</th><th>Tag ID</th><th>Ср. значение</th><th>Время работы</th><th>Период</th><th>Коэфф.</th></tr></thead><tbody>`;
    show.forEach(r => {
      const wt = findStatVal(r,K_WORK)??0;
      const pt = findStatVal(r,K_PERIOD)??0;
      const coeff = pt>0 ? ((wt/pt)*100).toFixed(1)+'%' : '—';
      html += `<tr><td>${esc(fmtTime(findKey(r,K_DATE)))}</td><td>${esc(String(findKey(r,K_TAGID)??''))}</td><td>${fmtNum(findStatVal(r,K_AVG))}</td><td>${fmtDuration(wt)}</td><td>${fmtDuration(pt)}</td><td>${coeff}</td></tr>`;
    });
    html += '</tbody></table>';
  } else {
    html = `<table class="data-table"><thead><tr><th>Дата/Время</th><th>ID</th><th>Значение</th></tr></thead><tbody>`;
    show.forEach(r => {
      html += `<tr><td>${esc(fmtTime(findKey(r,K_TIME)))}</td><td>${esc(String(findKey(r,K_TAGID)??''))}</td><td>${fmtNum(findKey(r,K_VALUE))}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  if (arr.length > maxRows) html += `<div class="table-footer">Показано ${maxRows} из ${arr.length} записей</div>`;
  body.innerHTML = html;
}

/* ================================================================
   CHART HELPERS
================================================================ */
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

/* ================================================================
   GLOBAL ACTIONS
================================================================ */
function applyGlobalRange() {
  const from=$('globalFrom').value, to=$('globalTo').value;
  if (!from||!to) { toast('Укажите период','error'); return; }
  // Reset all widget-local dates to global (transient, not saved)
  // Use raw input value for dateTo (seconds override is applied in fetchData via getToTimestamp)
  S.widgets.forEach(w => { w.dateFrom=from; w.dateTo=null; w.step=0; });
  // Stagger data loading
  S.widgets.forEach((w, i) => {
    setTimeout(() => fetchData(w), i * 150);
  });
  toast(`Период применён (шаг: ${autoStep(from, to)})`,'success');
}

function openSettings() {
  $('sServerUrl').value = S.serverUrl;
  $('sStepCoeff').value = S.stepCoefficient;
  $('sRefresh').value = S.refreshInterval;
  $('sPrintCols').value = S.printCols;
  openModal('settingsModal');
}

function saveSettings() {
  S.serverUrl = $('sServerUrl').value.trim().replace(/\/?$/, '/');
  S.stepCoefficient = parseInt($('sStepCoeff').value) || 4;
  S.refreshInterval = parseInt($('sRefresh').value) || 0;
  S.printCols = parseInt($('sPrintCols').value) || 2;
  updatePrintCols();
  startRefresh();
  loadSchema();  // Re-fetch schema when server URL changes
  silentSave(); updateStatus();
  closeModal('settingsModal');
  toast('Настройки сохранены','success');
}

function updatePrintCols() {
  // Update print CSS dynamically — set grid columns AND span rules
  let style = document.getElementById('printColsStyle');
  if (!style) { style = document.createElement('style'); style.id='printColsStyle'; document.head.appendChild(style); }
  const c = S.printCols;
  let css = `@media print {`;
  css += `#widgetsContainer { grid-template-columns: repeat(${c}, 1fr)!important; }`;
  // Generate span rules for all possible values up to c
  for (let i = 2; i <= c; i++) {
    if (i === c) {
      css += `.widget[data-colspan="${i}"] { grid-column: 1 / -1; }`;
    } else {
      css += `.widget[data-colspan="${i}"] { grid-column: span ${i}; }`;
    }
  }
  css += `.widget[data-rowspan="2"] { grid-row: span 2; }`;
  css += `.widget[data-rowspan="3"] { grid-row: span 3; }`;
  css += `}`;
  style.textContent = css;
}
updatePrintCols();

// Calculate column span for a widget based on its width relative to the dashboard
// Divide the screen into printCols equal parts. If widget spans all → colspan=printCols, etc.
function calcColSpan(w) {
  const area = $('dashboardArea');
  if (!area) return 1;
  const totalWidth = area.clientWidth - 32; // minus padding
  const cols = S.printCols || 3;
  const part = totalWidth / cols;
  if (part <= 0) return 1;
  // Check from largest to smallest span
  for (let span = cols; span >= 2; span--) {
    if (w.width >= part * (span - 0.5)) return span;
  }
  return 1;
}

// Calculate row span for a widget based on its height relative to a standard widget height
function calcRowSpan(w) {
  const baseHeight = 340; // default widget height
  if (w.height >= baseHeight * 2.5) return 3;
  if (w.height >= baseHeight * 1.5) return 2;
  return 1;
}

// Update data-colspan/data-rowspan attributes on all widgets (for print CSS)
function updateWidgetSpans() {
  S.widgets.forEach(w => {
    const el = $(w.id);
    if (el) {
      el.setAttribute('data-colspan', calcColSpan(w));
      el.setAttribute('data-rowspan', calcRowSpan(w));
    }
  });
}

function startRefresh() {
  if (refreshTmr) { clearInterval(refreshTmr); refreshTmr=null; }
  if (S.refreshInterval > 0) {
    refreshTmr = setInterval(() => S.widgets.forEach(w=>fetchData(w)), S.refreshInterval*1000);
  }
}

/* ================================================================
   MODALS
================================================================ */
function openModal(id) { $(id).classList.add('active'); }
function closeModal(id) { $(id).classList.remove('active'); }

/* ================================================================
   TOAST
================================================================ */
function toast(msg, type='info') {
  const c = $('toasts'), el = document.createElement('div');
  el.className = 'toast '+type;
  const icons = {success:'✓',error:'✕',info:'ℹ'};
  el.innerHTML = `<span>${icons[type]||'ℹ'}</span> ${esc(msg)}`;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 2500);
}
