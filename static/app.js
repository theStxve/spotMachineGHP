// ── CONFIG & STATE ──
const state = {
  dataLoaded: false,
  years: [],
  artists: [],
  lastfmKey: localStorage.getItem('lastfmKey') || '',
  lastfmUser: localStorage.getItem('lastfmUser') || '',
  settings: JSON.parse(localStorage.getItem('settings') || '{"genreTags":true,"similarSongs":false,"artistInfo":false,"trackStats":false}'),
  // Jahre, die dauerhaft aus allen Auswertungen herausgenommen werden
  // (globale Ausschlussliste - wie artist_blacklist, nur für Jahrgänge).
  excludedYears: [],
  lastResults: [],
  lastYear: null,
  tabCache: {},
  activeTab: 'recommend',
  charts: {},
  skipData: [],
  skipSort: { col: 'skip_rate', asc: false }
};

// ── GLOBALE JAHRES-INTEGRATION (years_excluded) ─────────────────────────────────
// Die globalen Jahre waren bisher nur eine Mehrfach-Auswahl über die Chips.
// Mit years_excluded wird ein Jahr dauerhaft aus ALLEN Auswertungen rausgenommen.
// Die Dropdowns der Tabs zeigen immer nur noch die Jahre, die nicht ausgeschlossen
// sind; beim Auswählen eines Jahres wird es sofort in diese Liste aufgenommen.

function excludedYearSet() {
  const out = new Set();
  (state.excludedYears || []).forEach(function (y) {
    const n = Number(y);
    if (Number.isFinite(n)) out.add(n);
  });
  return out;
}

function availableYears() {
  return (state.years || []).filter(function (y) { return !excludedYearSet().has(Number(y)); });
}

function fillYearSelect(id, years, includeAll) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const opts = years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join('');
  sel.innerHTML = (includeAll ? '<option value="all">Alle</option>' : '') + opts;
}

// Alle Tab-Jahres-Dropdowns neu befüllen (verfügbare Jahre = alle Jahre - ausgeschlossen)
function refreshYearDropdowns() {
  const years = availableYears();
  const optsAll = '<option value="all">Alle</option>' + years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join('');
  const opts = years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join('');
  const drops = {
    'rec-year': opts,
    'tops-year': optsAll,
    'heat-year': optsAll,
    'skip-year': optsAll,
    'disc-year': opts,
    'monthly-year': optsAll,
    'sessions-year': optsAll,
    'platforms-year': optsAll,
    'behavior-year': optsAll,
    'albums-year': optsAll,
    'comp-y1': opts,
    'comp-y2': opts,
    'pl-year-select': opts
  };
  for (const id in drops) {
    if (drops.hasOwnProperty(id)) {
      const el = document.getElementById(id);
      if (el) {
        const curVal = el.value;
        el.innerHTML = drops[id];
        if (curVal && (curVal === 'all' || years.includes(Number(curVal)) || years.includes(String(curVal)))) {
          el.value = curVal;
        }
      }
    }
  }
}

// Pro Tab ein Change-Handler: Wenn der Nutzer im Tab ein Jahr auswählt, wird dieser Tab aktualisiert
function bindYearDropdowns() {
  document.getElementById("tops-year")?.addEventListener("change", () => loadTopSongs());
  document.getElementById("heat-year")?.addEventListener("change", () => document.getElementById("heat-btn")?.click());
  document.getElementById("skip-year")?.addEventListener("change", () => document.getElementById("skip-btn")?.click());
  document.getElementById("disc-year")?.addEventListener("change", () => document.getElementById("disc-btn")?.click());
  document.getElementById("monthly-year")?.addEventListener("change", () => loadMonthly());
  document.getElementById("sessions-year")?.addEventListener("change", () => loadSessions());
  document.getElementById("platforms-year")?.addEventListener("change", () => loadPlatforms());
  document.getElementById("albums-year")?.addEventListener("change", () => loadAlbums());
  document.getElementById("behavior-year")?.addEventListener("change", () => document.getElementById("behavior-btn")?.click());
}

function isExcludedYear(year) {
  return excludedYearSet().has(Number(year));
}

// Exklusion speichern (in Settings: years_excluded) und Tabs neu rendern
async function applyYearExclusion(years, toastMsg) {
  showLoader('Wende Jahres-Ausschluss an...');
  try {
    const res = await saveSettings({ years_excluded: years });
    hideLoader();
    if (res.year_exclusion) renderYearExclusion(res.year_exclusion);
    refreshTabsAfterFilter();
    refreshYearDropdowns();
    if (toastMsg) showToast(toastMsg);
    else showToast((years.length ? years.length + ' Jahrgang' + (years.length === 1 ? '' : 'e') + ' ausgeschlossen — ' : '') + (res.total_streams || 0).toLocaleString() + ' Streams');
    return true;
  } catch (e) {
    hideLoader();
    alert('Fehler beim Ausschluss: ' + e.message);
    return false;
  }
}

// ── ICON HELPER ──
function icon(name, cls = "") {
  const el = document.createElement("span");
  el.innerHTML = `<i data-lucide="${name}" class="${cls}"></i>`;
  lucide.createIcons({ nodes: el.querySelectorAll("[data-lucide]") });
  return el.querySelector("svg")?.outerHTML ?? "";
}

// ── SHARED HELPERS ──
function showLoader(txt="Lade...") { document.getElementById("loader-text").textContent=txt; document.getElementById("loader").classList.remove("hidden"); }
function hideLoader() { document.getElementById("loader").classList.add("hidden"); }
function copyText(txt, btn) {
  navigator.clipboard.writeText(txt);
  const old = btn.innerHTML;
  btn.innerHTML = icon("check");
  setTimeout(()=> btn.innerHTML=old, 1500);
}

// ── API HELPERS ──
async function apiCall(url, method="GET", body=null) {
  const opts = { method };
  if(body) { opts.headers = {"Content-Type":"application/json"}; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  return res.json();
}

// ── ROUTER ──
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
    btn.classList.add("active");
    state.activeTab = btn.dataset.tab;
    document.getElementById(`panel-${state.activeTab}`).classList.remove("hidden");
    
    // Auto-fetch logic
    if (state.activeTab === 'artists' && state.artists.length === 0) loadArtists();
    // Der Top-Songs-Tab lädt beim ersten Öffnen selbst - das ist die
    // einfachste Liste und soll ohne Klick da stehen.
    if (state.activeTab === 'topsongs' && !state.topSongs) loadTopSongs();
    if (state.activeTab === 'monthly') loadMonthly();
    if (state.activeTab === 'sessions') loadSessions();
    if (state.activeTab === 'platforms') loadPlatforms();
    if (state.activeTab === 'albums') loadAlbums();
    if (state.activeTab === 'discover') loadDiscoverTimeline();
    if (state.activeTab === 'behavior') document.getElementById('behavior-btn').click();
    if (state.activeTab === 'searches') loadSearchesTab();
    if (state.activeTab === 'inferences') loadInferencesTab();
    if (state.activeTab === 'library') loadLibraryTab();
    if (state.activeTab === 'marquee') loadMarqueeTab();
    if (state.activeTab === 'profile') loadProfileTab();
    if (state.activeTab === 'wrapped') loadWrappedTab();
  });
});

async function loadArtists() {
    const data = await apiCall("/api/artists");
    if(data.error) return;
    state.artists = data;
    document.getElementById("artists-list").innerHTML = data.map(a => `<option value="${a}">`).join("");
}

/**
 * Die Jahres-Auswahl liegt jetzt global ueber allen Tabs. `state.years` sind
 * die Jahre im aktuellen Datensatz, `state.yearScope` beschreibt die globale
 * Auswahl. Die Vergleichs-Dropdowns bekommen nur noch die sichtbaren Jahre.
 */
function updateYearSelects() {
    refreshYearDropdowns();
    const scope = state.yearScope || { selected: state.years, all: true, counts: {} };
    const pool = scope.all ? state.years : scope.selected;
    const opts = pool.map(y => `<option value="${y}">${y}</option>`).join("");
    const y1 = document.getElementById("comp-y1");
    const y2 = document.getElementById("comp-y2");
    const prev1 = y1 ? y1.value : null;
    const prev2 = y2 ? y2.value : null;
    if (y1) y1.innerHTML = opts;
    if (y2) y2.innerHTML = opts;
    // Auswahl nur uebernehmen, wenn das Jahr noch im Pool liegt.
    if (y1 && pool.map(String).includes(prev1)) y1.value = prev1;
    if (y2 && pool.map(String).includes(prev2)) y2.value = prev2;
    renderYearChips();
    _initPlaylistYears();
}

/**
 * Zieljahr fuer die Empfehlungen: das juengste Jahr der globalen Auswahl.
 * Ohne Auswahl das juengste Jahr im Datensatz.
 */
function globalTargetYear() {
    const pool = state.yearScope && !state.yearScope.all && state.yearScope.selected.length
        ? state.yearScope.selected
        : state.years;
    const usable = (pool || []).filter(y => Number(y) <= new Date().getFullYear());
    return usable.length ? usable[usable.length - 1] : (pool && pool.length ? pool[pool.length - 1] : new Date().getFullYear());
}

/** Baut die globale Jahresleiste: Chips fuer alle Jahre plus "Alle". */
function renderYearChips() {
    const bar = document.getElementById("global-year-bar");
    const box = document.getElementById("year-chips");
    const hint = document.getElementById("year-bar-hint");
    if (!bar || !box) return;
    if (!state.years.length && !(state.yearScope && state.yearScope.available && state.yearScope.available.length)) {
        bar.style.display = "none";
        return;
    }
    bar.style.display = "flex";

    const scope = state.yearScope || { selected: state.years, all: true, counts: {}, streams: state.totalStreams || 0 };
    // Die Chips kommen aus year_scope.available - auch wenn gerade gefiltert
    // wird, muessen alle wahlbaren Jahre sichtbar bleiben.
    const available = (scope.available && scope.available.length) ? scope.available : state.years;
    const selected = new Set(scope.all ? available : scope.selected);
    const fmt = n => (n || 0).toLocaleString("de-DE");

    let html = `<button class="chip" data-year="__all" style="${scope.all ? "border-color:var(--green);color:var(--green);background:rgba(29,185,84,0.12);" : ""}">Alle</button>`;
    for (const y of available) {
        const on = !scope.all && selected.has(y);
        html += `<button class="chip" data-year="${y}" style="${on ? "border-color:var(--green);color:var(--green);background:rgba(29,185,84,0.12);" : ""}">${y}<span style="opacity:0.6;margin-left:0.3rem;font-size:0.72rem;">${fmt(scope.counts && scope.counts[y])}</span></button>`;
    }
    box.innerHTML = html;

    box.querySelectorAll(".chip").forEach(btn => {
        btn.addEventListener("click", () => toggleYear(btn.dataset.year));
    });
    if (hint) {
        hint.textContent = scope.all
            ? `${available.length} Jahre · ${fmt(state.totalStreams)} Streams`
            : `${selected.size} von ${available.length} Jahren · ${fmt(scope.streams)} Streams`;
    }
}

/** Klick auf einen Jahres-Chip: Solo, dazu oder wieder abwaehlen. */
function toggleYear(year) {
    const scope = state.yearScope || { selected: state.years, all: true };
    const available = (scope.available && scope.available.length) ? scope.available : state.years;
    let next;
    if (year === "__all") {
        next = [];
    } else {
        const current = scope.all ? available : scope.selected;
        const picked = new Set(current);
        if (picked.has(Number(year))) picked.delete(Number(year));
        else picked.add(Number(year));
        next = Array.from(picked).sort((a, b) => a - b);
        // Alle Jahre wieder angewaehlt ergibt wieder "alle".
        if (next.length === available.length) next = [];
    }
    applyGlobalYears(next);
}

/** Setzt die globalen Jahre und laedt die betroffenen Tabs neu. */
async function applyGlobalYears(years) {
    state.yearScope = { ...(state.yearScope || {}), selected: years.length ? years : state.years, all: !years.length, pending: true };
    renderYearChips();
    showLoader("Jahre werden angewendet...");
    const res = await apiCall("/api/settings", "POST", { years });
    hideLoader();
    if (res && res.error) {
        state.yearScope = { ...state.yearScope, pending: false };
        showToast("Jahre konnten nicht gesetzt werden", "error");
        renderYearChips();
        return;
    }
    if (res && res.total_streams !== undefined) {
        state.totalStreams = res.total_streams;
        state.years = res.years || state.years;
        state.yearScope = res.year_scope || state.yearScope;
        state.yearScope.pending = false;
    }
    updateYearSelects();
    refreshYearDropdowns();
    refreshActiveTab();
    showToast(state.yearScope.all ? "Alle Jahre aktiv" : `${state.yearScope.selected.length} Jahre aktiv`);
}

/** Laedt den gerade sichtbaren Tab neu, weil sich der Datenbestand geaendert hat. */
function refreshActiveTab() {
    const tab = state.activeTab;
    const reload = {
        overview: loadArtists,
        topsongs: loadTopSongs,
        heatmap: loadHeatmap,
        skips: loadSkips,
        discover: loadDiscoverTimeline,
        monthly: loadMonthly,
        sessions: loadSessions,
        platforms: loadPlatforms,
        albums: loadAlbums,
    };
    const fn = reload[tab];
    if (typeof fn === "function") fn();
    else if (tab === "recommend") loadRecForm();
    else if (tab === "compare") loadCompare();
    else if (tab === "behavior") document.getElementById("behavior-btn").click();
}

// ── MODULE: Upload ──
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileList = document.getElementById("file-list");
const uploadBtn = document.getElementById("upload-btn");
let pendingFiles = [];

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    handleSelectedFiles(await collectDroppedFiles(e.dataTransfer));
});
fileInput.addEventListener("change", () => handleSelectedFiles([...fileInput.files]));

/**
 * Sammelt Dateien aus einem Drop. Ordner werden rekursiv durchlaufen - ein
 * blosses dataTransfer.files enthaelt bei einem Ordner nichts.
 */
async function collectDroppedFiles(dt) {
    const items = dt.items ? [...dt.items] : [];
    const entries = items
        .map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
    if (!entries.length) return [...dt.files];

    const out = [];
    async function walk(entry) {
        if (entry.isFile) {
            const file = await new Promise((res, rej) => entry.file(res, rej));
            if (file) out.push(file);
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            // readEntries liefert hoechstens 100 Eintraege pro Aufruf
            for (;;) {
                const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                if (!batch.length) break;
                for (const child of batch) await walk(child);
            }
        }
    }
    for (const entry of entries) await walk(entry);
    return out.length ? out : [...dt.files];
}

function handleSelectedFiles(files) {
    const wanted = files.filter(f => f.name.endsWith(".zip") || f.name.endsWith(".json"));
    // Aus entpackten Ordnern kommen die Dateien mit vollem Pfad - nur der
    // Name zaehlt fuer die Anzeige.
    pendingFiles = wanted.map(f => {
        if (f.name && !f.name.includes("/") && !f.name.includes("\\")) return f;
        const base = (f.webkitRelativePath || f.name || "").split(/[\\/]/).pop();
        return new File([f], base, { type: f.type });
    });
    if (!pendingFiles.length) return;
    fileList.innerHTML = pendingFiles.map(f => `
        <span class="tag-pill" style="padding:0.3rem 0.6rem; font-size:0.8rem;">
            ${icon("file-text")} ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)
        </span>
    `).join("");
    fileList.classList.remove("hidden");
    uploadBtn.classList.remove("hidden");
    lucide.createIcons();
}

uploadBtn.addEventListener("click", async () => {
    const filesToUpload = pendingFiles.length > 0 ? pendingFiles : fileInput.files;
    if(!filesToUpload.length) return;
    showLoader("Lade hoch & verarbeite...");
    const fd = new FormData();
    for(let f of filesToUpload) fd.append("files", f);
    try {
        const res = await fetch("/upload", {method:"POST", body:fd});
        const data = await res.json();
        hideLoader();
        if(data.error) return alert(data.error);
        state.years = data.years;
        state.totalStreams = data.total_streams;
        if(data.year_scope) state.yearScope = data.year_scope;
        state.dataLoaded = true;
        if(data && data.account_status) state.accountStatus = data.account_status;
        updateYearSelects();
        document.getElementById("upload-section").classList.add("hidden");
        document.getElementById("tab-nav").classList.remove("hidden");
        document.getElementById("panel-recommend").classList.remove("hidden");
        updateHeaderSyncBtn();
        applyQuality(data.quality);
        if(data.media) applyMediaInfo(data.media);
        if(data.blacklist) renderBlacklist(data.blacklist);
        lucide.createIcons();
    } catch(err) {
        hideLoader();
        alert("Fehler beim Hochladen: " + err.message);
    }
});

// ── MODULE: Zwischenspeicherung ──
// Der Cache wird nie von selbst geladen: er liegt pro Browser, nicht pro
// Nutzer. Auf einem geteilten Rechner wuerde sonst die naechste Person die
// Daten des Vorherigen sehen. Deshalb wird gefragt.
window.addEventListener("wkmm:cache-found", (e) => {
    const info = e.detail;
    const box = document.getElementById("cache-offer");
    if(!box || !info) return;
    const when = info.savedAt ? new Date(info.savedAt).toLocaleString("de-DE") : "unbekannt";
    const files = (info.fileNames || []).slice(0, 3).join(", ");
    document.getElementById("cache-offer-text").innerHTML =
        `In diesem Browser liegen ${info.n.toLocaleString()} Streams vom ${when}` +
        `${files ? ` (${files}${info.fileNames.length > 3 ? ", …" : ""})` : ""}. ` +
        `<strong>Gehören die dir?</strong> Wenn nicht, bitte verwerfen.`;
    box.classList.remove("hidden");
    lucide.createIcons();
});

document.getElementById("cache-use-btn")?.addEventListener("click", async () => {
    showLoader("Lade gespeicherte Daten...");
    try {
        const res = await apiCall("/api/cache/restore", "POST", {});
        hideLoader();
        if(!res.success) return alert("Gespeicherte Daten konnten nicht geladen werden.");
        document.getElementById("cache-offer").classList.add("hidden");
        showToast(`${res.total_streams.toLocaleString()} Streams geladen`);
        await checkExistingSession();
    } catch(e) {
        hideLoader();
        alert("Laden fehlgeschlagen: " + e.message);
    }
});

document.getElementById("cache-drop-btn")?.addEventListener("click", async () => {
    await apiCall("/api/cache/clear", "POST", {});
    document.getElementById("cache-offer").classList.add("hidden");
    showToast("Zwischenspeicherung gelöscht");
});

document.getElementById("cache-wipe-btn")?.addEventListener("click", async () => {
    const res = await apiCall("/api/cache/clear", "POST", {});
    showToast(res.success ? "Zwischenspeicherung gelöscht" : "Löschen fehlgeschlagen");
});

// ── MODULE: Einstellungen (Zeitzone, Medienfilter, Profilname) ──
async function loadSettings() {
  const s = await apiCall("/api/settings");
  state.settingsTz = s.tz_mode;
  const tz = document.getElementById("toggle-tz-local");
  if(tz) tz.checked = s.tz_mode === "local";
  const prof = document.getElementById("profile-name");
  if(prof) prof.value = s.profile || "";
  const om = document.getElementById("toggle-only-music");
  if(om) om.checked = !!s.only_music;
  applyMediaInfo(s.media);
  renderBlacklist(s.blacklist || { names: [], matched: [], unknown: [] });
  if (s.year_exclusion) renderYearExclusion(s.year_exclusion);
  if (s.years && s.years.length) {
    state.years = s.years;
    refreshYearDropdowns();
  }
  updateTzHint();
}

function applyMediaInfo(media) {
    const hint = document.getElementById("media-hint");
    if(!hint || !media) return;
    if(!media.hidden) {
        hint.textContent = "nur Musik in den Daten";
        return;
    }
    const pct = media.total ? (media.hidden / media.total * 100) : 0;
    hint.textContent = `${media.podcast} Podcasts, ${media.audiobook} Hörbücher (${pct.toFixed(1)} %)`;
}

// ── MODULE: Artist-Blacklist ──
// Gesperrte Artists fliegen aus allen Auswertungen, nicht nur aus einem Tab.
function renderBlacklist(info) {
    state.blacklist = info || state.blacklist;
    const bl = state.blacklist;
    const box = document.getElementById("blacklist-chips");
    const hint = document.getElementById("blacklist-hint");
    if(!box) return;
    if(!bl || !bl.names || !bl.names.length) {
        box.innerHTML = '<span style="font-size:0.78rem;color:var(--muted);">Keine Artists gesperrt.</span>';
        if(hint) hint.textContent = "";
        return;
    }
    box.innerHTML = bl.names.map((name, i) => {
        const cls = bl.unknown.includes(name) ? "unknown" : "";
        const title = bl.unknown.includes(name) ? "kommt in deinen Daten nicht vor" : "gesperrt";
        return `<span class="tag-pill ${cls}" title="${title}"
            style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.25rem 0.5rem;font-size:0.78rem;">
            ${name.replace(/[<>&]/g,'')}
            <i data-lucide="x" data-bl-remove="${i}" style="width:11px;height:11px;cursor:pointer;"></i>
        </span>`;
    }).join("");
    box.querySelectorAll("[data-bl-remove]").forEach(el => {
        el.addEventListener("click", () => removeFromBlacklist(Number(el.dataset.blRemove)));
    });
    if(hint) {
        const parts = [];
        if(bl.artists_hidden) parts.push(`${bl.artists_hidden} Artists / ${bl.streams_hidden.toLocaleString()} Streams raus`);
        if(bl.unknown.length) parts.push(`${bl.unknown.length} ohne Treffer`);
        hint.textContent = parts.join(" · ");
    }
    lucide.createIcons();
}

async function addToBlacklist(name) {
    const clean = String(name || "").trim();
    if(!clean) return;
    const current = ((state.blacklist && state.blacklist.names) || []).slice();
    current.push(clean);
    await applyBlacklist(current, `${clean} gesperrt`);
}

async function removeFromBlacklist(index) {
    const current = (((state.blacklist && state.blacklist.names) || []).slice());
    const removed = current.splice(index, 1)[0];
    await applyBlacklist(current, `${removed} wieder freigegeben`);
}

async function renderYearExclusion(info) {
  state.excludedYears = info.excluded || [];
  const box = document.getElementById("years-excluded-chips");
  const hint = document.getElementById("years-excluded-hint");
  if (!box || !hint) return;
  if (!info.excluded || !info.excluded.length) {
    box.innerHTML = '<span style="font-size:0.78rem;color:var(--muted);">Keine Jahre ausgeschlossen.</span>';
    hint.textContent = "";
    return;
  }
  box.innerHTML = info.excluded.map(function (y, i) {
    return '<span class="tag-pill" style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.25rem 0.5rem;font-size:0.78rem;">' +
      y +
      '<i data-lucide="x" data-yex-remove="' + i + '" style="width:11px;height:11px;cursor:pointer;"></i></span>';
  }).join("");
  box.querySelectorAll("[data-yex-remove]").forEach(function (el) {
    el.addEventListener("click", function () { removeFromYearExclusion(Number(el.dataset.yexRemove)); });
  });
  hint.textContent = info.years_hidden + " Jahrgang" + (info.years_hidden === 1 ? "" : "e") + " raus · " + (info.streams_hidden || 0).toLocaleString() + " Streams";
  lucide.createIcons();
}

async function removeFromYearExclusion(index) {
  const current = ((state.excludedYears || []).slice());
  const removed = current.splice(index, 1)[0];
  await applyYearExclusion(current, `${removed} wieder eingeschlossen`);
}

document.getElementById("years-excluded-add-btn")?.addEventListener("click", async () => {
  const input = document.getElementById("years-excluded-input");
  const year = Number(input.value);
  if (!Number.isFinite(year)) return;
  const current = (state.excludedYears || []).slice();
  if (current.indexOf(year) !== -1) {
    showToast("Dieses Jahr ist bereits ausgeschlossen.", "info");
    return;
  }
  current.push(year);
  await applyYearExclusion(current, `${year} als ausgeschlossen markiert`);
  input.value = "";
});

document.getElementById("years-excluded-input")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const input = e.target;
  const year = Number(input.value);
  if (!Number.isFinite(year)) return;
  const current = (state.excludedYears || []).slice();
  if (current.indexOf(year) !== -1) {
    showToast("Dieses Jahr ist bereits ausgeschlossen.", "info");
    return;
  }
  current.push(year);
  applyYearExclusion(current).then(() => { input.value = ""; });
});



async function applyBlacklist(names, toastMsg) {
    showLoader("Wende Blacklist an...");
    try {
        const res = await saveSettings({ artist_blacklist: names });
        hideLoader();
        renderBlacklist(res.blacklist);
        refreshTabsAfterFilter();
        if(toastMsg) showToast(`${toastMsg} — ${res.total_streams.toLocaleString()} Streams`);
    } catch(e) {
        hideLoader();
        alert("Speichern fehlgeschlagen: " + e.message);
    }
}

document.getElementById("blacklist-add-btn")?.addEventListener("click", () => {
    const input = document.getElementById("blacklist-input");
    addToBlacklist(input.value).then(() => { if(input) input.value = ""; });
});

document.getElementById("blacklist-input")?.addEventListener("keydown", (e) => {
    if(e.key !== "Enter") return;
    e.preventDefault();
    const input = e.target;
    addToBlacklist(input.value).then(() => { input.value = ""; });
});

function updateTzHint() {
    const hint = document.getElementById("tz-hint");
    if(!hint) return;
    const local = state.settingsTz === "local";
    const zone = (window.Intl && Intl.DateTimeFormat)
        ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
    hint.textContent = local ? (zone || "lokal") : "UTC";
}

async function saveSettings(patch, onDone) {
    // Die IANA-Zone des Browsers mitschicken. Python kann die Systemzeitzone
    // unter Windows nicht zuverlaesig ermitteln, der Browser aber schon.
    const zone = (window.Intl && Intl.DateTimeFormat)
        ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
    const res = await apiCall("/api/settings", "POST", { ...patch, tz: zone });
    if(res.settings) {
        state.settingsTz = res.settings.tz_mode;
        updateTzHint();
    }
    if(res.media) applyMediaInfo(res.media);
    if(res.blacklist) renderBlacklist(res.blacklist);
    if(res.total_streams !== undefined) state.totalStreams = res.total_streams;
    if(res.year_scope) state.yearScope = res.year_scope;
            if(res.account_status) state.accountStatus = res.account_status;
    if(res.years && res.years.length) {
        state.years = res.years;
        updateYearSelects();
        refreshYearDropdowns();
    }
    if (res.year_exclusion) state.excludedYears = res.year_exclusion.excluded || [];
    if (res.excludedYears) state.excludedYears = res.excludedYears;
    if(res.cache_saved === false) {
        showToast("Hinweis: Zwischenspeicherung nicht möglich (Speicherplatz)");
    }
    if(typeof onDone === "function") onDone(res);
    return res;
}

/** Nach einem Filterwechsel: offene Tabs neu laden, damit die Zahlen passen. */
function refreshTabsAfterFilter() {
    state.tabCache = {};
    document.querySelector(`.tab-btn[data-tab="${state.activeTab}"]`)?.click();
}

document.getElementById("toggle-only-music")?.addEventListener("change", async (e) => {
    showLoader(e.target.checked ? "Blende Podcasts und Hörbücher aus..." : "Ganzes Dataset...");
    try {
        const res = await saveSettings({ only_music: e.target.checked });
        hideLoader();
        refreshTabsAfterFilter();
        const m = res.media || {};
        showToast(e.target.checked
            ? `Nur Musik — ${(m.music || 0).toLocaleString()} Streams`
            : `Alle Medien — ${(m.total || 0).toLocaleString()} Streams`);
    } catch(err) {
        hideLoader();
        alert("Umschalten fehlgeschlagen: " + err.message);
    }
});

document.getElementById("toggle-tz-local")?.addEventListener("change", async (e) => {
    showLoader("Wende Zeitzone an...");
    try {
        await saveSettings({ tz_mode: e.target.checked ? "local" : "utc" });
        hideLoader();
        refreshTabsAfterFilter();
        showToast(e.target.checked
            ? "Auswertung läuft jetzt in lokaler Zeit"
            : "Auswertung läuft wieder in UTC");
    } catch(err) {
        hideLoader();
        alert("Umschalten fehlgeschlagen: " + err.message);
    }
});

document.getElementById("profile-name")?.addEventListener("change", async (e) => {
    await saveSettings({ profile: e.target.value });
    showToast("Name gespeichert");
});

document.getElementById("settings-open")?.addEventListener("click", loadSettings);

// ── MODULE: Top Songs ──
// Die reine Bestenliste. "Empfehlungen" mischt Songs des Zieljahres mit
// Treffern aus anderen Jahren - das ist eine Empfehlung, keine Rangliste.
async function loadTopSongs() {
    // "all" heisst: alles, was der globale Jahresfilter freigibt.
    const year = document.getElementById("tops-year").value;
    const sort = document.getElementById("tops-sort").value;
    const limit = document.getElementById("tops-limit").value;
    showLoader("Bestenliste wird berechnet...");
    try {
        const data = await apiCall(`/api/top_songs?year=${year}&sort=${sort}&limit=${limit}`);
        hideLoader();
        if(data.error) return alert(data.error);
        state.topSongs = data;
        renderTopSongs();
        document.getElementById("tops-results").classList.remove("hidden");
        lucide.createIcons();
    } catch(e) {
        hideLoader();
        alert("Fehler: " + e.message);
    }
}

function renderTopSongs() {
    const data = state.topSongs;
    if(!data) return;
    const filterTxt = (document.getElementById("tops-filter").value || "").toLowerCase();
    const all = data.songs || [];
    const shown = filterTxt
        ? all.filter(s => (s.track||"").toLowerCase().includes(filterTxt)
                      || (s.artist||"").toLowerCase().includes(filterTxt)
                      || (s.album||"").toLowerCase().includes(filterTxt))
        : all;

    // Kennzahlen
    const uniqueArtists = new Set(all.map(s => s.artist)).size;
    const totalPlays = all.reduce((a,s) => a + s.play_count, 0);
    document.getElementById("tops-stat-cards").innerHTML = `
        <div class="stat-card"><h4>Streams im Zeitraum</h4><div class="val">${data.total_streams.toLocaleString()}</div></div>
        <div class="stat-card"><h4>Verschiedene Songs</h4><div class="val">${data.total_songs.toLocaleString()}</div></div>
        <div class="stat-card"><h4>Hörzeit</h4><div class="val">${data.total_hours.toLocaleString()} h</div></div>
        <div class="stat-card"><h4>Artists in der Liste</h4><div class="val">${uniqueArtists.toLocaleString()}</div></div>`;

    const pct = data.total_streams ? (totalPlays / data.total_streams * 100) : 0;
    document.getElementById("tops-summary").innerHTML = filterTxt
        ? `<strong>${shown.length}</strong> von ${all.length} Songs nach Filter „${filterTxt.replace(/[<>&]/g,'')}"`
        : `Die Top ${all.length} Songs decken <strong>${pct.toFixed(1)} %</strong> aller Streams ab.`;

    if(!shown.length) {
        document.getElementById("tops-list").innerHTML =
            '<div style="padding:2rem;text-align:center;color:var(--muted);">Keine Songs gefunden.</div>';
        return;
    }

    const maxPlays = Math.max(...shown.map(s => s.play_count), 1);
    const maxMin = Math.max(...shown.map(s => s.total_minutes), 1);
    const esc = (s) => String(s==null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    const safe = (s) => String(s==null ? '' : s).split("'").join("\\'");

    document.getElementById("tops-list").innerHTML = shown.map(s => {
        const skipPct = (s.skip_rate * 100).toFixed(0);
        const donePct = (s.completion_rate * 100).toFixed(0);
        const skipColor = s.skip_rate > 0.7 ? '#e5534b' : s.skip_rate > 0.4 ? '#f9c22e' : 'var(--green)';
        const playBar = Math.max(2, (s.play_count / maxPlays * 100)).toFixed(0);
        const minBar = Math.max(2, (s.total_minutes / maxMin * 100)).toFixed(0);
        return `
        <div style="display:flex;align-items:center;gap:0.85rem;padding:0.65rem 0.5rem;border-bottom:1px solid var(--border);border-radius:6px;transition:background 0.15s;"
             onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''"
             onclick="openSongDetail('${safe(s.track)}','${safe(s.artist)}')">
            <div style="width:26px;text-align:right;font-weight:800;color:var(--muted);font-size:0.9rem;flex-shrink:0;">${s.rank}</div>
            <div style="flex:1;min-width:0;overflow:hidden;">
                <div style="font-size:0.9rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.track)}</div>
                <div style="font-size:0.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.artist)}${s.album ? " · " + esc(s.album) : ""}</div>
                <div style="margin-top:0.35rem;height:3px;background:var(--border);border-radius:2px;display:flex;gap:2px;">
                    <div style="height:3px;border-radius:2px;background:var(--green);opacity:0.75;width:${playBar}%;"></div>
                    <div style="height:3px;border-radius:2px;background:var(--similar);opacity:0.55;width:${minBar}%;"></div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.9rem;flex-shrink:0;font-size:0.82rem;">
                <div style="text-align:center;min-width:40px;">
                    <div style="font-weight:700;color:var(--text);font-size:0.95rem;">${s.play_count}</div>
                    <div style="font-size:0.7rem;color:var(--muted);">plays</div>
                </div>
                <div style="text-align:center;min-width:52px;">
                    <div style="color:var(--text);">${s.total_minutes.toLocaleString()}</div>
                    <div style="font-size:0.7rem;color:var(--muted);">min</div>
                </div>
                <div style="text-align:center;min-width:44px;">
                    <div style="color:var(--text);">${s.avg_minutes.toFixed(1)}</div>
                    <div style="font-size:0.7rem;color:var(--muted);">ø/play</div>
                </div>
                <div style="text-align:center;min-width:38px;">
                    <div style="font-weight:700;color:${skipColor};">${skipPct}%</div>
                    <div style="font-size:0.7rem;color:var(--muted);">skip</div>
                </div>
                <div style="text-align:center;min-width:38px;">
                    <div style="color:var(--text);">${donePct}%</div>
                    <div style="font-size:0.7rem;color:var(--muted);">fertig</div>
                </div>
                ${s.spotify_url ? `<a href="${s.spotify_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
                    style="display:flex;align-items:center;color:var(--green);" title="In Spotify öffnen">
                    <i data-lucide="external-link" style="width:13px;height:13px;"></i></a>` : ""}
                <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--border);"></i>
            </div>
        </div>`;
    }).join("");
    lucide.createIcons();
}

document.getElementById("tops-btn")?.addEventListener("click", loadTopSongs);
document.getElementById("tops-filter")?.addEventListener("input", renderTopSongs);
document.getElementById("tops-csv-btn")?.addEventListener("click", async () => {
    const data = state.topSongs;
    if(!data || !data.songs || !data.songs.length) return alert("Keine Daten zum Kopieren.");
    const head = "Platz;Titel;Artist;Album;Plays;Minuten;O Min pro Play;Skip %;Zu Ende %;Score;Spotify";
    const lines = data.songs.map(s => [
        s.rank, s.track, s.artist, s.album, s.play_count,
        String(s.total_minutes).replace(".", ","),
        String(s.avg_minutes).replace(".", ","),
        (s.skip_rate * 100).toFixed(1).replace(".", ","),
        (s.completion_rate * 100).toFixed(1).replace(".", ","),
        String(s.engagement_score).replace(".", ","),
        s.spotify_url || ""
    ].join(";"));
    copyText([head, ...lines].join("\n"), document.getElementById("tops-csv-btn"));
    showToast("Bestenliste als CSV kopiert");
});

// ── MODULE: Datenqualität (auffällige Zeitstempel) ──
function applyQuality(q) {
    state.quality = q || null;
    const box = document.getElementById("data-quality-box");
    if(!box) return;
    if(!q || !q.has_outliers) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const years = (q.detail||[]).map(o => `${o.year} (${o.count} Streams)`).join(", ");
    document.getElementById("quality-badge").textContent = q.include_outliers ? "entfernt" : `${q.dropped} ausgeschlossen`;
    document.getElementById("quality-text").innerHTML =
        `In deiner Datei stecken Streams mit offenbar kaputten Zeitstempeln: ${years}. ` +
        `Sie wurden aus den Auswertungen herausgehalten${q.earliest ? ", frühester Jahrgang im Datensatz: " + q.earliest : ""}. ` +
        `Falls das doch echte Streams sind, kannst du sie unten einschalten.`;
    const toggle = document.getElementById("toggle-outliers");
    if(toggle) toggle.checked = !!q.include_outliers;
}

const outliersToggle = document.getElementById("toggle-outliers");
if(outliersToggle) {
    outliersToggle.addEventListener("change", async () => {
        showLoader("Wende Datenfilter an...");
        try {
            const res = await apiCall("/api/outliers", "POST", { include: outliersToggle.checked });
            hideLoader();
            if(res.error) return alert(res.error);
            state.years = res.years || state.years;
            if(res.total_streams !== undefined) state.totalStreams = res.total_streams;
            if(res.year_scope) state.yearScope = res.year_scope;
            if(res.account_status) state.accountStatus = res.account_status;
            updateYearSelects();
            applyQuality(res.quality);
            showToast(outliersToggle.checked
                ? `Auffällige Jahrgänge wieder aktiv (${res.total_streams.toLocaleString()} Streams)`
                : `Auffällige Jahrgänge entfernt (${res.total_streams.toLocaleString()} Streams)`);
            // Tabs neu laden, damit die Zahlen zur Anzeige passen
            state.tabCache = {};
            if(state.activeTab !== 'recommend') {
                document.querySelector(`.tab-btn[data-tab="${state.activeTab}"]`)?.click();
            }
        } catch(e) {
            hideLoader();
            alert("Umschalten fehlgeschlagen: " + e.message);
        }
    });
}

// ── MODULE: Settings & Live Sync ──
function updateHeaderSyncBtn() {
    const syncBtn = document.getElementById("header-sync-btn");
    if(syncBtn && state.dataLoaded && state.lastfmUser && state.lastfmKey) {
        syncBtn.classList.remove("hidden");
    } else if(syncBtn) {
        syncBtn.classList.add("hidden");
    }
}

async function refreshLatestStreamInfo() {
    const infoEl = document.getElementById("sync-latest-info");
    if(!infoEl) return;
    if(!state.dataLoaded) {
        infoEl.textContent = "Erst Spotify-Daten hochladen, um den Sync-Startpunkt zu bestimmen.";
        return;
    }
    const data = await apiCall("/api/lastfm/latest_stream");
    if(data && data.track) {
        infoEl.innerHTML = `Letzter bekannter Song:<br><strong style="color:var(--text);">${data.track}</strong> (${data.artist})<br><span style="color:var(--green); font-size:0.75rem;">Stand: ${data.timestamp_formatted}</span>`;
    } else {
        infoEl.textContent = "Kein bisheriger Stream im Speicher.";
    }
}

document.getElementById("settings-open").addEventListener("click", () => {
    document.getElementById("lastfm-user").value = state.lastfmUser;
    document.getElementById("lastfm-key").value = state.lastfmKey;
    document.getElementById("toggle-genre-tags").checked = state.settings.genreTags;
    document.getElementById("toggle-similar-songs").checked = state.settings.similarSongs;
    document.getElementById("toggle-artist-info").checked = state.settings.artistInfo;
    document.getElementById("toggle-track-stats").checked = state.settings.trackStats;
    updateTogglesState();
    refreshLatestStreamInfo();
    document.getElementById("settings-modal").classList.remove("hidden");
});

document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("settings-modal"))
        document.getElementById("settings-modal").classList.add("hidden");
});

function updateTogglesState() {
    const hasKey = !!document.getElementById("lastfm-key").value.trim();
    document.querySelectorAll(".toggle-row").forEach(r => {
        if(hasKey) r.classList.remove("disabled");
        else r.classList.add("disabled");
    });
}
document.getElementById("lastfm-key").addEventListener("input", updateTogglesState);

document.getElementById("lastfm-toggle").addEventListener("click", () => {
    const inp = document.getElementById("lastfm-key");
    const isHidden = inp.type === "password";
    inp.type = isHidden ? "text" : "password";
    const icon = document.getElementById("lastfm-toggle").querySelector("i");
    icon.setAttribute("data-lucide", isHidden ? "eye-off" : "eye");
    lucide.createIcons({ nodes: [icon] });
});

document.getElementById("settings-save").addEventListener("click", () => {
    const u = document.getElementById("lastfm-user").value.trim();
    const k = document.getElementById("lastfm-key").value.trim();
    state.lastfmUser = u;
    state.lastfmKey = k;
    localStorage.setItem('lastfmUser', u);
    localStorage.setItem('lastfmKey', k);
    state.settings = {
        genreTags: document.getElementById("toggle-genre-tags").checked,
        similarSongs: document.getElementById("toggle-similar-songs").checked,
        artistInfo: document.getElementById("toggle-artist-info").checked,
        trackStats: document.getElementById("toggle-track-stats").checked
    };
    localStorage.setItem('settings', JSON.stringify(state.settings));
    updateHeaderSyncBtn();
    document.getElementById("settings-modal").classList.add("hidden");
    document.getElementById("settings-status").textContent = "";
});

document.getElementById("lastfm-test").addEventListener("click", async () => {
    const k = document.getElementById("lastfm-key").value.trim();
    const statusEl = document.getElementById("settings-status");
    statusEl.textContent = "Teste...";
    const data = await apiCall("/api/lastfm/test", "POST", {key: k});
    statusEl.style.color = data.valid ? "var(--green)" : "#e5534b";
    statusEl.textContent = data.valid ? "Key ist gültig!" : "Ungültiger Key!";
    if(data.valid) updateTogglesState();
});

// Sync Execution Function
async function executeLastFmSync() {
    if(!state.dataLoaded) return alert("Bitte lade zuerst deine Grunddaten hoch!");
    const username = state.lastfmUser || (document.getElementById("lastfm-user") ? document.getElementById("lastfm-user").value.trim() : "");
    const key = state.lastfmKey || (document.getElementById("lastfm-key") ? document.getElementById("lastfm-key").value.trim() : "");

    if(!username || !key) {
        alert("Bitte trage in den Einstellungen zuerst deinen Last.fm Usernamen und API Key ein!");
        document.getElementById("settings-open").click();
        return;
    }

    showLoader("Synchronisiere neue Streams von Last.fm...");
    const res = await apiCall("/api/lastfm/sync", "POST", {username, key});
    hideLoader();

    if(res.error) {
        alert("Sync-Fehler: " + res.error);
        return;
    }

    if(res.years) {
        state.years = res.years;
        updateYearSelects();
    }

    // Reset caches so new songs reflect in tabs
    state.tabCache = {};
    state.artists = [];

    refreshLatestStreamInfo();
    const badge = document.getElementById("sync-status-badge");
    if(badge) {
        badge.textContent = `+${res.added_count} Streams`;
        badge.style.color = "var(--green)";
    }

    let detailMsg = res.message;
    if (res.added_count > 0 && res.recent_added && res.recent_added.length > 0) {
        detailMsg += "\n\nZuletzt hinzugefügt:\n" + res.recent_added.map(t => `• ${t.artist} - ${t.track}`).join("\n");
    } else if (res.added_count === 0) {
        detailMsg += "\n\nHinweis: Spotify übermittelt Songs an Last.fm erst NACHDEM sie zu Ende gehört wurden. Aktuell laufende Songs werden daher erst nach dem Trackende geloggt.";
    }
    alert(detailMsg);
}

document.getElementById("header-sync-btn")?.addEventListener("click", executeLastFmSync);
document.getElementById("modal-sync-btn")?.addEventListener("click", executeLastFmSync);

// ── MODULE: Recommendations ──
async function fetchLastFMTags(recs) {
    if(!state.lastfmKey || !state.settings.genreTags) return;
    const tracks = recs.slice(0,20).map(r => ({artist: r.artist, track: r.track}));
    const tags = await apiCall("/api/lastfm/tags", "POST", {key: state.lastfmKey, tracks});
    if(tags.error) return;
    
    const allTags = new Set();
    recs.slice(0,20).forEach((r, i) => {
        const t = tags[`${r.artist} — ${r.track}`];
        if(t && t.length) {
            r.tags = t;
            t.forEach(tag => allTags.add(tag));
            const div = document.querySelector(`.song-tags[data-id="${i}"]`);
            if(div) div.innerHTML = t.map(x => `<span class="tag-pill">${x}</span>`).join("");
        }
    });
    
    // Tag Filters
    const filterContainer = document.getElementById("rec-tag-filters");
    filterContainer.innerHTML = Array.from(allTags).map(t => `<span class="tag-pill filter-tag" data-tag="${t}">${t}</span>`).join("");
    document.querySelectorAll(".filter-tag").forEach(el => {
        el.addEventListener("click", () => {
            el.classList.toggle("active-filter");
            el.style.background = el.classList.contains("active-filter") ? "var(--green)" : "var(--surface2)";
            el.style.color = el.classList.contains("active-filter") ? "#000" : "var(--muted)";
            renderRecommendations();
        });
    });
}

async function fetchLastFMSimilarStats(recs) {
    if(!state.lastfmKey) return;
    
    // Similar Songs
    if(state.settings.similarSongs && recs.length > 0) {
        const top = recs.slice(0,5);
        for(let r of top) {
            const sim = await apiCall("/api/lastfm/similar", "POST", {artist: r.artist, track: r.track, key: state.lastfmKey, limit: 3});
            if(sim && sim.tracks) {
                sim.tracks.forEach(st => {
                    if(!recs.find(x => x.track === st.name && x.artist === st.artist)) {
                        recs.push({
                            track: st.name,
                            artist: st.artist,
                            play_count: 0,
                            total_minutes: 0,
                            engagement_score: 0,
                            source: 'lastfm_similar',
                            match_reason: 'Ähnlich via Last.fm',
                            is_similar: true
                        });
                    }
                });
            }
        }
        renderRecommendations(true); // render without re-fetching
    }
}

async function applyTrackStats() {
    if(!state.lastfmKey || !state.settings.trackStats) return;
    const cards = document.querySelectorAll(".song-card");
    for(let card of cards) {
        const i = card.dataset.id;
        if(i === undefined) continue;
        const r = state.lastResults[i];
        if(!r) continue;
        
        apiCall("/api/lastfm/track_stats", "POST", {artist: r.artist, track: r.track, key: state.lastfmKey}).then(stats => {
            if(stats && stats.listeners) {
                const statLine = document.createElement("div");
                statLine.className = "global-stats-line";
                statLine.textContent = `${Number(stats.listeners).toLocaleString()} Listeners · ${Number(stats.playcount).toLocaleString()} Scrobbles global`;
                card.querySelector(".song-info").appendChild(statLine);
            }
        });
    }
}

function renderRecommendations(skipFetch = false) {
    const sort = document.getElementById("rec-sort").value;
    const directOnly = document.getElementById("rec-direct-only").checked;
    let recs = [...state.lastResults];
    
    // Filter
    if(directOnly) recs = recs.filter(r => r.source === "direct");
    
    const activeTags = Array.from(document.querySelectorAll(".active-filter")).map(el => el.dataset.tag);
    if(activeTags.length > 0) {
        recs = recs.filter(r => r.tags && activeTags.some(t => r.tags.includes(t)));
    }
    
    // Sort
    if(sort === "score") recs.sort((a,b)=>b.engagement_score - a.engagement_score);
    if(sort === "plays") recs.sort((a,b)=>b.play_count - a.play_count);
    if(sort === "minutes") recs.sort((a,b)=>b.total_minutes - a.total_minutes);
    if(sort === "artist") recs.sort((a,b)=>a.artist.localeCompare(b.artist));
    
    document.getElementById("rec-list").innerHTML = recs.map((r, i) => `
        <div class="song-card" data-id="${i}" style="${r.is_similar ? 'border-left: 3px solid var(--similar); padding-left: 0.5rem;' : ''}">
            <div class="song-info" style="flex:1;">
                <strong>${r.track}</strong> - ${r.artist}
                <br><small style="color:var(--muted)">Plays: ${r.play_count} | Min: ${r.total_minutes} | Score: ${r.engagement_score.toFixed(2)} | <span style="color:var(--${r.source==='direct'?'direct':'similar'})">${r.match_reason}</span></small>
                <div class="song-tags" data-id="${i}">${r.tags ? r.tags.map(x => `<span class="tag-pill">${x}</span>`).join("") : ''}</div>
            </div>
            <button class="copy-btn" onclick="copyText('${r.artist} - ${r.track}', this)">${icon("copy")}</button>
        </div>
    `).join("");
    
    if(!skipFetch) applyTrackStats();
}

document.getElementById("rec-btn").addEventListener("click", async () => {
    showLoader("Empfehlungen...");
const data = await apiCall("/recommend", "POST", {
        year: parseInt(document.getElementById("rec-year")?.value || globalTargetYear()),
        top_n: parseInt(document.getElementById("rec-topn").value),
        min_minutes: parseFloat(document.getElementById("rec-min").value)
    });
    hideLoader();
    if(data.error) return alert(data.error);
    state.lastResults = data.recommendations;
    document.getElementById("rec-tag-filters").innerHTML = "";
    document.getElementById("rec-results").classList.remove("hidden");
    
    // Render initially
    renderRecommendations(true);
    
    // Background fetches
    await fetchLastFMTags(state.lastResults);
    await fetchLastFMSimilarStats(state.lastResults);
    applyTrackStats();
});
document.getElementById("rec-sort").addEventListener("change", () => renderRecommendations(true));
document.getElementById("rec-direct-only").addEventListener("change", () => renderRecommendations(true));

// ── MODULE: Compare ──
document.getElementById("comp-btn").addEventListener("click", async () => {
    showLoader("Vergleiche Jahre...");
    const y1 = document.getElementById("comp-y1").value;
    const y2 = document.getElementById("comp-y2").value;
    const data = await apiCall("/api/compare", "POST", { year1: y1, year2: y2 });
    hideLoader();
    if (data.error) return alert("Fehler: " + data.error);

    const d1 = data[y1], d2 = data[y2];
    if (!d1 || !d2) return;

    function statBar(label, v1, v2, unit="") {
        const max = Math.max(v1, v2, 1);
        const w1 = (v1/max*100).toFixed(0);
        const w2 = (v2/max*100).toFixed(0);
        const win1 = v1 >= v2;
        return `
        <div style="margin-bottom:1rem;">
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:0.35rem;">
            <span style="font-weight:${win1?'700':'400'};color:${win1?'var(--green)':'var(--muted)'};">${Number(v1).toLocaleString()}${unit}</span>
            <span style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">${label}</span>
            <span style="font-weight:${!win1?'700':'400'};color:${!win1?'#5b8def':'var(--muted)'};">${Number(v2).toLocaleString()}${unit}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
            <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
              <div style="height:6px;background:var(--green);width:${w1}%;border-radius:3px;float:right;"></div>
            </div>
            <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
              <div style="height:6px;background:#5b8def;width:${w2}%;border-radius:3px;"></div>
            </div>
          </div>
        </div>`;
    }

    const rank1={}, rank2={};
    d1.top_artists.forEach((a,i)=>rank1[a]=i+1);
    d2.top_artists.forEach((a,i)=>rank2[a]=i+1);

    function artistMovement(a) {
        const r1=rank1[a], r2=rank2[a];
        if(!r1) return `<span style="color:var(--green);font-size:0.7rem;">✦NEU</span>`;
        if(!r2) return `<span style="color:#e5534b;font-size:0.7rem;">✦WEG</span>`;
        const d=r1-r2;
        if(d>0) return `<span style="color:var(--green);font-size:0.7rem;">▲${d}</span>`;
        if(d<0) return `<span style="color:#e5534b;font-size:0.7rem;">▼${Math.abs(d)}</span>`;
        return `<span style="color:var(--muted);font-size:0.7rem;">━</span>`;
    }

    const allArtists = [...new Set([...d1.top_artists, ...d2.top_artists])];

    const songs1 = (d1.top_songs||[]).slice(0,8);
    const songs2 = (d2.top_songs||[]).slice(0,8);

    document.getElementById("comp-results").innerHTML = `
      <!-- Hero header -->
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:0.75rem;align-items:center;margin-bottom:1.25rem;grid-column:1/-1;">
        <div style="background:rgba(29,185,84,0.1);border:1px solid rgba(29,185,84,0.3);border-radius:14px;padding:1.25rem;text-align:center;">
          <div style="font-size:2.8rem;font-weight:900;color:var(--green);line-height:1;">${y1}</div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.3rem;">${d1.stats.total_streams.toLocaleString()} Streams</div>
          <div style="font-size:1.3rem;font-weight:700;color:var(--text);margin-top:0.25rem;">${d1.stats.total_hours}h gehört</div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.15rem;">${d1.stats.unique_tracks.toLocaleString()} Unique Tracks</div>
        </div>
        <div style="text-align:center;font-size:1.6rem;font-weight:900;color:var(--border);">vs</div>
        <div style="background:rgba(91,141,239,0.1);border:1px solid rgba(91,141,239,0.3);border-radius:14px;padding:1.25rem;text-align:center;">
          <div style="font-size:2.8rem;font-weight:900;color:#5b8def;line-height:1;">${y2}</div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.3rem;">${d2.stats.total_streams.toLocaleString()} Streams</div>
          <div style="font-size:1.3rem;font-weight:700;color:var(--text);margin-top:0.25rem;">${d2.stats.total_hours}h gehört</div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.15rem;">${d2.stats.unique_tracks.toLocaleString()} Unique Tracks</div>
        </div>
      </div>

      <!-- Stat bars -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:1.2rem;grid-column:1/-1;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h4 style="font-size:0.9rem;display:flex;align-items:center;gap:0.4rem;"><i data-lucide="bar-chart-2" style="width:14px;height:14px;color:var(--muted);"></i> Statistiken im Vergleich</h4>
          <div style="display:flex;gap:1rem;font-size:0.75rem;">
            <span style="color:var(--green);">■ ${y1}</span>
            <span style="color:#5b8def;">■ ${y2}</span>
          </div>
        </div>
        ${statBar("Hörzeit", d1.stats.total_hours, d2.stats.total_hours, "h")}
        ${statBar("Streams", d1.stats.total_streams, d2.stats.total_streams)}
        ${statBar("Unique Tracks", d1.stats.unique_tracks, d2.stats.unique_tracks)}
      </div>

      <!-- Top Songs side by side -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:1.2rem;grid-column:1/-1;">
        <h4 style="font-size:0.9rem;margin-bottom:0.85rem;display:flex;align-items:center;gap:0.4rem;"><i data-lucide="music" style="width:14px;height:14px;color:var(--muted);"></i> Top Songs — klickbar</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;">
          <div>
            <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--green);margin-bottom:0.5rem;letter-spacing:0.5px;">${y1}</div>
            ${songs1.map((s,i)=>`
              <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.3rem;border-bottom:1px solid var(--border);cursor:pointer;border-radius:4px;transition:background 0.15s;"
                   onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''"
                   onclick="openSongDetail('${s.track.replace(/'/g,"\'")}','${s.artist.replace(/'/g,"\'")}')">
                <span style="font-size:0.7rem;color:var(--muted);min-width:14px;">${i+1}.</span>
                <div style="overflow:hidden;flex:1;min-width:0;">
                  <div style="font-size:0.85rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.track}</div>
                  <div style="font-size:0.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.artist}</div>
                </div>
                <span style="font-size:0.75rem;color:var(--green);flex-shrink:0;font-weight:600;">${s.play_count}x</span>
              </div>`).join("")}
          </div>
          <div>
            <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:#5b8def;margin-bottom:0.5rem;letter-spacing:0.5px;">${y2}</div>
            ${songs2.map((s,i)=>`
              <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.3rem;border-bottom:1px solid var(--border);cursor:pointer;border-radius:4px;transition:background 0.15s;"
                   onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''"
                   onclick="openSongDetail('${s.track.replace(/'/g,"\'")}','${s.artist.replace(/'/g,"\'")}')">
                <span style="font-size:0.7rem;color:var(--muted);min-width:14px;">${i+1}.</span>
                <div style="overflow:hidden;flex:1;min-width:0;">
                  <div style="font-size:0.85rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.track}</div>
                  <div style="font-size:0.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.artist}</div>
                </div>
                <span style="font-size:0.75rem;color:#5b8def;flex-shrink:0;font-weight:600;">${s.play_count}x</span>
              </div>`).join("")}
          </div>
        </div>
      </div>

      <!-- Artist movement grid -->
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:1.2rem;grid-column:1/-1;">
        <h4 style="font-size:0.9rem;margin-bottom:0.75rem;display:flex;align-items:center;gap:0.4rem;"><i data-lucide="mic-2" style="width:14px;height:14px;color:var(--muted);"></i> Artist-Ranking: ${y1} → ${y2}</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:0.45rem;">
          ${allArtists.map(a=>{
            const r1=rank1[a]?`#${rank1[a]}`:"—";
            const r2=rank2[a]?`#${rank2[a]}`:"—";
            const isNew=!rank1[a]&&rank2[a];
            const isDrop=rank1[a]&&!rank2[a];
            const bg=isNew?"rgba(29,185,84,0.07)":isDrop?"rgba(229,83,75,0.07)":"transparent";
            const bdr=isNew?"rgba(29,185,84,0.25)":isDrop?"rgba(229,83,75,0.25)":"var(--border)";
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0.6rem;border-radius:8px;background:${bg};border:1px solid ${bdr};cursor:pointer;"
                         onclick="searchArtist('${a.replace(/'/g,"\'")}')">
              <span style="font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:0.4rem;">${a}</span>
              <div style="display:flex;align-items:center;gap:0.35rem;flex-shrink:0;">
                <span style="font-size:0.72rem;color:var(--green);">${r1}</span>
                <span style="font-size:0.7rem;color:var(--border);">→</span>
                <span style="font-size:0.72rem;color:#5b8def;">${r2}</span>
                ${artistMovement(a)}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <!-- New & Dropped -->
      <div style="background:rgba(29,185,84,0.06);border:1px solid rgba(29,185,84,0.25);border-radius:12px;padding:1.1rem;">
        <h4 style="font-size:0.85rem;color:var(--green);margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;">
          <i data-lucide="sparkles" style="width:13px;height:13px;"></i> Neu in ${y2}
        </h4>
        <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
          ${data.new_artists.length
            ? data.new_artists.map(a=>`<span class="gain-badge gain" style="padding:0.3rem 0.7rem;font-size:0.8rem;cursor:pointer;" onclick="searchArtist('${a.replace(/'/g,"\'")}')">+ ${a}</span>`).join("")
            : `<span style="color:var(--muted);font-size:0.85rem;">Keine neuen Top-Artists</span>`}
        </div>
      </div>

      <div style="background:rgba(229,83,75,0.06);border:1px solid rgba(229,83,75,0.25);border-radius:12px;padding:1.1rem;">
        <h4 style="font-size:0.85rem;color:#e5534b;margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;">
          <i data-lucide="archive" style="width:13px;height:13px;"></i> Abgefallen seit ${y1}
        </h4>
        <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
          ${data.dropped_artists.length
            ? data.dropped_artists.map(a=>`<span class="gain-badge drop" style="padding:0.3rem 0.7rem;font-size:0.8rem;cursor:pointer;" onclick="searchArtist('${a.replace(/'/g,"\'")}')">− ${a}</span>`).join("")
            : `<span style="color:var(--muted);font-size:0.85rem;">Keine weggefallenen Top-Artists</span>`}
        </div>
      </div>
    `;

    document.getElementById("comp-results").classList.remove("hidden");
    lucide.createIcons();
});

// ── MODULE: Heatmap ──
document.getElementById("heat-btn").addEventListener("click", async () => {
showLoader("Visualisiere Hörzeiten...");
    const year = document.getElementById("heat-year")?.value || "all";
    const viewMode = document.getElementById("heat-view-mode") ? document.getElementById("heat-view-mode").value : "both";
    const data = await apiCall("/api/heatmap?year=" + year);
    hideLoader();
    if(data.error) return alert("Fehler beim Laden der Heatmap: " + data.error);

    // 1. Stats Summary
    const statsContainer = document.getElementById("heat-stats-summary");
    statsContainer.innerHTML = `
        <div class="stat-card">
            <h4>Gesamte Hörzeit</h4>
            <div class="val">${data.total_hours.toLocaleString()} h</div>
        </div>
        <div class="stat-card">
            <h4>Gesamte Streams</h4>
            <div class="val">${data.total_streams.toLocaleString()}</div>
        </div>
        <div class="stat-card">
            <h4>Häufigster Hör-Slot</h4>
            <div class="val" style="font-size:1.15rem; color:var(--text);">${data.peak_slot.day}</div>
            <div style="font-size:0.8rem; color:var(--green);">${data.peak_slot.time_label} (${data.peak_slot.minutes} min)</div>
        </div>
        <div class="stat-card">
            <h4>Spitzen-Wochentag</h4>
            <div class="val" style="font-size:1.15rem; color:var(--text);">${data.days_full[data.daily_minutes.indexOf(Math.max(...data.daily_minutes))]}</div>
            <div style="font-size:0.8rem; color:var(--muted);">${Math.max(...data.daily_minutes).toFixed(0)} Min gesamt</div>
        </div>
    `;
    statsContainer.classList.remove("hidden");

    // 2. Sections Visibility based on viewMode
    const chartsSec = document.getElementById("heat-charts-section");
    const matrixSec = document.getElementById("heat-matrix-section");
    if (viewMode === "curves") {
        chartsSec.classList.remove("hidden");
        matrixSec.classList.add("hidden");
    } else if (viewMode === "grid") {
        chartsSec.classList.add("hidden");
        matrixSec.classList.remove("hidden");
    } else {
        chartsSec.classList.remove("hidden");
        matrixSec.classList.remove("hidden");
    }

    // 3. Render 24h Hourly Curve & Daily Bar Chart
    if (viewMode !== "grid") {
        // Hourly Chart
        if (state.charts['heat_hourly']) state.charts['heat_hourly'].destroy();
        const ctxHour = document.getElementById("heat-hourly-chart").getContext("2d");
        state.charts['heat_hourly'] = new Chart(ctxHour, {
            type: 'line',
            data: {
                labels: data.hourly_labels,
                datasets: [{
                    label: 'Hörminuten',
                    data: data.hourly_minutes,
                    borderColor: '#1db954',
                    backgroundColor: 'rgba(29, 185, 84, 0.15)',
                    fill: true,
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 6
                }]
            },
            options: {
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    x: { grid: { color: '#2a2a2a' }, ticks: { color: '#888' } },
                    y: { grid: { color: '#2a2a2a' }, ticks: { color: '#888' }, title: { display: true, text: 'Minuten', color: '#888' } }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });

        // Daily Bar Chart
        if (state.charts['heat_daily']) state.charts['heat_daily'].destroy();
        const ctxDay = document.getElementById("heat-daily-chart").getContext("2d");
        state.charts['heat_daily'] = new Chart(ctxDay, {
            type: 'bar',
            data: {
                labels: data.days_full,
                datasets: [{
                    label: 'Hörminuten',
                    data: data.daily_minutes,
                    backgroundColor: '#1db954',
                    borderRadius: 6
                }]
            },
            options: {
                maintainAspectRatio: false,
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#888' } },
                    y: { grid: { color: '#2a2a2a' }, ticks: { color: '#888' }, title: { display: true, text: 'Minuten', color: '#888' } }
                },
                plugins: { legend: { display: false } }
            }
        });
    }

    // 4. Render 7x24 Matrix
    if (viewMode !== "curves") {
        let html = `<div class="heatmap-axis-col"></div>` + 
            Array.from({length:24}).map((_,i)=>`<div class="heatmap-axis-col">${i < 10 ? '0' + i : i}h</div>`).join("");

        data.days.forEach((day, r) => {
            html += `<div class="heatmap-axis-row">${day}</div>`;
            for(let c=0; c<24; c++){
                const val = data.matrix[r][c];
                const streams = data.streams_matrix ? data.streams_matrix[r][c] : 0;
                const intensity = data.max_value > 0 ? (val / data.max_value) : 0;
                // Min intensity to be visible if > 0
                const styledI = val > 0 ? Math.max(0.12, intensity).toFixed(2) : '0';
                html += `<div class="heatmap-cell" data-r="${r}" data-c="${c}" data-day="${data.days_full[r]}" style="--i:${styledI}" title="${data.days_full[r]}, ${c}:00 Uhr: ${val.toFixed(1)} Min (${streams} Streams)"></div>`;
            }
        });

        document.getElementById("heatmap-container").innerHTML = html;

        // Click Handler for Detailed Inspection Card
        document.querySelectorAll(".heatmap-cell").forEach(cell => {
            cell.addEventListener("click", async () => {
                document.querySelectorAll(".heatmap-cell").forEach(c => c.classList.remove("active-cell"));
                cell.classList.add("active-cell");

                const r = cell.dataset.r;
                const c = cell.dataset.c;
                const dayName = cell.dataset.day;

                const detailCard = document.getElementById("heat-detail-card");
                detailCard.classList.remove("hidden");
                document.getElementById("heat-detail-title").textContent = `${dayName}, ${c}:00 - ${(parseInt(c)+1)%24}:00 Uhr`;
                document.getElementById("heat-detail-subtitle").textContent = "Lade detaillierte Statistiken...";
                document.getElementById("heat-detail-songs").innerHTML = "<p style='color:var(--muted); font-size:0.85rem;'>Lade Songs...</p>";
                document.getElementById("heat-detail-artists").innerHTML = "<p style='color:var(--muted); font-size:0.85rem;'>Lade Artists...</p>";
                detailCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                const cellData = await apiCall(`/api/heatmap/cell?year=${year}&weekday=${r}&hour=${c}`);
                if (!cellData || cellData.total_streams === 0) {
                    document.getElementById("heat-detail-subtitle").textContent = "Keine Streams in diesem Zeitfenster.";
                    document.getElementById("heat-detail-songs").innerHTML = "<p style='color:var(--muted); font-size:0.85rem;'>Keine Tracks abgespielt.</p>";
                    document.getElementById("heat-detail-artists").innerHTML = "<p style='color:var(--muted); font-size:0.85rem;'>Keine Artists.</p>";
                    return;
                }

                document.getElementById("heat-detail-subtitle").textContent = 
                    `${cellData.total_streams} Streams gesamt · ${cellData.total_minutes} Minuten abgespielt`;

                // Render Top Songs
                document.getElementById("heat-detail-songs").innerHTML = cellData.top_songs.map((s, idx) => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:0.5rem;">
                            <strong style="color:var(--text);">${idx+1}. ${s.track}</strong><br>
                            <span style="color:var(--muted); font-size:0.8rem;">${s.artist}</span>
                        </div>
                        <div style="text-align:right; white-space:nowrap; font-size:0.8rem; color:var(--green);">
                            ${s.play_count}x (${s.minutes}m)
                        </div>
                    </div>
                `).join("");

                // Render Top Artists
                document.getElementById("heat-detail-artists").innerHTML = cellData.top_artists.map((a, idx) => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                        <div>
                            <strong style="color:var(--text);">${idx+1}. ${a.artist}</strong>
                        </div>
                        <div style="text-align:right; font-size:0.8rem; color:var(--green);">
                            ${a.play_count} Plays (${a.minutes}m)
                        </div>
                    </div>
                `).join("");
            });
        });
    }
    lucide.createIcons();
});

document.getElementById("heat-detail-close")?.addEventListener("click", () => {
    document.getElementById("heat-detail-card").classList.add("hidden");
    document.querySelectorAll(".heatmap-cell").forEach(c => c.classList.remove("active-cell"));
});

// ── MODULE: Artist ──
document.getElementById("artist-btn").addEventListener("click", async () => {
    const artist = document.getElementById("artist-input").value.trim();
    if(!artist) return;
    showLoader("Analysiere Artist-Daten...");
    const data = await apiCall("/api/artist", "POST", {artist});
    hideLoader();
    if(data.error || !data.artist) return alert("Artist nicht gefunden!");

    const artistQueryStr = (data.artist || "").replace(/"/g, '&quot;');
    document.getElementById("artist-header").innerHTML = `
        <div style="display:flex; align-items:center; gap:1.25rem; flex-wrap:wrap; margin-bottom:0.5rem;">
            <div class="cover-box" data-query="${artistQueryStr}" style="width:76px; height:76px; border-radius:50%; background:rgba(29,185,84,0.12); border:2px solid rgba(29,185,84,0.4); display:flex; align-items:center; justify-content:center; font-size:2.2rem; overflow:hidden; flex-shrink:0; box-shadow:0 4px 12px rgba(0,0,0,0.35);">
                🎤
            </div>
            <div>
                <h2 style="font-size:1.6rem; margin:0 0 0.25rem 0; display:flex; align-items:center; gap:0.5rem;">
                    ${data.artist}
                </h2>
                <span style="color:var(--muted); font-size:0.85rem;">Erstes Mal gestreamt am ${data.first_heard} · Zuletzt gehört am ${data.last_heard}</span>
            </div>
        </div>
    `;
    document.querySelectorAll("#artist-header .cover-box").forEach(el => _loadCoverArt(el));

    document.getElementById("artist-stats-grid").innerHTML = `
        <div class="stat-card">
            <h4>Gesamt Plays</h4>
            <div class="val">${data.total_plays.toLocaleString()}</div>
        </div>
        <div class="stat-card">
            <h4>Hörzeit gesamt</h4>
            <div class="val">${data.total_hours.toLocaleString()} h</div>
            <div style="font-size:0.8rem; color:var(--muted);">${data.total_minutes.toLocaleString()} Min</div>
        </div>
        <div class="stat-card" style="text-align:left;">
            <h4><i data-lucide="play" style="width:12px;height:12px;color:var(--green)"></i> Erster Song überhaupt</h4>
            <div class="val" style="font-size:1.05rem; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${data.first_track}">${data.first_track}</div>
            <div style="font-size:0.8rem; color:var(--green); margin-top:2px;">${data.first_heard} (${data.first_heard_time})</div>
            <div style="font-size:0.75rem; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${data.first_album}</div>
        </div>
        <div class="stat-card" style="text-align:left;">
            <h4><i data-lucide="history" style="width:12px;height:12px;color:var(--green)"></i> Letzter Song</h4>
            <div class="val" style="font-size:1.05rem; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${data.last_track}">${data.last_track}</div>
            <div style="font-size:0.8rem; color:var(--green); margin-top:2px;">${data.last_heard} (${data.last_heard_time})</div>
            <div style="font-size:0.75rem; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${data.last_album}</div>
        </div>
    `;

    // 1. Plays by Year Chart
    if(state.charts['artist']) state.charts['artist'].destroy();
    const ctx = document.getElementById("artist-chart").getContext("2d");
    const years = Object.keys(data.plays_by_year).sort();
    const vals = years.map(y => data.plays_by_year[y]);
    state.charts['artist'] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: years,
            datasets: [{ label: 'Streams', data: vals, backgroundColor: '#1db954', borderRadius: 6 }]
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, ticks: { color: '#888' } },
                y: { grid: { color: '#2a2a2a' }, ticks: { color: '#888' } }
            },
            plugins: { legend: { display: false } }
        }
    });

    // 2. Plays by Month Chart (or hide wrap if not enough data)
    const monthWrap = document.getElementById("artist-monthly-wrap");
    if(data.plays_by_month && Object.keys(data.plays_by_month).length > 1) {
        monthWrap.classList.remove("hidden");
        if(state.charts['artist_monthly']) state.charts['artist_monthly'].destroy();
        const ctxMonth = document.getElementById("artist-chart-monthly").getContext("2d");
        const months = Object.keys(data.plays_by_month).sort();
        const mvals = months.map(m => data.plays_by_month[m]);
        state.charts['artist_monthly'] = new Chart(ctxMonth, {
            type: 'line',
            data: {
                labels: months,
                datasets: [{
                    label: 'Streams',
                    data: mvals,
                    borderColor: '#5b8def',
                    backgroundColor: 'rgba(91, 141, 239, 0.15)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2,
                    pointRadius: 2
                }]
            },
            options: {
                maintainAspectRatio: false,
                scales: {
                    x: { grid: { color: '#2a2a2a' }, ticks: { color: '#888', maxTicksLimit: 8 } },
                    y: { grid: { color: '#2a2a2a' }, ticks: { color: '#888' } }
                },
                plugins: { legend: { display: false } }
            }
        });
    } else {
        monthWrap.classList.add("hidden");
    }

    // 3. Top Songs (clickable → Song Detail Modal)
    document.getElementById("artist-top-songs").innerHTML = data.top_songs.map((s, idx) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.45rem 0; border-bottom:1px solid var(--border); font-size:0.85rem; cursor:pointer;" 
             onclick="openSongDetail('${s.track.replace(/'/g, "\'")}','${data.artist.replace(/'/g, "\'")}')">
            <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:0.5rem;">
                <strong style="color:var(--text);">${idx+1}. ${s.track}</strong>
            </div>
            <div style="text-align:right; white-space:nowrap; font-size:0.8rem; color:var(--green);">
                ${s.play_count}x (${s.total_min ? s.total_min.toFixed(0) : 0}m)
            </div>
        </div>
    `).join("");

    // 4. Top Albums
    if(data.top_albums && data.top_albums.length > 0) {
        document.getElementById("artist-top-albums").innerHTML = data.top_albums.map((a, idx) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.45rem 0; border-bottom:1px solid var(--border); font-size:0.85rem; cursor:pointer;"
                 onclick="openAlbumDetail('${(a.album||'').replace(/'/g, "\'")}','${data.artist.replace(/'/g, "\'")}')">
                <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:0.5rem;">
                    <strong style="color:var(--text);">${idx+1}. ${a.album || 'Single / Ohne Album'}</strong>
                </div>
                <div style="text-align:right; white-space:nowrap; font-size:0.8rem; color:var(--muted);">
                    ${a.play_count} Plays (${a.minutes}m)
                </div>
            </div>
        `).join("");
    } else {
        document.getElementById("artist-top-albums").innerHTML = "<p style='color:var(--muted); font-size:0.85rem;'>Keine Alben gefunden.</p>";
    }

    document.getElementById("artist-results").classList.remove("hidden");
    document.getElementById("artist-bio-container").innerHTML = "";

    // 5. Last.fm Artist Info with working Read More Link
    if(state.lastfmKey && state.settings.artistInfo) {
        const info = await apiCall("/api/lastfm/artist_info", "POST", {artist: data.artist, key: state.lastfmKey});
        if(info && (info.bio_summary || info.read_more_url)) {
            let bioStr = info.bio_summary || "";
            if(bioStr.length > 380) bioStr = bioStr.substring(0, 380) + "...";
            
            const readMoreLink = info.read_more_url 
                ? `<a href="${info.read_more_url}" target="_blank" rel="noopener" style="color:var(--green); text-decoration:none; font-weight:600; display:inline-flex; align-items:center; gap:0.25rem; margin-top:0.4rem;">
                    Mehr Biografie auf Last.fm lesen <i data-lucide="external-link" style="width:12px;height:12px;"></i>
                   </a>`
                : "";

            let simStr = (info.similar_artists || []).map(sa => `<span class="pill sim-artist-pill" data-artist="${sa.name}">${sa.name}</span>`).join("");

            document.getElementById("artist-bio-container").innerHTML = `
                <div class="artist-bio">
                    <p style="line-height:1.6; color:#ddd;">${bioStr}</p>
                    <div style="margin-top:0.5rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                        ${readMoreLink}
                        <small style="color:var(--muted);">${Number(info.listeners).toLocaleString()} Hörer weltweit (Last.fm)</small>
                    </div>
                    ${simStr ? `<div style="margin-top:0.75rem;"><span style="font-size:0.75rem; text-transform:uppercase; color:var(--muted); display:block; margin-bottom:0.3rem;">Ähnliche Künstler:</span><div class="artist-similar-pills">${simStr}</div></div>` : ''}
                </div>
            `;

            document.querySelectorAll(".sim-artist-pill").forEach(p => {
                p.addEventListener("click", () => {
                    document.getElementById("artist-input").value = p.dataset.artist;
                    document.getElementById("artist-btn").click();
                });
            });
            lucide.createIcons();
        }
    }
    lucide.createIcons();
});

// ── MODULE: Skips ──
let _skipCharts = {};
function _destroySkipCharts() {
    Object.values(_skipCharts).forEach(c => { try { c.destroy(); } catch(e){} });
    _skipCharts = {};
}

function renderSkipList() {
    const filterTxt = document.getElementById("skip-filter").value.toLowerCase();
    let data = state.skipData.filter(s =>
        s.artist.toLowerCase().includes(filterTxt) ||
        s.track.toLowerCase().includes(filterTxt)
    );
    const {col, asc} = state.skipSort;
    data.sort((a,b) => {
        let vA = a[col], vB = b[col];
        if(typeof vA === 'string') return asc ? vA.localeCompare(vB) : vB.localeCompare(vA);
        return asc ? vA - vB : vB - vA;
    });

    const maxPlays = Math.max(...data.map(s => s.play_count), 1);

    document.getElementById("skip-list").innerHTML = data.map(s => {
        const skipPct = (s.skip_rate * 100).toFixed(0);
        const skipColor = s.skip_rate > 0.7 ? '#e5534b' : s.skip_rate > 0.4 ? '#f9c22e' : 'var(--green)';
        const barW = Math.max(3, (s.play_count / maxPlays * 100)).toFixed(0);
        const avgSec = (s.avg_ms_played / 1000).toFixed(0);
        const safe = (str) => (str||'').split("'").join("\\'");
        return `
        <div style="display:flex;align-items:center;gap:0.75rem;padding:0.6rem 0.5rem;border-bottom:1px solid var(--border);cursor:pointer;border-radius:6px;transition:background 0.15s;"
             onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''"
             onclick="openSongDetail('${safe(s.track)}','${safe(s.artist)}')">
            <div style="flex:1;min-width:0;overflow:hidden;">
                <div style="font-size:0.88rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.track}</div>
                <div style="font-size:0.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.artist}</div>
                <div style="margin-top:0.3rem;height:3px;background:var(--border);border-radius:2px;">
                    <div style="height:3px;border-radius:2px;background:var(--green);opacity:0.5;width:${barW}%;"></div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.75rem;flex-shrink:0;font-size:0.82rem;">
                <div style="text-align:center;min-width:44px;">
                    <div style="font-weight:700;color:${skipColor};font-size:0.95rem;">${skipPct}%</div>
                    <div style="font-size:0.7rem;color:var(--muted);">skip</div>
                </div>
                <div style="text-align:center;min-width:36px;">
                    <div style="font-weight:600;color:var(--text);">${s.play_count}</div>
                    <div style="font-size:0.7rem;color:var(--muted);">plays</div>
                </div>
                <div style="text-align:center;min-width:36px;">
                    <div style="color:var(--muted);">${avgSec}s</div>
                    <div style="font-size:0.7rem;color:var(--muted);">avg</div>
                </div>
                <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--border);"></i>
            </div>
        </div>`;
    }).join("");
    lucide.createIcons();
}

document.getElementById("skip-btn").addEventListener("click", async () => {
    _destroySkipCharts();
    showLoader("Skip-Analyse läuft...");
    const y = document.getElementById("skip-year").value;
    const m = document.getElementById("skip-min").value;
    const n = document.getElementById("skip-topn")?.value || 30;

    const [listData, analyticsData] = await Promise.all([
        apiCall(`/api/skips?year=${y}&min_plays=${m}&top_n=${n}`),
        apiCall(`/api/skip_analytics?year=${y}&min_plays=${m}`)
    ]);
    hideLoader();
    if(listData.error) return;

    state.skipData = listData;
    document.getElementById("skip-results").classList.remove("hidden");

    // ── Stat cards ──
    const a = analyticsData;
    document.getElementById("skip-stat-cards").innerHTML = `
        <div class="stat-card">
            <h4>Gesamt Skip-Rate</h4>
            <div class="val" style="color:${a.overall_skip_rate>50?'#e5534b':a.overall_skip_rate>30?'#f9c22e':'var(--green)'};">${a.overall_skip_rate}%</div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:0.2rem;">${a.total_skips.toLocaleString()} von ${a.total_streams.toLocaleString()} Streams</div>
        </div>
        <div class="stat-card" style="cursor:pointer;" onclick="openSongDetail('${(a.worst_song?.track||'').replace(/'/g,"\'")}','${(a.worst_song?.artist||'').replace(/'/g,"\'")}')">
            <h4>Meistgeskippt</h4>
            <div style="font-size:0.9rem;font-weight:700;color:#e5534b;margin:0.3rem 0;">${a.worst_song?.track||'—'}</div>
            <div style="font-size:0.75rem;color:var(--muted);">${a.worst_song?.skip_rate||0}% Skip-Rate</div>
        </div>
        <div class="stat-card" style="cursor:pointer;" onclick="openSongDetail('${(a.best_song?.track||'').replace(/'/g,"\'")}','${(a.best_song?.artist||'').replace(/'/g,"\'")}')">
            <h4>Beste Completion</h4>
            <div style="font-size:0.9rem;font-weight:700;color:var(--green);margin:0.3rem 0;">${a.best_song?.track||'—'}</div>
            <div style="font-size:0.75rem;color:var(--muted);">${a.best_song?.skip_rate||0}% Skip-Rate</div>
        </div>
        <div class="stat-card">
            <h4>Songs analysiert</h4>
            <div class="val" style="font-size:1.4rem;">${listData.length.toLocaleString()}</div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:0.2rem;">mit ≥${m} Plays</div>
        </div>
    `;

    // ── Chart 1: Skip-Rate Verteilung ──
    const ctxDist = document.getElementById("skip-dist-chart")?.getContext("2d");
    if (ctxDist) {
        const colors = a.skip_dist_labels.map((_, i) => {
            const ratio = i / 9;
            return `hsl(${120 - ratio*120},70%,45%)`;
        });
        _skipCharts['dist'] = new Chart(ctxDist, {
            type: 'bar',
            data: {
                labels: a.skip_dist_labels,
                datasets: [{ data: a.skip_dist_values, backgroundColor: colors, borderRadius: 4 }]
            },
            options: {
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.raw} Songs mit dieser Skip-Rate` } }
                },
                scales: {
                    x: { ticks: { color: '#666', font: { size: 9 }, maxRotation: 30 }, grid: { display: false } },
                    y: { ticks: { color: '#666', font: { size: 10 } }, grid: { color: '#1a1a1a' } }
                }
            }
        });
    }

    // ── Chart 2: Skip-Rate nach Uhrzeit ──
    const ctxHour = document.getElementById("skip-hour-chart")?.getContext("2d");
    if (ctxHour) {
        _skipCharts['hour'] = new Chart(ctxHour, {
            type: 'line',
            data: {
                labels: Array.from({length:24},(_,i)=>i+'h'),
                datasets: [{
                    data: a.skip_by_hour,
                    borderColor: '#e5534b',
                    backgroundColor: 'rgba(229,83,75,0.15)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: '#e5534b'
                }]
            },
            options: {
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)}% Skips um ${ctx.label}` } }
                },
                scales: {
                    x: { ticks: { color: '#666', font: { size: 9 } }, grid: { color: '#1a1a1a' } },
                    y: { ticks: { color: '#666', font: { size: 10 }, callback: v => v+'%' }, grid: { color: '#1a1a1a' }, min: 0 }
                }
            }
        });
    }

    // ── Chart 3: Top Skip Artists (horizontal bar) ──
    const ctxArt = document.getElementById("skip-artist-chart")?.getContext("2d");
    if (ctxArt && a.top_skip_artists.length) {
        const arts = [...a.top_skip_artists].reverse();
        _skipCharts['artist'] = new Chart(ctxArt, {
            type: 'bar',
            data: {
                labels: arts.map(x => x.artist.length > 18 ? x.artist.slice(0,16)+'…' : x.artist),
                datasets: [{
                    data: arts.map(x => x.skip_rate),
                    backgroundColor: arts.map(x => x.skip_rate > 60 ? '#e5534b' : x.skip_rate > 40 ? '#f9c22e' : '#1db954'),
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y',
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)}% Skip-Rate (${arts[ctx.dataIndex].plays} Plays)` } }
                },
                scales: {
                    x: { ticks: { color: '#666', font: { size: 9 }, callback: v => v+'%' }, grid: { color: '#1a1a1a' } },
                    y: { ticks: { color: '#888', font: { size: 10 } }, grid: { display: false } }
                }
            }
        });
    }

    // ── Chart 4: Skip-Rate Trend nach Jahr ──
    const ctxYear = document.getElementById("skip-year-chart")?.getContext("2d");
    if (ctxYear && a.skip_by_year_labels.length) {
        _skipCharts['year'] = new Chart(ctxYear, {
            type: 'line',
            data: {
                labels: a.skip_by_year_labels,
                datasets: [{
                    label: 'Skip-Rate',
                    data: a.skip_by_year_values,
                    borderColor: '#f9c22e',
                    backgroundColor: 'rgba(249,194,46,0.12)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 5,
                    pointBackgroundColor: '#f9c22e',
                    pointBorderColor: '#000',
                    pointBorderWidth: 1
                }]
            },
            options: {
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)}% Skip-Rate in ${ctx.label}` } }
                },
                scales: {
                    x: { ticks: { color: '#888' }, grid: { color: '#1a1a1a' } },
                    y: { ticks: { color: '#666', callback: v => v+'%' }, grid: { color: '#1a1a1a' }, min: 0 }
                }
            }
        });
    }

    renderSkipList();
    lucide.createIcons();
});

document.getElementById("skip-filter").addEventListener("input", renderSkipList);
document.querySelectorAll(".sortable-header").forEach(hdr => {
    hdr.addEventListener("click", () => {
        const col = hdr.dataset.sort;
        if(state.skipSort.col === col) state.skipSort.asc = !state.skipSort.asc;
        else { state.skipSort.col = col; state.skipSort.asc = false; }
        document.querySelectorAll(".sortable-header").forEach(h => h.classList.remove("asc"));
        if(state.skipSort.asc) hdr.classList.add("asc");
        renderSkipList();
    });
});

// ── MODULE: Discover ──
let allTimelineData = [];

document.getElementById("disc-btn").addEventListener("click", async () => {
const year = document.getElementById("disc-year").value;
       showLoader(`Analysiere Entdeckungen für ${year === "all" ? "alle Jahre" : year}...`);
    const data = await apiCall("/api/discover?year=" + year);
    hideLoader();
    if(data.error) return alert("Fehler: " + data.error);
    // year="all" liefert Jahreslabel "all" - fuer die Ueberschriften deutsch.
    const yLabel = data.year === "all" ? "alle Jahre" : data.year;

    // 1. Stats Summary
    const statsContainer = document.getElementById("disc-stats");
    statsContainer.innerHTML = `
        <div class="stat-card">
            <h4>Gehörte Artists (${yLabel})</h4>
            <div class="val">${data.total_artists.toLocaleString()}</div>
        </div>
        <div class="stat-card">
            <h4>Erst-Entdeckungen (${yLabel})</h4>
            <div class="val" style="color:var(--green);">${data.new_discovered_artists.length}</div>
            <div style="font-size:0.8rem; color:var(--muted);">Nie zuvor gehört</div>
        </div>
        <div class="stat-card">
            <h4>Verpasste Perlen</h4>
            <div class="val">${data.missed_tracks.length}</div>
            <div style="font-size:0.8rem; color:var(--muted);">Aus anderen Jahren</div>
        </div>
        <div class="stat-card">
            <h4>Nostalgie / Vergessen</h4>
            <div class="val" style="color:#ff9f43;">${data.forgotten_gems.length}</div>
            <div style="font-size:0.8rem; color:var(--muted);">Seitdem nie wieder gehört</div>
        </div>
    `;
    statsContainer.classList.remove("hidden");

    // 2. New Discovered Artists
    const newArtSec = document.getElementById("disc-new-artists-section");
    const newArtList = document.getElementById("disc-new-artists-list");
    if (data.new_discovered_artists && data.new_discovered_artists.length > 0) {
        newArtList.innerHTML = data.new_discovered_artists.map((a, i) => `
            <div class="card" style="padding:0.75rem 1rem; display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="searchArtist('${a.artist.replace(/'/g, "\'")}')">
                <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:0.5rem;">
                    <strong style="color:var(--text); font-size:0.9rem;">${i+1}. ${a.artist}</strong><br>
                    <small style="color:var(--green); font-size:0.75rem;">Neu in ${a.year !== undefined && a.year !== null ? a.year : yLabel} entdeckt</small>
                </div>
                <div style="text-align:right; font-size:0.8rem; color:var(--muted); white-space:nowrap;">
                    ${a.play_count} Plays<br><small>${a.total_min}m</small>
                </div>
            </div>
        `).join("");
        newArtSec.classList.remove("hidden");
    } else {
        newArtSec.classList.add("hidden");
    }

    // 3. Missed Tracks
    const missedSec = document.getElementById("disc-missed-section");
    const missedList = document.getElementById("disc-missed-list");
    if (data.missed_tracks && data.missed_tracks.length > 0) {
        missedList.innerHTML = data.missed_tracks.map((s, i) => `
            <div class="card" style="padding:0.9rem; display:flex; flex-direction:column; justify-content:space-between;">
                <div>
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.3rem;">
                        <span class="badge badge-similar" style="font-size:0.7rem;">Top Artist Match</span>
                        <button class="copy-btn" onclick="copyText('${s.artist.replace(/'/g, "\'")} - ${s.track.replace(/'/g, "\'")}', this)">${icon("copy")}</button>
                    </div>
                    <strong style="font-size:0.95rem; color:var(--text);">${s.track}</strong><br>
                    <span style="color:var(--muted); font-size:0.85rem;">${s.artist}</span>
                </div>
                <div style="margin-top:0.75rem; font-size:0.75rem; color:var(--muted); display:flex; justify-content:space-between;">
                    <span>${s.play_count} Plays in anderen Jahren</span>
                    <span style="color:var(--green);">Score: ${s.engagement_score.toFixed(2)}</span>
                </div>
            </div>
        `).join("");
        missedSec.classList.remove("hidden");
    } else {
        missedSec.classList.add("hidden");
    }

    // 4. Forgotten Gems (Nostalgie)
    const forgSec = document.getElementById("disc-forgotten-section");
    const forgList = document.getElementById("disc-forgotten-list");
    if (data.forgotten_gems && data.forgotten_gems.length > 0) {
        forgList.innerHTML = data.forgotten_gems.map((g, i) => `
            <div class="card" style="padding:0.75rem 1rem; border-left:3px solid #ff9f43; display:flex; justify-content:space-between; align-items:center;">
                <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:0.5rem;">
                    <strong style="color:var(--text); font-size:0.9rem;">${g.track}</strong><br>
                    <small style="color:var(--muted);">${g.artist}</small>
                </div>
                <div style="text-align:right; font-size:0.8rem; white-space:nowrap;">
                    <span style="color:#ff9f43; font-weight:600;">${g.play_count}x früher</span><br>
                    <small style="color:var(--muted);">Danach 0x</small>
                </div>
            </div>
        `).join("");
        forgSec.classList.remove("hidden");
    } else {
        forgSec.classList.add("hidden");
    }

    lucide.createIcons();
});

function searchArtist(artistName) {
    const artistTabBtn = document.querySelector('[data-tab="artists"]');
    if(artistTabBtn) {
        artistTabBtn.click();
        document.getElementById("artist-input").value = artistName;
        document.getElementById("artist-btn").click();
    }
}

async function loadDiscoverTimeline() {
    if(allTimelineData.length === 0) {
        const data = await apiCall("/api/discoveries");
        if(!data || data.error) return;
        allTimelineData = data;
    }
    renderTimeline(allTimelineData);
}

function renderTimeline(list) {
    const container = document.getElementById("disc-timeline");
    if(!list || list.length === 0) {
        container.innerHTML = "<p style='color:var(--muted); font-size:0.85rem;'>Keine Künstler gefunden.</p>";
        return;
    }
    container.innerHTML = list.slice(0, 150).map((d, i) => `
        <div class="card" style="padding:0.75rem 1rem; display:flex; justify-content:space-between; align-items:center; background:var(--surface2); border:1px solid var(--border);">
            <div style="display:flex; align-items:center; gap:0.75rem; overflow:hidden;">
                <span style="font-size:0.75rem; font-weight:700; color:var(--muted); min-width:28px;">#${i+1}</span>
                <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    <strong style="color:var(--text); font-size:0.95rem; cursor:pointer;" onclick="searchArtist('${d.artist.replace(/'/g, "\'")}')">${d.artist}</strong><br>
                    <span style="font-size:0.8rem; color:var(--green);"><i data-lucide="play" style="width:10px;height:10px;"></i> ${d.first_track}</span>
                    ${d.first_album ? `<small style="color:var(--muted);"> (${d.first_album})</small>` : ''}
                </div>
            </div>
            <div style="text-align:right; font-size:0.8rem; white-space:nowrap; margin-left:0.5rem;">
                <span style="font-weight:600; color:var(--text);">${d.first_heard}</span><br>
                <small style="color:var(--muted);">${d.total_plays_ever} Plays bisher</small>
            </div>
        </div>
    `).join("");
    lucide.createIcons();
}

document.getElementById("disc-timeline-search")?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    if(!q) renderTimeline(allTimelineData);
    else {
        const filtered = allTimelineData.filter(d => 
            d.artist.toLowerCase().includes(q) || 
            (d.first_track && d.first_track.toLowerCase().includes(q))
        );
        renderTimeline(filtered);
    }
});

// ── MODULE: Monthly ──
let _monthlyCharts = {};
function _destroyMonthlyCharts() {
    Object.values(_monthlyCharts).forEach(c => { try { c.destroy(); } catch(e){} });
    _monthlyCharts = {};
}

async function loadMonthly() {
    _destroyMonthlyCharts();
    showLoader("Lade Monatsdaten...");
    const data = await apiCall("/api/monthly_v2?year=" + document.getElementById("monthly-year").value);
    hideLoader();
    if (!data || data.error || !data.months) return;

    document.getElementById("monthly-results").classList.remove("hidden");

    // ── Chart 1: Hörzeit + Streams ──
    const ctx = document.getElementById("monthly-chart")?.getContext("2d");
    if (ctx) {
        _monthlyCharts['main'] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.months,
                datasets: [
                    { label:'Hörzeit', data:data.minutes, backgroundColor:'#1db954', borderRadius:4, yAxisID:'y', order:2 },
                    { label:'Streams', data:data.streams, type:'line', borderColor:'#5b8def', backgroundColor:'rgba(91,141,239,0.15)', fill:false, tension:0.3, yAxisID:'y1', order:1, pointRadius:4, pointBackgroundColor:'#5b8def', pointBorderColor:'#000', pointBorderWidth:1, borderWidth:2.5 }
                ]
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode:'index', intersect:false },
                plugins: {
                    legend: { labels: { color:'#888', font:{ size:11 } } },
                    tooltip: { callbacks: { label: ctx => ctx.dataset.label === 'Hörzeit'
                        ? ` Hörzeit: ${ctx.raw >= 120 ? (ctx.raw/60).toFixed(1)+'h' : ctx.raw.toFixed(0)+' min'}`
                        : ` Streams: ${ctx.raw.toLocaleString()}` } }
                },
                scales: {
                    x: { grid:{color:'#1a1a1a'}, ticks:{color:'#666'} },
                    y: { position:'left', grid:{color:'#1a1a1a'}, ticks:{color:'#888', callback:v => v>=120?(v/60).toFixed(0)+'h':v.toFixed(0)+'m'} },
                    y1: { position:'right', grid:{drawOnChartArea:false}, ticks:{color:'#5b8def', callback:v=>v.toLocaleString()} }
                }
            }
        });
    }

    // ── Chart 2: Unique Artists ──
    const ctxA = document.getElementById("monthly-artists-chart")?.getContext("2d");
    if (ctxA) {
        _monthlyCharts['artists'] = new Chart(ctxA, {
            type: 'line',
            data: {
                labels: data.months,
                datasets: [
                    { label:'Artists', data:data.unique_artists, borderColor:'#ff9f43', backgroundColor:'rgba(255,159,67,0.12)', fill:true, tension:0.3, pointRadius:4, pointBackgroundColor:'#ff9f43' },
                    { label:'Tracks', data:data.unique_tracks, borderColor:'#9b5de5', backgroundColor:'rgba(155,93,229,0.08)', fill:true, tension:0.3, pointRadius:4, pointBackgroundColor:'#9b5de5' }
                ]
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode:'index', intersect:false },
                plugins: { legend:{ position:'top', labels:{color:'#888',font:{size:10}} } },
                scales: {
                    x: { grid:{color:'#1a1a1a'}, ticks:{color:'#666',font:{size:10}} },
                    y: { grid:{color:'#1a1a1a'}, ticks:{color:'#666',font:{size:10}} }
                }
            }
        });
    }

    // ── Chart 3: Skip-Rate Trend ──
    const ctxS = document.getElementById("monthly-skip-chart")?.getContext("2d");
    if (ctxS) {
        _monthlyCharts['skip'] = new Chart(ctxS, {
            type: 'line',
            data: {
                labels: data.months,
                datasets: [{
                    data: data.skip_rates,
                    borderColor:'#e5534b', backgroundColor:'rgba(229,83,75,0.12)', fill:true, tension:0.4,
                    pointRadius:4, pointBackgroundColor:'#e5534b', pointBorderColor:'#000', pointBorderWidth:1
                }]
            },
            options: {
                maintainAspectRatio: false,
                plugins: { legend:{display:false}, tooltip:{ callbacks:{ label: ctx => ` ${ctx.raw}% Skip-Rate in ${data.months[ctx.dataIndex]}` } } },
                scales: {
                    x: { grid:{color:'#1a1a1a'}, ticks:{color:'#666',font:{size:10}} },
                    y: { grid:{color:'#1a1a1a'}, ticks:{color:'#666',font:{size:10}, callback:v=>v+'%'}, min:0 }
                }
            }
        });
    }

    // ── Top Song per Month table ──
    document.getElementById("monthly-top-songs").innerHTML = data.months.map((m, i) => {
        const s = data.top_songs[i];
        if (!s) return '';
        const safe = str => (str||'').split("'").join("\'");
        return `
        <div style="display:flex;align-items:center;gap:0.75rem;padding:0.45rem 0.4rem;border-bottom:1px solid var(--border);cursor:pointer;border-radius:5px;transition:background 0.15s;"
             onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''"
             onclick="openSongDetail('${safe(s.track)}','${safe(s.artist)}')">
            <div style="font-size:0.78rem;font-weight:700;color:var(--green);min-width:28px;">${m}</div>
            <div style="flex:1;overflow:hidden;">
                <div style="font-size:0.88rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.track}</div>
                <div style="font-size:0.75rem;color:var(--muted);">${s.artist}</div>
            </div>
            <div style="font-size:0.8rem;color:var(--green);font-weight:600;flex-shrink:0;">${s.count}x</div>
            <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--border);flex-shrink:0;"></i>
        </div>`;
    }).join('');
    lucide.createIcons();
}


// ── MODULE: Sessions ──
let _sessionCharts = {};
function _destroySessionCharts() {
    Object.values(_sessionCharts).forEach(c => { try { c.destroy(); } catch(e){} });
    _sessionCharts = {};
}

const CHART_OPTS = {
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
        x: { grid: { color: '#1a1a1a' }, ticks: { color: '#666', font: { size: 10 } } },
        y: { grid: { color: '#1a1a1a' }, ticks: { color: '#666', font: { size: 10 } } }
    }
};

async function loadSessions() {
    _destroySessionCharts();
    showLoader("Lade Sessions...");
    const year = document.getElementById("sessions-year")?.value || "all";
    const data = await apiCall("/api/sessions_v2?year=" + year);
    hideLoader();
    if (!data || data.error) return;

    document.getElementById("sessions-results").classList.remove("hidden");

    const fmtMin = v => v >= 120 ? (v/60).toFixed(1)+'h' : v.toFixed(0)+'min';
    const peakWd = ["Mo","Di","Mi","Do","Fr","Sa","So"];

    // ── Stat cards ──
    document.getElementById("sessions-stats").innerHTML = `
        <div class="stat-card">
            <h4>Gesamt Sessions</h4>
            <div class="val">${data.total_sessions.toLocaleString()}</div>
        </div>
        <div class="stat-card">
            <h4>Ø Session-Länge</h4>
            <div class="val">${fmtMin(data.avg_session_min)}</div>
            <div style="font-size:0.78rem;color:var(--muted);">${data.avg_tracks_per_session.toFixed(1)} Songs/Session</div>
        </div>
        <div class="stat-card">
            <h4>Längste Session</h4>
            <div class="val">${fmtMin(data.longest_session_min)}</div>
            <div style="font-size:0.78rem;color:var(--muted);">${data.longest_session_start}</div>
        </div>
        <div class="stat-card">
            <h4>Listening-Streak</h4>
            <div class="val">${data.max_streak_days}<span style="font-size:1rem;"> Tage</span></div>
            <div style="font-size:0.78rem;color:var(--muted);">${data.total_days} Tage mit Musik</div>
        </div>
    `;
    lucide.createIcons();

    // ── Chart 1: Histogram ──
    const ctxH = document.getElementById("sessions-chart")?.getContext("2d");
    if (ctxH) {
        const hist = data.session_length_histogram;
        _sessionCharts['hist'] = new Chart(ctxH, {
            type: 'bar',
            data: {
                labels: Object.keys(hist),
                datasets: [{ data: Object.values(hist), backgroundColor: ['#5b8def','#1db954','#f9c22e','#ff9f43','#e5534b'], borderRadius: 6 }]
            },
            options: { ...CHART_OPTS, plugins: { ...CHART_OPTS.plugins,
                tooltip: { callbacks: { label: ctx => ` ${ctx.raw} Sessions` } }
            }}
        });
    }

    // ── Chart 2: Sessions by Weekday ──
    const ctxWd = document.getElementById("sessions-weekday-chart")?.getContext("2d");
    if (ctxWd) {
        _sessionCharts['weekday'] = new Chart(ctxWd, {
            type: 'bar',
            data: {
                labels: data.weekday_labels,
                datasets: [{ data: data.weekday_counts, backgroundColor: '#1db954', borderRadius: 6 }]
            },
            options: { ...CHART_OPTS, plugins: { ...CHART_OPTS.plugins,
                tooltip: { callbacks: { label: ctx => ` ${ctx.raw} Sessions` } }
            }}
        });
    }

    // ── Chart 3: Sessions by Start Hour ──
    const ctxHr = document.getElementById("sessions-hour-chart")?.getContext("2d");
    if (ctxHr) {
        const hourLabels = Array.from({length:24},(_,i)=>i+'h');
        _sessionCharts['hour'] = new Chart(ctxHr, {
            type: 'line',
            data: {
                labels: hourLabels,
                datasets: [{ data: data.sessions_by_hour, borderColor:'#5b8def', backgroundColor:'rgba(91,141,239,0.15)', fill:true, tension:0.4, pointRadius:3 }]
            },
            options: { ...CHART_OPTS, plugins: { ...CHART_OPTS.plugins,
                tooltip: { callbacks: { label: ctx => ` ${ctx.raw} Sessions um ${ctx.label}` } }
            }}
        });
    }

    // ── Chart 4: Avg Duration by Weekday ──
    const ctxDur = document.getElementById("sessions-weekday-dur-chart")?.getContext("2d");
    if (ctxDur) {
        const vals = data.weekday_avg_dur;
        _sessionCharts['wddur'] = new Chart(ctxDur, {
            type: 'bar',
            data: {
                labels: data.weekday_labels,
                datasets: [{ data: vals, backgroundColor: vals.map(v => v > 30 ? '#1db954' : v > 15 ? '#f9c22e' : '#5b8def'), borderRadius: 6 }]
            },
            options: { ...CHART_OPTS, plugins: { ...CHART_OPTS.plugins,
                tooltip: { callbacks: { label: ctx => ` Ø ${ctx.raw >= 60 ? (ctx.raw/60).toFixed(1)+'h' : ctx.raw+'min'}` } }
            }, scales: { ...CHART_OPTS.scales,
                y: { ...CHART_OPTS.scales.y, ticks: { ...CHART_OPTS.scales.y.ticks, callback: v => v+'m' } }
            }}
        });
    }
}


// ── MODULE: Platforms ──
async function loadPlatforms() {
    showLoader("Lade...");
    const data = await apiCall("/api/platforms?year=" + document.getElementById("platforms-year").value);
    hideLoader();
    if (data.error || !data.platforms) return;
    
    if(state.charts['platforms']) state.charts['platforms'].destroy();
    const ctx = document.getElementById("platforms-chart").getContext("2d");
    state.charts['platforms'] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: data.platforms.map(p => p.name),
            datasets: [{ data: data.platforms.map(p => p.minutes), backgroundColor: ['#1db954', '#5b8def', '#e5534b', '#f9c22e', '#9b5de5'], borderWidth: 0 }]
        },
        options: {
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
                legend: { position: 'bottom', labels: { color: '#888', font: { size: 10 } } },
                tooltip: { callbacks: {
                    label: ctx => {
                        const v = ctx.raw;
                        return ` ${ctx.label}: ${v >= 120 ? (v/60).toFixed(1)+'h' : v.toFixed(0)+' min'} (${ctx.dataset.data[ctx.dataIndex] && (ctx.raw / ctx.dataset.data.reduce((a,b)=>a+b,0)*100).toFixed(1)}%)`;
                    }
                }}
            }
        }
    });
    
    document.getElementById("platforms-table").innerHTML = data.platforms.map(p => `
        <div class="skip-row">
            <div><strong>${p.name}</strong></div>
            <div>${p.minutes >= 120 ? (p.minutes/60).toFixed(1)+'h' : p.minutes.toFixed(0)+' min'}</div>
            <div style="color:var(--muted);">${p.pct.toFixed(1)}%</div>
        </div>
    `).join("");
}


// ── MODULE: Albums ──
let _albumsData = [];

function _renderAlbums() {
    const filter = (document.getElementById("albums-filter")?.value || "").toLowerCase();
    const sortKey = document.getElementById("albums-sort")?.value || "play_count";
    let data = _albumsData.filter(a =>
        a.album.toLowerCase().includes(filter) ||
        a.artist.toLowerCase().includes(filter)
    );
    data = [...data].sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));

    const maxPlays = Math.max(...data.map(a => a.play_count), 1);

    // ── Top 3 podium ──
    const top3 = data.slice(0, 3);
    const medals = ["🥇", "🥈", "🥉"];
    const medalColors = ["#f9c22e", "#aaa", "#cd7f32"];
    document.getElementById("albums-top3").innerHTML = top3.length ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem;margin-bottom:0.5rem;">
            ${top3.map((a, i) => {
                const qStr = `${a.artist} ${a.album}`.replace(/"/g, "&quot;");
                return `
                <div style="background:var(--surface2);border:1px solid ${i===0?'rgba(249,194,46,0.4)':'var(--border)'};border-radius:12px;padding:1rem;cursor:pointer;transition:border-color 0.2s;"
                     onmouseover="this.style.borderColor='${medalColors[i]}40'" onmouseout="this.style.borderColor='${i===0?'rgba(249,194,46,0.4)':'var(--border)'}'"
                     onclick="openAlbumDetail('${a.album.replace(/'/g,"\'")}','${a.artist.replace(/'/g,"\'")}')">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.6rem;">
                        <span style="font-size:1.5rem;">${medals[i]}</span>
                        <div class="cover-box" data-uri="${a.uri || ''}" data-query="${qStr}" style="width:58px; height:58px; border-radius:8px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; font-size:1.8rem; overflow:hidden; box-shadow:0 3px 8px rgba(0,0,0,0.35);">
                            💿
                        </div>
                    </div>
                    <div style="font-size:0.95rem;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.album}</div>
                    <div style="font-size:0.8rem;color:var(--muted);margin:0.2rem 0 0.6rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.artist}</div>
                    <div style="display:flex;justify-content:space-between;font-size:0.8rem;">
                        <span style="color:var(--green);font-weight:700;">${a.play_count} Plays</span>
                        <span style="color:var(--muted);">${a.total_minutes.toFixed(0)} min</span>
                    </div>
                    <div style="margin-top:0.5rem;height:4px;background:var(--border);border-radius:2px;">
                        <div style="height:4px;background:${medalColors[i]};border-radius:2px;width:${(a.play_count/maxPlays*100).toFixed(0)}%;"></div>
                    </div>
                </div>
            `}).join("")}
        </div>
    ` : "";

    // ── Rest of list ──
    const rest = data.slice(3);
    document.getElementById("albums-list").innerHTML = rest.length ? `
        <div style="display:flex;flex-direction:column;gap:0.3rem;">
            ${rest.map((a, i) => {
                const barW = Math.max(3, (a.play_count / maxPlays * 100)).toFixed(0);
                const qStr = `${a.artist} ${a.album}`.replace(/"/g, "&quot;");
                return `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.55rem 0.7rem;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:all 0.15s;"
                     onmouseover="this.style.background='var(--surface2)';this.style.borderColor='var(--border)'" 
                     onmouseout="this.style.background='';this.style.borderColor='transparent'"
                     onclick="openAlbumDetail('${a.album.replace(/'/g,"\'")}','${a.artist.replace(/'/g,"\'")}')">
                    <span style="font-size:0.72rem;color:var(--muted);min-width:24px;text-align:right;">#${i+4}</span>
                    <div class="cover-box" data-uri="${a.uri || ''}" data-query="${qStr}" style="width:38px; height:38px; border-radius:6px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; font-size:1.1rem; overflow:hidden; flex-shrink:0; box-shadow:0 2px 4px rgba(0,0,0,0.3);">
                        💿
                    </div>
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:baseline;gap:0.4rem;">
                            <strong style="font-size:0.9rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.album}</strong>
                        </div>
                        <div style="font-size:0.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.artist}</div>
                        <div style="margin-top:0.3rem;height:3px;background:var(--border);border-radius:2px;max-width:300px;">
                            <div style="height:3px;background:var(--green);border-radius:2px;width:${barW}%;opacity:0.7;"></div>
                        </div>
                    </div>
                    <div style="text-align:right;white-space:nowrap;flex-shrink:0;">
                        <div style="font-size:0.88rem;font-weight:700;color:var(--green);">${a.play_count}x</div>
                        <div style="font-size:0.75rem;color:var(--muted);">${a.total_minutes.toFixed(0)} min · ${a.unique_tracks} Tracks</div>
                    </div>
                    <i data-lucide="chevron-right" style="width:14px;height:14px;color:var(--border);flex-shrink:0;"></i>
                </div>`;
            }).join("")}
        </div>
    ` : (data.length <= 3 && data.length > 0 ? "" : `<p style="color:var(--muted);font-size:0.85rem;text-align:center;padding:1rem 0;">Keine Alben gefunden.</p>`);

    document.querySelectorAll("#panel-albums .cover-box").forEach(el => _loadCoverArt(el));
    lucide.createIcons();
}

async function loadAlbums() {
    showLoader("Lade Alben...");
    const data = await apiCall("/api/albums?year=" + (document.getElementById("albums-year").value || "all") + "&top_n=50");
    hideLoader();
    if (data.error) return;
    _albumsData = data;
    _renderAlbums();
}

document.getElementById("albums-filter")?.addEventListener("input", _renderAlbums);
document.getElementById("albums-sort")?.addEventListener("change", _renderAlbums);

// ── MODULE: Behavior & Loops ──
document.getElementById("behavior-btn").addEventListener("click", async () => {
    showLoader("Analysiere Hörverhalten & Dauerschleifen...");
    const year = document.getElementById("behavior-year").value;
    const data = await apiCall("/api/behavior?year=" + year);
    hideLoader();
    if(data.error) return alert("Fehler: " + data.error);

    // 1. Stats Summary
    document.getElementById("behavior-stats-summary").innerHTML = `
        <div class="stat-card">
            <h4>Gesamte Streams</h4>
            <div class="val">${data.total_streams.toLocaleString()}</div>
            <div style="font-size:0.8rem; color:var(--muted);">${data.total_hours.toLocaleString()} h Musik</div>
        </div>
        <div class="stat-card">
            <h4>Shuffle-Nutzung</h4>
            <div class="val">${data.shuffle.pct}%</div>
            <div style="font-size:0.8rem; color:var(--muted);">${data.shuffle.on.toLocaleString()}x Shuffle an / ${data.shuffle.off.toLocaleString()}x aus</div>
        </div>
        <div class="stat-card">
            <h4>Offline-Modus</h4>
            <div class="val">${data.offline.pct}%</div>
            <div style="font-size:0.8rem; color:var(--muted);">${data.offline.plays.toLocaleString()} Songs offline gehört</div>
        </div>
        <div class="stat-card">
            <h4>Größte Loop-Obsession</h4>
            <div class="val" style="font-size:1.1rem; color:var(--green);">${data.top_loops.length ? data.top_loops[0].track : 'Keine'}</div>
            <div style="font-size:0.8rem; color:var(--muted);">${data.top_loops.length ? data.top_loops[0].loop_count + 'x in Dauerschleife (' + data.top_loops[0].loop_min + ' Min)' : ''}</div>
        </div>
    `;

    // 2. Dayparts Doughnut Chart
    if(state.charts['behavior_dayparts']) state.charts['behavior_dayparts'].destroy();
    const ctxDp = document.getElementById("behavior-dayparts-chart").getContext("2d");
    state.charts['behavior_dayparts'] = new Chart(ctxDp, {
        type: 'doughnut',
        data: {
            labels: data.dayparts.map(d => d.name),
            datasets: [{
                data: data.dayparts.map(d => d.count),
                backgroundColor: ['#5b8def', '#f9c22e', '#ff9f43', '#1db954'],
                borderWidth: 0
            }]
        },
        options: {
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
                legend: { position: 'bottom', labels: { color: '#888', font: { size: 10 }, boxWidth: 12 } },
                tooltip: { callbacks: {
                    label: ctx => ` ${ctx.label}: ${ctx.raw.toLocaleString()} Streams (${(ctx.raw / ctx.dataset.data.reduce((a,b)=>a+b,0) * 100).toFixed(1)}%)`
                }}
            }
        }
    });

    // 3. Reason End Bar Chart (Warum stoppst du Songs?)
    if(state.charts['behavior_reason_end']) state.charts['behavior_reason_end'].destroy();
    const ctxRe = document.getElementById("behavior-reason-end-chart").getContext("2d");
    state.charts['behavior_reason_end'] = new Chart(ctxRe, {
        type: 'bar',
        data: {
            labels: data.end_breakdown.map(e => e.label),
            datasets: [{
                label: 'Streams',
                data: data.end_breakdown.map(e => e.count),
                backgroundColor: ['#1db954', '#e5534b', '#f9c22e', '#5b8def', '#9b5de5', '#888'],
                borderRadius: 4
            }]
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: '#888', font: { size: 9 }, maxRotation: 20 }, grid: { color: '#1a1a1a' } },
                y: { grid: { color: '#2a2a2a' }, ticks: { color: '#888', callback: v => v.toLocaleString() } }
            },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toLocaleString()} Streams` } }
            }
        }
    });

    // 4. Loop Obsessions List
    document.getElementById("behavior-loops-list").innerHTML = data.top_loops.map((l, i) => `
        <div class="skip-row" style="padding:0.6rem 0;">
            <div style="flex:0.2; font-weight:bold; color:var(--green);">#${i+1}</div>
            <div style="flex:2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <strong>${l.track}</strong><br>
                <small style="color:var(--muted)">${l.artist}</small>
            </div>
            <div style="text-align:right;">
                <span class="badge" style="background:rgba(29,185,84,0.15); color:var(--green); border:1px solid rgba(29,185,84,0.3); font-size:0.75rem;">
                    ${l.loop_count}x direkt geloopt
                </span><br>
                <small style="color:var(--muted);">${l.loop_min} Min</small>
            </div>
        </div>
    `).join("") || "<p style='color:var(--muted); font-size:0.85rem;'>Keine Dauerschleifen in diesem Zeitraum.</p>";

    // 5. Start Triggers List
    document.getElementById("behavior-start-list").innerHTML = data.start_breakdown.map(s => `
        <div class="skip-row" style="padding:0.6rem 0;">
            <div style="flex:2;"><strong>${s.label}</strong></div>
            <div style="text-align:right;">
                <span style="font-weight:bold; color:var(--text);">${s.count.toLocaleString()}</span>
                <small style="color:var(--muted);"> (${s.pct}%)</small>
            </div>
        </div>
    `).join("");

    document.getElementById("behavior-results").classList.remove("hidden");
    lucide.createIcons();
});



// ── MODULE: Song Detail Modal (Redesign) ──
let _songDetailCharts = {};

function _destroySongCharts() {
    Object.values(_songDetailCharts).forEach(c => { try { c.destroy(); } catch(e){} });
    _songDetailCharts = {};
}

async function openSongDetail(track, artist) {
    _destroySongCharts();
    const modal = document.getElementById("song-detail-modal");
    document.getElementById("song-modal-title").textContent = track;
    const safeA = (artist || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
    document.getElementById("song-modal-artist").innerHTML = `<span style="color:var(--muted);">von</span> <strong style="color:var(--text); cursor:pointer;" onclick="_closeSongModal(); searchArtist('${safeA}')" title="Zu ${artist} springen">${artist} <i data-lucide="arrow-right" style="width:11px;height:11px;vertical-align:middle;opacity:0.5;"></i></strong>`;
    document.getElementById("song-modal-body").innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;padding:3rem 0;color:var(--muted);">
            <div class="spinner" style="width:32px;height:32px;border-width:2px;"></div>
            <span style="font-size:0.85rem;">Lade Song-Daten...</span>
        </div>`;
    modal.classList.remove("hidden");

    const data = await apiCall("/api/song", "POST", { track, artist });
    if (!data || data.error || !data.track) {
        document.getElementById("song-modal-body").innerHTML = '<div style="color:#e5534b;padding:1.5rem;text-align:center;">Keine Daten gefunden.</div>';
        return;
    }

    const spotifyBtn = data.spotify_url
        ? `<a href="${data.spotify_url}" target="_blank" class="btn btn-primary" style="font-size:0.82rem;padding:0.45rem 1rem;gap:0.4rem;">
             <i data-lucide="external-link" style="width:13px;height:13px;"></i> Auf Spotify
           </a>`
        : "";

    const skipColor = data.skip_rate > 60 ? '#e5534b' : data.skip_rate > 35 ? '#f9c22e' : 'var(--green)';
    const completionColor = data.completion_rate > 60 ? 'var(--green)' : data.completion_rate > 35 ? '#f9c22e' : '#e5534b';
    const loopBadge = data.consecutive_repeats > 10
        ? `<div style="background:rgba(29,185,84,0.12);border:1px solid rgba(29,185,84,0.35);border-radius:8px;padding:0.5rem 0.85rem;display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;">
               <i data-lucide="repeat" style="width:14px;height:14px;color:var(--green);"></i>
               <span><strong style="color:var(--green);font-size:1.05rem;">${data.consecutive_repeats.toLocaleString()}x</strong> <span style="color:var(--muted);">auf Dauerschleife geloopt</span></span>
           </div>`
        : "";

    const songQueryStr = `${data.artist} ${data.track}`.replace(/"/g, '&quot;');
    document.getElementById("song-modal-body").innerHTML = `
        <!-- Header with big cover art -->
        <div style="display:flex; gap:1.2rem; align-items:center; margin-bottom:1.25rem; padding-bottom:1rem; border-bottom:1px solid var(--border); flex-wrap:wrap;">
            <div class="cover-box" data-uri="${data.uri || ''}" data-query="${songQueryStr}" style="width:84px; height:84px; border-radius:10px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; font-size:2.2rem; overflow:hidden; flex-shrink:0; box-shadow:0 4px 12px rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.08);">
                🎵
            </div>
            <div style="flex:1; min-width:180px;">
                <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.4rem;">
                    ${data.album ? `<span style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:0.78rem;color:var(--muted);padding:0.25rem 0.6rem;display:inline-flex;align-items:center;gap:0.3rem;">
                        <i data-lucide="disc" style="width:11px;height:11px;"></i> ${data.album}</span>` : ""}
                    <span style="font-size:0.78rem;color:var(--muted);">Erstmals: <strong style="color:var(--text);">${data.first_played}</strong></span>
                    <span style="font-size:0.78rem;color:var(--muted);">Zuletzt: <strong style="color:var(--text);">${data.last_played}</strong></span>
                </div>
                <div style="font-size:0.85rem; color:var(--green); font-weight:600; cursor:pointer;" onclick="_closeSongModal(); searchArtist('${safeA}')" title="Zu ${data.artist} springen">
                    <i data-lucide="mic-2" style="width:13px;height:13px;vertical-align:middle;"></i> Mehr von ${data.artist} <i data-lucide="arrow-right" style="width:12px;height:12px;vertical-align:middle;"></i>
                </div>
            </div>
            <div>
                ${spotifyBtn}
            </div>
        </div>

        <!-- Hero stats row -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:0.6rem;margin-bottom:1rem;">
            <div class="song-modal-stat" style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.8rem;text-align:center;">
                <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;">Plays</div>
                <div style="font-size:1.6rem;font-weight:800;color:var(--green);line-height:1;">${data.play_count.toLocaleString()}</div>
                <div style="font-size:0.72rem;color:var(--muted);margin-top:0.2rem;">${data.total_min} min</div>
            </div>
            <div class="song-modal-stat" style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.8rem;text-align:center;">
                <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;">Skip-Rate</div>
                <div style="font-size:1.6rem;font-weight:800;color:${skipColor};line-height:1;">${data.skip_rate}%</div>
                <div style="font-size:0.72rem;color:var(--muted);margin-top:0.2rem;">${data.skip_count}x geskippt</div>
            </div>
            <div class="song-modal-stat" style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.8rem;text-align:center;">
                <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;">Komplett</div>
                <div style="font-size:1.6rem;font-weight:800;color:${completionColor};line-height:1;">${data.completion_rate}%</div>
                <div style="font-size:0.72rem;color:var(--muted);margin-top:0.2rem;">durchgehört</div>
            </div>
            <div class="song-modal-stat" style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.8rem;text-align:center;">
                <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;">Loops</div>
                <div style="font-size:1.6rem;font-weight:800;color:var(--green);line-height:1;">${data.consecutive_repeats.toLocaleString()}</div>
                <div style="font-size:0.72rem;color:var(--muted);margin-top:0.2rem;">in Reihe</div>
            </div>
        </div>

        ${loopBadge}

        <!-- Charts row -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-top:1rem;">
            <!-- Plays by year -->
            <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;min-width:0;">
                <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;">
                    <i data-lucide="bar-chart-2" style="width:12px;height:12px;"></i> Plays nach Jahr
                </div>
                <div style="position:relative;height:130px;"><canvas id="song-modal-year-chart"></canvas></div>
            </div>
            <!-- Dayparts doughnut -->
            <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;min-width:0;">
                <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;">
                    <i data-lucide="sun-moon" style="width:12px;height:12px;"></i> Wann hörst du ihn?
                </div>
                <div style="position:relative;height:130px;"><canvas id="song-modal-dayparts-chart"></canvas></div>
            </div>
        </div>

        <!-- Last.fm section placeholder -->
        <div id="song-modal-lfm-section" style="margin-top:1rem;"></div>

        <!-- Similar songs placeholder -->
        <div id="song-modal-similar" style="display:none;margin-top:1rem;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;">
            <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;">
                <i data-lucide="shuffle" style="width:12px;height:12px;"></i> Ähnliche Songs (Last.fm)
            </div>
            <div id="song-modal-similar-list"></div>
        </div>

        <!-- Platforms -->
        ${Object.keys(data.platforms||{}).length ? `
        <div style="margin-top:1rem;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;">
            <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.4rem;">
                <i data-lucide="monitor-smartphone" style="width:12px;height:12px;"></i> Genutzte Plattformen
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:0.4rem;">
                ${Object.entries(data.platforms).map(([p,c]) => `
                    <span style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:0.25rem 0.6rem;font-size:0.8rem;">
                        ${p}: <strong style="color:var(--green);">${c}x</strong>
                    </span>`).join("")}
            </div>
        </div>` : ""}
    `;

    modal.querySelectorAll(".cover-box").forEach(el => _loadCoverArt(el));
    lucide.createIcons();

    // Render Year Chart
    const years = Object.keys(data.plays_by_year || {}).sort();
    const yearVals = years.map(y => data.plays_by_year[y]);
    if (years.length > 0) {
        const ctxY = document.getElementById("song-modal-year-chart");
        if (ctxY) {
            _songDetailCharts['year'] = new Chart(ctxY.getContext("2d"), {
                type: 'bar',
                data: {
                    labels: years,
                    datasets: [{ data: yearVals, backgroundColor: '#1db954', borderRadius: 5 }]
                },
                options: {
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { callbacks: {
                        label: ctx => ` ${ctx.raw} Plays`
                    }}},
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#666', font: { size: 10 } } },
                        y: { grid: { color: '#222' }, ticks: { color: '#666', font: { size: 10 } } }
                    }
                }
            });
        }
    }

    // Render Dayparts Doughnut
    const dpEntries = Object.entries(data.dayparts || {});
    if (dpEntries.length > 0) {
        const ctxD = document.getElementById("song-modal-dayparts-chart");
        if (ctxD) {
            _songDetailCharts['dayparts'] = new Chart(ctxD.getContext("2d"), {
                type: 'doughnut',
                data: {
                    labels: dpEntries.map(([k]) => k.split(" ")[0]),
                    datasets: [{ data: dpEntries.map(([,v]) => v), backgroundColor: ['#5b8def','#f9c22e','#ff9f43','#1db954'], borderWidth: 0 }]
                },
                options: {
                    maintainAspectRatio: false,
                    cutout: '60%',
                    plugins: {
                        legend: { position: 'bottom', labels: { color: '#888', font: { size: 10 }, boxWidth: 10, padding: 8 } },
                        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw}x` } }
                    }
                }
            });
        }
    }

    // Last.fm enrichment
    if (state.lastfmKey) {
        const lfmSection = document.getElementById("song-modal-lfm-section");
        lfmSection.innerHTML = `<div style="font-size:0.8rem;color:var(--muted);padding:0.5rem 0;text-align:center;">Last.fm Daten werden geladen...</div>`;

        apiCall("/api/lastfm/track_stats", "POST", { artist: data.artist, track: data.track, key: state.lastfmKey }).then(lfm => {
            if (lfm && lfm.listeners) {
                const dur = lfm.duration_sec > 0 ? `${Math.floor(lfm.duration_sec/60)}:${String(lfm.duration_sec%60).padStart(2,'0')}` : null;
                lfmSection.innerHTML = `
                    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;">
                        <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;">
                            <i data-lucide="globe" style="width:12px;height:12px;"></i> Last.fm — Weltweit
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.5rem;">
                            <div style="text-align:center;">
                                <div style="font-size:1.2rem;font-weight:700;color:var(--text);">${Number(lfm.listeners).toLocaleString()}</div>
                                <div style="font-size:0.72rem;color:var(--muted);">Hörer</div>
                            </div>
                            <div style="text-align:center;">
                                <div style="font-size:1.2rem;font-weight:700;color:var(--text);">${Number(lfm.playcount).toLocaleString()}</div>
                                <div style="font-size:0.72rem;color:var(--muted);">Scrobbles</div>
                            </div>
                            <div style="text-align:center;">
                                <div style="font-size:1.2rem;font-weight:700;color:var(--text);">${dur || '—'}</div>
                                <div style="font-size:0.72rem;color:var(--muted);">Länge</div>
                            </div>
                        </div>
                    </div>`;
                lucide.createIcons();
            } else {
                lfmSection.innerHTML = "";
            }
        });

        apiCall("/api/lastfm/similar", "POST", { artist: data.artist, track: data.track, key: state.lastfmKey, limit: 5 }).then(sim => {
            const simWrap = document.getElementById("song-modal-similar");
            const simList = document.getElementById("song-modal-similar-list");
            if (simWrap && simList && sim && sim.tracks && sim.tracks.length > 0) {
                simList.innerHTML = sim.tracks.map(t => `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--border);cursor:pointer;"
                         onclick="_destroySongCharts();openSongDetail('${t.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','${t.artist.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">
                        <div>
                            <strong style="font-size:0.88rem;color:var(--text);">${t.name}</strong>
                            <span style="font-size:0.8rem;color:var(--muted);"> — ${t.artist}</span>
                        </div>
                        <i data-lucide="chevron-right" style="width:14px;height:14px;color:var(--muted);flex-shrink:0;"></i>
                    </div>`).join("");
simWrap.style.display = "block";
                lucide.createIcons();
            }
        });
    }
}


// ── MODULE: Album Detail Modal (Redesign) ──
let _albumDetailCharts = {};

function _destroyAlbumCharts() {
    Object.values(_albumDetailCharts).forEach(c => { try { c.destroy(); } catch(e){} });
    _albumDetailCharts = {};
}

async function openAlbumDetail(album, artist) {
    _destroyAlbumCharts();
    const modal = document.getElementById("album-detail-modal");
    document.getElementById("album-modal-title").textContent = album;
    const safeAlbumArtist = (artist || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
    document.getElementById("album-modal-artist").innerHTML = `<span style="color:var(--muted);">von</span> <strong style="color:var(--text); cursor:pointer;" onclick="document.getElementById('album-detail-modal').classList.add('hidden'); searchArtist('${safeAlbumArtist}')" title="Zu ${artist} springen">${artist} <i data-lucide="arrow-right" style="width:11px;height:11px;vertical-align:middle;opacity:0.5;"></i></strong>`;
    document.getElementById("album-modal-body").innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;padding:3rem 0;color:var(--muted);">
            <div class="spinner" style="width:32px;height:32px;border-width:2px;"></div>
            <span style="font-size:0.85rem;">Lade Album-Daten...</span>
        </div>`;
    modal.classList.remove("hidden");

    const data = await apiCall("/api/album_detail", "POST", { album, artist });
    if (!data || data.error || !data.album) {
        document.getElementById("album-modal-body").innerHTML = '<div style="color:#e5534b;padding:1.5rem;text-align:center;">Keine Daten gefunden.</div>';
        return;
    }

    const skipColor = data.skip_rate > 60 ? '#e5534b' : data.skip_rate > 35 ? '#f9c22e' : 'var(--green)';
    const maxPlays = Math.max(...(data.tracks||[]).map(t => t.play_count), 1);
    const albumQueryStr = `${data.artist} ${data.album}`.replace(/"/g, '&quot;');

    document.getElementById("album-modal-body").innerHTML = `
        <!-- Header with big cover art -->
        <div style="display:flex; gap:1.2rem; align-items:center; margin-bottom:1.25rem; padding-bottom:1rem; border-bottom:1px solid var(--border); flex-wrap:wrap;">
            <div class="cover-box" data-uri="${data.uri || ''}" data-query="${albumQueryStr}" style="width:84px; height:84px; border-radius:10px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; font-size:2.2rem; overflow:hidden; flex-shrink:0; box-shadow:0 4px 12px rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.08);">
                💿
            </div>
            <div style="flex:1; min-width:180px;">
                <div style="display:flex; gap:0.6rem; flex-wrap:wrap; font-size:0.78rem; color:var(--muted); margin-bottom:0.4rem;">
                    <span>Erstmals: <strong style="color:var(--text);">${data.first_played}</strong></span>
                    <span>Zuletzt: <strong style="color:var(--text);">${data.last_played}</strong></span>
                    <span><strong style="color:var(--text);">${data.unique_tracks}</strong> Tracks</span>
                </div>
                <div style="font-size:0.85rem; color:var(--green); font-weight:600; cursor:pointer;" onclick="document.getElementById('album-detail-modal').classList.add('hidden'); searchArtist('${safeAlbumArtist}')" title="Zu ${artist} springen">
                    <i data-lucide="mic-2" style="width:13px;height:13px;vertical-align:middle;"></i> Mehr von ${artist} <i data-lucide="arrow-right" style="width:12px;height:12px;vertical-align:middle;"></i>
                </div>
            </div>
        </div>

        <!-- Hero stats -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.6rem;margin-bottom:1.1rem;">
            <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;text-align:center;">
                <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;">Plays</div>
                <div style="font-size:1.6rem;font-weight:800;color:var(--green);line-height:1;">${data.play_count.toLocaleString()}</div>
            </div>
            <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;text-align:center;">
                <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;">Hörzeit</div>
                <div style="font-size:1.6rem;font-weight:800;color:var(--text);line-height:1;">${data.total_min}</div>
                <div style="font-size:0.72rem;color:var(--muted);">Minuten</div>
            </div>
            <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;text-align:center;">
                <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.3rem;">Skip-Rate</div>
                <div style="font-size:1.6rem;font-weight:800;color:${skipColor};line-height:1;">${data.skip_rate}%</div>
            </div>
        </div>

        <!-- Chart -->
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;margin-bottom:1rem;">
            <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;">
                <i data-lucide="bar-chart-2" style="width:12px;height:12px;"></i> Plays nach Jahr
            </div>
            <div style="position:relative;height:120px;"><canvas id="album-modal-year-chart"></canvas></div>
        </div>

        <!-- Track list -->
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:0.85rem;">
            <div style="font-size:0.75rem;color:var(--muted);text-transform:uppercase;margin-bottom:0.7rem;display:flex;align-items:center;gap:0.4rem;">
                <i data-lucide="music" style="width:12px;height:12px;"></i> Tracks — klicken für Details
            </div>
            ${(data.tracks || []).map((t, i) => {
                const barW = Math.max(4, (t.play_count / maxPlays * 100)).toFixed(0);
                const tSkipColor = t.skip_rate > 60 ? '#e5534b' : t.skip_rate > 35 ? '#f9c22e' : '#1db954';
                return `<div style="padding:0.6rem 0.5rem;border-bottom:1px solid var(--border);cursor:pointer;border-radius:6px;transition:background 0.15s;"
                     onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''"
                     onclick="_destroySongCharts();openSongDetail('${t.track.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','${data.artist.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.35rem;">
                        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:0.5rem;flex:1;">
                            <span style="font-size:0.75rem;color:var(--muted);margin-right:0.4rem;">${i+1}.</span>
                            <strong style="font-size:0.9rem;color:var(--text);">${t.track}</strong>
                        </div>
                        <div style="display:flex;align-items:center;gap:0.6rem;flex-shrink:0;font-size:0.8rem;">
                            <span style="color:var(--green);font-weight:600;">${t.play_count}x</span>
                            <span style="color:${tSkipColor};font-size:0.75rem;">${t.skip_rate}% skip</span>
                            <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);"></i>
                        </div>
                    </div>
                    <div style="height:4px;background:var(--border);border-radius:2px;">
                        <div style="height:4px;border-radius:2px;background:var(--green);width:${barW}%;transition:width 0.3s;"></div>
                    </div>
                </div>`;
            }).join("")}
        </div>
    `;

    modal.querySelectorAll(".cover-box").forEach(el => _loadCoverArt(el));
    lucide.createIcons();

    // Year chart
    const years = Object.keys(data.plays_by_year || {}).sort();
    const yearVals = years.map(y => data.plays_by_year[y]);
    if (years.length > 0) {
        const ctxY = document.getElementById("album-modal-year-chart");
        if (ctxY) {
            _albumDetailCharts['year'] = new Chart(ctxY.getContext("2d"), {
                type: 'bar',
                data: {
                    labels: years,
                    datasets: [{ data: yearVals, backgroundColor: '#1db954', borderRadius: 5 }]
                },
                options: {
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw} Plays` }}},
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#666', font: { size: 10 } } },
                        y: { grid: { color: '#222' }, ticks: { color: '#666', font: { size: 10 } } }
                    }
                }
            });
        }
    }
}

// ── Close handlers for Song & Album modals ──
function _closeSongModal() {
    try { _destroySongCharts(); } catch(e) {}
    document.getElementById("song-detail-modal").classList.add("hidden");
}
function _closeAlbumModal() {
    try { _destroyAlbumCharts(); } catch(e) {}
    document.getElementById("album-detail-modal").classList.add("hidden");
}

document.getElementById("song-modal-close").addEventListener("click", _closeSongModal);
document.getElementById("song-detail-modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("song-detail-modal")) _closeSongModal();
});

document.getElementById("album-modal-close").addEventListener("click", _closeAlbumModal);
document.getElementById("album-detail-modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("album-detail-modal")) _closeAlbumModal();
});

// ESC key closes the topmost open modal only - sind zwei Fenster gestapelt
// (Song im Album), soll nur das oberste verschwinden.
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("song-detail-modal").classList.contains("hidden")) {
        _closeSongModal();
        return;
    }
    if (!document.getElementById("album-detail-modal").classList.contains("hidden")) _closeAlbumModal();
    if (!document.getElementById("settings-modal").classList.contains("hidden"))
        document.getElementById("settings-modal").classList.add("hidden");
});

// ── MODULE: Song-Suche ──
let _searchTimeout = null;
document.getElementById("search-input")?.addEventListener("input", (e) => {
    clearTimeout(_searchTimeout);
    const q = e.target.value.trim();
    if (!q) {
        document.getElementById("search-results").innerHTML = '<p id="search-placeholder" style="color:var(--muted); font-size:0.9rem; text-align:center; padding:2rem 0;">Fang an zu tippen um Songs zu finden...</p>';
        return;
    }
    _searchTimeout = setTimeout(() => runSearch(q), 280);
});

async function runSearch(q) {
    const resultsEl = document.getElementById("search-results");
    resultsEl.innerHTML = '<p style="color:var(--muted); font-size:0.85rem; text-align:center; padding:1.5rem 0;">Suche...</p>';
    const data = await apiCall(`/api/search?q=${encodeURIComponent(q)}&top_n=30`);
    if (!data || data.error || data.length === 0) {
        resultsEl.innerHTML = `<p style="color:var(--muted); font-size:0.85rem; text-align:center; padding:1.5rem 0;">Keine Songs für "${q}" gefunden.</p>`;
        return;
    }
    resultsEl.innerHTML = `
        <div style="font-size:0.8rem; color:var(--muted); margin-bottom:0.75rem;">${data.length} Songs gefunden — klicke einen an für alle Details</div>
        ${data.map((s) => {
            const safeTrack = (s.track || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
            const safeArtist = (s.artist || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
            const qStr = `${s.artist} ${s.track}`.replace(/"/g, "&quot;");
            return `
            <div class="search-result-row" onclick="openSongDetail('${safeTrack}','${safeArtist}')">
                <div style="display:flex; justify-content:space-between; align-items:center; padding:0.65rem 0.85rem; border-bottom:1px solid var(--border); cursor:pointer; border-radius:8px; transition:background 0.15s; gap:0.85rem;">
                    <div class="cover-box" data-uri="${s.uri || ''}" data-query="${qStr}" style="width:44px; height:44px; border-radius:6px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; flex-shrink:0; overflow:hidden; font-size:1.2rem; box-shadow:0 2px 5px rgba(0,0,0,0.3);">
                        🎵
                    </div>
                    <div style="overflow:hidden; flex:1; min-width:0;">
                        <strong style="color:var(--text); font-size:0.92rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block;">${s.track}</strong>
                        <div style="color:var(--muted); font-size:0.8rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            <span>${s.artist}</span>
                            ${s.album ? `<span style="opacity:0.6;"> · ${s.album}</span>` : ""}
                        </div>
                    </div>
                    <div style="text-align:right; white-space:nowrap; flex-shrink:0;">
                        <span style="color:var(--green); font-weight:700; font-size:0.9rem;">${s.play_count}x</span><br>
                        <span style="color:var(--muted); font-size:0.75rem;">${s.total_min} min · Skip: ${s.skip_rate}%</span>
                    </div>
                </div>
            </div>
        `}).join("")}
    `;
    resultsEl.querySelectorAll(".cover-box").forEach(el => _loadCoverArt(el));
    lucide.createIcons();
}

// ── MODULE: Playlist-Builder & Mix-Generator ──
let _plCurrentMode = "song";
let _plSelectedSong = null;
let _plGeneratedTracks = [];
state.playlistBasket = JSON.parse(localStorage.getItem("wkmm_playlist_basket") || "[]");

function _saveBasket() {
    localStorage.setItem("wkmm_playlist_basket", JSON.stringify(state.playlistBasket));
    _renderBasket();
}

function _renderBasket() {
    const listEl = document.getElementById("pl-basket-items");
    const emptyEl = document.getElementById("pl-basket-empty");
    const metaEl = document.getElementById("pl-basket-meta");
    const badgeEl = document.getElementById("playlist-basket-badge");
    if (!listEl) return;

    const count = state.playlistBasket.length;
    if (badgeEl) badgeEl.textContent = `🛒 ${count} im Korb`;
    
    // Estimate total minutes (ca 3.5 min per track)
    const estMin = Math.round(count * 3.5);
    const estTimeStr = estMin >= 60 ? `${Math.floor(estMin / 60)}h ${estMin % 60}m` : `${estMin} min`;
    if (metaEl) metaEl.textContent = `${count} Songs · ca. ${estTimeStr}`;

    if (count === 0) {
        listEl.innerHTML = `
            <div id="pl-basket-empty" style="text-align:center; padding:2rem 1rem; color:var(--muted); font-size:0.85rem;">
                <i data-lucide="disc" style="width:32px; height:32px; opacity:0.3; margin-bottom:0.5rem; display:block; margin-left:auto; margin-right:auto;"></i>
                Dein Korb ist noch leer.<br>Generiere Tracks und klicke auf <strong>+</strong> um Songs hinzuzufügen.
            </div>`;
        lucide.createIcons();
        return;
    }

    listEl.innerHTML = state.playlistBasket.map((t, idx) => {
        const safeTrack = (t.track || "").replace(/'/g, "\'");
        const safeArtist = (t.artist || "").replace(/'/g, "\'");
        return `
            <div class="basket-item">
                <span style="color:var(--muted); font-size:0.75rem; min-width:18px;">${idx + 1}.</span>
                <div style="flex:1; min-width:0; overflow:hidden; cursor:pointer;" onclick="openSongDetail('${safeTrack}', '${safeArtist}')">
                    <div style="font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${t.track}</div>
                    <div style="font-size:0.72rem; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${t.artist}</div>
                </div>
                <button type="button" class="btn btn-ghost" style="padding:0.2rem; color:#e5534b; flex-shrink:0;" title="Entfernen" onclick="removeFromBasket(${idx})">
                    <i data-lucide="x" style="width:13px; height:13px;"></i>
                </button>
            </div>`;
    }).join("");
    lucide.createIcons();
}

window.addToBasket = function(track, artist, album, in_lib, play_count) {
    const exists = state.playlistBasket.some(t => t.track.toLowerCase() === track.toLowerCase() && t.artist.toLowerCase() === artist.toLowerCase());
    if (exists) {
        showToast(`»${track}« ist bereits im Korb`);
        return;
    }
    state.playlistBasket.push({ track, artist, album, in_lib, play_count });
    _saveBasket();
    showToast(`»${track}« hinzugefügt!`);
};

window.removeFromBasket = function(idx) {
    state.playlistBasket.splice(idx, 1);
    _saveBasket();
};

// Toast notification helper
function showToast(msg) {
    let toast = document.getElementById("wkmm-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "wkmm-toast";
        toast.style.cssText = "position:fixed; bottom:24px; right:24px; background:#1db954; color:#000; font-weight:700; font-size:0.85rem; padding:0.6rem 1.2rem; border-radius:30px; box-shadow:0 6px 20px rgba(0,0,0,0.5); z-index:9999; transition:all 0.3s; opacity:0; transform:translateY(10px); pointer-events:none;";
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(10px)";
    }, 2200);
}

// Mode Switcher
document.querySelectorAll(".pl-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        _plCurrentMode = mode;
        document.querySelectorAll(".pl-mode-btn").forEach(b => {
            b.classList.toggle("btn-primary", b.dataset.mode === mode);
            b.classList.toggle("btn-outline", b.dataset.mode !== mode);
        });
        document.querySelectorAll(".pl-input-section").forEach(sec => {
            sec.classList.add("hidden");
        });
        const activeSec = document.getElementById(`pl-input-${mode}`);
        if (activeSec) activeSec.classList.remove("hidden");
    });
});

// Autocomplete for Song mode
let _plSongSearchTimeout = null;
const plSongSearchInput = document.getElementById("pl-song-search");
const plSongDropdown = document.getElementById("pl-song-dropdown");

plSongSearchInput?.addEventListener("input", (e) => {
    clearTimeout(_plSongSearchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) {
        if (plSongDropdown) plSongDropdown.style.display = "none";
        return;
    }
    _plSongSearchTimeout = setTimeout(async () => {
        const data = await apiCall(`/api/search?q=${encodeURIComponent(q)}&top_n=8`);
        if (!data || data.error || !data.length) {
            if (plSongDropdown) plSongDropdown.style.display = "none";
            return;
        }
        plSongDropdown.innerHTML = data.map(s => `
            <div style="padding:0.6rem 0.85rem; cursor:pointer; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;"
                 onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''"
                 onclick="selectPlSong('${s.track.replace(/'/g, "\'")}', '${s.artist.replace(/'/g, "\'")}')">
                <div style="overflow:hidden; margin-right:0.5rem;">
                    <strong style="color:var(--text); font-size:0.88rem;">${s.track}</strong><br>
                    <span style="color:var(--muted); font-size:0.78rem;">${s.artist}</span>
                </div>
                <span style="color:var(--green); font-size:0.75rem; font-weight:600; flex-shrink:0;">${s.play_count}x</span>
            </div>
        `).join("");
        plSongDropdown.style.display = "block";
    }, 250);
});

window.selectPlSong = function(track, artist) {
    _plSelectedSong = { track, artist };
    if (plSongDropdown) plSongDropdown.style.display = "none";
    if (plSongSearchInput) plSongSearchInput.value = "";
    const selBox = document.getElementById("pl-song-selected");
    const selTxt = document.getElementById("pl-song-selected-txt");
    if (selBox && selTxt) {
        selTxt.textContent = `${track} — ${artist}`;
        selBox.style.display = "block";
    }
};

document.getElementById("pl-song-clear")?.addEventListener("click", () => {
    _plSelectedSong = null;
    const selBox = document.getElementById("pl-song-selected");
    if (selBox) selBox.style.display = "none";
});

// Autocomplete for Artist mode
let _plArtistSearchTimeout = null;
const plArtistSearchInput = document.getElementById("pl-artist-search");
const plArtistDropdown = document.getElementById("pl-artist-dropdown");

plArtistSearchInput?.addEventListener("input", (e) => {
    clearTimeout(_plArtistSearchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) {
        if (plArtistDropdown) plArtistDropdown.style.display = "none";
        return;
    }
    _plArtistSearchTimeout = setTimeout(async () => {
        const data = await apiCall(`/api/search?q=${encodeURIComponent(q)}&top_n=10`);
        if (!data || data.error || !data.length) {
            if (plArtistDropdown) plArtistDropdown.style.display = "none";
            return;
        }
        const uniqueArtists = [...new Set(data.map(d => d.artist))];
        plArtistDropdown.innerHTML = uniqueArtists.map(art => `
            <div style="padding:0.55rem 0.85rem; cursor:pointer; border-bottom:1px solid var(--border); font-size:0.88rem; color:var(--text);"
                 onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''"
                 onclick="document.getElementById('pl-artist-search').value='${art.replace(/'/g, "\'")}'; document.getElementById('pl-artist-dropdown').style.display='none';">
                <strong>${art}</strong>
            </div>
        `).join("");
        plArtistDropdown.style.display = "block";
    }, 250);
});

// Genre chip clicks
document.querySelectorAll(".pl-genre-chip").forEach(chip => {
    chip.addEventListener("click", () => {
        const g = chip.dataset.genre;
        const inp = document.getElementById("pl-genre-search");
        if (inp) inp.value = g;
        document.querySelectorAll(".pl-genre-chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
    });
});

// Populate year select
function _initPlaylistYears() {
    const sel = document.getElementById("pl-year-select");
    if (!sel || sel.options.length > 0) return;
// Die Playlist arbeitet innerhalb der globalen Jahresauswahl.
       const pool = state.yearScope && state.yearScope.all
           ? state.years
           : (state.yearScope && state.yearScope.selected) || state.years;
       pool.forEach(y => {
           const opt = document.createElement("option");
           opt.value = opt.textContent = String(y);
           sel.appendChild(opt);
       });
    if (sel.options.length === 0) {
        ["2026", "2025", "2024"].forEach(y => {
            const opt = document.createElement("option");
            opt.value = opt.textContent = y;
            sel.appendChild(opt);
        });
    }
}

// Generate Playlist Action
document.getElementById("pl-generate-btn")?.addEventListener("click", async () => {
    const mode = _plCurrentMode;
    const limit = document.getElementById("pl-limit-select")?.value || 25;
    const source_mix = document.getElementById("pl-mix-select")?.value || "both";
    let query = "", artist = "", album = "", year = "", genre = "";

    if (mode === "song") {
        if (_plSelectedSong) {
            query = _plSelectedSong.track;
            artist = _plSelectedSong.artist;
        } else {
            const raw = document.getElementById("pl-song-search")?.value.trim();
            if (!raw) return alert("Bitte wähle zuerst einen Song aus.");
            const parts = raw.split(" — ");
            query = parts[0]?.trim();
            artist = parts[1]?.trim() || "";
        }
    } else if (mode === "artist") {
        artist = document.getElementById("pl-artist-search")?.value.trim();
        if (!artist) return alert("Bitte gib einen Artist-Namen ein.");
    } else if (mode === "album") {
        album = document.getElementById("pl-album-search")?.value.trim();
        artist = document.getElementById("pl-album-artist")?.value.trim() || "";
        if (!album) return alert("Bitte gib einen Album-Titel ein.");
    } else if (mode === "year") {
        year = document.getElementById("pl-year-select")?.value;
        if (!year) return alert("Bitte wähle ein Jahr aus.");
    } else if (mode === "genre") {
        genre = document.getElementById("pl-genre-search")?.value.trim();
        if (!genre) return alert("Bitte gib ein Genre oder Tag ein.");
    }

    showLoader("Stelle Playlist zusammen...");
    const payload = {
        mode,
        query,
        artist,
        album,
        year,
        genre,
        source_mix,
        limit,
        key: state.lastfmKey || ""
    };

    const res = await apiCall("/api/playlist/generate", "POST", payload);
    hideLoader();

    if (!res || res.error) {
        alert(res?.error || "Fehler beim Erstellen der Playlist.");
        return;
    }

    _plGeneratedTracks = res.tracks || [];

    // Show results
    document.getElementById("pl-results-area")?.classList.remove("hidden");
    document.getElementById("pl-hero-title").textContent = res.title || "Deine Playlist";
    document.getElementById("pl-hero-desc").textContent = res.description || "";
    document.getElementById("pl-gen-count").textContent = _plGeneratedTracks.length;

    const listEl = document.getElementById("pl-tracks-list");
    if (listEl) {
        if (_plGeneratedTracks.length === 0) {
            listEl.innerHTML = '<div style="color:var(--muted); text-align:center; padding:2rem;">Keine Tracks gefunden. Probiere einen anderen Modus oder andere Suchbegriffe.</div>';
        } else {
            listEl.innerHTML = _plGeneratedTracks.map((t, i) => {
                const safeTrack = (t.track || "").replace(/'/g, "\'");
                const safeArtist = (t.artist || "").replace(/'/g, "\'");
                const safeAlbum = (t.album || "").replace(/'/g, "\'");
                
                const badge = t.in_library
                    ? `<span style="background:rgba(29,185,84,0.15); color:var(--green); border:1px solid rgba(29,185,84,0.3); font-size:0.72rem; padding:0.15rem 0.5rem; border-radius:12px; font-weight:600;">📚 ${t.play_count}x gehört</span>`
                    : `<span style="background:rgba(91,141,239,0.15); color:#5b8def; border:1px solid rgba(91,141,239,0.3); font-size:0.72rem; padding:0.15rem 0.5rem; border-radius:12px; font-weight:600;">✨ Entdeckung</span>`;

                return `
                    <div class="playlist-track-row">
                        <div style="display:flex; align-items:center; gap:0.75rem; flex:1; min-width:0;">
                            <span style="font-size:0.75rem; font-weight:700; color:var(--muted); min-width:22px; text-align:right;">#${i + 1}</span>
                            <div style="overflow:hidden; flex:1; cursor:pointer;" onclick="openSongDetail('${safeTrack}', '${safeArtist}')">
                                <div style="font-size:0.92rem; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                    ${t.track}
                                </div>
                                <div style="font-size:0.78rem; color:var(--muted); margin-top:0.15rem; display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                                    <strong style="color:var(--muted);">${t.artist}</strong>
                                    ${t.album ? `<span style="color:var(--border);">&bull; ${t.album}</span>` : ""}
                                </div>
                            </div>
                        </div>

                        <div style="display:flex; align-items:center; gap:0.6rem; flex-shrink:0;">
                            ${badge}
                            <a href="${t.spotify_url || '#'}" target="_blank" class="btn btn-ghost" style="padding:0.35rem 0.5rem; font-size:0.75rem; color:var(--muted);" title="Auf Spotify öffnen">
                                <i data-lucide="external-link" style="width:13px; height:13px;"></i>
                            </a>
                            <button type="button" class="btn btn-primary" style="padding:0.35rem 0.65rem; font-size:0.78rem;" title="In Meine Playlist hinzufügen"
                                    onclick="addToBasket('${safeTrack}', '${safeArtist}', '${safeAlbum}', ${t.in_library}, ${t.play_count})">
                                <i data-lucide="plus" style="width:13px; height:13px;"></i>
                            </button>
                        </div>
                    </div>`;
            }).join("");
            lucide.createIcons();
        }
    }
});

// Add all generated to basket
document.getElementById("pl-add-all-btn")?.addEventListener("click", () => {
    if (!_plGeneratedTracks.length) return;
    let addedCount = 0;
    _plGeneratedTracks.forEach(t => {
        const exists = state.playlistBasket.some(b => b.track.toLowerCase() === t.track.toLowerCase() && b.artist.toLowerCase() === t.artist.toLowerCase());
        if (!exists) {
            state.playlistBasket.push({
                track: t.track,
                artist: t.artist,
                album: t.album,
                in_lib: t.in_library,
                play_count: t.play_count
            });
            addedCount++;
        }
    });
    _saveBasket();
    showToast(`${addedCount} neue Songs in den Korb gelegt!`);
});

// Clear Basket
document.getElementById("pl-basket-clear")?.addEventListener("click", () => {
    if (!state.playlistBasket.length) return;
    if (confirm("Möchtest du den gesamten Playlist-Korb leeren?")) {
        state.playlistBasket = [];
        _saveBasket();
        showToast("Korb geleert.");
    }
});

// Shuffle Basket
document.getElementById("pl-basket-shuffle")?.addEventListener("click", () => {
    if (state.playlistBasket.length < 2) return;
    for (let i = state.playlistBasket.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.playlistBasket[i], state.playlistBasket[j]] = [state.playlistBasket[j], state.playlistBasket[i]];
    }
    _saveBasket();
    showToast("Playlist gemischt!");
});

// Copy to clipboard
document.getElementById("pl-copy-text-btn")?.addEventListener("click", () => {
    if (!state.playlistBasket.length) return alert("Dein Korb ist noch leer.");
    const text = state.playlistBasket.map(t => `${t.artist} - ${t.track}`).join(String.fromCharCode(10));
    navigator.clipboard.writeText(text).then(() => {
        showToast("📋 Trackliste in Zwischenablage kopiert!");
    }).catch(() => {
        prompt("Kopiere die Tracks:", text);
    });
});

// Export M3U
document.getElementById("pl-export-m3u-btn")?.addEventListener("click", () => {
    if (!state.playlistBasket.length) return alert("Dein Korb ist noch leer.");
    let m3u = "#EXTM3U" + String.fromCharCode(10);
    state.playlistBasket.forEach(t => {
        m3u += `#EXTINF:-1,${t.artist} - ${t.track}` + String.fromCharCode(10) + `${t.artist} - ${t.track}.mp3` + String.fromCharCode(10);
    });
    const blob = new Blob([m3u], { type: "audio/x-mpegurl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Playlist_${new Date().toISOString().slice(0, 10)}.m3u`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("⬇️ .m3u Playlist heruntergeladen!");
});

// Initialize on tab click
document.querySelectorAll(".tab-btn").forEach(btn => {
    if (btn.dataset.tab === "playlist") {
        btn.addEventListener("click", () => {
            _initPlaylistYears();
            _renderBasket();
            // Populate quick artist chips if we have top artists
            const chipContainer = document.getElementById("pl-artist-quick-chips");
            if (chipContainer && chipContainer.children.length <= 1 && state.skipData && state.skipData.length) {
                const topA = [...new Set(state.skipData.map(s => s.artist))].slice(0, 6);
                topA.forEach(a => {
                    const span = document.createElement("span");
                    span.className = "pl-genre-chip";
                    span.textContent = a;
                    span.addEventListener("click", () => {
                        const inp = document.getElementById("pl-artist-search");
                        if (inp) inp.value = a;
                    });
                    chipContainer.appendChild(span);
                });
            }
        });
    }
});

// Auto-restore session on startup / page refresh
async function checkExistingSession() {
    try {
        const res = await apiCall("/api/session_status");
        if(res.loaded) {
            state.years = res.years;
            state.totalStreams = res.total_streams;
            if(res.year_scope) state.yearScope = res.year_scope;
            if(res.account_status) state.accountStatus = res.account_status;
            state.dataLoaded = true;
        if(data && data.account_status) state.accountStatus = data.account_status;
            if (res.year_exclusion) renderYearExclusion(res.year_exclusion);
            updateYearSelects();
            refreshYearDropdowns();
            document.getElementById("upload-section").classList.add("hidden");
            document.getElementById("tab-nav").classList.remove("hidden");
            document.getElementById("panel-recommend").classList.remove("hidden");
            updateHeaderSyncBtn();
            applyQuality(res.quality);
            if(res.media) applyMediaInfo(res.media);
            if(res.blacklist) renderBlacklist(res.blacklist);
            // Die Einstellungen (Zeitzone, Medien-Toggle, Profil, Blacklist)
            // koennen aus dem Cache stammen und weichen dann von den noch
            // leeren UI-Feldern ab - darum einmal frisch einlesen. Sonst waere
            // z. B. der lokale Zeitzonen-Schalter nach dem Reload ausgegraut.
            await loadSettings();
            lucide.createIcons();
            showToast(`Datensatz aktiv: ${res.total_streams.toLocaleString()} Streams`);
        }
    } catch(e) {
        console.error("Session restore check:", e);
    }
}

// ── PRIVACY: Lebenszeichen + Disconnect-Meldung ──
// Solange der Tab offen ist, halten wir die Session aktiv. Beim Verlassen der
// Seite melden wir den Disconnect, damit der Server die Daten raeumt.
const WKMM_CONFIG = window.WKMM_CONFIG || { privacyMode: false, idleSeconds: 0 };
const HEARTBEAT_MS = Math.max(30000, Math.min((WKMM_CONFIG.idleSeconds || 1200) * 500, 120000));

function startHeartbeat() {
    if(!WKMM_CONFIG.privacyMode || state._heartbeat) return;
    state._heartbeat = setInterval(() => {
        if(!state.dataLoaded) return;
        fetch("/api/heartbeat", {method:"POST", keepalive:true}).catch(()=>{});
    }, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if(state._heartbeat) { clearInterval(state._heartbeat); state._heartbeat = null; }
}

function notifyDisconnect() {
    if(!WKMM_CONFIG.privacyMode || !state.dataLoaded) return;
    try {
        navigator.sendBeacon("/api/disconnect", new Blob([], {type:"text/plain"}));
    } catch(e) {
        fetch("/api/disconnect", {method:"POST", keepalive:true}).catch(()=>{});
    }
}

window.addEventListener("pagehide", notifyDisconnect);
window.addEventListener("beforeunload", () => { stopHeartbeat(); });

// Initial renders on startup
document.addEventListener("DOMContentLoaded", () => {
  _renderBasket();
  bindYearDropdowns();
  refreshYearDropdowns();
  checkExistingSession().then(startHeartbeat);
});

// Also trigger immediately in case DOM is already loaded
checkExistingSession().then(startHeartbeat);

// ── INIT ──
lucide.createIcons();


// ═════════════════════════════════════════════════════════════════════════════
// ── MODULE: Account Data Analytics (SearchQueries, Inferences, Library, etc.) ─
// ═════════════════════════════════════════════════════════════════════════════

let _searchesRawData = null;
let _inferencesRawData = null;
let _libraryRawData = null;

// ── 1. SUCHANFRAGEN TAB ──
async function loadSearchesTab() {
  const emptyState = document.getElementById("searches-empty-state");
  const content = document.getElementById("searches-content");
  showLoader("Lade Suchanfragen...");
  try {
    const data = await apiCall("/api/account/searches");
    hideLoader();

    if (!data || !data.loaded) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      lucide.createIcons();
      return;
    }

    _searchesRawData = data;
    if (emptyState) emptyState.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    // Stats
    const totalEl = document.getElementById("searches-total");
    if (totalEl) totalEl.textContent = (data.total_searches || 0).toLocaleString();
    const uniqEl = document.getElementById("searches-unique");
    if (uniqEl) uniqEl.textContent = (data.unique_queries || 0).toLocaleString();
    const rateEl = document.getElementById("searches-rate");
    if (rateEl) rateEl.textContent = (data.interaction_rate || 0) + "%";
    const platEl = document.getElementById("searches-top-platform");
    if (platEl) platEl.textContent = (data.platforms && data.platforms[0]) ? data.platforms[0].platform : "-";

    // Charts
    _renderSearchesCharts(data);

    // Geister-Suchen
    const ghostChips = document.getElementById("searches-ghost-chips");
    const ghostCard = document.getElementById("searches-ghost-card");
    if (ghostChips) {
      if (data.ghost_searches && data.ghost_searches.length > 0) {
        if (ghostCard) ghostCard.classList.remove("hidden");
        ghostChips.innerHTML = data.ghost_searches.map(g => `
          <span class="tag-pill" style="border-color:rgba(229,83,75,0.4); color:#e5534b; background:rgba(229,83,75,0.1); padding:0.3rem 0.6rem; font-size:0.8rem; display:inline-flex; align-items:center; gap:0.35rem;">
            ${g.query} <strong style="opacity:0.75; font-size:0.72rem;">${g.count}x</strong>
          </span>
        `).join("");
      } else {
        if (ghostCard) ghostCard.classList.add("hidden");
      }
    }

    // Top Suchen Chips
    const topChips = document.getElementById("searches-top-chips");
    if (topChips && data.top_queries) {
      topChips.innerHTML = data.top_queries.slice(0, 25).map(q => `
        <span class="tag-pill" style="cursor:pointer;" onclick="filterSearchesTable('${q.query.replace(/'/g, "\\'")}')">
          ${q.query} <span style="opacity:0.6; font-size:0.72rem; margin-left:0.25rem;">${q.count}</span>
        </span>
      `).join("");
    }

    // Date range
    const rangeEl = document.getElementById("searches-date-range");
    if (rangeEl && data.date_range) {
      rangeEl.textContent = `· ${data.date_range.start.split(" ")[0]} – ${data.date_range.end.split(" ")[0]} (${data.date_range.days_count} Tage)`;
    }

    // Table render
    _renderSearchesTable(data.recent_searches || [], true);
    lucide.createIcons();
  } catch (e) {
    hideLoader();
    console.error("Error loading searches:", e);
    if (emptyState) emptyState.classList.remove("hidden");
    if (content) content.classList.add("hidden");
    lucide.createIcons();
  }
}

function _renderSearchesCharts(data) {
  // 1. Hours Chart (0-23)
  const hourCtx = document.getElementById("searches-hour-chart");
  if (hourCtx && typeof Chart !== "undefined") {
    if (state.charts["searches-hour"]) state.charts["searches-hour"].destroy();
    const hourLabels = Array.from({length: 24}, (_, i) => `${i}h`);
    state.charts["searches-hour"] = new Chart(hourCtx, {
      type: "bar",
      data: {
        labels: hourLabels,
        datasets: [{
          label: "Suchanfragen",
          data: data.hour_counts || [],
          backgroundColor: "#1db954",
          borderRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: "#1a1a1a" }, ticks: { color: "#666", font: { size: 9 } } },
          y: { grid: { color: "#1a1a1a" }, ticks: { color: "#666", font: { size: 9 } } }
        }
      }
    });
  }

  // 2. Weekday Chart
  const wdCtx = document.getElementById("searches-weekday-chart");
  if (wdCtx && typeof Chart !== "undefined") {
    if (state.charts["searches-weekday"]) state.charts["searches-weekday"].destroy();
    state.charts["searches-weekday"] = new Chart(wdCtx, {
      type: "bar",
      data: {
        labels: data.weekday_labels || ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
        datasets: [{
          label: "Suchanfragen",
          data: data.weekday_counts || [],
          backgroundColor: "rgba(29,185,84,0.75)",
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: "#1a1a1a" }, ticks: { color: "#666" } },
          y: { grid: { color: "#1a1a1a" }, ticks: { color: "#666" } }
        }
      }
    });
  }
}

let _searchesCurrentPage = 0;
let _searchesCurrentItems = [];
const SEARCHES_PAGE_SIZE = 100;

function _renderSearchesTable(items, resetPage = true) {
  const tbody = document.getElementById("searches-table-body");
  if (!tbody) return;
  _searchesCurrentItems = items || [];
  if (resetPage) _searchesCurrentPage = 0;

  if (!_searchesCurrentItems.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--muted); padding:1.5rem;">Keine passenden Suchen gefunden.</td></tr>';
    _updateSearchesPagination();
    return;
  }

  const start = _searchesCurrentPage * SEARCHES_PAGE_SIZE;
  const pageItems = _searchesCurrentItems.slice(start, start + SEARCHES_PAGE_SIZE);

  tbody.innerHTML = pageItems.map(s => `
    <tr>
      <td style="color:var(--muted); font-size:0.76rem; font-family:monospace;">${s.time}</td>
      <td style="font-weight:600; color:var(--text);">${s.query}</td>
      <td style="color:var(--muted);">${s.platform}</td>
      <td>
        ${s.has_interaction ? '<span style="color:var(--green); display:inline-flex; align-items:center; gap:0.2rem;"><i data-lucide="check-circle-2" style="width:12px;height:12px;"></i> Klick</span>' : '<span style="color:var(--muted);">Kein Klick</span>'}
      </td>
    </tr>
  `).join("");
  lucide.createIcons();
  _updateSearchesPagination();
}

function _updateSearchesPagination() {
  const total = _searchesCurrentItems.length;
  const totalPages = Math.ceil(total / SEARCHES_PAGE_SIZE);
  const start = _searchesCurrentPage * SEARCHES_PAGE_SIZE + 1;
  const end = Math.min(start + SEARCHES_PAGE_SIZE - 1, total);
  const infoEl = document.getElementById("searches-page-info");
  const prevBtn = document.getElementById("searches-prev-btn");
  const nextBtn = document.getElementById("searches-next-btn");
  if (infoEl) infoEl.textContent = total > 0 ? `${start}–${end} von ${total.toLocaleString()}` : "0 Ergebnisse";
  if (prevBtn) prevBtn.disabled = _searchesCurrentPage <= 0;
  if (nextBtn) nextBtn.disabled = _searchesCurrentPage >= totalPages - 1;
}

function filterSearchesTable(query) {
  const input = document.getElementById("searches-filter-input");
  if (input) {
    input.value = query;
    input.dispatchEvent(new Event("input"));
  }
}

document.getElementById("searches-filter-input")?.addEventListener("input", (e) => {
  const filter = e.target.value.toLowerCase().trim();
  if (!_searchesRawData || !_searchesRawData.recent_searches) return;
  const filtered = filter
    ? _searchesRawData.recent_searches.filter(s =>
        s.query.toLowerCase().includes(filter) || s.platform.toLowerCase().includes(filter)
      )
    : _searchesRawData.recent_searches;
  _renderSearchesTable(filtered, true);
});

document.getElementById("searches-prev-btn")?.addEventListener("click", () => {
  if (_searchesCurrentPage > 0) {
    _searchesCurrentPage--;
    _renderSearchesTable(_searchesCurrentItems, false);
    document.getElementById("searches-table-body")?.closest("div")?.scrollTo(0, 0);
  }
});

document.getElementById("searches-next-btn")?.addEventListener("click", () => {
  const totalPages = Math.ceil(_searchesCurrentItems.length / SEARCHES_PAGE_SIZE);
  if (_searchesCurrentPage < totalPages - 1) {
    _searchesCurrentPage++;
    _renderSearchesTable(_searchesCurrentItems, false);
    document.getElementById("searches-table-body")?.closest("div")?.scrollTo(0, 0);
  }
});


// ── 2. GESCHMACKSPROFIL & INFERENCES TAB ──
async function loadInferencesTab() {
  const emptyState = document.getElementById("inferences-empty-state");
  const content = document.getElementById("inferences-content");
  showLoader("Lade Geschmacksprofil...");
  try {
    const data = await apiCall("/api/account/inferences");
    let payData = null;
    try { payData = await apiCall("/api/account/payments"); } catch(e) {}
    hideLoader();

    if (!data || !data.loaded) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      lucide.createIcons();
      return;
    }

    _inferencesRawData = data;
    if (emptyState) emptyState.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    // Stats
    const totalEl = document.getElementById("inferences-total");
    if (totalEl) totalEl.textContent = (data.total_inferences || 0).toLocaleString();
    const userInfo = data.user_info || {};
    const countryEl = document.getElementById("inferences-country");
    if (countryEl) countryEl.textContent = userInfo.country || "DE";
    const createdEl = document.getElementById("inferences-created");
    if (createdEl) {
      const ct = userInfo.creation_time;
      if (ct) {
        try {
          const d = new Date(ct);
          const months = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
          createdEl.textContent = `seit ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
        } catch(e) { createdEl.textContent = ct.split("T")[0]; }
      } else {
        createdEl.textContent = userInfo.username || "-";
      }
    }

    // Payments Section
    const paySec = document.getElementById("payments-section");
    if (payData && payData.loaded) {
      if (paySec) paySec.classList.remove("hidden");
      const totSpentEl = document.getElementById("payments-total-spent");
      if (totSpentEl) totSpentEl.textContent = `${payData.total_spent} ${payData.currency}`;

      const validHour = typeof payData.cost_per_hour === "number" && !isNaN(payData.cost_per_hour);
      const hrRateEl = document.getElementById("payments-hour-rate");
      if (hrRateEl) hrRateEl.textContent = validHour ? `${payData.cost_per_hour} ${payData.currency} / h` : "-";

      const validStream = typeof payData.cost_per_stream_cents === "number" && !isNaN(payData.cost_per_stream_cents);
      const stRateEl = document.getElementById("payments-stream-rate");
      if (stRateEl) stRateEl.textContent = validStream ? `${payData.cost_per_stream_cents} Cent / Stream` : "-";

      const costHourEl = document.getElementById("inferences-cost-per-hour");
      if (costHourEl) costHourEl.textContent = validHour ? `${payData.cost_per_hour} ${payData.currency} / h` : "-";

      // Süße Merch-Liste
      const merchBox = document.getElementById("payments-merch-box");
      const merchList = document.getElementById("payments-merch-list");
      const merchBadge = document.getElementById("payments-merch-badge");
      if (merchBox && merchList && payData.merch_items && payData.merch_items.length) {
        merchBox.classList.remove("hidden");
        if (merchBadge) {
          merchBadge.textContent = `${payData.merch_items.length} Artikel (Gesamt inkl. Versand: ${payData.merch_spent} ${payData.merch_currency})`;
        }
        merchList.innerHTML = payData.merch_items.map(item => `
          <div style="background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:0.85rem; display:flex; align-items:center; gap:0.85rem;">
            <div style="font-size:1.8rem; line-height:1; flex-shrink:0;">💿</div>
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600; color:var(--text); font-size:0.88rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${item.title}">${item.title}</div>
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.4rem; font-size:0.75rem; color:var(--muted); margin-top:0.35rem;">
                <div>
                  <span style="color:var(--green); font-weight:700;">${item.amount} ${item.currency}</span>
                  ${item.order_total && item.order_total !== item.amount ? `<span style="margin-left:0.4rem; color:var(--muted); font-size:0.72rem;">(inkl. Versand &amp; Steuern: <strong>${item.order_total} ${item.currency}</strong>)</span>` : ''}
                </div>
                <span>${item.date || 'Bestellung'} · <span style="color:#5b8def;">Erfüllt &amp; Bezahlt</span></span>
              </div>
            </div>
          </div>
        `).join("");
      } else if (merchBox) {
        merchBox.classList.add("hidden");
      }
    } else {
      if (paySec) paySec.classList.add("hidden");
      const costHourEl = document.getElementById("inferences-cost-per-hour");
      if (costHourEl) costHourEl.textContent = "-";
    }

    // Categories & Tags
    _renderInferencesCategories(data.categories || []);
    lucide.createIcons();
  } catch (e) {
    hideLoader();
    console.error("Error loading inferences:", e);
    if (emptyState) emptyState.classList.remove("hidden");
    if (content) content.classList.add("hidden");
    lucide.createIcons();
  }
}

function _renderInferencesCategories(categories, filter = "") {
  const container = document.getElementById("inferences-categories-container");
  if (!container) return;
  const filterLower = filter.toLowerCase().trim();

  let html = "";
  for (const cat of categories) {
    const matchingTags = filterLower ? cat.tags.filter(t => t.toLowerCase().includes(filterLower)) : cat.tags;
    if (filterLower && matchingTags.length === 0) continue;

    html += `
      <div style="background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:1.1rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <strong style="font-size:0.95rem; color:var(--text);">${cat.category}</strong>
          <span style="font-size:0.75rem; color:var(--muted);">${matchingTags.length} Tags</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:0.5rem;">
          ${matchingTags.map(t => {
            let explanation = "";
            if (t.includes("On Repeat_Sponsored Playlist Audience")) {
              explanation = '<span style="display:block; font-size:0.72rem; color:var(--muted); margin-top:0.25rem;">Regelmäßiger Hörer von „On Repeat" · Zielgruppe für gesponserte Playlists</span>';
            }
            return `
              <div class="tag-pill" style="font-size:0.8rem; padding:0.35rem 0.65rem; background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.12); display:inline-block;">
                <span style="font-weight:600; color:var(--text);">${t}</span>
                ${explanation}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  if (!html) {
    html = '<div style="color:var(--muted); text-align:center; padding:2rem;">Keine passenden Tags gefunden.</div>';
  }
  container.innerHTML = html;
}

document.getElementById("inferences-tag-search")?.addEventListener("input", (e) => {
  if (!_inferencesRawData || !_inferencesRawData.categories) return;
  _renderInferencesCategories(_inferencesRawData.categories, e.target.value);
});


// ── 3. BIBLIOTHEK & PLAYLISTS TAB ──
let _libraryActivityChart = null;
let _libraryArtistsChart = null;
const _coverArtCache = new Map();

async function _loadCoverArt(el) {
  if (!el) return;
  const uri = el.getAttribute("data-uri");
  const query = el.getAttribute("data-query");
  const cacheKey = (uri && uri.startsWith("spotify:")) ? uri : (query || "");
  if (!cacheKey) return;

  if (_coverArtCache.has(cacheKey)) {
    const url = _coverArtCache.get(cacheKey);
    if (url) el.innerHTML = `<img src="${url}" style="width:100%; height:100%; object-fit:cover; border-radius:inherit;" alt="" loading="lazy" />`;
    return;
  }

  // 1. Offizieller Spotify oEmbed-Thumbnail (CORS-offen, kein Key nötig)
  if (uri && uri.startsWith("spotify:")) {
    const parts = uri.split(":");
    const type = parts[1];
    const id = parts[2];
    if (id && (type === "track" || type === "album" || type === "artist")) {
      try {
        const res = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/${type}/${id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.thumbnail_url) {
            _coverArtCache.set(cacheKey, data.thumbnail_url);
            el.innerHTML = `<img src="${data.thumbnail_url}" style="width:100%; height:100%; object-fit:cover; border-radius:inherit;" alt="" loading="lazy" />`;
            return;
          }
        }
      } catch (e) {}
    }
  }

  // 2. iTunes Search API Fallback (CORS-offen, kein Key nötig, hochauflösend)
  if (query) {
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=1`);
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0 && data.results[0].artworkUrl100) {
          const highRes = data.results[0].artworkUrl100.replace("/100x100bb.jpg", "/300x300bb.jpg");
          _coverArtCache.set(cacheKey, highRes);
          el.innerHTML = `<img src="${highRes}" style="width:100%; height:100%; object-fit:cover; border-radius:inherit;" alt="" loading="lazy" />`;
          return;
        }
      }
    } catch (e) {}
  }
}

function _renderGraveyardTable(filter = "") {
  if (!_libraryRawData || !_libraryRawData.graveyard_tracks) return;
  const tbody = document.getElementById("library-graveyard-tbody");
  if (!tbody) return;

  const fLower = filter.toLowerCase().trim();
  let list = _libraryRawData.graveyard_tracks;
  if (fLower) {
    list = list.filter(t => t.track.toLowerCase().includes(fLower) || t.artist.toLowerCase().includes(fLower) || (t.album && t.album.toLowerCase().includes(fLower)));
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--muted); padding:1.5rem;">Keine passenden Friedhof-Songs gefunden.</td></tr>';
    return;
  }

  tbody.innerHTML = list.slice(0, 100).map(t => {
    const safeTrack = (t.track || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
    const safeArtist = (t.artist || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
    const qStr = `${t.artist} ${t.track}`.replace(/"/g, "&quot;");
    return `
    <tr style="cursor:pointer;" onclick="openSongDetail('${safeTrack}','${safeArtist}')" title="Klicke für Song-Details">
      <td style="width:50px;">
        <div class="cover-box" data-uri="${t.uri || ''}" data-query="${qStr}" style="width:38px; height:38px; border-radius:6px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; font-size:1.1rem; overflow:hidden; box-shadow:0 2px 4px rgba(0,0,0,0.3);">
          💿
        </div>
      </td>
      <td style="font-weight:600; color:var(--text);">${t.track}</td>
      <td style="color:var(--muted); cursor:pointer;" onclick="event.stopPropagation(); searchArtist('${safeArtist}');" title="Zu ${t.artist}">${t.artist}</td>
      <td style="color:var(--muted); font-size:0.76rem;">${t.album || "-"}</td>
      <td>
        <span style="display:inline-block; padding:0.15rem 0.45rem; border-radius:4px; font-size:0.72rem; font-weight:600; ${t.streams === 0 ? "background:rgba(229,83,75,0.15); color:#e5534b;" : "background:rgba(255,193,7,0.15); color:#ffc107;"}">
          ${t.status || t.streams + " Plays"}
        </span>
      </td>
    </tr>
  `}).join("");

  tbody.querySelectorAll(".cover-box").forEach(el => _loadCoverArt(el));
}

function _renderGhosthitsTable(filter = "") {
  if (!_libraryRawData || !_libraryRawData.ghost_hits) return;
  const tbody = document.getElementById("library-ghosthits-tbody");
  if (!tbody) return;

  const fLower = filter.toLowerCase().trim();
  let list = _libraryRawData.ghost_hits;
  if (fLower) {
    list = list.filter(t => t.track.toLowerCase().includes(fLower) || t.artist.toLowerCase().includes(fLower));
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--muted); padding:1.5rem;">Keine Geister-Hits gefunden.</td></tr>';
    return;
  }

  tbody.innerHTML = list.slice(0, 50).map(t => {
    const safeTrack = (t.track || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
    const safeArtist = (t.artist || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
    const qStr = `${t.artist} ${t.track}`.replace(/"/g, "&quot;");
    return `
    <tr style="cursor:pointer;" onclick="openSongDetail('${safeTrack}','${safeArtist}')" title="Klicke für Song-Details">
      <td style="width:50px;">
        <div class="cover-box" data-uri="${t.uri || ''}" data-query="${qStr}" style="width:38px; height:38px; border-radius:6px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; font-size:1.1rem; overflow:hidden; box-shadow:0 2px 4px rgba(0,0,0,0.3);">
          🎵
        </div>
      </td>
      <td style="font-weight:600; color:var(--text);">${t.track}</td>
      <td style="color:var(--muted); cursor:pointer;" onclick="event.stopPropagation(); searchArtist('${safeArtist}');" title="Zu ${t.artist}">${t.artist}</td>
      <td><strong style="color:var(--green);">${t.streams}</strong> Streams</td>
    </tr>
  `}).join("");

  tbody.querySelectorAll(".cover-box").forEach(el => _loadCoverArt(el));
}

async function loadLibraryTab() {
  const emptyState = document.getElementById("library-empty-state");
  const content = document.getElementById("library-content");
  showLoader("Lade Bibliothek & Playlists...");
  try {
    let libData = null;
    let plData = null;
    try { libData = await apiCall("/api/account/library"); } catch(e) {}
    try { plData = await apiCall("/api/account/playlists"); } catch(e) {}
    hideLoader();

    const hasAny = (libData && libData.loaded) || (plData && plData.loaded);
    if (!hasAny) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      lucide.createIcons();
      return;
    }

    _libraryRawData = libData;
    if (emptyState) emptyState.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    // Stats
    const trEl = document.getElementById("library-tracks-count");
    if (trEl) trEl.textContent = (libData && libData.loaded) ? (libData.tracks_count || 0).toLocaleString() : "-";
    const albEl = document.getElementById("library-albums-count");
    if (albEl) albEl.textContent = (libData && libData.loaded) ? (libData.albums_count || 0).toLocaleString() : "-";
    const plEl = document.getElementById("library-playlists-count");
    if (plEl) plEl.textContent = (plData && plData.loaded) ? (plData.total_playlists || 0).toLocaleString() : "-";
    const graveEl = document.getElementById("library-graveyard-count");
    if (graveEl) graveEl.textContent = (libData && libData.loaded) ? (libData.graveyard_count || 0).toLocaleString() : "0";

    // Charts
    if (libData && libData.loaded) {
      const actCtx = document.getElementById("library-activity-chart");
      if (actCtx) {
        if (_libraryActivityChart) _libraryActivityChart.destroy();
        const activeCount = Math.max(0, (libData.tracks_count || 0) - (libData.graveyard_count || 0));
        _libraryActivityChart = new Chart(actCtx, {
          type: "doughnut",
          data: {
            labels: ["Aktiv gehört", "Friedhof (0-1x gehört)"],
            datasets: [{
              data: [activeCount, libData.graveyard_count || 0],
              backgroundColor: ["#1db954", "#e5534b"],
              borderWidth: 0,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: "right", labels: { color: "#b3b3b3", font: { size: 11 } } }
            }
          }
        });
      }

      const artCtx = document.getElementById("library-artists-chart");
      if (artCtx && libData.top_library_artists && libData.top_library_artists.length) {
        if (_libraryArtistsChart) _libraryArtistsChart.destroy();
        const top10 = libData.top_library_artists.slice(0, 10);
        _libraryArtistsChart = new Chart(artCtx, {
          type: "bar",
          data: {
            labels: top10.map(a => a.artist),
            datasets: [{
              label: "Gespeicherte Tracks",
              data: top10.map(a => a.count),
              backgroundColor: "#5b8def",
              borderRadius: 4,
            }]
          },
          options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            onClick: (e, elements) => {
              if (elements && elements.length) {
                const a = top10[elements[0].index].artist;
                searchArtist(a);
              }
            },
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: "#888" }, grid: { color: "rgba(255,255,255,0.05)" } },
              y: { ticks: { color: "#ddd", font: { size: 11 } }, grid: { display: false } }
            }
          }
        });
      }
    }

    // 1. Graveyard Table
    _renderGraveyardTable();
    document.getElementById("library-graveyard-search")?.addEventListener("input", (e) => {
      _renderGraveyardTable(e.target.value);
    });

    // 2. Ghost Hits Table
    _renderGhosthitsTable();
    document.getElementById("library-ghosthits-search")?.addEventListener("input", (e) => {
      _renderGhosthitsTable(e.target.value);
    });

    // 3. Playlists Section
    const plSec = document.getElementById("playlists-section");
    const plGrid = document.getElementById("playlists-grid");
    if (plData && plData.loaded && plData.playlists) {
      if (plSec) plSec.classList.remove("hidden");
      if (plGrid) {
        plGrid.innerHTML = plData.playlists.slice(0, 16).map(p => `
          <div style="background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:0.85rem;">
            <div style="font-weight:600; color:var(--text); font-size:0.9rem; margin-bottom:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${p.name}">
              ${p.name}
            </div>
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--muted); margin-bottom:0.4rem;">
              <span>${p.track_count} Tracks</span>
              ${p.followers ? `<span>${p.followers} Follower</span>` : ""}
            </div>
            ${p.top_artists && p.top_artists.length ? `<div style="font-size:0.72rem; color:var(--muted); opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.top_artists.join(", ")}</div>` : ""}
          </div>
        `).join("");
      }

      // Duplicates
      const dupCard = document.getElementById("playlists-duplicates-card");
      const dupList = document.getElementById("playlists-duplicates-list");
      if (dupCard && dupList) {
        if (plData.duplicates && plData.duplicates.length > 0) {
          dupCard.classList.remove("hidden");
          dupList.innerHTML = plData.duplicates.slice(0, 15).map(d => `
            <div style="font-size:0.8rem; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:6px; padding:0.4rem 0.6rem; display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
              <span style="font-weight:600; color:var(--text);">${d.song}</span>
              <span style="font-size:0.72rem; color:var(--muted);">In: ${d.playlists.join(", ")}</span>
            </div>
          `).join("");
        } else {
          dupCard.classList.add("hidden");
        }
      }
    } else {
      if (plSec) plSec.classList.add("hidden");
    }

    lucide.createIcons();
  } catch (e) {
    hideLoader();
    console.error("Error loading library:", e);
    if (emptyState) emptyState.classList.remove("hidden");
    if (content) content.classList.add("hidden");
    lucide.createIcons();
  }
}


// ── 4. HÖRERTYPEN & MARKETING TAB (MARQUEE) ──
let _marqueeRawData = null;
let _marqueeChartInstance = null;
let _marqueeActiveSegment = "all";

async function loadMarqueeTab() {
  const emptyState = document.getElementById("marquee-empty-state");
  const content = document.getElementById("marquee-content");
  showLoader("Lade Hörertypen & Marketing...");
  try {
    const data = await apiCall("/api/account/marquee");
    hideLoader();

    if (!data || !data.loaded) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      lucide.createIcons();
      return;
    }

    _marqueeRawData = data;
    if (emptyState) emptyState.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    // Stats
    const totalEl = document.getElementById("marquee-total");
    if (totalEl) totalEl.textContent = (data.total_artists || 0).toLocaleString();
    const superEl = document.getElementById("marquee-super");
    if (superEl) superEl.textContent = (data.super_count || 0).toLocaleString();
    const modEl = document.getElementById("marquee-moderate");
    if (modEl) modEl.textContent = (data.moderate_count || 0).toLocaleString();
    const inactEl = document.getElementById("marquee-inactive");
    if (inactEl) inactEl.textContent = (data.inactive_count || 0).toLocaleString();

    // Super Listeners Chips - Klick führt direkt zur Artist-Detailseite!
    const chipsEl = document.getElementById("marquee-super-chips");
    if (chipsEl) {
      chipsEl.innerHTML = (data.super_listeners || []).map(a => {
        const safeA = a.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        return `
        <span class="tag-pill" style="font-size:0.82rem; padding:0.35rem 0.75rem; background:rgba(29,185,84,0.15); border:1px solid rgba(29,185,84,0.45); color:var(--text); font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:0.4rem; transition:all 0.15s ease;"
              onmouseover="this.style.background='rgba(29,185,84,0.3)'; this.style.borderColor='var(--green)'; this.style.transform='translateY(-1px)';"
              onmouseout="this.style.background='rgba(29,185,84,0.15)'; this.style.borderColor='rgba(29,185,84,0.45)'; this.style.transform='none';"
              onclick="searchArtist('${safeA}')"
              title="Klicke, um ${a} in den Artist-Details zu öffnen">
          🌟 ${a} <i data-lucide="arrow-right" style="width:12px;height:12px;opacity:0.6;"></i>
        </span>
      `}).join("");
    }

    // Chart
    const ctx = document.getElementById("marquee-segment-chart");
    if (ctx && data.segments) {
      if (_marqueeChartInstance) _marqueeChartInstance.destroy();
      const labels = data.segments.map(s => s.segment);
      const counts = data.segments.map(s => s.count);
      const colors = ["#1db954", "#5b8def", "#9b59b6", "#ff9f43", "#718096"];
      _marqueeChartInstance = new Chart(ctx, {
        type: "doughnut",
        data: {
          labels,
          datasets: [{
            data: counts,
            backgroundColor: colors.slice(0, labels.length),
            borderWidth: 0,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "right", labels: { color: "#b3b3b3", font: { size: 11 } } },
            tooltip: {
              callbacks: {
                label: (ctx) => ` ${ctx.label}: ${ctx.raw} Artists`
              }
            }
          }
        }
      });
    }

    // Table render
    _renderMarqueeTable();

    // Pills listener
    document.querySelectorAll("#marquee-filter-pills button").forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll("#marquee-filter-pills button").forEach(b => b.classList.remove("active-pill"));
        btn.classList.add("active-pill");
        _marqueeActiveSegment = btn.getAttribute("data-segment");
        _renderMarqueeTable();
      };
    });

    document.getElementById("marquee-search-input")?.addEventListener("input", () => {
      _renderMarqueeTable();
    });

    lucide.createIcons();
  } catch (e) {
    hideLoader();
    console.error("Error loading marquee:", e);
    if (emptyState) emptyState.classList.remove("hidden");
    if (content) content.classList.add("hidden");
    lucide.createIcons();
  }
}

function _renderMarqueeTable() {
  if (!_marqueeRawData || !_marqueeRawData.all_artists) return;
  const tbody = document.getElementById("marquee-table-body");
  if (!tbody) return;

  const search = (document.getElementById("marquee-search-input")?.value || "").toLowerCase().trim();
  let list = _marqueeRawData.all_artists;

  if (_marqueeActiveSegment !== "all") {
    list = list.filter(item => item.segment === _marqueeActiveSegment);
  }
  if (search) {
    list = list.filter(item => item.artist.toLowerCase().includes(search));
  }

  const segmentColors = {
    "Super Listeners": "background:rgba(29,185,84,0.15); color:var(--green);",
    "Moderate listeners": "background:rgba(91,141,239,0.15); color:#5b8def;",
    "Light listeners": "background:rgba(155,89,182,0.15); color:#9b59b6;",
    "Previously Active Listeners": "background:rgba(255,159,67,0.15); color:#ff9f43;",
  };

  tbody.innerHTML = list.slice(0, 150).map(item => {
    const safeA = item.artist.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    return `
    <tr>
      <td style="font-weight:600; color:var(--text); cursor:pointer;" onclick="searchArtist('${safeA}')" title="Zu ${item.artist} springen">
        ${item.artist} <i data-lucide="arrow-right" style="width:11px;height:11px;opacity:0.4;vertical-align:middle;margin-left:3px;"></i>
      </td>
      <td>
        <span style="display:inline-block; padding:0.2rem 0.5rem; border-radius:4px; font-size:0.74rem; font-weight:600; ${segmentColors[item.segment] || 'background:rgba(255,255,255,0.06); color:var(--muted);'}">
          ${item.segment}
        </span>
      </td>
    </tr>
  `}).join("");
  lucide.createIcons();
}

// ── 5. PROFIL & FOLLOWER TAB ──
async function loadProfileTab() {
  const emptyState = document.getElementById("profile-empty-state");
  const content = document.getElementById("profile-content");
  showLoader("Lade Profil & Follower...");
  try {
    const data = await apiCall("/api/account/follow");
    hideLoader();

    if (!data || !data.loaded) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      lucide.createIcons();
      return;
    }

    if (emptyState) emptyState.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    const u = data.user_info || {};
    // Avatar
    const avatarImg = document.getElementById("profile-avatar");
    if (avatarImg) {
      if (u.imageUrl) {
        avatarImg.src = u.imageUrl;
        avatarImg.style.display = "block";
      } else {
        avatarImg.style.display = "none";
      }
    }

    // Details
    const nameEl = document.getElementById("profile-display-name");
    if (nameEl) nameEl.textContent = u.displayName || u.username || "Spotify User";
    const tasteBadge = document.getElementById("profile-badge-tastemaker");
    if (tasteBadge) {
      if (u.tasteMaker) tasteBadge.classList.remove("hidden");
      else tasteBadge.classList.add("hidden");
    }

    const cEl = document.getElementById("profile-country");
    if (cEl) cEl.textContent = `Land: ${u.country || "DE"}`;
    const crEl = document.getElementById("profile-created");
    if (crEl) {
      if (u.creationTime) {
        try {
          const dt = new Date(u.creationTime);
          const months = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
          crEl.textContent = `Dabei seit: ${months[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
        } catch(e) { crEl.textContent = `Dabei seit: ${u.creationTime}`; }
      } else { crEl.textContent = "Dabei seit: -"; }
    }
    const bEl = document.getElementById("profile-birthdate");
    if (bEl) bEl.textContent = u.birthdate ? `Geboren: ${u.birthdate.slice(0, 4)}` : "Geboren: -";
    const gEl = document.getElementById("profile-gender");
    if (gEl) gEl.textContent = u.gender ? `Geschlecht: ${u.gender === "male" ? "Männlich" : (u.gender === "female" ? "Weiblich" : u.gender)}` : "Geschlecht: -";

    // Stats
    const fCountEl = document.getElementById("profile-followers-count");
    if (fCountEl) fCountEl.textContent = (data.followers_count || 0).toLocaleString();
    const fgCountEl = document.getElementById("profile-following-count");
    if (fgCountEl) fgCountEl.textContent = (data.following_count || 0).toLocaleString();
    const mutCountEl = document.getElementById("profile-mutual-count");
    if (mutCountEl) mutCountEl.textContent = (data.mutual_count || 0).toLocaleString();
    const blkCountEl = document.getElementById("profile-blocked-count");
    if (blkCountEl) blkCountEl.textContent = (data.blocked_count || 0).toLocaleString();

    const mutualSet = new Set(data.mutual || []);

    // Followers List
    const fListEl = document.getElementById("profile-followers-list");
    if (fListEl) {
      if (data.followers && data.followers.length) {
        fListEl.innerHTML = data.followers.map(name => `
          <div style="background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:0.45rem 0.75rem; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:600; color:var(--text); font-size:0.85rem;">${name}</span>
            ${mutualSet.has(name) ? '<span class="tag-pill" style="font-size:0.7rem; padding:0.15rem 0.45rem; background:rgba(91,141,239,0.15); color:#5b8def; border-color:#5b8def;">Freund</span>' : ''}
          </div>
        `).join("");
      } else {
        fListEl.innerHTML = '<div style="color:var(--muted); font-size:0.8rem; padding:1rem 0;">Keine Follower gefunden.</div>';
      }
    }

    // Following List
    const fgListEl = document.getElementById("profile-following-list");
    if (fgListEl) {
      if (data.following && data.following.length) {
        fgListEl.innerHTML = data.following.map(name => `
          <div style="background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:0.45rem 0.75rem; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:600; color:var(--text); font-size:0.85rem;">${name}</span>
            ${mutualSet.has(name) ? '<span class="tag-pill" style="font-size:0.7rem; padding:0.15rem 0.45rem; background:rgba(91,141,239,0.15); color:#5b8def; border-color:#5b8def;">Freund</span>' : ''}
          </div>
        `).join("");
      } else {
        fgListEl.innerHTML = '<div style="color:var(--muted); font-size:0.8rem; padding:1rem 0;">Du folgst noch keinen Konten.</div>';
      }
    }

    lucide.createIcons();
  } catch (e) {
    hideLoader();
    console.error("Error loading profile:", e);
    if (emptyState) emptyState.classList.remove("hidden");
    if (content) content.classList.add("hidden");
    lucide.createIcons();
  }
}

// ── 6. WRAPPED TAB ──
async function loadWrappedTab() {
  const emptyState = document.getElementById("wrapped-empty-state");
  const content = document.getElementById("wrapped-content");
  showLoader("Lade Wrapped-Archiv...");
  try {
    const data = await apiCall("/api/account/wrapped");
    hideLoader();

    if (!data || !data.loaded) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      lucide.createIcons();
      return;
    }

    if (emptyState) emptyState.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    const minEl = document.getElementById("wrapped-minutes");
    if (minEl) minEl.innerHTML = `${Math.round(data.total_minutes).toLocaleString()} <span style="font-size:0.85rem; color:var(--muted); font-weight:normal;">Minuten (~${data.total_hours} h)</span>`;
    const ageEl = document.getElementById("wrapped-age");
    if (ageEl) ageEl.textContent = data.listening_age ? `${data.listening_age} Jahre` : "-";
    const clubEl = document.getElementById("wrapped-club");
    if (clubEl) clubEl.textContent = data.user_club || "-";
    const tempoEl = document.getElementById("wrapped-tempo");
    if (tempoEl) tempoEl.textContent = data.avg_tempo_bpm ? `${data.avg_tempo_bpm} BPM` : "-";

    const popEl = document.getElementById("wrapped-popularity");
    if (popEl) popEl.textContent = data.avg_popularity !== null ? `${data.avg_popularity} %` : "-";
    const shEl = document.getElementById("wrapped-shares");
    if (shEl) shEl.textContent = (data.shares_count || 0).toLocaleString();
    const roleEl = document.getElementById("wrapped-role");
    if (roleEl) roleEl.textContent = data.club_role || "Mitglied";
    const hintEl = document.getElementById("wrapped-club-hint");
    if (hintEl && data.club_percent) {
      hintEl.textContent = `Du gehörst zu den Top ${data.club_percent} % in deinem Club.`;
    }

    lucide.createIcons();
  } catch (e) {
    hideLoader();
    console.error("Error loading wrapped:", e);
    if (emptyState) emptyState.classList.remove("hidden");
    if (content) content.classList.add("hidden");
    lucide.createIcons();
  }
}
