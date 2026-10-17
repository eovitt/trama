// =====================================================
// TRAMA — books.js
// Biblioteca de livros: status, sessões de leitura, diário,
// metas, conclusão e estatísticas.
// Usa utilitários globais definidos em app.js (t, $, escapeHTML,
// showToast, openOverlay, closeOverlay, supabaseClient, prefs...).
// =====================================================

// -----------------------------------------------------
// ESTADO
// -----------------------------------------------------

let books = [];
let readingSessions = [];   // sessões concluídas + a sessão ativa (active = true)
let bookNotes = [];
let bookEvents = [];
let activeSession = null;   // sessão de leitura em andamento (persistida no banco)
let libraryReady = true;    // false quando o banco ainda não recebeu a atualização
let libraryLoaded = false;
let editingBookId = null;
let tickIntervalId = null;

const busyActions = new Set();

const libraryState = {
    tab: "reading",
    search: "",
    genre: "all",
    rating: "all",
    sort: "default",
    period: "30"
};

const detailsState = { bookId: null, tab: "overview", editingNoteId: null, noteKind: "note" };
const bookFormState = { goalType: "pages", priority: 2 };

let selectedBookCoverFile = null;
let bookCoverMarkedForRemoval = false;

const STATUSES = ["reading", "want", "paused", "finished"];

// -----------------------------------------------------
// ELEMENTOS
// -----------------------------------------------------

const bookModal = $("bookModal");
const bookForm = $("bookForm");
const bookFormError = $("bookFormError");
const saveBookButton = $("saveBookButton");
const bookCoverFile = $("bookCoverFile");
const bookCoverPreviewWrapper = $("bookCoverPreviewWrapper");
const bookCoverPreview = $("bookCoverPreview");
const bookCoverUploadText = $("bookCoverUploadText");
const libraryList = $("libraryList");
const bookMenu = $("bookMenu");

// -----------------------------------------------------
// UTILITÁRIOS DE DATA, TEMPO E DADOS
// -----------------------------------------------------

function nowISO() {
    return new Date().toISOString();
}

function parseLocalDate(dateStr) {
    return dateStr ? new Date(`${dateStr}T00:00:00`) : null;
}

function addDays(dateStr, days) {
    const d = parseLocalDate(dateStr);
    d.setDate(d.getDate() + days);
    return localISO(d);
}

function daysBetween(fromStr, toStr) {
    return Math.round((parseLocalDate(toStr) - parseLocalDate(fromStr)) / 86400000);
}

function shortDate(dateStr) {
    if (!dateStr) return "—";
    const d = parseLocalDate(String(dateStr).slice(0, 10));
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(currentLocale(), sameYear
        ? { day: "numeric", month: "short" }
        : { day: "numeric", month: "short", year: "numeric" });
}

function timeOfDay(iso) {
    return iso ? new Date(iso).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" }) : "";
}

// Duração legível: "1h 20min", "35min", "<1min"
function humanDuration(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    if (s > 0 && s < 60) return "<1min";
    return formatTotalTime(s);
}

function bookById(id) {
    return books.find(b => Number(b.id) === Number(id)) || null;
}

function completedSessions() {
    return readingSessions.filter(s => !s.active);
}

function sessionsForBook(bookId) {
    return completedSessions()
        .filter(s => Number(s.book_id) === Number(bookId))
        .sort((a, b) => (b.session_date || "").localeCompare(a.session_date || "")
            || String(b.ended_at || b.created_at || "").localeCompare(String(a.ended_at || a.created_at || ""))
            || Number(b.id) - Number(a.id));
}

// Tempo decorrido calculado a partir dos horários salvos (sobrevive a recarregar a página)
function sessionElapsed(session) {
    if (!session) return 0;
    const running = session.segment_started_at ? Math.floor((Date.now() - Date.parse(session.segment_started_at)) / 1000) : 0;
    return Math.max(0, Number(session.accumulated_seconds || 0) + Math.max(0, running));
}

function isSessionRunning() {
    return Boolean(activeSession && activeSession.segment_started_at);
}

function progressPct(book) {
    if (!book.total_pages) return null;
    return Math.min(100, Math.round(((book.current_page || 0) / book.total_pages) * 100));
}

function isAtLastPage(book) {
    return Boolean(book.total_pages) && (book.current_page || 0) >= book.total_pages;
}

function normalizeGenre(value) {
    return normalizeText(value || "");
}

// Estatísticas de um livro — única fonte para cards, detalhes e resumo
function bookStats(bookId) {
    const sessions = sessionsForBook(bookId);
    const pages = sessions.reduce((sum, s) => sum + Number(s.pages_read || 0), 0);
    const seconds = sessions.reduce((sum, s) => sum + Number(s.duration_seconds || 0), 0);
    const timed = sessions.filter(s => Number(s.duration_seconds) > 0);
    const timedPages = timed.reduce((sum, s) => sum + Number(s.pages_read || 0), 0);
    const timedSeconds = timed.reduce((sum, s) => sum + Number(s.duration_seconds || 0), 0);

    return {
        sessions,
        count: sessions.length,
        pages,
        seconds,
        avgPages: sessions.length ? pages / sessions.length : 0,
        avgSeconds: timed.length ? timedSeconds / timed.length : 0,
        pagesPerHour: timedSeconds >= 300 ? timedPages / (timedSeconds / 3600) : null
    };
}

// Progresso da meta diária de um livro (páginas ou minutos)
function goalInfo(book, dateStr = todayISO()) {
    const type = book.goal_type === "minutes" ? "minutes" : "pages";
    const target = Number(type === "minutes" ? book.daily_goal_minutes : book.daily_goal_pages) || 0;
    if (!target) return null;

    const daySessions = completedSessions().filter(s => Number(s.book_id) === Number(book.id) && s.session_date === dateStr);
    let done;

    if (type === "pages") {
        done = daySessions.reduce((sum, s) => sum + Number(s.pages_read || 0), 0);
    } else {
        let seconds = daySessions.reduce((sum, s) => sum + Number(s.duration_seconds || 0), 0);
        // Conta também a sessão em andamento, se for deste livro e de hoje
        if (activeSession && Number(activeSession.book_id) === Number(book.id) && dateStr === todayISO()) {
            seconds += sessionElapsed(activeSession);
        }
        done = Math.floor(seconds / 60);
    }

    return { type, target, done, remaining: Math.max(0, target - done), met: done >= target };
}

// Previsão de término: só quando há dados suficientes para ser confiável
function forecast(book) {
    if (book.status !== "reading" || !book.total_pages || isAtLastPage(book)) return null;

    const since = addDays(todayISO(), -29);
    const recent = sessionsForBook(book.id).filter(s => s.session_date >= since && Number(s.pages_read) > 0);
    const days = new Set(recent.map(s => s.session_date));
    if (recent.length < 3 || days.size < 2) return goalForecast(book);

    const firstDay = [...days].sort()[0];
    const spanDays = daysBetween(firstDay, todayISO()) + 1;
    const pages = recent.reduce((sum, s) => sum + Number(s.pages_read || 0), 0);
    const pace = pages / Math.max(2, spanDays);   // páginas por dia corrido (não só dias lidos)
    if (pace <= 0) return null;

    const daysLeft = Math.max(1, Math.ceil((book.total_pages - book.current_page) / pace));
    if (daysLeft > 730) return null;

    return { daysLeft, date: addDays(todayISO(), daysLeft), pace };
}

// Sem dados de ritmo suficientes: usa a meta diária de páginas, se houver
function goalForecast(book) {
    const goal = book.goal_type !== "minutes" ? Number(book.daily_goal_pages) || 0 : 0;
    if (!goal) return null;
    const daysLeft = Math.max(1, Math.ceil((book.total_pages - (book.current_page || 0)) / goal));
    if (daysLeft > 730) return null;
    return { daysLeft, date: addDays(todayISO(), daysLeft), pace: goal, byGoal: true };
}

function forecastText(fc) {
    return fc.byGoal ? t("lib.forecastGoal", fc.daysLeft, shortDate(fc.date), fc.pace) : t("lib.forecast", fc.daysLeft, shortDate(fc.date));
}

// Páginas do progresso que não estão em nenhuma sessão (editadas à mão, salto ao concluir…)
function unloggedPages(book) {
    if (!book || book.status === "want") return 0;
    return Math.max(0, (book.current_page || 0) - bookStats(book.id).pages);
}

function activeReadingDays() {
    return new Set(completedSessions()
        .filter(s => Number(s.pages_read) > 0 || Number(s.duration_seconds) > 0)
        .map(s => s.session_date));
}

function computeStreak() {
    const days = activeReadingDays();
    if (!days.size) return 0;

    let cursor = todayISO();
    if (!days.has(cursor)) cursor = addDays(cursor, -1);

    let streak = 0;
    while (days.has(cursor)) {
        streak++;
        cursor = addDays(cursor, -1);
    }
    return streak;
}

function computeBestStreak() {
    let best = 0;
    let current = 0;
    let previous = null;

    [...activeReadingDays()].sort().forEach(day => {
        current = previous && daysBetween(previous, day) === 1 ? current + 1 : 1;
        best = Math.max(best, current);
        previous = day;
    });

    return best;
}

// Conclusões de livros (inclui as anteriores de livros reabertos), sem contar o mesmo evento duas vezes
function finishRecords() {
    const records = [];
    const seen = new Set();

    bookEvents.filter(e => e.type === "finished").forEach(e => {
        const date = e.details?.date || String(e.created_at).slice(0, 10);
        const key = `${e.book_id}|${date}`;
        if (!seen.has(key)) { seen.add(key); records.push({ bookId: e.book_id, date }); }
    });

    // Livros concluídos antes do histórico existir
    books.filter(b => b.finished_at).forEach(b => {
        const key = `${b.id}|${b.finished_at}`;
        if (!seen.has(key)) { seen.add(key); records.push({ bookId: b.id, date: b.finished_at }); }
    });

    return records;
}

function periodStart(period) {
    if (period === "all") return null;
    if (period === "year") return `${new Date().getFullYear()}-01-01`;
    return addDays(todayISO(), -(Number(period) - 1));
}

// -----------------------------------------------------
// BANCO DE DADOS — helpers
// -----------------------------------------------------

function isSchemaError(error) {
    const code = String(error?.code || "");
    const msg = String(error?.message || "");
    return ["42703", "42P01", "PGRST204", "PGRST205", "PGRST200"].includes(code)
        || /does not exist|schema cache|could not find/i.test(msg);
}

function dbErrorMessage(error, fallbackKey) {
    const code = String(error?.code || "");
    const msg = String(error?.message || "").toLowerCase();
    if (isSchemaError(error)) return t("lib.err.schema");
    if (code === "23505") return t("lib.err.activeExists");
    if (code === "23514") return t("lib.err.invalid");
    if (msg.includes("bucket")) return t("movie.errBucket");
    if (msg.includes("failed to fetch") || msg.includes("network")) return t("lib.err.network");
    return t(fallbackKey);
}

async function run(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
}

// Evita cliques duplos: a mesma ação não roda duas vezes ao mesmo tempo
async function withBusy(key, fn) {
    if (busyActions.has(key)) return;
    busyActions.add(key);

    // Só mexe nos botões que estavam habilitados — os desabilitados por outro motivo continuam assim
    const touched = [...document.querySelectorAll(`[data-busy-key="${key}"]`)].filter(el => !el.disabled);
    touched.forEach(el => { el.disabled = true; el.classList.add("is-loading"); });

    try {
        return await fn();
    } finally {
        busyActions.delete(key);
        touched.forEach(el => { if (document.contains(el)) { el.disabled = false; el.classList.remove("is-loading"); } });
    }
}

// Registra um evento no histórico do livro (falha aqui não desfaz a ação principal)
async function logEvent(bookId, type, details = {}) {
    try {
        const row = await run(supabaseClient.from("reading_book_events")
            .insert({ user_id: currentUserId, book_id: bookId, type, details })
            .select().single());
        if (row) bookEvents.push(row);
    } catch (error) {
        console.warn("Não foi possível registrar no histórico:", error);
    }
}

function replaceBook(updated) {
    const index = books.findIndex(b => Number(b.id) === Number(updated.id));
    if (index === -1) books.unshift(updated);
    else books[index] = updated;
}

function replaceSession(updated) {
    const index = readingSessions.findIndex(s => Number(s.id) === Number(updated.id));
    if (index === -1) readingSessions.unshift(updated);
    else readingSessions[index] = updated;
}

async function updateBook(bookId, changes) {
    const row = await run(supabaseClient.from("reading_books")
        .update({ ...changes, updated_at: nowISO() })
        .eq("id", bookId).eq("user_id", currentUserId)
        .select().single());
    replaceBook(row);
    return row;
}

// -----------------------------------------------------
// CARREGAR
// -----------------------------------------------------

async function loadBooks() {
    libraryLoaded = false;
    renderLibrary();

    try {
        // Confere se o banco já recebeu a atualização da biblioteca
        const probe = await supabaseClient.from("reading_books").select("id,status,genre,started_at").limit(1);
        if (probe.error) {
            if (isSchemaError(probe.error)) { libraryReady = false; libraryLoaded = true; renderLibrary(); return; }
            throw probe.error;
        }

        const [booksResult, sessionsResult, notesResult, eventsResult] = await Promise.all([
            supabaseClient.from("reading_books").select("*").eq("user_id", currentUserId).order("created_at", { ascending: false }),
            supabaseClient.from("reading_sessions").select("*").eq("user_id", currentUserId).order("session_date", { ascending: false }),
            supabaseClient.from("book_notes").select("*").eq("user_id", currentUserId).order("created_at", { ascending: false }),
            supabaseClient.from("reading_book_events").select("*").eq("user_id", currentUserId).order("created_at", { ascending: true })
        ]);

        const failure = [booksResult, sessionsResult, notesResult, eventsResult].find(r => r.error);
        if (failure) {
            if (isSchemaError(failure.error)) { libraryReady = false; libraryLoaded = true; renderLibrary(); return; }
            throw failure.error;
        }

        libraryReady = true;
        books = booksResult.data || [];
        readingSessions = sessionsResult.data || [];
        bookNotes = notesResult.data || [];
        bookEvents = eventsResult.data || [];
        activeSession = readingSessions.find(s => s.active) || null;

        if (activeSession) startTick();
        else stopTick();
    } catch (error) {
        console.error(error);
        showToast(t("books.loadError"), "error");
    } finally {
        libraryLoaded = true;
        renderLibrary();
    }
}

function resetBooksState() {
    books = [];
    readingSessions = [];
    bookNotes = [];
    bookEvents = [];
    activeSession = null;
    stopTick();
    updateTabTitle();
    closeBookMenu();
}

// -----------------------------------------------------
// RENDERIZAÇÃO — BIBLIOTECA
// -----------------------------------------------------

function renderLibrary() {
    $("librarySchemaNotice").classList.toggle("hidden", libraryReady);
    $("libraryTabs").classList.toggle("hidden", !libraryReady);
    document.querySelector(".libbar-actions").classList.toggle("hidden", !libraryReady);
    document.querySelector(".library-summary").classList.toggle("hidden", !libraryReady);
    $("addBookButton").disabled = !libraryReady;

    renderTabs();
    renderLibraryFilters();
    renderLibraryList();
    renderActiveSessionBar();
    renderChallenge();
    renderLibrarySummary();
    renderBookHeroStats();
    if (typeof renderDataSummary === "function" && currentUserId) renderDataSummary();
    refreshOpenDetails();
    updateTabTitle();
    if (typeof checkAchievements === "function") checkAchievements();
}

function statusCounts() {
    const counts = { reading: 0, want: 0, paused: 0, finished: 0, all: books.length };
    books.forEach(b => { if (counts[b.status] !== undefined) counts[b.status]++; });
    return counts;
}

function renderTabs() {
    const counts = statusCounts();
    $("countReading").textContent = counts.reading;
    $("countWant").textContent = counts.want;
    $("countPaused").textContent = counts.paused;
    $("countFinished").textContent = counts.finished;
    $("countAll").textContent = counts.all;

    document.querySelectorAll("#libraryTabs .library-tab").forEach(tab => {
        const active = tab.dataset.tab === libraryState.tab;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
    });

    moveTabIndicator();
    setFilterCount("bookFilterCount", (libraryState.genre !== "all") + (libraryState.rating !== "all") + (libraryState.sort !== "default"));

    const view = currentView();
    document.querySelectorAll(".view-toggle button").forEach(b => {
        b.classList.toggle("active", b.dataset.view === view);
        b.setAttribute("aria-pressed", String(b.dataset.view === view));
    });
}

function moveTabIndicator() {
    const active = document.querySelector("#libraryTabs .library-tab.active");
    const indicator = document.querySelector("#libraryTabs .tab-indicator");
    if (!active || !indicator || !active.offsetWidth) return;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}
window.addEventListener("resize", () => moveTabIndicator());

function renderLibraryFilters() {
    const select = $("libraryGenre");
    const current = libraryState.genre;
    const genres = new Map();
    books.forEach(b => { if (b.genre && b.genre.trim()) genres.set(normalizeGenre(b.genre), b.genre.trim()); });
    const sorted = [...genres.entries()].sort((a, b) => a[1].localeCompare(b[1], currentLocale()));

    select.innerHTML = `<option value="all">${t("filter.allGenres")}</option>` +
        sorted.map(([key, label]) => `<option value="${escapeHTML(key)}">${escapeHTML(label)}</option>`).join("");
    select.value = genres.has(current) ? current : "all";
    if (select.value === "all") libraryState.genre = "all";

    $("bookGenreList").innerHTML = sorted.map(([, label]) => `<option value="${escapeHTML(label)}">`).join("");
}

function currentView() {
    return prefs.booksView?.[libraryState.tab] || "grid";
}

function filtersActive() {
    return Boolean(libraryState.search.trim()) || libraryState.genre !== "all" || libraryState.rating !== "all";
}

function lastActivity(book) {
    const last = sessionsForBook(book.id)[0];
    return last ? `${last.session_date}|${last.ended_at || last.created_at || ""}` : String(book.started_at || book.created_at || "");
}

function filteredBooks() {
    const search = normalizeText(libraryState.search);
    let list = books.filter(b => libraryState.tab === "all" || b.status === libraryState.tab);

    if (search) list = list.filter(b => normalizeText(`${b.title} ${b.author || ""}`).includes(search));
    if (libraryState.genre !== "all") list = list.filter(b => normalizeGenre(b.genre) === libraryState.genre);
    if (libraryState.rating === "none") list = list.filter(b => !b.rating);
    else if (libraryState.rating !== "all") list = list.filter(b => Number(b.rating) >= Number(libraryState.rating));

    const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "", currentLocale());
    const byAdded = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
    const sorters = {
        added: byAdded,
        title: byTitle,
        author: (a, b) => (a.author || "￿").localeCompare(b.author || "￿", currentLocale()) || byTitle(a, b),
        progress: (a, b) => (progressPct(b) ?? -1) - (progressPct(a) ?? -1) || byTitle(a, b),
        finished: (a, b) => String(b.finished_at || "").localeCompare(String(a.finished_at || "")) || byTitle(a, b),
        priority: (a, b) => (a.priority || 2) - (b.priority || 2) || byAdded(a, b)
    };

    let sort = libraryState.sort;
    if (sort === "default") {
        sort = { want: "priority", finished: "finished" }[libraryState.tab] || "activity";
    }

    if (sort === "activity") {
        list.sort((a, b) => {
            const aActive = activeSession && Number(activeSession.book_id) === Number(a.id) ? 1 : 0;
            const bActive = activeSession && Number(activeSession.book_id) === Number(b.id) ? 1 : 0;
            return bActive - aActive || lastActivity(b).localeCompare(lastActivity(a)) || byAdded(a, b);
        });
    } else {
        list.sort(sorters[sort] || byAdded);
    }

    return list;
}

let lastShelfKey = "";

function renderLibraryList() {
    if (!libraryReady) { libraryList.innerHTML = ""; return; }

    if (!libraryLoaded) {
        libraryList.className = "library-list view-cards";
        libraryList.innerHTML = Array.from({ length: 3 }).map(() => `<div class="lib-card skeleton-card"></div>`).join("");
        return;
    }

    const list = filteredBooks();
    const view = currentView();
    libraryList.className = `library-list view-${view}`;

    if (!list.length) {
        libraryList.innerHTML = renderEmptyState();
        return;
    }

    const resultsInfo = filtersActive()
        ? `<div class="results-info">${t("lib.results", list.length)} <button type="button" class="inline-link" data-action="clear-filters">${t("lib.clearFilters")}</button></div>`
        : "";

    const pickBar = libraryState.tab === "want" && !filtersActive() && list.length >= 2
        ? `<div class="list-toolbar"><button type="button" class="chip-button pick-button" data-action="pick-next"><svg><use href="#i-shuffle"/></svg>${t("pick.button")}</button></div>`
        : "";

    // A animação de "guardar na estante" só toca ao trocar de aba ou de visualização
    const shelfKey = `${libraryState.tab}|${view}`;
    const enter = shelfKey !== lastShelfKey;
    lastShelfKey = shelfKey;
    libraryList.innerHTML = resultsInfo + pickBar + (view === "grid"
        ? `<div class="bookshelf${enter ? " enter" : ""}" role="list">${list.map(renderSpine).join("")}<span class="bookend" aria-hidden="true"></span></div>`
        : list.map(renderBookCard).join(""));
}

function renderEmptyState() {
    if (filtersActive()) {
        return emptyBlock("🔍", t("lib.empty.filtered"), t("lib.empty.filteredDesc"),
            `<button type="button" class="secondary-button" data-action="clear-filters">${t("lib.clearFilters")}</button>`);
    }

    const counts = statusCounts();
    const addBtn = (labelKey, status) =>
        `<button type="button" class="primary-button compact" data-action="add-book" data-status="${status}">${t(labelKey)}</button>`;

    switch (libraryState.tab) {
        case "reading":
            return emptyBlock("📖", t("lib.empty.reading"), t("lib.empty.readingDesc"),
                addBtn("lib.empty.addBook", "reading") +
                (counts.want ? `<button type="button" class="secondary-button" data-action="go-tab" data-tab="want">${t("lib.empty.seeWant", counts.want)}</button>` : ""));
        case "want":
            return emptyBlock("🔖", t("lib.empty.want"), t("lib.empty.wantDesc"), addBtn("lib.empty.addWant", "want"));
        case "paused":
            return emptyBlock("⏸", t("lib.empty.paused"), t("lib.empty.pausedDesc"), "");
        case "finished":
            return emptyBlock("🏁", t("lib.empty.finished"), t("lib.empty.finishedDesc"),
                counts.reading ? `<button type="button" class="secondary-button" data-action="go-tab" data-tab="reading">${t("lib.empty.seeReading")}</button>` : "");
        default:
            return emptyBlock("📚", t("lib.empty.all"), t("lib.empty.allDesc"), addBtn("lib.empty.addBook", "reading"));
    }
}

function emptyBlock(icon, title, desc, actions) {
    return `
        <div class="empty library-empty">
            <div class="empty-icon">${icon}</div>
            <strong>${title}</strong>
            <p>${desc}</p>
            ${actions ? `<div class="empty-actions">${actions}</div>` : ""}
        </div>`;
}

function coverImg(book, cls) {
    const fallback = placeholderImage(300, 450);
    return `<img class="${cls}" src="${escapeHTML(book.cover || fallback)}" alt="${t("books.coverOf", { title: escapeHTML(book.title) })}"
                 loading="lazy" data-fallback="${fallback}">`;
}

function statusBadge(status) {
    return `<span class="status-badge status-${status}">${t(`lib.status.${status}`)}</span>`;
}

function starsHTML(rating, size = "") {
    if (!rating) return "";
    return `<span class="stars ${size}" aria-label="${t("lib.rating.aria", rating)}">${
        [1, 2, 3, 4, 5].map(i => `<svg class="${i <= rating ? "on" : ""}"><use href="#i-star"/></svg>`).join("")}</span>`;
}

function progressBar(book, compact = false) {
    const pct = progressPct(book);
    if (pct === null) return "";
    return `
        <div class="lib-progress ${compact ? "compact" : ""}">
            <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
                <div class="progress-fill ${book.status === "finished" ? "done" : ""}" style="width:${pct}%"></div>
            </div>
            <span class="lib-progress-label">${pct}%</span>
        </div>`;
}

function goalLine(book) {
    const goal = goalInfo(book);
    if (!goal) return "";
    const unit = t(goal.type === "pages" ? "lib.unit.pagesShort" : "lib.unit.minShort");
    if (goal.met) {
        return `<div class="lib-line goal-met"><svg><use href="#i-check"/></svg>${t("lib.goal.met", goal.done, goal.target, unit)}</div>`;
    }
    return `<div class="lib-line">${t("lib.goal.progress", goal.done, goal.target, unit, goal.remaining)}</div>`;
}

// Uma única linha de destaque por card (a mais útil no momento)
function cardInsight(book) {
    if (book.status === "reading") {
        if (isAtLastPage(book)) {
            return `<div class="lib-insight celebrate">🎉 ${t("lib.lastPageReached")}
                <button type="button" class="inline-link" data-action="finish-book" data-id="${book.id}" data-busy-key="finish-${book.id}">${t("lib.markFinished")}</button></div>`;
        }
        const goal = goalInfo(book);
        if (goal && !goal.met) {
            const unit = t(goal.type === "pages" ? "lib.unit.pagesShort" : "lib.unit.minShort");
            return `<div class="lib-insight"><svg><use href="#i-flag"/></svg>${t("lib.goal.progress", goal.done, goal.target, unit, goal.remaining)}</div>`;
        }
        if (goal && goal.met) {
            const unit = t(goal.type === "pages" ? "lib.unit.pagesShort" : "lib.unit.minShort");
            return `<div class="lib-insight ok"><svg><use href="#i-check"/></svg>${t("lib.goal.met", goal.done, goal.target, unit)}</div>`;
        }
        const fc = forecast(book);
        if (fc) return `<div class="lib-insight"><svg><use href="#i-flag"/></svg>${forecastText(fc)}</div>`;
        return "";
    }
    if (book.status === "want" && book.notes) return `<p class="lib-insight notes">${escapeHTML(book.notes)}</p>`;
    if (book.status === "paused" && book.status_changed_at) return `<div class="lib-insight">${t("lib.pausedSince", shortDate(String(book.status_changed_at).slice(0, 10)))}</div>`;
    if (book.status === "finished") {
        return `<div class="lib-insight">${book.rating ? starsHTML(book.rating, "small") : ""}${book.finished_at ? `<span>${t("lib.finishedOn", shortDate(book.finished_at))}</span>` : ""}</div>`;
    }
    return "";
}

function renderBookCard(book) {
    const isActive = activeSession && Number(activeSession.book_id) === Number(book.id);
    const otherActive = activeSession && !isActive;
    const pct = progressPct(book);

    // Linha de dados: só o essencial
    const meta = [];
    if (book.author) meta.push(`<span>${escapeHTML(book.author)}</span>`);
    if (book.status === "want") {
        meta.push(`<span class="prio-dot prio-${book.priority || 2}">${t(`lib.priority.${book.priority || 2}`)}</span>`);
        if (book.total_pages) meta.push(`<span>${t("lib.totalPages", book.total_pages)}</span>`);
    } else {
        meta.push(`<span>${book.total_pages ? t("lib.pageOf", book.current_page || 0, book.total_pages) : t("lib.pageOnly", book.current_page || 0)}</span>`);
    }

    let action = "";
    if (book.status === "reading") {
        if (isActive) {
            const running = isSessionRunning();
            action = `
                <div class="lib-live ${running ? "running" : "paused"}">
                    <span class="lib-timer" data-session-timer>${formatDuration(sessionElapsed(activeSession))}</span>
                    <button type="button" class="round-action" data-action="${running ? "pause-session" : "resume-session"}" data-busy-key="session"
                            aria-label="${t(running ? "books.pause" : "books.resume")}" title="${t(running ? "books.pause" : "books.resume")}">
                        <svg><use href="#i-${running ? "pause" : "play"}"/></svg></button>
                    <button type="button" class="round-action primary" data-action="finish-session" data-busy-key="session"
                            aria-label="${t("lib.session.finish")}" title="${t("lib.session.finish")}"><svg><use href="#i-stop"/></svg></button>
                </div>`;
        } else {
            const label = t(sessionsForBook(book.id).length ? "lib.session.continue" : "books.start");
            action = `<button type="button" class="round-action primary" data-action="start-session" data-id="${book.id}" data-busy-key="session"
                        aria-label="${label}" title="${otherActive ? t("books.otherTimer") : label}" ${otherActive ? "disabled" : ""}><svg><use href="#i-play"/></svg></button>`;
        }
    } else if (book.status === "want") {
        action = `<button type="button" class="round-action" data-action="start-book" data-id="${book.id}" data-busy-key="status-${book.id}" aria-label="${t("lib.action.startBook")}" title="${t("lib.action.startBook")}"><svg><use href="#i-play"/></svg></button>`;
    } else if (book.status === "paused") {
        action = `<button type="button" class="round-action" data-action="resume-book" data-id="${book.id}" data-busy-key="status-${book.id}" aria-label="${t("lib.action.resumeBook")}" title="${t("lib.action.resumeBook")}"><svg><use href="#i-play"/></svg></button>`;
    } else if (book.status === "finished" && !book.rating) {
        action = `<button type="button" class="round-action" data-action="review" data-id="${book.id}" aria-label="${t("lib.action.rate")}" title="${t("lib.action.rate")}"><svg><use href="#i-star"/></svg></button>`;
    }

    // O selo de status só aparece na aba "Todos" (nas outras ele é óbvio)
    const badge = libraryState.tab === "all" ? statusBadge(book.status) : "";

    return `
        <article class="lib-card status-${book.status} ${isActive ? "is-active" : ""}" data-id="${book.id}">
            <button type="button" class="lib-cover-btn" data-action="details" data-id="${book.id}" aria-label="${t("lib.action.details")}: ${escapeHTML(book.title)}">
                ${coverImg(book, "lib-cover")}
            </button>

            <div class="lib-body">
                <div class="lib-head">
                    <button type="button" class="lib-title" data-action="details" data-id="${book.id}">${escapeHTML(book.title)}</button>
                    ${badge}
                </div>
                <div class="lib-meta">${meta.join("")}</div>
                ${book.status !== "want" && pct !== null ? `
                    <div class="lib-progress-line" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
                        <span class="lib-progress-fill ${book.status === "finished" ? "done" : ""}" style="width:${pct}%"></span>
                    </div>` : ""}
                ${cardInsight(book)}
            </div>

            ${book.status !== "want" && pct !== null ? `<div class="lib-pct ${book.status === "finished" ? "done" : ""}">${pct}<small>%</small></div>` : `<div class="lib-pct none"></div>`}

            <div class="lib-actions">
                ${action}
                <button type="button" class="menu-trigger" data-action="menu" data-id="${book.id}" aria-haspopup="menu" aria-label="${t("lib.menu.label")}"><svg><use href="#i-more"/></svg></button>
            </div>
        </article>`;
}

// ---------- Estante: cada livro é uma lombada em pé na prateleira ----------
// Cor de encadernação estável para cada título (couro, tecido, papel)
const BINDINGS = [
    ["#6e2420", "#e9cf9a"], ["#2f4a33", "#e4cf98"], ["#2f3a4f", "#e6d3a6"], ["#8a5a24", "#f6e4b8"],
    ["#5e2a3a", "#ecd2a2"], ["#6b4527", "#f0d9a8"], ["#4a4a3f", "#e8d5a4"], ["#d6c49a", "#4a2f1c"],
    ["#7a3b2a", "#f2dcaa"], ["#3d3a52", "#e7d3a3"], ["#556042", "#f0dfb0"], ["#b8956a", "#3a2516"]
];
function bookHash(text) {
    let h = 2166136261;
    for (const ch of String(text || "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
function bookBinding(book) {
    const [bg, ink] = BINDINGS[bookHash(book.title) % BINDINGS.length];
    return { bg, ink };
}
function spineSize(book) {
    const pages = Number(book.total_pages) || 220;
    const width = Math.round(Math.min(64, Math.max(24, 18 + pages / 14)));
    const height = 150 + (bookHash(book.title + "h") % 48);   // alturas levemente diferentes, como numa estante real
    return { width, height };
}

function renderSpine(book, index) {
    const pct = progressPct(book);
    const { bg, ink } = bookBinding(book);
    const { width, height } = spineSize(book);
    const live = activeSession && Number(activeSession.book_id) === Number(book.id);
    const statusLine = book.status === "finished"
        ? [book.finished_at ? shortDate(book.finished_at) : null, book.total_pages ? t("lib.unit.pages", book.total_pages) : null].filter(Boolean).join(" · ")
        : book.status === "want" ? t(`lib.priority.${book.priority || 2}`)
        : pct !== null ? t("shelf.progress", pct, book.current_page || 0, book.total_pages) : t("lib.pageOnly", book.current_page || 0);
    const label = [book.title, book.author, t(`lib.status.${book.status}`), statusLine].filter(Boolean).join(" — ");
    // Ação rápida dentro da prévia (a mesma do botão redondo da lista)
    const otherActive = activeSession && Number(activeSession.book_id) !== Number(book.id);
    const quick = book.status === "reading" && !live
        ? [`start-session`, t(sessionsForBook(book.id).length ? "lib.session.continue" : "books.start"), "play", otherActive]
        : book.status === "want" ? ["start-book", t("lib.action.startBook"), "play", false]
        : book.status === "paused" ? ["resume-book", t("lib.action.resumeBook"), "play", false]
        : book.status === "finished" ? ["share-card", t("card.share"), "share", false]
        : null;

    return `
        <div class="spine-slot" role="listitem" style="--i:${Math.min(index, 24)};--w:${width}px;--h:${height}px;--bind:${bg};--ink:${ink};--pct:${pct ?? 0}">
            <button type="button" class="spine shelf-item status-${book.status}${live ? " live" : ""}${width < 34 ? " slim" : ""}" data-action="details" data-id="${book.id}" aria-label="${escapeHTML(label)}">
                <span class="spine-band top"></span>
                <span class="spine-title">${escapeHTML(book.title)}</span>
                ${book.author ? `<span class="spine-author">${escapeHTML(initialsOf(book.author))}</span>` : ""}
                <span class="spine-band bottom"></span>
                ${book.status === "reading" || book.status === "paused" ? `<span class="spine-fill" aria-hidden="true"></span><span class="spine-ribbon" aria-hidden="true"></span>` : ""}
                ${book.status === "finished" ? `<span class="spine-seal" aria-hidden="true"></span>` : ""}
            </button>
            <div class="spine-peek">
                ${coverImg(book, "peek-cover")}
                <div class="peek-text">
                    <strong>${escapeHTML(book.title)}</strong>
                    ${book.author ? `<span>${escapeHTML(book.author)}</span>` : ""}
                    <em>${statusLine}${book.status === "finished" && book.rating ? ` · ${"★".repeat(Math.min(5, Number(book.rating)))}` : ""}</em>
                    ${pct !== null && book.status !== "want" && book.status !== "finished" ? `<i class="peek-bar"><b style="width:${pct}%"></b></i>` : ""}
                </div>
                ${quick ? `<button type="button" class="peek-action" data-action="${quick[0]}" data-id="${book.id}" data-busy-key="${quick[0] === "start-session" ? "session" : `status-${book.id}`}" ${quick[3] ? "disabled" : ""}><svg><use href="#i-${quick[2]}"/></svg>${quick[1]}</button>` : ""}
            </div>
        </div>`;
}

function initialsOf(name) {
    const parts = String(name).trim().split(/\s+/);
    return parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : parts[0];
}

// -----------------------------------------------------
// SESSÃO ATIVA — barra, cronômetro, título da aba
// -----------------------------------------------------

function renderActiveSessionBar() {
    renderFocusMode();
    const bar = $("activeSessionBar");
    const pill = $("topbarSession");
    const book = activeSession ? bookById(activeSession.book_id) : null;

    renderHeroNext(book);

    if (!activeSession || !book || !libraryReady) {
        bar.classList.add("hidden");
        pill.classList.add("hidden");
        return;
    }

    const running = isSessionRunning();
    const elapsed = formatDuration(sessionElapsed(activeSession));
    const pct = progressPct(book);

    bar.className = `active-session-bar ${running ? "running" : "paused"}`;
    bar.innerHTML = `
        <div class="asb-top">
            <span class="asb-dot" aria-hidden="true"></span>
            <small>${t(running ? "lib.session.readingNow" : "lib.session.paused")}</small>
            <button type="button" class="asb-icon" data-action="focus-open" aria-label="${t("focus.open")}" title="${t("focus.open")}"><svg><use href="#i-focus"/></svg></button>
        </div>
        <button type="button" class="asb-title" data-action="details" data-id="${book.id}">${escapeHTML(book.title)}</button>
        <div class="asb-timer" data-session-timer>${elapsed}</div>
        ${pct !== null ? `<div class="asb-progress"><span style="width:${pct}%"></span></div>` : ""}
        <div class="asb-actions">
            <button type="button" class="asb-btn" data-action="${running ? "pause-session" : "resume-session"}" data-busy-key="session">
                <svg><use href="#i-${running ? "pause" : "play"}"/></svg>${t(running ? "books.pause" : "books.resume")}</button>
            <button type="button" class="asb-btn primary" data-action="finish-session" data-busy-key="session">${t("lib.session.finish")}</button>
        </div>`;

    pill.classList.remove("hidden");
    pill.classList.toggle("paused", !running);
    pill.innerHTML = `<svg><use href="#i-${running ? "clock" : "pause"}"/></svg><span data-session-timer>${elapsed}</span><span class="pill-title">${escapeHTML(book.title)}</span>`;
    pill.title = t("lib.session.goToBook");
}

// Sem sessão ativa: mostra o último livro lido, pronto para retomar com um clique
function renderHeroNext(activeBook) {
    const box = $("heroNext");
    if (!box) return;
    const reading = books.filter(b => b.status === "reading");
    if (activeBook || !libraryReady || !reading.length) { box.classList.add("hidden"); return; }

    const book = [...reading].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)))[0];
    const pct = progressPct(book);

    box.classList.remove("hidden");
    box.innerHTML = `
        <small class="hero-next-eyebrow">${t("next.eyebrow")}</small>
        <div class="hero-next-row">
            <button type="button" class="hero-next-cover" data-action="details" data-id="${book.id}" aria-label="${escapeHTML(book.title)}">${coverImg(book, "hero-next-img")}</button>
            <div class="hero-next-info">
                <strong>${escapeHTML(book.title)}</strong>
                <span>${book.total_pages ? t("lib.pageOf", book.current_page || 0, book.total_pages) : t("lib.pageOnly", book.current_page || 0)}</span>
                ${pct !== null ? `<div class="asb-progress"><span style="width:${pct}%"></span></div>` : ""}
            </div>
        </div>
        <button type="button" class="asb-btn primary wide" data-action="start-session" data-id="${book.id}" data-busy-key="session">
            <svg><use href="#i-play"/></svg>${t("next.resume")}</button>`;
}

function startTick() {
    stopTick();
    tickIntervalId = setInterval(onTick, 1000);
}

function stopTick() {
    if (tickIntervalId) clearInterval(tickIntervalId);
    tickIntervalId = null;
}

function onTick() {
    if (!activeSession) { stopTick(); return; }
    const text = formatDuration(sessionElapsed(activeSession));
    document.querySelectorAll("[data-session-timer]").forEach(el => { el.textContent = text; });
    checkSessionGoal();
    updateFocusRing();
    updateTabTitle();
}

function checkSessionGoal() {
    const goal = Number(prefs.sessionGoalMin || 0);
    if (!goal || !isSessionRunning()) return;
    if (sessionElapsed(activeSession) < goal * 60) return;

    // Guarda que o aviso já foi dado nesta sessão (não repete ao recarregar a página)
    let notified = null;
    try { notified = localStorage.getItem("trama.goalNotified"); } catch (e) { /* sem armazenamento */ }
    if (notified === String(activeSession.id)) return;
    try { localStorage.setItem("trama.goalNotified", String(activeSession.id)); } catch (e) { /* sem armazenamento */ }

    if (prefs.sessionSound) playChime();
    showToast(t("books.goalReached", goal), "success");
}

function updateTabTitle() {
    const book = activeSession ? bookById(activeSession.book_id) : null;
    if (prefs.timerInTab && book && isSessionRunning()) {
        document.title = `⏱ ${formatDuration(sessionElapsed(activeSession))} · ${book.title}`;
    } else {
        document.title = BASE_TITLE;
    }
}

$("topbarSession").addEventListener("click", () => {
    if (!activeSession) return;
    goToPage("livrosPage");
    if (libraryState.tab !== "reading" && libraryState.tab !== "all") setLibraryTab("reading");
});

// -----------------------------------------------------
// ESTATÍSTICAS DE LEITURA (aba Estatísticas, com filtro de período)
// -----------------------------------------------------

function renderLibrarySummary() {
    const counts = statusCounts();
    $("libraryStatusRow").innerHTML = STATUSES.map(s =>
        `<button type="button" class="status-chip status-${s}" data-action="go-tab" data-tab="${s}">
            <strong>${counts[s]}</strong><span>${t(`lib.tab.${s}`)}</span></button>`).join("");

    document.querySelectorAll("#summaryPeriod button").forEach(b => b.classList.toggle("active", b.dataset.period === libraryState.period));

    const start = periodStart(libraryState.period);
    const sessions = completedSessions().filter(s => !start || s.session_date >= start);
    const pages = sessions.reduce((sum, s) => sum + Number(s.pages_read || 0), 0);
    const seconds = sessions.reduce((sum, s) => sum + Number(s.duration_seconds || 0), 0);
    const timed = sessions.filter(s => Number(s.duration_seconds) > 0);
    const pagesByDay = {};
    sessions.forEach(s => { pagesByDay[s.session_date] = (pagesByDay[s.session_date] || 0) + Number(s.pages_read || 0); });
    const readingDays = Object.values(pagesByDay).filter(v => v > 0);
    const days = new Set(sessions.map(s => s.session_date)).size;
    const finished = finishRecords().filter(r => !start || r.date >= start).length;

    const fmt = n => Number(n).toLocaleString(currentLocale());
    const primary = [
        [t("label.pagesLogged"), fmt(pages), "i-book"],
        [t("label.totalTime"), seconds ? humanDuration(seconds) : "0min", "i-clock"],
        [t("lib.stat.sessions"), fmt(sessions.length), "i-history"],
        [t("lib.stat.finished"), fmt(finished), "i-flag"]
    ];
    const secondary = [
        [t("lib.stat.avgPages"), sessions.length ? Math.round(pages / sessions.length) : 0],
        [t("lib.stat.avgTime"), timed.length ? humanDuration(timed.reduce((a, s) => a + Number(s.duration_seconds), 0) / timed.length) : "—"],
        [t("stats.avgPerDay"), t("stats.pagesUnit", readingDays.length ? Math.round(readingDays.reduce((a, v) => a + v, 0) / readingDays.length) : 0)],
        [t("lib.stat.readingDays"), days],
        [t("label.streak"), t("unit.days", computeStreak())],
        [t("stats.bestStreak"), t("unit.days", computeBestStreak())]
    ];

    $("librarySummary").innerHTML = `
        <div class="kpi-primary">
            ${primary.map(([label, value, icon]) => `
                <div class="kpi">
                    <span class="kpi-label"><svg><use href="#${icon}"/></svg>${label}</span>
                    <strong class="kpi-value">${value}</strong>
                </div>`).join("")}
        </div>
        <dl class="kpi-secondary">
            ${secondary.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
        </dl>`;

    renderPagesChart();
    renderFinishedChart();
    renderHeatmap();
}

// Páginas lidas por dia (últimos 14 dias)
function renderPagesChart() {
    const pagesByDay = {};
    completedSessions().forEach(s => { pagesByDay[s.session_date] = (pagesByDay[s.session_date] || 0) + Number(s.pages_read || 0); });

    const weekdays = t("chart.weekdays");
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const key = addDays(todayISO(), -i);
        days.push({ key, date: parseLocalDate(key), pages: pagesByDay[key] || 0, isToday: i === 0 });
    }
    const max = Math.max(1, ...days.map(d => d.pages));

    $("readingChart").innerHTML = days.map(day => {
        const height = day.pages ? Math.max(8, (day.pages / max) * 100) : 3;
        return `
            <div class="chart-col ${day.isToday ? "today" : ""}" title="${day.date.toLocaleDateString(currentLocale())}: ${t("unit.pages", day.pages)}">
                <span class="chart-value">${day.pages || ""}</span>
                <div class="chart-bar ${day.pages ? "filled" : ""}" style="height:${height}%"></div>
                <span class="chart-label">${day.isToday ? t("chart.today") : weekdays[day.date.getDay()]}</span>
            </div>`;
    }).join("");
}

// Livros concluídos por mês (últimos 12 meses)
function renderFinishedChart() {
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, date: d, count: 0 });
    }
    finishRecords().forEach(r => {
        const m = months.find(x => x.key === r.date.slice(0, 7));
        if (m) m.count++;
    });
    const max = Math.max(1, ...months.map(m => m.count));

    $("finishedChart").innerHTML = months.map((m, i) => {
        const label = m.date.toLocaleDateString(currentLocale(), { month: "short" }).replace(".", "");
        const height = m.count ? Math.max(10, (m.count / max) * 100) : 3;
        return `
            <div class="chart-col ${i === 11 ? "today" : ""}" title="${m.date.toLocaleDateString(currentLocale(), { month: "long", year: "numeric" })}: ${m.count}">
                <span class="chart-value">${m.count || ""}</span>
                <div class="chart-bar ${m.count ? "filled done" : ""}" style="height:${height}%"></div>
                <span class="chart-label">${label}</span>
            </div>`;
    }).join("");
}

function renderBookHeroStats() {
    const all = completedSessions();
    const pages = all.reduce((sum, s) => sum + Number(s.pages_read || 0), 0);
    const seconds = all.reduce((sum, s) => sum + Number(s.duration_seconds || 0), 0);
    const fmt = n => Number(n).toLocaleString(currentLocale());

    $("heroBookStreak").textContent = computeStreak();
    $("heroBookPages").textContent = fmt(pages);
    $("heroBookActive").textContent = statusCounts().reading;

    // Desafio do ano como um número do topo (clique para definir/alterar)
    const year = new Date().getFullYear();
    const goal = challengeGoal(year);
    const done = finishRecords().filter(r => String(r.date || "").startsWith(String(year))).length;
    $("heroChallenge").innerHTML = goal
        ? `<strong>${done}<small>/${goal}</small></strong><span>${t("ch.readout", year)}</span><i class="readout-bar"><b style="width:${Math.min(100, done / goal * 100)}%"></b></i>`
        : `<strong class="plus">+</strong><span>${t("ch.readoutSet")}</span>`;

    // Topo das Estatísticas
    $("heroStatPages").textContent = fmt(pages);
    $("heroStatTime").textContent = seconds ? humanDuration(seconds) : "0h";
    $("heroStatBooks").textContent = finishRecords().length;
}

// -----------------------------------------------------
// INTERAÇÃO — abas, filtros, cliques
// -----------------------------------------------------

function setLibraryTab(tab) {
    libraryState.tab = tab;
    libraryState.sort = "default";
    $("librarySort").value = "default";
    renderTabs();
    renderLibraryList();
}

document.querySelectorAll("#libraryTabs .library-tab").forEach(tab => {
    tab.addEventListener("click", () => setLibraryTab(tab.dataset.tab));
});

$("librarySearch").addEventListener("input", debounce(e => {
    libraryState.search = e.target.value;
    renderLibraryList();
}, 180));

$("libraryGenre").addEventListener("change", e => { libraryState.genre = e.target.value; renderTabs(); renderLibraryList(); });
$("libraryRating").addEventListener("change", e => { libraryState.rating = e.target.value; renderTabs(); renderLibraryList(); });
$("librarySort").addEventListener("change", e => { libraryState.sort = e.target.value; renderTabs(); renderLibraryList(); });

document.querySelectorAll(".view-toggle button").forEach(button => {
    button.addEventListener("click", () => {
        setPref("booksView", { ...(prefs.booksView || {}), [libraryState.tab]: button.dataset.view });
        renderTabs();
        renderLibraryList();
    });
});

document.querySelectorAll("#summaryPeriod button").forEach(button => {
    button.addEventListener("click", () => {
        libraryState.period = button.dataset.period;
        renderLibrarySummary();
    });
});

function clearLibraryFilters() {
    libraryState.search = "";
    libraryState.genre = "all";
    libraryState.rating = "all";
    $("librarySearch").value = "";
    $("libraryGenre").value = "all";
    $("libraryRating").value = "all";
    libraryState.sort = "default";
    $("librarySort").value = "default";
    renderTabs();
    renderLibraryList();
}

setupFilterPop("bookFilterButton", "bookFilterPop");

$("addBookButton").addEventListener("click", () =>
    openBookModalForCreate(["want", "paused", "finished"].includes(libraryState.tab) ? libraryState.tab : "reading"));

// Um único "ouvinte" para todos os botões da biblioteca, barra e detalhes
document.addEventListener("click", event => {
    const el = event.target.closest("[data-action]");
    if (!el || el.disabled) return;
    if (!el.closest("#livrosPage, #bookHero, #statsPage, #achievementsPage, #bookDetailsModal, #bookMenu, #celebrationModal, #readingFormModal, #focusMode")) return;

    const id = el.dataset.id ? Number(el.dataset.id) : null;
    const action = el.dataset.action;

    const handlers = {
        "details": () => {
            // Na estante, o livro sai da prateleira antes de abrir
            if (el.classList.contains("spine") && !prefs.reduceMotion && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
                el.classList.add("pulled");
                setTimeout(() => { openBookDetails(id); el.classList.remove("pulled"); }, 280);
            } else openBookDetails(id);
        },
        "menu": () => openBookMenu(id, el),
        "start-session": () => startSession(id),
        "pause-session": () => pauseSession(),
        "resume-session": () => resumeSession(),
        "finish-session": () => openFinishSession(),
        "log-reading": () => openLogForm(id),
        "start-book": () => startBookFromWant(id),
        "resume-book": () => resumeBook(id),
        "pause-book": () => pauseBook(id),
        "finish-book": () => finishBook(id),
        "reopen-book": () => reopenBook(id),
        "edit-book": () => openEditBook(id),
        "delete-book": () => deleteBook(id),
        "review": () => openBookDetails(id, "review"),
        "clear-filters": () => clearLibraryFilters(),
        "go-tab": () => {
            if (el.closest("#statsPage")) goToPage("livrosPage");
            setLibraryTab(el.dataset.tab);
        },
        "add-book": () => openBookModalForCreate(el.dataset.status || "reading"),
        "reconcile-pages": () => reconcilePages(id),
        "challenge-edit": () => editChallenge(),
        "focus-open": () => openFocusMode(),
        "focus-exit": () => closeFocusMode(),
        "focus-finish": () => { closeFocusMode(); openFinishSession(); },
        "pick-next": () => pickNextBook(),
        "share-card": () => openShareCard(id)
    };

    if (handlers[action]) {
        event.preventDefault();
        closeBookMenu();
        handlers[action]();
    }
});

// -----------------------------------------------------
// MENU DE AÇÕES (⋯)
// -----------------------------------------------------

let bookMenuAnchor = null;

function openBookMenu(bookId, anchor) {
    const book = bookById(bookId);
    if (!book) return;

    if (bookMenuAnchor === anchor && !bookMenu.classList.contains("hidden")) { closeBookMenu(); return; }

    const item = (action, icon, labelKey, extra = "") =>
        `<button type="button" role="menuitem" data-action="${action}" data-id="${book.id}" ${extra}><svg><use href="#i-${icon}"/></svg>${t(labelKey)}</button>`;

    const items = [item("details", "eye", "lib.menu.details"), item("edit-book", "edit", "lib.menu.edit")];

    if (book.status === "reading") {
        items.push(item("log-reading", "pen", "books.register"));
        items.push(item("pause-book", "pause", "lib.menu.pause"));
        items.push(item("finish-book", "flag", "lib.menu.finish"));
    } else if (book.status === "paused") {
        items.push(item("resume-book", "play", "lib.action.resumeBook"));
        items.push(item("finish-book", "flag", "lib.menu.finish"));
    } else if (book.status === "want") {
        items.push(item("start-book", "play", "lib.action.startBook"));
    } else if (book.status === "finished") {
        items.push(item("share-card", "share", "card.create"));
        items.push(item("review", "star", "lib.menu.review"));
        items.push(item("reopen-book", "refresh", "lib.menu.reopen"));
    }

    items.push(`<div class="menu-sep"></div>`);
    items.push(item("delete-book", "trash", "lib.menu.delete", `class="danger"`));

    bookMenu.innerHTML = items.join("");
    bookMenu.classList.remove("hidden");
    bookMenuOpenedAt = Date.now();
    bookMenuAnchor = anchor;
    anchor.setAttribute("aria-expanded", "true");

    // Posiciona perto do botão, sem sair da tela
    const rect = anchor.getBoundingClientRect();
    const menuRect = bookMenu.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 6);
    let left = rect.right - menuRect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    bookMenu.style.top = `${top}px`;
    bookMenu.style.left = `${left}px`;

    bookMenu.querySelector("button")?.focus({ preventScroll: true });
}

// Retorna true se havia um menu aberto (usado pelo Esc)
function closeBookMenu() {
    if (bookMenu.classList.contains("hidden")) return false;
    bookMenu.classList.add("hidden");
    if (bookMenuAnchor) {
        bookMenuAnchor.setAttribute("aria-expanded", "false");
        if (document.contains(bookMenuAnchor)) bookMenuAnchor.focus();
    }
    bookMenuAnchor = null;
    return true;
}

document.addEventListener("click", event => {
    if (bookMenu.classList.contains("hidden")) return;
    if (!event.target.closest("#bookMenu") && !event.target.closest("[data-action='menu']")) closeBookMenu();
}, true);

// Fecha ao rolar a página — exceto a rolagem que acontece junto com o clique que abriu o menu
let bookMenuOpenedAt = 0;
window.addEventListener("resize", () => closeBookMenu());
document.addEventListener("scroll", event => {
    if (bookMenu.classList.contains("hidden") || Date.now() - bookMenuOpenedAt < 400) return;
    if (event.target instanceof Element && event.target.closest("#bookMenu")) return;
    closeBookMenu();
}, true);

bookMenu.addEventListener("keydown", event => {
    const items = [...bookMenu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
});

// -----------------------------------------------------
// JANELA DE CONFIRMAÇÃO (substitui o confirm() do navegador)
// -----------------------------------------------------

let dialogResolver = null;

// actions: [{ label, value, style: "primary" | "secondary" | "danger" }]
function askDialog({ title, message, actions }) {
    return new Promise(resolve => {
        if (dialogResolver) dialogResolver(null);
        dialogResolver = resolve;

        $("dialogTitle").textContent = title;
        $("dialogMessage").innerHTML = message || "";
        $("dialogActions").innerHTML = actions.map((a, i) =>
            `<button type="button" class="${a.style === "danger" ? "danger-button" : a.style === "primary" ? "primary-button" : "secondary-button"}" data-dialog-index="${i}">${a.label}</button>`
        ).join("");

        $("dialogActions").querySelectorAll("button").forEach(button => {
            button.addEventListener("click", () => finishDialog(actions[Number(button.dataset.dialogIndex)].value));
        });

        openOverlay($("dialogModal"));
        const primary = $("dialogActions").querySelector(".primary-button, .danger-button") || $("dialogActions").querySelector("button");
        setTimeout(() => primary?.focus(), 50);
    });
}

function confirmDialog(title, message, confirmLabel, danger = false) {
    return askDialog({
        title, message,
        actions: [
            { label: t("lib.cancel"), value: false, style: "secondary" },
            { label: confirmLabel, value: true, style: danger ? "danger" : "primary" }
        ]
    });
}

function finishDialog(value) {
    closeOverlay($("dialogModal"));
    const resolve = dialogResolver;
    dialogResolver = null;
    if (resolve) resolve(value);
}

$("dialogModal").addEventListener("click", event => { if (event.target === $("dialogModal")) finishDialog(null); });

// Fecha janelas deste módulo (chamado pelo Esc em app.js)
function closeBooksOverlay(overlay) {
    if (overlay.id === "dialogModal") finishDialog(null);
    else if (overlay.id === "bookModal") closeBookModalFn();
    else if (overlay.id === "bookDetailsModal") closeBookDetails();
    else closeOverlay(overlay);
}

document.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", () => {
        const overlay = $(button.dataset.close);
        if (overlay.id === "bookDetailsModal") closeBookDetails();
        else closeOverlay(overlay);
    });
});

["bookDetailsModal", "readingFormModal", "celebrationModal"].forEach(id => {
    $(id).addEventListener("click", event => {
        if (event.target !== $(id)) return;
        if (id === "bookDetailsModal") closeBookDetails();
        else closeOverlay($(id));
    });
});

// -----------------------------------------------------
// FORMULÁRIO DE LIVRO (adicionar / editar)
// -----------------------------------------------------

function refreshBookModalTexts() {
    const editing = Boolean(editingBookId);
    const status = $("bookStatus").value;
    $("bookModalEyebrow").textContent = t(editing ? "bookModal.editEyebrow" : "bookModal.newEyebrow") +
        (!editing && status !== "reading" ? ` · ${t(`lib.status.${status}`).toUpperCase()}` : "");
    $("bookModalTitle").textContent = t(editing ? "bookModal.editTitle" : "bookModal.newTitle");
    if (!saveBookButton.disabled) saveBookButton.textContent = t(editing ? "btn.saveChanges" : "btn.saveBook");
}

function setGoalType(type) {
    bookFormState.goalType = type;
    document.querySelectorAll("#bookGoalType button").forEach(b => b.classList.toggle("active", b.dataset.goalType === type));
    $("bookDailyGoal").max = type === "minutes" ? 1440 : 5000;
    if (typeof updateBookPreview === "function" && $("bookModal").classList.contains("show")) updateBookPreview();
}

function setPriority(priority) {
    bookFormState.priority = priority;
    document.querySelectorAll("#bookPriority button").forEach(b => b.classList.toggle("active", Number(b.dataset.priority) === priority));
}

function updateBookFormVisibility() {
    const status = $("bookStatus").value;
    $("bookModal").dataset.status = status;
    $("bookFinishedField").classList.toggle("hidden", status !== "finished");
    $("bookStartedField").classList.toggle("hidden", status === "want");
    $("bookCurrentPageField").classList.toggle("hidden", status === "want" || status === "finished");
    $("bookPriorityField").classList.toggle("hidden", status !== "want");
    $("bookGoalField").classList.toggle("hidden", status === "finished");
    $("bookDatesRow").classList.toggle("hidden", status === "want");
}

document.querySelectorAll("#bookGoalType button").forEach(b => b.addEventListener("click", () => setGoalType(b.dataset.goalType)));
document.querySelectorAll("#bookPriority button").forEach(b => b.addEventListener("click", () => setPriority(Number(b.dataset.priority))));
function setBookFormStatus(status) {
    $("bookStatus").value = status;
}
$("bookStatus").addEventListener("change", () => {
    setBookFormStatus($("bookStatus").value);
    updateBookFormVisibility();
    if ($("bookStatus").value === "finished" && !$("bookFinishedAt").value) $("bookFinishedAt").value = todayISO();
    if ($("bookStatus").value === "reading" && !$("bookStartedAt").value) $("bookStartedAt").value = todayISO();
});

function openBookModalForCreate(status = "reading") {
    if (!libraryReady) { showToast(t("lib.err.schema"), "error"); return; }

    editingBookId = null;
    bookForm.reset();
    resetBookCoverField();
    bookFormError.textContent = "";

    setBookFormStatus(status);
    $("bookStartedAt").value = status === "want" ? "" : todayISO();
    $("bookFinishedAt").value = status === "finished" ? todayISO() : "";
    $("bookDailyGoal").value = prefs.defaultDailyGoal || "";
    setGoalType("pages");
    setPriority(2);
    updateBookFormVisibility();
    setDateLimits();
    renderGenreChips();
    updateBookPreview();

    refreshBookModalTexts();
    openOverlay(bookModal);
    setTimeout(() => $("bookTitle").focus(), 100);
}

function openEditBook(id) {
    const book = bookById(id);
    if (!book) return;

    editingBookId = book.id;
    bookForm.reset();
    resetBookCoverField();
    bookFormError.textContent = "";

    $("bookTitle").value = book.title || "";
    $("bookAuthor").value = book.author || "";
    $("bookGenre").value = book.genre || "";
    setBookFormStatus(book.status || "reading");
    $("bookTotalPages").value = book.total_pages ?? "";
    $("bookCurrentPage").value = book.current_page ?? 0;
    $("bookStartedAt").value = book.started_at || "";
    $("bookFinishedAt").value = book.finished_at || "";
    setGoalType(book.goal_type === "minutes" ? "minutes" : "pages");
    $("bookDailyGoal").value = (book.goal_type === "minutes" ? book.daily_goal_minutes : book.daily_goal_pages) || "";
    setPriority(book.priority || 2);
    loadExistingBookCover(book.cover);
    updateBookFormVisibility();
    setDateLimits();
    renderGenreChips();
    updateBookPreview();

    refreshBookModalTexts();
    openOverlay(bookModal);
    setTimeout(() => $("bookTitle").focus(), 100);
}

function setDateLimits() {
    $("bookStartedAt").max = todayISO();
    $("bookFinishedAt").max = todayISO();
}

function closeBookModalFn() {
    closeOverlay(bookModal);
    bookFormError.textContent = "";
    editingBookId = null;
}

$("closeBookModal").addEventListener("click", closeBookModalFn);
bookForm.addEventListener("input", () => { bookFormError.textContent = ""; });
bookModal.addEventListener("click", event => { if (event.target === bookModal) closeBookModalFn(); });

function readIntField(id) {
    const raw = $(id).value.trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
}

function getBookFormData() {
    const status = $("bookStatus").value;
    const goal = readIntField("bookDailyGoal");
    const total = readIntField("bookTotalPages");
    let current = status === "want" ? 0 : readIntField("bookCurrentPage");
    if (current === null) current = 0;

    return {
        title: $("bookTitle").value.trim(),
        author: $("bookAuthor").value.trim() || null,
        genre: $("bookGenre").value.trim() || null,
        status,
        total_pages: total,
        current_page: current,
        started_at: status === "want" ? null : ($("bookStartedAt").value || null),
        finished_at: status === "finished" ? ($("bookFinishedAt").value || null) : undefined,
        goal_type: bookFormState.goalType,
        daily_goal_pages: bookFormState.goalType === "pages" ? goal : null,
        daily_goal_minutes: bookFormState.goalType === "minutes" ? goal : null,
        priority: status === "want" ? bookFormState.priority : (editingBookId ? bookById(editingBookId)?.priority ?? null : null)
    };
}

function validateBookData(data, original) {
    const isInt = v => v === null || (Number.isInteger(v));
    if (!data.title) return t("book.errTitle");
    if (!isInt(data.total_pages) || !isInt(data.current_page) || !isInt(data.daily_goal_pages) || !isInt(data.daily_goal_minutes)) return t("lib.err.wholeNumbers");
    if (data.total_pages !== null && (data.total_pages <= 0 || data.total_pages > 100000)) return t("book.errTotal");
    if (data.current_page < 0) return t("book.errNegative");
    if (data.total_pages !== null && data.current_page > data.total_pages) return t("book.errOver");
    if (data.daily_goal_pages !== null && (data.daily_goal_pages < 1 || data.daily_goal_pages > 5000)) return t("lib.err.goal");
    if (data.daily_goal_minutes !== null && (data.daily_goal_minutes < 1 || data.daily_goal_minutes > 1440)) return t("lib.err.goal");

    const today = todayISO();
    if (data.started_at && data.started_at > today) return t("lib.err.futureDate");
    if (data.finished_at && data.finished_at > today) return t("lib.err.futureDate");
    if (data.finished_at && data.started_at && data.finished_at < data.started_at) return t("lib.err.finishBeforeStart");

    // Duplicado: mesmo título e autor já na biblioteca
    const key = normalizeText(`${data.title}|${data.author || ""}`);
    const duplicate = books.some(b => normalizeText(`${b.title}|${b.author || ""}`) === key && (!original || Number(b.id) !== Number(original.id)));
    if (duplicate) return t("lib.err.duplicate");

    if (original && activeSession && Number(activeSession.book_id) === Number(original.id) && data.status !== "reading") {
        return t("lib.err.activeSessionStatus");
    }

    return null;
}

bookForm.addEventListener("submit", event => {
    event.preventDefault();
    withBusy("book-form", saveBookForm);
});

async function saveBookForm() {
    bookFormError.textContent = "";
    if (!currentUserId) { bookFormError.textContent = t("auth.sessionExpired"); return; }

    const original = editingBookId ? bookById(editingBookId) : null;
    const data = getBookFormData();
    const problem = validateBookData(data, original);
    if (problem) { bookFormError.textContent = problem; return; }

    const today = todayISO();
    const statusChanged = !original || original.status !== data.status;

    // Datas automáticas coerentes com o status
    if (data.status === "reading" && !data.started_at) data.started_at = today;
    if (data.status === "finished") {
        if (!data.finished_at) data.finished_at = today;
        if (!data.started_at) data.started_at = original?.started_at || data.finished_at;
        if (data.total_pages && data.current_page < data.total_pages && statusChanged) data.current_page = data.total_pages;
    }
    if (data.finished_at === undefined) delete data.finished_at;   // preserva a data de conclusão anterior
    if (statusChanged) data.status_changed_at = nowISO();

    saveBookButton.disabled = true;
    saveBookButton.textContent = t(original ? "btn.saving" : "btn.adding");

    try {
        if (selectedBookCoverFile) {
            saveBookButton.textContent = t("btn.uploadingCover");
            data.cover = await uploadImageToBucket(selectedBookCoverFile);
        } else if (bookCoverMarkedForRemoval) {
            data.cover = null;
        }

        let saved;
        if (original) {
            saved = await updateBook(original.id, data);
        } else {
            saved = await run(supabaseClient.from("reading_books")
                .insert({ ...data, user_id: currentUserId })
                .select().single());
            replaceBook(saved);
        }

        // Histórico
        if (!original) {
            await logEvent(saved.id, "created", { status: saved.status });
            if (saved.status === "finished") await logEvent(saved.id, "finished", { date: saved.finished_at });
        } else {
            if (statusChanged) {
                await logEvent(saved.id, saved.status === "finished" ? "finished" : "status", saved.status === "finished"
                    ? { date: saved.finished_at, from: original.status }
                    : { from: original.status, to: saved.status });
            }
            if ((original.current_page || 0) !== (saved.current_page || 0) && !(statusChanged && saved.status === "finished")) {
                await logEvent(saved.id, "page", { from: original.current_page || 0, to: saved.current_page || 0 });
            }
            const fields = ["title", "author", "genre", "total_pages", "started_at", "finished_at", "goal_type", "daily_goal_pages", "daily_goal_minutes", "priority", "notes", "cover"]
                .filter(f => (original[f] ?? null) !== (saved[f] ?? null));
            if (fields.length) await logEvent(saved.id, "edited", { fields });
        }

        closeBookModalFn();
        renderLibrary();
        showToast(t(original ? "book.updated" : "book.added"), "success");

        // Avançou a página pelo formulário: oferece registrar como leitura (para as estatísticas baterem)
        const jump = original ? (saved.current_page || 0) - (original.current_page || 0) : 0;
        if (jump > 0 && saved.status !== "want" && unloggedPages(saved) > 0) {
            const logIt = await askDialog({
                title: t("lib.editJump.title"),
                message: `<p>${t("lib.editJump.message", original.current_page || 0, saved.current_page, Math.min(jump, unloggedPages(saved)))}</p>`,
                actions: [
                    { label: t("lib.editJump.only"), value: false, style: "secondary" },
                    { label: t("lib.reconcile.confirm"), value: true, style: "primary" }
                ]
            });
            if (logIt) {
                try {
                    const date = saved.status === "finished" && saved.finished_at && saved.finished_at <= today ? saved.finished_at : today;
                    const n = Math.min(jump, unloggedPages(saved));
                    await insertProgressSession(saved, n, date);
                    renderLibrary();
                    showToast(t("lib.reconcile.done", n), "success");
                } catch (error) {
                    console.error(error);
                    showToast(dbErrorMessage(error, "books.registerError"), "error");
                }
            }
        }

        if (saved.status === "finished" && statusChanged) openCompletion(saved.id);
    } catch (error) {
        console.error(error);
        bookFormError.textContent = dbErrorMessage(error, "book.errSave");
    } finally {
        saveBookButton.disabled = false;
        refreshBookModalTexts();
    }
}

// Capa do livro
function resetBookCoverField() {
    selectedBookCoverFile = null;
    bookCoverMarkedForRemoval = false;
    bookCoverFile.value = "";
    bookCoverPreview.src = "";
    bookCoverPreviewWrapper.classList.add("hidden");
    bookCoverUploadText.textContent = t("bf.coverHint");
}

function loadExistingBookCover(url) {
    if (!url) return;
    bookCoverPreview.src = url;
    bookCoverPreviewWrapper.classList.remove("hidden");
    bookCoverUploadText.textContent = t("bf.coverHint");
}

bookCoverFile.addEventListener("change", () => {
    const file = bookCoverFile.files[0];
    if (!file) return;
    if (!validateImageFile(file, bookFormError)) { bookCoverFile.value = ""; return; }

    selectedBookCoverFile = file;
    bookCoverMarkedForRemoval = false;
    bookCoverPreview.src = URL.createObjectURL(file);
    bookCoverPreviewWrapper.classList.remove("hidden");
    bookCoverUploadText.textContent = t("bf.coverHint");
    updateBookPreview();
});

$("removeBookCoverButton").addEventListener("click", () => {
    resetBookCoverField();
    bookCoverMarkedForRemoval = true;
    updateBookPreview();
});

// ---------- Livro vivo: a prévia se monta enquanto você preenche ----------
function updateBookPreview() {
    const title = $("bookTitle").value.trim();
    const author = $("bookAuthor").value.trim();
    const total = Number($("bookTotalPages").value) || 0;
    const current = Number($("bookCurrentPage").value) || 0;
    const goal = Number($("bookDailyGoal").value) || 0;
    const status = $("bookStatus").value;
    const preview = $("bookPreview");
    const { bg, ink } = bookBinding({ title: title || "Trama" });

    $("bkPrevTitle").textContent = title || t("bf.untitled");
    $("bkPrevAuthor").textContent = author;
    preview.style.setProperty("--bind", bg);
    preview.style.setProperty("--ink", ink);
    // páginas mais grossas para livros maiores
    preview.style.setProperty("--thick", `${Math.round(Math.min(46, Math.max(12, 10 + (total || 200) / 22)))}px`);
    preview.classList.toggle("has-title", Boolean(title));
    preview.classList.toggle("has-cover", !bookCoverPreviewWrapper.classList.contains("hidden"));
    const pct = total ? Math.min(100, Math.round(current / total * 100)) : 0;
    preview.style.setProperty("--pct", pct);
    preview.classList.toggle("marked", status !== "want" && current > 0);

    // Previsão de término com a meta em páginas
    let forecast = "";
    if (status !== "finished" && status !== "want" && total && goal && bookFormState.goalType === "pages" && total > current) {
        const days = Math.ceil((total - current) / goal);
        const end = new Date(); end.setDate(end.getDate() + days);
        forecast = t("bf.forecast", days, end.toLocaleDateString(currentLocale(), { day: "numeric", month: "long" }));
    } else if (total && current >= total && total > 0) forecast = t("bf.done");
    else if (total) forecast = t("bf.pagesLeft", Math.max(0, total - current));
    $("bookForecast").textContent = forecast;
}

function renderGenreChips() {
    const counts = {};
    books.forEach(b => { if (b.genre) { const k = b.genre.trim(); counts[k] = (counts[k] || 0) + 1; } });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);
    const current = $("bookGenre").value.trim().toLowerCase();
    $("bookGenreChips").innerHTML = top.map(g => `<button type="button" class="${g.toLowerCase() === current ? "on" : ""}" data-genre="${escapeHTML(g)}">${escapeHTML(g)}</button>`).join("");
}
$("bookGenreChips").addEventListener("click", e => {
    const b = e.target.closest("[data-genre]");
    if (!b) return;
    $("bookGenre").value = b.dataset.genre;
    renderGenreChips();
    $("bookTotalPages").focus();
});
bookForm.addEventListener("input", e => {
    if (e.target.id === "bookGenre") renderGenreChips();
    updateBookPreview();
});
// A capa reage ao ponteiro (de leve)
$("bookPreview").addEventListener("pointermove", e => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--rx", ((e.clientY - r.top) / r.height - .5).toFixed(2));
    e.currentTarget.style.setProperty("--ry", ((e.clientX - r.left) / r.width - .5).toFixed(2));
});
$("bookPreview").addEventListener("pointerleave", e => { e.currentTarget.style.setProperty("--rx", 0); e.currentTarget.style.setProperty("--ry", 0); });

// -----------------------------------------------------
// MUDANÇAS DE STATUS
// -----------------------------------------------------

function blockIfActiveSession(bookId) {
    if (activeSession && Number(activeSession.book_id) === Number(bookId)) {
        showToast(t("lib.err.activeSessionStatus"), "error");
        return true;
    }
    return false;
}

async function changeStatus(bookId, status, eventType, extraChanges = {}, eventDetails = {}) {
    const book = bookById(bookId);
    if (!book) return null;

    return withBusy(`status-${bookId}`, async () => {
        try {
            const saved = await updateBook(bookId, { status, status_changed_at: nowISO(), ...extraChanges });
            await logEvent(bookId, eventType, { from: book.status, to: status, ...eventDetails });
            renderLibrary();
            return saved;
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "lib.err.save"), "error");
            return null;
        }
    });
}

async function startBookFromWant(bookId) {
    const book = bookById(bookId);
    if (!book) return;
    const saved = await changeStatus(bookId, "reading", "started", { started_at: book.started_at || todayISO() });
    if (saved) {
        showToast(t("lib.toast.started", { title: saved.title }), "success");
        if (libraryState.tab === "want") setLibraryTab("reading");
    }
}

async function pauseBook(bookId) {
    if (blockIfActiveSession(bookId)) return;
    const saved = await changeStatus(bookId, "paused", "paused");
    if (saved) showToast(t("lib.toast.paused", { title: saved.title }), "success");
}

async function resumeBook(bookId) {
    const book = bookById(bookId);
    if (!book) return;
    const saved = await changeStatus(bookId, "reading", "resumed", { started_at: book.started_at || todayISO() });
    if (saved) {
        showToast(t("lib.toast.resumed", { title: saved.title }), "success");
        if (libraryState.tab === "paused") setLibraryTab("reading");
    }
}

// Conclusão: sempre por ação explícita do usuário
async function finishBook(bookId) {
    const book = bookById(bookId);
    if (!book || blockIfActiveSession(bookId)) return;

    const notAtEnd = book.total_pages && (book.current_page || 0) < book.total_pages;
    const ok = await confirmDialog(
        t("lib.finish.title"),
        `<p>${t("lib.finish.message", { title: escapeHTML(book.title) })}</p>${notAtEnd ? `<p class="hint">${t("lib.finish.notAtEnd", book.current_page || 0, book.total_pages)}</p>
            <label class="check-line"><input type="checkbox" id="finishLogRest" checked><span>${t("lib.finish.logRest", book.total_pages - (book.current_page || 0))}</span></label>` : ""}`,
        t("lib.finish.confirm"));
    if (!ok) return;
    const logRest = notAtEnd && Boolean($("finishLogRest")?.checked);
    const pageBefore = book.current_page || 0;

    const today = todayISO();
    const changes = {
        finished_at: today,
        started_at: book.started_at && book.started_at <= today ? book.started_at : today
    };
    if (notAtEnd) changes.current_page = book.total_pages;

    const saved = await changeStatus(bookId, "finished", "finished", changes, { date: today, page_before: pageBefore });
    if (saved && logRest) {
        try {
            await insertProgressSession(saved, saved.total_pages - pageBefore, today, saved.total_pages);
            renderLibrary();
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "books.registerError"), "error");
        }
    }
    if (saved) openCompletion(saved.id);
}

async function reopenBook(bookId) {
    const book = bookById(bookId);
    if (!book) return;

    const choice = await askDialog({
        title: t("lib.reopen.title"),
        message: `<p>${t("lib.reopen.message", { title: escapeHTML(book.title) })}</p>`,
        actions: [
            { label: t("lib.cancel"), value: null, style: "secondary" },
            { label: t("lib.reopen.restart"), value: "restart", style: "secondary" },
            { label: t("lib.reopen.continue"), value: "continue", style: "primary" }
        ]
    });
    if (!choice) return;

    const changes = choice === "restart" ? { current_page: 0 } : {};
    const saved = await changeStatus(bookId, "reading", "reopened", changes,
        { restart: choice === "restart", previous_finished_at: book.finished_at, page_before: book.current_page || 0 });
    if (saved) {
        showToast(t("lib.toast.reopened", { title: saved.title }), "success");
        if (libraryState.tab === "finished") setLibraryTab("reading");
    }
}

async function deleteBook(bookId) {
    const book = bookById(bookId);
    if (!book) return;

    const sessions = sessionsForBook(bookId).length;
    const notes = bookNotes.filter(n => Number(n.book_id) === Number(bookId)).length;
    const ok = await confirmDialog(
        t("lib.delete.title"),
        `<p>${t("lib.delete.message", { title: escapeHTML(book.title) })}</p><p class="hint">${t("lib.delete.detail", sessions, notes)}</p>`,
        t("lib.delete.confirm"), true);
    if (!ok) return;

    await withBusy(`delete-${bookId}`, async () => {
        try {
            await run(supabaseClient.from("reading_books").delete().eq("id", bookId).eq("user_id", currentUserId));

            books = books.filter(b => Number(b.id) !== Number(bookId));
            readingSessions = readingSessions.filter(s => Number(s.book_id) !== Number(bookId));
            bookNotes = bookNotes.filter(n => Number(n.book_id) !== Number(bookId));
            bookEvents = bookEvents.filter(e => Number(e.book_id) !== Number(bookId));
            if (activeSession && Number(activeSession.book_id) === Number(bookId)) { activeSession = null; stopTick(); }
            if (detailsState.bookId === bookId) closeBookDetails();

            renderLibrary();
            showToast(t("books.deleted"), "success");
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "books.deleteError"), "error");
        }
    });
}

// -----------------------------------------------------
// CRONÔMETRO — sessão persistida no banco
// -----------------------------------------------------

async function refreshActiveSessionFromServer() {
    try {
        const rows = await run(supabaseClient.from("reading_sessions").select("*").eq("user_id", currentUserId).eq("active", true));
        readingSessions = readingSessions.filter(s => !s.active);
        activeSession = rows && rows[0] ? rows[0] : null;
        if (activeSession) { readingSessions.unshift(activeSession); startTick(); } else stopTick();
    } catch (error) {
        console.error(error);
    }
    renderLibrary();
}

async function startSession(bookId) {
    const book = bookById(bookId);
    if (!book || book.status !== "reading") return;
    if (activeSession) { showToast(t("books.otherTimer"), "error"); return; }

    await withBusy("session", async () => {
        try {
            const now = nowISO();
            const row = await run(supabaseClient.from("reading_sessions").insert({
                user_id: currentUserId,
                book_id: bookId,
                active: true,
                started_at: now,
                segment_started_at: now,
                accumulated_seconds: 0,
                start_page: book.current_page || 0,
                pages_read: 0,
                duration_seconds: 0,
                session_date: todayISO()
            }).select().single());

            activeSession = row;
            readingSessions.unshift(row);
            startTick();
            renderLibrary();
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "lib.err.session"), "error");
            if (String(error?.code) === "23505") await refreshActiveSessionFromServer();
        }
    });
}

async function updateActiveSession(changes) {
    const rows = await run(supabaseClient.from("reading_sessions")
        .update({ ...changes, updated_at: nowISO() })
        .eq("id", activeSession.id).eq("user_id", currentUserId).eq("active", true)
        .select());

    if (!rows || !rows.length) {
        // A sessão foi finalizada em outro aparelho
        showToast(t("lib.err.sessionGone"), "error");
        await loadBooks();
        return null;
    }

    replaceSession(rows[0]);
    if (rows[0].active) activeSession = rows[0];
    return rows[0];
}

async function pauseSession(silent = false) {
    if (!activeSession || !activeSession.segment_started_at) return true;

    const run_ = async () => {
        try {
            const saved = await updateActiveSession({ accumulated_seconds: sessionElapsed(activeSession), segment_started_at: null });
            renderLibrary();
            return Boolean(saved);
        } catch (error) {
            console.error(error);
            if (!silent) showToast(dbErrorMessage(error, "lib.err.session"), "error");
            return false;
        }
    };

    return silent ? run_() : withBusy("session", run_);
}

async function resumeSession() {
    if (!activeSession || activeSession.segment_started_at) return;
    const book = bookById(activeSession.book_id);
    if (book && book.status !== "reading") { showToast(t("lib.err.activeSessionStatus"), "error"); return; }

    await withBusy("session", async () => {
        try {
            await updateActiveSession({ segment_started_at: nowISO() });
            renderLibrary();
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "lib.err.session"), "error");
        }
    });
}

// Finalizar: pausa o tempo e pede página inicial/final
async function openFinishSession() {
    if (!activeSession) return;
    const book = bookById(activeSession.book_id);
    if (!book) return;

    const paused = await pauseSession(true);
    if (!paused && activeSession?.segment_started_at) { showToast(t("lib.err.session"), "error"); return; }
    if (!activeSession) return;

    const elapsed = sessionElapsed(activeSession);
    const startPage = activeSession.start_page ?? book.current_page ?? 0;

    $("readingFormContent").innerHTML = `
        <p class="eyebrow">${t("lib.session.eyebrow")}</p>
        <h2>${t("lib.session.finishTitle")}</h2>
        <div class="session-head">
            ${coverImg(book, "mini-cover")}
            <div>
                <strong>${escapeHTML(book.title)}</strong>
                <span class="hint">${t("lib.session.startedAt", timeOfDay(activeSession.started_at), shortDate(activeSession.session_date))}</span>
            </div>
            <div class="session-time"><span>${t("lib.session.time")}</span><strong>${formatDuration(elapsed)}</strong></div>
        </div>

        <form id="finishSessionForm" class="settings-form" novalidate>
            <div class="form-row">
                <label><span>${t("lib.field.startPage")}</span>
                    <input type="number" id="fsStart" min="0" ${book.total_pages ? `max="${book.total_pages}"` : ""} value="${startPage}" inputmode="numeric" required></label>
                <label><span>${t("lib.field.endPage")}</span>
                    <input type="number" id="fsEnd" min="0" ${book.total_pages ? `max="${book.total_pages}"` : ""} value="${Math.max(startPage, book.current_page || 0)}" inputmode="numeric" required></label>
            </div>
            <p class="form-preview" id="fsPreview"></p>
            <label><span>${t("lib.field.sessionNote")}</span>
                <textarea id="fsNote" rows="2" maxlength="2000" placeholder="${t("lib.ph.sessionNote")}"></textarea></label>
            <p id="fsError" class="error-message" role="alert"></p>
            <div class="modal-actions">
                <button type="button" class="link-danger" id="fsDiscard">${t("lib.session.discard")}</button>
                <button type="submit" class="primary-button" id="fsSave" data-busy-key="finish-session-save">${t("lib.session.save")}</button>
            </div>
        </form>`;

    const updatePreview = () => {
        const s = Number($("fsStart").value);
        const e = Number($("fsEnd").value);
        $("fsPreview").textContent = Number.isFinite(s) && Number.isFinite(e) && e >= s
            ? t("lib.preview.pages", s, e, e - s) + (book.total_pages ? ` · ${Math.min(100, Math.round((e / book.total_pages) * 100))}%` : "")
            : "";
    };
    $("fsStart").addEventListener("input", updatePreview);
    $("fsEnd").addEventListener("input", updatePreview);
    $("finishSessionForm").addEventListener("input", () => { $("fsError").textContent = ""; });
    updatePreview();

    $("finishSessionForm").addEventListener("submit", e => { e.preventDefault(); withBusy("finish-session-save", () => saveFinishedSession(book)); });
    $("fsDiscard").addEventListener("click", discardSession);

    openOverlay($("readingFormModal"));
    setTimeout(() => $("fsEnd").focus(), 80);
}

function validatePages(start, end, book, errorEl) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) { errorEl.textContent = t("lib.err.wholeNumbers"); return false; }
    if (start < 0 || end < 0) { errorEl.textContent = t("book.errNegative"); return false; }
    if (book.total_pages && (start > book.total_pages || end > book.total_pages)) { errorEl.textContent = t("lib.err.overTotal", book.total_pages); return false; }
    if (end < start) { errorEl.textContent = t("lib.err.endBeforeStart"); return false; }
    return true;
}

async function saveFinishedSession(book) {
    const errorEl = $("fsError");
    errorEl.textContent = "";
    if (!activeSession) return;

    const start = Number($("fsStart").value);
    const end = Number($("fsEnd").value);
    if (!validatePages(start, end, book, errorEl)) return;

    const elapsed = Math.min(86400, sessionElapsed(activeSession));
    const pages = end - start;
    if (pages === 0 && elapsed < 1) { errorEl.textContent = t("lib.err.emptySession"); return; }

    const pageBefore = book.current_page || 0;

    try {
        const session = await updateActiveSession({
            active: false,
            ended_at: nowISO(),
            start_page: start,
            end_page: end,
            pages_read: pages,
            duration_seconds: elapsed,
            accumulated_seconds: elapsed,
            segment_started_at: null,
            note: $("fsNote").value.trim() || null,
            session_date: localISO(new Date(activeSession.started_at || Date.now()))
        });
        if (!session) { closeOverlay($("readingFormModal")); return; }

        activeSession = null;
        stopTick();

        let saved = book;
        if (end !== pageBefore) saved = await updateBook(book.id, { current_page: end });

        closeOverlay($("readingFormModal"));
        renderLibrary();
        showSessionSummary(saved, { seconds: elapsed, pages, from: pageBefore, to: end });
    } catch (error) {
        console.error(error);
        errorEl.textContent = dbErrorMessage(error, "lib.err.session");
        renderLibrary();
    }
}

async function discardSession() {
    if (!activeSession) return;
    const ok = await confirmDialog(t("lib.session.discardTitle"), `<p>${t("lib.session.discardMessage")}</p>`, t("lib.session.discard"), true);
    if (!ok) return;

    await withBusy("session", async () => {
        try {
            await run(supabaseClient.from("reading_sessions").delete().eq("id", activeSession.id).eq("user_id", currentUserId));
            readingSessions = readingSessions.filter(s => Number(s.id) !== Number(activeSession.id));
            activeSession = null;
            stopTick();
            closeOverlay($("readingFormModal"));
            renderLibrary();
            showToast(t("lib.session.discarded"), "success");
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "lib.err.session"), "error");
        }
    });
}

function showSessionSummary(book, result) {
    const pct = progressPct(book);
    const atEnd = book.status === "reading" && isAtLastPage(book);

    $("celebrationContent").innerHTML = `
        <div class="celebration-icon small"><svg><use href="#i-check"/></svg></div>
        <h2>${t("lib.summary.sessionSaved")}</h2>
        <p class="hint center">${escapeHTML(book.title)}</p>
        <div class="summary-metrics">
            <div><span>${t("lib.session.time")}</span><strong>${humanDuration(result.seconds)}</strong></div>
            <div><span>${t("lib.summary.pagesRead")}</span><strong>${result.pages}</strong></div>
            <div><span>${t("lib.summary.currentPage")}</span><strong>${result.to}</strong></div>
            <div><span>${t("lib.summary.progress")}</span><strong>${pct !== null ? `${pct}%` : "—"}</strong></div>
        </div>
        ${pct !== null ? `<div class="progress-track big"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
        ${atEnd ? `<div class="lib-banner center">🎉 ${t("lib.lastPageReached")}</div>` : ""}
        <div class="modal-actions">
            <button type="button" class="secondary-button" data-close-celebration>${t("close")}</button>
            ${atEnd ? `<button type="button" class="primary-button" data-action="finish-book" data-id="${book.id}">${t("lib.markFinished")}</button>` : ""}
        </div>`;

    $("celebrationContent").querySelector("[data-close-celebration]").addEventListener("click", () => closeOverlay($("celebrationModal")));
    $("celebrationContent").querySelector("[data-action='finish-book']")?.addEventListener("click", () => closeOverlay($("celebrationModal")), true);
    openOverlay($("celebrationModal"));
}

// -----------------------------------------------------
// REGISTRO MANUAL DE LEITURA
// -----------------------------------------------------

function openLogForm(bookId) {
    const book = bookById(bookId);
    if (!book) return;
    if (book.status !== "reading") { showToast(t("lib.err.logNotReading"), "error"); return; }
    if (activeSession && Number(activeSession.book_id) === Number(bookId)) {
        showToast(t("lib.err.finishSessionFirst"), "error");
        openFinishSession();
        return;
    }

    const current = book.current_page || 0;

    $("readingFormContent").innerHTML = `
        <p class="eyebrow">${t("lib.log.eyebrow")}</p>
        <h2>${t("books.register")}</h2>
        <div class="session-head">
            ${coverImg(book, "mini-cover")}
            <div>
                <strong>${escapeHTML(book.title)}</strong>
                <span class="hint">${book.total_pages ? t("lib.pageOf", current, book.total_pages) : t("lib.pageOnly", current)}</span>
            </div>
        </div>

        <form id="logForm" class="settings-form" novalidate>
            <div class="segmented" id="logMode">
                <button type="button" data-mode="page" class="active">${t("lib.log.modePage")}</button>
                <button type="button" data-mode="pages">${t("lib.log.modePages")}</button>
            </div>
            <label><span id="logValueLabel">${t("lib.log.newPage")}</span>
                <input type="number" id="logValue" min="0" inputmode="numeric" ${book.total_pages ? `max="${book.total_pages}"` : ""} placeholder="${current}" required></label>
            <p class="form-preview" id="logPreview"></p>
            <div class="form-row">
                <label><span>${t("lib.field.date")}</span><input type="date" id="logDate" value="${todayISO()}" max="${todayISO()}" required></label>
                <label><span>${t("lib.field.minutes")}</span><input type="number" id="logMinutes" min="0" max="1440" inputmode="numeric" placeholder="${t("lib.ph.optional")}"></label>
            </div>
            <label><span>${t("lib.field.sessionNote")}</span><textarea id="logNote" rows="2" maxlength="2000" placeholder="${t("lib.ph.sessionNote")}"></textarea></label>
            <p id="logError" class="error-message" role="alert"></p>
            <div class="modal-actions">
                <button type="button" class="secondary-button" data-close-form>${t("lib.cancel")}</button>
                <button type="submit" class="primary-button" data-busy-key="log-save">${t("lib.log.save")}</button>
            </div>
        </form>`;

    let mode = "page";
    const newPageFor = () => {
        const raw = $("logValue").value.trim();
        if (raw === "") return null;
        const v = Number(raw);
        return mode === "page" ? v : current + v;
    };
    const updatePreview = () => {
        const np = newPageFor();
        const p = $("logPreview");
        p.classList.remove("warn");
        if (np === null || !Number.isFinite(np)) { p.textContent = ""; return; }
        if (np < current) { p.textContent = t("lib.preview.correction", current, np); p.classList.add("warn"); return; }
        p.textContent = t("lib.preview.pages", current, np, np - current) +
            (book.total_pages ? ` · ${Math.min(100, Math.round((np / book.total_pages) * 100))}%` : "");
    };

    $("logMode").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
        mode = b.dataset.mode;
        $("logMode").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
        $("logValueLabel").textContent = t(mode === "page" ? "lib.log.newPage" : "lib.log.pagesRead");
        $("logValue").min = mode === "page" ? 0 : 1;
        $("logValue").max = book.total_pages ? (mode === "page" ? book.total_pages : book.total_pages - current) : "";
        $("logValue").placeholder = mode === "page" ? String(current) : "20";
        updatePreview();
        $("logValue").focus();
    }));
    $("logValue").addEventListener("input", updatePreview);
    $("logForm").addEventListener("input", () => { $("logError").textContent = ""; });
    $("readingFormContent").querySelector("[data-close-form]").addEventListener("click", () => closeOverlay($("readingFormModal")));
    $("logForm").addEventListener("submit", e => { e.preventDefault(); withBusy("log-save", () => saveManualLog(book, newPageFor(), mode)); });

    openOverlay($("readingFormModal"));
    setTimeout(() => $("logValue").focus(), 80);
}

async function saveManualLog(book, newPage, mode) {
    const errorEl = $("logError");
    errorEl.textContent = "";

    const current = book.current_page || 0;
    const date = $("logDate").value;
    const minutesRaw = $("logMinutes").value.trim();
    const minutes = minutesRaw === "" ? 0 : Number(minutesRaw);
    const note = $("logNote").value.trim() || null;

    if (newPage === null) { errorEl.textContent = t("lib.err.enterValue"); return; }
    if (!Number.isInteger(newPage) || !Number.isInteger(minutes)) { errorEl.textContent = t("lib.err.wholeNumbers"); return; }
    if (mode === "pages" && newPage - current < 1) { errorEl.textContent = t("lib.err.pagesPositive"); return; }
    if (newPage < 0) { errorEl.textContent = t("book.errNegative"); return; }
    if (book.total_pages && newPage > book.total_pages) { errorEl.textContent = t("lib.err.overTotal", book.total_pages); return; }
    if (!date || date > todayISO()) { errorEl.textContent = t("lib.err.futureDate"); return; }
    if (minutes < 0 || minutes > 1440) { errorEl.textContent = t("lib.err.minutes"); return; }
    if (newPage === current && minutes === 0) { errorEl.textContent = t("lib.err.nothingToLog"); return; }

    try {
        // Página menor que a atual = correção (não conta como páginas lidas)
        if (newPage < current) {
            const ok = await confirmDialog(t("lib.correction.title"), `<p>${t("lib.correction.message", current, newPage)}</p>`, t("lib.correction.confirm"));
            if (!ok) return;

            const saved = await updateBook(book.id, { current_page: newPage });
            await logEvent(book.id, "page", { from: current, to: newPage, reason: "correction" });
            if (minutes > 0) {
                const row = await run(supabaseClient.from("reading_sessions").insert({
                    user_id: currentUserId, book_id: book.id, active: false, start_page: newPage, end_page: newPage,
                    pages_read: 0, duration_seconds: minutes * 60, session_date: date, note
                }).select().single());
                replaceSession(row);
            }
            closeOverlay($("readingFormModal"));
            renderLibrary();
            showToast(t("lib.toast.pageCorrected", saved.current_page), "success");
            return;
        }

        const row = await run(supabaseClient.from("reading_sessions").insert({
            user_id: currentUserId,
            book_id: book.id,
            active: false,
            start_page: current,
            end_page: newPage,
            pages_read: newPage - current,
            duration_seconds: minutes * 60,
            session_date: date,
            note
        }).select().single());
        replaceSession(row);

        let saved = book;
        if (newPage !== current) saved = await updateBook(book.id, { current_page: newPage });

        closeOverlay($("readingFormModal"));
        renderLibrary();
        showToast(t("books.sessionSaved"), "success");

        if (saved.status === "reading" && isAtLastPage(saved)) {
            const finishNow = await confirmDialog(t("lib.lastPage.title"), `<p>${t("lib.lastPage.message", { title: escapeHTML(saved.title) })}</p>`, t("lib.markFinished"));
            if (finishNow) await finishBookConfirmed(saved.id);
        }
    } catch (error) {
        console.error(error);
        errorEl.textContent = dbErrorMessage(error, "books.registerError");
    }
}

// Sessão sem cronômetro que registra páginas já avançadas no progresso
async function insertProgressSession(book, pages, date, endPage = null) {
    const end = endPage ?? (book.current_page || 0);
    const row = await run(supabaseClient.from("reading_sessions").insert({
        user_id: currentUserId,
        book_id: book.id,
        active: false,
        start_page: Math.max(0, end - pages),
        end_page: end,
        pages_read: pages,
        duration_seconds: 0,
        session_date: date,
        note: t("lib.reconcile.note")
    }).select().single());
    replaceSession(row);
    return row;
}

async function reconcilePages(bookId) {
    const book = bookById(bookId);
    const pages = unloggedPages(book);
    if (!pages) return;

    const today = todayISO();
    const date = book.status === "finished" && book.finished_at && book.finished_at <= today ? book.finished_at : today;
    const ok = await confirmDialog(t("lib.reconcile.title"), `<p>${t("lib.reconcile.message", pages, shortDate(date))}</p>`, t("lib.reconcile.confirm"));
    if (!ok) return;

    await withBusy(`reconcile-${bookId}`, async () => {
        try {
            await insertProgressSession(book, pages, date);
            renderLibrary();
            showToast(t("lib.reconcile.done", pages), "success");
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "books.registerError"), "error");
        }
    });
}

// Conclusão já confirmada pelo usuário (evita pedir duas vezes)
async function finishBookConfirmed(bookId) {
    const book = bookById(bookId);
    if (!book) return;
    const today = todayISO();
    const saved = await changeStatus(bookId, "finished", "finished",
        { finished_at: today, started_at: book.started_at && book.started_at <= today ? book.started_at : today },
        { date: today, page_before: book.current_page || 0 });
    if (saved) openCompletion(saved.id);
}

// -----------------------------------------------------
// CORRIGIR / EXCLUIR SESSÕES
// -----------------------------------------------------

function isLatestSession(session) {
    const latest = sessionsForBook(session.book_id)[0];
    return latest && Number(latest.id) === Number(session.id);
}

function openEditSession(sessionId) {
    const session = readingSessions.find(s => Number(s.id) === Number(sessionId) && !s.active);
    if (!session) return;
    const book = bookById(session.book_id);
    if (!book) return;

    const hasPages = session.start_page !== null && session.start_page !== undefined && session.end_page !== null && session.end_page !== undefined;

    $("readingFormContent").innerHTML = `
        <p class="eyebrow">${t("lib.editSession.eyebrow")}</p>
        <h2>${t("lib.editSession.title")}</h2>
        <form id="editSessionForm" class="settings-form" novalidate>
            <div class="form-row">
                <label><span>${t("lib.field.startPage")}</span><input type="number" id="esStart" min="0" value="${hasPages ? session.start_page : ""}" placeholder="—" inputmode="numeric"></label>
                <label><span>${t("lib.field.endPage")}</span><input type="number" id="esEnd" min="0" value="${hasPages ? session.end_page : ""}" placeholder="—" inputmode="numeric"></label>
            </div>
            <label id="esPagesField" class="${hasPages ? "hidden" : ""}"><span>${t("lib.log.pagesRead")}</span>
                <input type="number" id="esPages" min="0" value="${session.pages_read || 0}" inputmode="numeric"></label>
            <p class="form-preview" id="esPreview"></p>
            <div class="form-row">
                <label><span>${t("lib.field.date")}</span><input type="date" id="esDate" value="${session.session_date}" max="${todayISO()}"></label>
                <label><span>${t("lib.field.minutes")}</span><input type="number" id="esMinutes" min="0" max="1440" value="${Math.round((session.duration_seconds || 0) / 60)}" inputmode="numeric"></label>
            </div>
            <label><span>${t("lib.field.sessionNote")}</span><textarea id="esNote" rows="2" maxlength="2000">${escapeHTML(session.note || "")}</textarea></label>
            ${isLatestSession(session) && hasPages ? `<p class="hint">${t("lib.editSession.latestHint")}</p>` : ""}
            <p id="esError" class="error-message" role="alert"></p>
            <div class="modal-actions">
                <button type="button" class="secondary-button" data-close-form>${t("lib.cancel")}</button>
                <button type="submit" class="primary-button" data-busy-key="edit-session">${t("btn.saveChanges")}</button>
            </div>
        </form>`;

    const sync = () => {
        const s = $("esStart").value.trim();
        const e = $("esEnd").value.trim();
        const both = s !== "" && e !== "";
        $("esPagesField").classList.toggle("hidden", both);
        $("esPreview").textContent = both && Number(e) >= Number(s) ? t("lib.preview.pages", Number(s), Number(e), Number(e) - Number(s)) : "";
    };
    $("esStart").addEventListener("input", sync);
    $("editSessionForm").addEventListener("input", () => { $("esError").textContent = ""; });
    $("esEnd").addEventListener("input", sync);
    sync();

    $("readingFormContent").querySelector("[data-close-form]").addEventListener("click", () => closeOverlay($("readingFormModal")));
    $("editSessionForm").addEventListener("submit", e => { e.preventDefault(); withBusy("edit-session", () => saveEditedSession(session, book)); });

    openOverlay($("readingFormModal"));
}

async function saveEditedSession(session, book) {
    const errorEl = $("esError");
    errorEl.textContent = "";

    const sRaw = $("esStart").value.trim();
    const eRaw = $("esEnd").value.trim();
    const minutes = Number($("esMinutes").value || 0);
    const date = $("esDate").value;
    const changes = { note: $("esNote").value.trim() || null, session_date: date, duration_seconds: minutes * 60 };

    if ((sRaw === "") !== (eRaw === "")) { errorEl.textContent = t("lib.err.bothPages"); return; }
    if (sRaw !== "") {
        const start = Number(sRaw);
        const end = Number(eRaw);
        if (!validatePages(start, end, book, errorEl)) return;
        Object.assign(changes, { start_page: start, end_page: end, pages_read: end - start });
    } else {
        const pages = Number($("esPages").value || 0);
        if (!Number.isInteger(pages) || pages < 0) { errorEl.textContent = t("lib.err.wholeNumbers"); return; }
        Object.assign(changes, { start_page: null, end_page: null, pages_read: pages });
    }
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) { errorEl.textContent = t("lib.err.minutes"); return; }
    if (!date || date > todayISO()) { errorEl.textContent = t("lib.err.futureDate"); return; }

    const wasLatest = isLatestSession(session);
    const oldEnd = session.end_page;

    try {
        const row = await run(supabaseClient.from("reading_sessions")
            .update({ ...changes, updated_at: nowISO() })
            .eq("id", session.id).eq("user_id", currentUserId)
            .select().single());
        replaceSession(row);

        // Se era o último registro e a página atual veio dele, a página atual acompanha a correção
        if (wasLatest && oldEnd !== null && oldEnd !== undefined && (book.current_page || 0) === oldEnd
            && row.end_page !== null && row.end_page !== oldEnd) {
            await updateBook(book.id, { current_page: row.end_page });
        }

        await logEvent(book.id, "session_edited", { session_id: session.id, pages_before: session.pages_read, pages_after: row.pages_read });
        closeOverlay($("readingFormModal"));
        renderLibrary();
        showToast(t("lib.toast.sessionUpdated"), "success");
    } catch (error) {
        console.error(error);
        errorEl.textContent = dbErrorMessage(error, "lib.err.save");
    }
}

async function deleteSession(sessionId) {
    const session = readingSessions.find(s => Number(s.id) === Number(sessionId) && !s.active);
    if (!session) return;
    const book = bookById(session.book_id);
    const revert = book && isLatestSession(session) && session.end_page !== null && session.end_page !== undefined
        && (book.current_page || 0) === session.end_page && session.start_page !== null && session.start_page !== undefined;

    const ok = await confirmDialog(t("lib.deleteSession.title"),
        `<p>${t("lib.deleteSession.message", shortDate(session.session_date), session.pages_read || 0)}</p>${revert ? `<p class="hint">${t("lib.deleteSession.revert", session.start_page)}</p>` : ""}`,
        t("lib.delete.confirm"), true);
    if (!ok) return;

    await withBusy(`delete-session-${sessionId}`, async () => {
        try {
            await run(supabaseClient.from("reading_sessions").delete().eq("id", session.id).eq("user_id", currentUserId));
            readingSessions = readingSessions.filter(s => Number(s.id) !== Number(session.id));
            if (revert) await updateBook(book.id, { current_page: session.start_page });
            if (book) await logEvent(book.id, "session_deleted", { date: session.session_date, pages: session.pages_read || 0 });
            renderLibrary();
            showToast(t("lib.toast.sessionDeleted"), "success");
        } catch (error) {
            console.error(error);
            showToast(dbErrorMessage(error, "lib.err.save"), "error");
        }
    });
}

// -----------------------------------------------------
// CONCLUSÃO — celebração + avaliação opcional
// -----------------------------------------------------

function openCompletion(bookId) {
    const book = bookById(bookId);
    if (!book) return;
    const stats = bookStats(bookId);
    const days = book.started_at && book.finished_at ? daysBetween(book.started_at, book.finished_at) + 1 : null;

    $("celebrationContent").innerHTML = `
        <div class="celebration-hero">
            <div class="celebration-cover">${coverImg(book, "")}<span class="celebration-badge"><svg><use href="#i-check"/></svg></span></div>
            <div class="sparkles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        </div>
        <h2 class="center">${t("lib.complete.title")}</h2>
        <p class="hint center">${t("lib.complete.subtitle", { title: escapeHTML(book.title) })}</p>
        <div class="summary-metrics three">
            <div><span>${t("lib.complete.pages")}</span><strong>${book.total_pages || book.current_page || 0}</strong></div>
            <div><span>${t("label.totalTime")}</span><strong>${stats.seconds ? humanDuration(stats.seconds) : "—"}</strong></div>
            <div><span>${t("lib.complete.days")}</span><strong>${days || "—"}</strong></div>
        </div>
        <div class="completion-review">
            <h3>${t("lib.complete.reviewTitle")}</h3>
            <p class="hint">${t("lib.review.optional")}</p>
            ${reviewFormHTML("cr", book)}
        </div>
        <p id="crError" class="error-message" role="alert"></p>
        <div class="modal-actions">
            <button type="button" class="secondary-button" id="crSkip">${t("lib.complete.skip")}</button>
            <button type="button" class="secondary-button with-icon" id="crCard"><svg><use href="#i-share"/></svg>${t("card.create")}</button>
            <button type="button" class="primary-button" id="crSave" data-busy-key="review-save">${t("lib.review.save")}</button>
        </div>`;

    wireReviewForm("cr", book);
    $("crSkip").addEventListener("click", () => closeOverlay($("celebrationModal")));
    $("crCard").addEventListener("click", () => withBusy("review-save", async () => {
        const ok = await saveReview("cr", bookById(book.id), $("crError"));
        if (ok) { closeOverlay($("celebrationModal")); openShareCard(book.id); }
    }));
    $("crSave").addEventListener("click", () => withBusy("review-save", async () => {
        const ok = await saveReview("cr", book, $("crError"));
        if (ok) {
            closeOverlay($("celebrationModal"));
            openShareCard(book.id);
        }
    }));

    openOverlay($("celebrationModal"));
    if (libraryState.tab === "reading" || libraryState.tab === "paused") renderLibraryList();
}

// Formulário de avaliação (usado na conclusão e na aba "Avaliação" dos detalhes)
function reviewFormHTML(prefix, book) {
    return `
        <div class="review-form">
            <div class="field">
                <span class="field-label">${t("lib.review.rating")}</span>
                <div class="star-input" id="${prefix}Stars" role="radiogroup" aria-label="${t("lib.review.rating")}" data-value="${book.rating || 0}">
                    ${[1, 2, 3, 4, 5].map(i => `<button type="button" role="radio" data-star="${i}" aria-checked="${i === book.rating}" aria-label="${t("lib.rating.aria", i)}"><svg><use href="#i-star"/></svg></button>`).join("")}
                    <button type="button" class="inline-link star-clear" data-star="0">${t("lib.review.clear")}</button>
                </div>
            </div>
            <label><span>${t("lib.review.review")}</span><textarea id="${prefix}Review" rows="3" maxlength="10000" placeholder="${t("lib.ph.review")}">${escapeHTML(book.review || "")}</textarea></label>
            <label><span>${t("lib.review.quote")}</span><textarea id="${prefix}Quote" rows="2" maxlength="2000" placeholder="${t("lib.ph.quote")}">${escapeHTML(book.favorite_quote || "")}</textarea></label>
            <label><span>${t("lib.review.learnings")}</span><textarea id="${prefix}Learnings" rows="2" maxlength="5000">${escapeHTML(book.learnings || "")}</textarea></label>
            <label><span>${t("lib.review.impressions")}</span><textarea id="${prefix}Impressions" rows="2" maxlength="5000">${escapeHTML(book.impressions || "")}</textarea></label>
        </div>`;
}

function wireReviewForm(prefix) {
    const group = $(`${prefix}Stars`);
    const paint = value => {
        group.dataset.value = value;
        group.querySelectorAll("[data-star]").forEach(b => {
            const n = Number(b.dataset.star);
            if (n > 0) { b.classList.toggle("on", n <= value); b.setAttribute("aria-checked", String(n === value)); }
        });
    };
    group.querySelectorAll("[data-star]").forEach(b => {
        b.addEventListener("click", () => {
            const n = Number(b.dataset.star);
            paint(Number(group.dataset.value) === n ? 0 : n);   // clicar de novo na mesma estrela limpa
        });
        b.addEventListener("mouseenter", () => {
            const n = Number(b.dataset.star);
            if (n) group.querySelectorAll("[data-star]").forEach(x => x.classList.toggle("hover", Number(x.dataset.star) > 0 && Number(x.dataset.star) <= n));
        });
    });
    group.addEventListener("mouseleave", () => group.querySelectorAll("[data-star]").forEach(x => x.classList.remove("hover")));
    group.addEventListener("keydown", e => {
        const v = Number(group.dataset.value);
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); paint(Math.min(5, v + 1)); }
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); paint(Math.max(0, v - 1)); }
    });
    paint(Number(group.dataset.value));
}

async function saveReview(prefix, book, errorEl) {
    errorEl.textContent = "";
    const rating = Number($(`${prefix}Stars`).dataset.value) || null;
    const changes = {
        rating,
        review: $(`${prefix}Review`).value.trim() || null,
        favorite_quote: $(`${prefix}Quote`).value.trim() || null,
        learnings: $(`${prefix}Learnings`).value.trim() || null,
        impressions: $(`${prefix}Impressions`).value.trim() || null
    };

    const unchanged = Object.keys(changes).every(k => (book[k] ?? null) === changes[k]);
    if (unchanged) return true;

    try {
        await updateBook(book.id, changes);
        await logEvent(book.id, "review", { rating });
        renderLibrary();
        showToast(t("lib.toast.reviewSaved"), "success");
        return true;
    } catch (error) {
        console.error(error);
        errorEl.textContent = dbErrorMessage(error, "lib.err.save");
        return false;
    }
}

// -----------------------------------------------------
// DETALHES E DIÁRIO DO LIVRO
// -----------------------------------------------------

function openBookDetails(bookId, tab = "overview") {
    if (!bookById(bookId)) return;
    detailsState.bookId = bookId;
    detailsState.composerOpen = tab === "notes";
    detailsState.tab = tab === "notes" ? "history" : tab;
    detailsState.editingNoteId = null;
    renderBookDetails();
    openOverlay($("bookDetailsModal"));
}

function closeBookDetails() {
    detailsState.bookId = null;
    closeOverlay($("bookDetailsModal"));
}

function refreshOpenDetails() {
    if (!detailsState.bookId || !$("bookDetailsModal").classList.contains("show")) return;
    if (!bookById(detailsState.bookId)) { closeBookDetails(); return; }
    // Não redesenha a aba enquanto o usuário escreve nela
    const typing = $("bookDetailsContent").contains(document.activeElement) && ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName);
    if (!typing) renderBookDetails();
}

function primaryActionFor(book) {
    const isActive = activeSession && Number(activeSession.book_id) === Number(book.id);
    const btn = (action, icon, label, extra = "") =>
        `<button type="button" class="bd-primary" data-action="${action}" data-id="${book.id}" ${extra}><svg><use href="#i-${icon}"/></svg>${label}</button>`;
    if (book.status === "reading") {
        if (isActive) return btn("finish-session", "stop", t("lib.session.finish"), `data-busy-key="session"`);
        return btn("start-session", "play", t(sessionsForBook(book.id).length ? "lib.session.continue" : "books.start"),
            `data-busy-key="session" ${activeSession ? `disabled title="${t("books.otherTimer")}"` : ""}`);
    }
    if (book.status === "want") return btn("start-book", "play", t("lib.action.startBook"));
    if (book.status === "paused") return btn("resume-book", "play", t("lib.action.resumeBook"));
    return btn("reopen-book", "refresh", t("lib.menu.reopen"));
}

// Anel de progresso do livro (no topo da janela)
function bookRing(book) {
    const pct = progressPct(book);
    const r = 42, c = 2 * Math.PI * r;
    const value = pct ?? 0;
    return `
        <div class="bd-ring ${book.status === "finished" ? "done" : ""}">
            <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle cx="50" cy="50" r="${r}" class="bd-ring-track"/>
                <circle cx="50" cy="50" r="${r}" class="bd-ring-value" stroke-dasharray="${(c * value / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 50 50)"/>
            </svg>
            <div class="bd-ring-text">
                <strong>${pct !== null ? `${pct}<small>%</small>` : "—"}</strong>
                <span>${book.total_pages ? `${book.current_page || 0}/${book.total_pages}` : t("lib.pageOnly", book.current_page || 0)}</span>
            </div>
        </div>`;
}

function renderBookDetails() {
    const book = bookById(detailsState.bookId);
    if (!book) return;

    const sessions = sessionsForBook(book.id);
    const notes = bookNotes.filter(n => Number(n.book_id) === Number(book.id));
    const tabs = [
        ["overview", t("lib.details.tab.overview"), ""],
        ["sessions", t("lib.details.tab.sessions"), sessions.length],
        ["history", t("lib.details.tab.history"), notes.length ? notes.length : ""]
    ];
    const activeTab = detailsState.tab === "review" ? "overview" : detailsState.tab;

    $("bookDetailsContent").innerHTML = `
        <header class="bd-stage">
            ${book.cover ? `<div class="bd-stage-backdrop" style="background-image:${cssUrl(book.cover)}"></div>` : ""}
            <div class="bd-stage-row">
                <div class="bd-stage-cover">${coverImg(book, "bd-cover")}</div>
                <div class="bd-stage-info">
                    <span class="bd-status status-${book.status}"><i></i>${t(`lib.status.${book.status}`)}</span>
                    <h2 id="bookDetailsTitle">${escapeHTML(book.title)}</h2>
                    ${book.author ? `<p class="bd-author">${escapeHTML(book.author)}</p>` : ""}
                    ${book.rating ? `<div class="bd-stars">${starsHTML(book.rating, "small")}</div>` : ""}
                    <div class="bd-actions">
                        ${book.status === "finished" ? `<button type="button" class="bd-primary" data-action="share-card" data-id="${book.id}"><svg><use href="#i-share"/></svg>${t("card.create")}</button>` : primaryActionFor(book)}
                        ${book.status === "finished" ? `<button type="button" class="bd-icon" data-action="reopen-book" data-id="${book.id}" aria-label="${t("lib.menu.reopen")}" title="${t("lib.menu.reopen")}"><svg><use href="#i-refresh"/></svg></button>` : ""}
                        <button type="button" class="bd-icon" data-action="edit-book" data-id="${book.id}" aria-label="${t("lib.menu.edit")}" title="${t("lib.menu.edit")}"><svg><use href="#i-edit"/></svg></button>
                        <button type="button" class="bd-icon" data-action="menu" data-id="${book.id}" aria-haspopup="menu" aria-label="${t("lib.menu.label")}" title="${t("lib.menu.label")}"><svg><use href="#i-more"/></svg></button>
                    </div>
                </div>
                ${book.status !== "want" ? bookRing(book) : ""}
            </div>
        </header>

        <div class="bd-tabs" role="tablist">
            <span class="bd-tab-indicator" aria-hidden="true"></span>
            ${tabs.map(([key, label, count]) => `
                <button type="button" role="tab" class="bd-tab ${activeTab === key ? "active" : ""}" data-bd-tab="${key}" aria-selected="${activeTab === key}">
                    ${label}${count !== "" && count !== 0 ? `<span class="tab-count">${count}</span>` : ""}
                </button>`).join("")}
        </div>

        <div class="bd-panel" role="tabpanel">${detailsPanelHTML(book, sessions, notes)}</div>`;

    $("bookDetailsModal").setAttribute("aria-labelledby", "bookDetailsTitle");

    $("bookDetailsContent").querySelectorAll("[data-bd-tab]").forEach(tab => {
        tab.addEventListener("click", () => {
            detailsState.tab = tab.dataset.bdTab;
            detailsState.editingNoteId = null;
            detailsState.composerOpen = false;
            renderBookDetails();
            $("bookDetailsContent").querySelector(`[data-bd-tab="${detailsState.tab}"]`)?.focus();
        });
    });

    // Traço luminoso embaixo da aba ativa
    requestAnimationFrame(() => {
        const active = $("bookDetailsContent").querySelector(".bd-tab.active");
        const indicator = $("bookDetailsContent").querySelector(".bd-tab-indicator");
        if (active && indicator) {
            indicator.style.width = `${active.offsetWidth}px`;
            indicator.style.transform = `translateX(${active.offsetLeft}px)`;
        }
    });

    wireDetailsPanel(book);
}

function detailsPanelHTML(book, sessions, notes) {
    switch (detailsState.tab) {
        case "sessions": return sessionsPanelHTML(book, sessions);
        case "history": return historyPanelHTML(book, notes);
        case "review": return `
            <button type="button" class="bd-back" id="bdBack">${t("bd.back")}</button>
            <p class="hint">${t("lib.review.optional")}</p>${reviewFormHTML("dr", book)}
            <p id="drError" class="error-message" role="alert"></p>
            <div class="modal-actions"><button type="button" class="primary-button" id="drSave" data-busy-key="review-save">${t("lib.review.save")}</button></div>`;
        default: return overviewPanelHTML(book, sessions);
    }
}

// Trajetória: do início ao fim (ou à previsão de término)
function trajectoryHTML(book) {
    if (book.status === "want" || !book.started_at) return "";
    const today = todayISO();
    const pct = progressPct(book);
    const fc = forecast(book);

    if (book.status === "finished" && book.finished_at) {
        const days = Math.max(1, daysBetween(book.started_at, book.finished_at) + 1);
        return `
            <div class="bd-trajectory done">
                <div class="traj-head"><h3>${t("bd.trajectory")}</h3><span>${t("bd.finishedIn", days)}</span></div>
                <div class="traj-track"><span class="traj-fill" style="width:100%"></span><i class="traj-dot start"></i><i class="traj-dot end"></i></div>
                <div class="traj-labels"><span>${t("bd.start")}<b>${shortDate(book.started_at)}</b></span><span>${t("lib.field.finishedAt")}<b>${shortDate(book.finished_at)}</b></span></div>
            </div>`;
    }

    const elapsed = daysBetween(book.started_at, today) + 1;
    const end = fc ? fc.date : null;
    const totalSpan = end ? Math.max(elapsed, daysBetween(book.started_at, end) + 1) : null;
    const nowPos = totalSpan ? Math.min(96, Math.max(4, (elapsed / totalSpan) * 100)) : (pct ?? 50);

    return `
        <div class="bd-trajectory">
            <div class="traj-head"><h3>${t("bd.trajectory")}</h3><span>${t("bd.daysReading", elapsed)}</span></div>
            <div class="traj-track">
                <span class="traj-fill" style="width:${nowPos}%"></span>
                <i class="traj-dot start"></i>
                <i class="traj-now" style="left:${nowPos}%"><b>${pct !== null ? `${pct}%` : t("bd.today")}</b></i>
                ${end ? `<i class="traj-dot end ghost"></i>` : ""}
            </div>
            <div class="traj-labels">
                <span>${t("bd.start")}<b>${shortDate(book.started_at)}</b></span>
                ${end ? `<span class="right">${t("bd.eta")}<b>${shortDate(end)}</b></span>` : ""}
            </div>
            ${fc ? `<p class="traj-note">${forecastText(fc)}${fc.byGoal ? "" : ` · ${t("lib.forecastHint")}`}</p>` : ""}
        </div>`;
}

function overviewPanelHTML(book, sessions) {
    const stats = bookStats(book.id);
    const previousFinishes = finishRecords()
        .filter(r => Number(r.bookId) === Number(book.id) && !(book.status === "finished" && r.date === book.finished_at))
        .map(r => shortDate(r.date));

    const kpis = [
        [t("label.pagesLogged"), stats.pages],
        [t("lib.stat.readingTime"), stats.seconds ? humanDuration(stats.seconds) : "—"],
        [t("lib.stat.sessions"), stats.count],
        [t("lib.stat.pace"), stats.pagesPerHour ? t("lib.unit.pagesPerHour", Math.round(stats.pagesPerHour)) : "—"]
    ];

    const ficha = [
        book.genre ? [t("field.genre"), escapeHTML(book.genre)] : null,
        book.total_pages ? [t("bd.pages"), book.total_pages] : null,
        [t("lib.details.added"), shortDate(String(book.created_at || "").slice(0, 10))],
        book.started_at ? [t("lib.field.startedAt"), shortDate(book.started_at)] : null,
        book.status === "finished" && book.finished_at ? [t("lib.field.finishedAt"), shortDate(book.finished_at)] : null,
        previousFinishes.length ? [t("lib.details.previousFinishes"), previousFinishes.join(", ")] : null,
        book.status === "want" ? [t("lib.field.priority"), t(`lib.priority.${book.priority || 2}`)] : null
    ].filter(Boolean);

    const hasReview = book.rating || book.review || book.favorite_quote || book.learnings || book.impressions;
    const review = book.status === "finished" || hasReview ? `
        <div class="bd-section bd-review">
            <div class="bd-section-head">
                <h3>${t("bd.review")}</h3>
                <button type="button" class="inline-link" data-bd-review>${t(hasReview ? "bd.editReview" : "bd.rate")}</button>
            </div>
            ${hasReview ? `
                ${book.rating ? `<div class="bd-review-stars">${starsHTML(book.rating)}</div>` : ""}
                ${book.review ? `<p class="prewrap">${escapeHTML(book.review)}</p>` : ""}
                ${book.favorite_quote ? `<blockquote class="fav-quote"><svg><use href="#i-quote"/></svg>${escapeHTML(book.favorite_quote)}</blockquote>` : ""}
                ${book.learnings ? `<p class="bd-review-extra"><b>${t("lib.review.learnings")}</b>${escapeHTML(book.learnings)}</p>` : ""}
                ${book.impressions ? `<p class="bd-review-extra"><b>${t("lib.review.impressions")}</b>${escapeHTML(book.impressions)}</p>` : ""}`
            : `<p class="hint">${t("lib.review.optional")}</p>`}
        </div>` : "";

    return `
        ${book.status !== "want" ? `
            <div class="bd-kpis">${kpis.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join("")}</div>` : ""}
        ${unloggedPages(book) ? `
            <div class="reconcile-banner">
                <span class="reconcile-icon"><svg><use href="#i-history"/></svg></span>
                <p>${t("lib.reconcile.banner", unloggedPages(book))}</p>
                <button type="button" class="secondary-button compact" data-action="reconcile-pages" data-id="${book.id}" data-busy-key="reconcile-${book.id}">${t("lib.reconcile.button")}</button>
            </div>` : ""}
        ${trajectoryHTML(book)}
        ${goalHistoryHTML(book)}
        ${review}
        ${book.notes ? `<div class="bd-section"><h3>${t("lib.field.notes")}</h3><p class="prewrap">${escapeHTML(book.notes)}</p></div>` : ""}
        <dl class="bd-ficha">${ficha.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

function goalHistoryHTML(book) {
    const today = goalInfo(book);
    if (!today) return "";

    const unit = t(today.type === "pages" ? "lib.unit.pagesShort" : "lib.unit.minShort");
    const weekdays = t("chart.weekdays");
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const key = addDays(todayISO(), -i);
        const info = goalInfo(book, key);
        days.push({ key, ...info, isToday: i === 0 });
    }
    const max = Math.max(today.target, ...days.map(d => d.done));
    const metCount = days.filter(d => d.met).length;
    const goalPct = (today.target / max) * 100;

    return `
        <div class="bd-section">
            <div class="goal-head">
                <h3>${t("lib.goal.title")}</h3>
                <span class="hint">${t("lib.goal.daily", today.target, unit)}</span>
            </div>
            <p class="${today.met ? "goal-met" : ""}">${today.met ? t("lib.goal.met", today.done, today.target, unit) : t("lib.goal.progress", today.done, today.target, unit, today.remaining)}</p>
            <div class="goal-chart">
                <span class="goal-line" aria-hidden="true" style="bottom: calc(18px + ${(goalPct / 100).toFixed(3)} * (100% - 18px))"></span>
                ${days.map(d => `
                    <div class="chart-col ${d.isToday ? "today" : ""}" title="${shortDate(d.key)}: ${d.done}/${d.target} ${unit}">
                        <div class="chart-bar ${d.done ? "filled" : ""} ${d.met ? "met" : ""}" style="height:${d.done ? Math.max(6, (d.done / max) * 100) : 3}%"></div>
                        <span class="chart-label">${d.isToday ? t("chart.today") : weekdays[parseLocalDate(d.key).getDay()]}</span>
                    </div>`).join("")}
            </div>
            <p class="hint">${t("lib.goal.history", metCount, 14)}</p>
        </div>`;
}

function sessionsPanelHTML(book, sessions) {
    const isActive = activeSession && Number(activeSession.book_id) === Number(book.id);

    // Mini gráfico: páginas por sessão, da mais antiga para a mais recente
    const recent = sessions.slice(0, 24).reverse();
    const max = Math.max(1, ...recent.map(s => Number(s.pages_read || 0)));
    const chart = recent.length > 1 ? `
        <div class="bd-spark" aria-hidden="true">
            ${recent.map(s => `<span title="${shortDate(s.session_date)}: +${s.pages_read || 0}" style="height:${Math.max(6, (Number(s.pages_read || 0) / max) * 100)}%"></span>`).join("")}
        </div>` : "";

    const activeRow = isActive ? `
        <li class="session-row active">
            <div class="session-date"><strong>${t("lib.session.readingNow")}</strong><span>${t("lib.session.startedAt", timeOfDay(activeSession.started_at), shortDate(activeSession.session_date))}</span></div>
            <div class="session-data"><span class="session-duration" data-session-timer>${formatDuration(sessionElapsed(activeSession))}</span></div>
            <div class="session-tools always"><button type="button" class="primary-button compact" data-action="finish-session">${t("lib.session.finish")}</button></div>
        </li>` : "";

    const rows = sessions.map(s => {
        const range = s.started_at && s.ended_at ? `${timeOfDay(s.started_at)}–${timeOfDay(s.ended_at)}` : t("lib.session.manual");
        const hasRange = s.start_page !== null && s.start_page !== undefined && s.end_page !== null && s.end_page !== undefined;
        return `
            <li class="session-row">
                <div class="session-date"><strong>${shortDate(s.session_date)}</strong><span>${range}</span></div>
                <div class="session-data">
                    <span class="session-plus">+${s.pages_read || 0}</span>
                    ${hasRange ? `<span class="session-range">${t("lib.session.pageRange", s.start_page, s.end_page)}</span>` : ""}
                    <span class="session-duration">${s.duration_seconds ? humanDuration(s.duration_seconds) : "—"}</span>
                    ${s.note ? `<p class="session-note">${escapeHTML(s.note)}</p>` : ""}
                </div>
                <div class="session-tools">
                    <button type="button" class="icon-action small" data-session-edit="${s.id}" aria-label="${t("lib.editSession.title")}" title="${t("lib.editSession.title")}"><svg><use href="#i-edit"/></svg></button>
                    <button type="button" class="icon-action small danger" data-session-delete="${s.id}" aria-label="${t("lib.deleteSession.title")}" title="${t("lib.deleteSession.title")}"><svg><use href="#i-trash"/></svg></button>
                </div>
            </li>`;
    }).join("");

    return `
        <div class="bd-panel-head">
            <div>
                <h3>${t("bd.sessionsChart")}</h3>
                <span class="hint">${t("lib.details.sessionsCount", sessions.length)}</span>
            </div>
            ${book.status === "reading" && !isActive ? `<button type="button" class="secondary-button compact with-icon" data-action="log-reading" data-id="${book.id}"><svg><use href="#i-pen"/></svg>${t("books.register")}</button>` : ""}
        </div>
        ${chart}
        ${activeRow || rows ? `<ul class="session-list">${activeRow}${rows}</ul>` : `<p class="empty-inline">${t("lib.details.noSessions")}</p>`}`;
}

// Marcos calculados a partir das sessões (primeira leitura, 25/50/75%, maior sessão)
function bookMilestones(book) {
    const asc = [...sessionsForBook(book.id)].reverse();
    if (!asc.length) return [];
    const items = [];
    const first = asc[0];
    items.push({ kind: "milestone", icon: "play", at: `${first.session_date}T00:00:01`, text: t("bd.milestone.first") });

    if (book.total_pages) {
        const currentPct = book.status === "finished" ? 100 : (progressPct(book) ?? 0);
        let cumulative = 0;
        const hit = new Set();
        asc.forEach(s => {
            cumulative += Number(s.pages_read || 0);
            const reached = s.end_page !== null && s.end_page !== undefined ? Number(s.end_page) : cumulative;
            [25, 50, 75].forEach(p => {
                // Só marca o que o livro realmente já alcançou (evita contar releituras duas vezes)
                if (p > currentPct) return;
                if (!hit.has(p) && reached >= book.total_pages * p / 100) {
                    hit.add(p);
                    items.push({ kind: "milestone", icon: "flag", at: `${s.session_date}T23:59:0${p / 25}`, text: t("bd.milestone.pct", p) });
                }
            });
        });
    }

    const best = asc.reduce((a, s) => Number(s.pages_read || 0) > Number(a.pages_read || 0) ? s : a, asc[0]);
    if (Number(best.pages_read) > 0 && asc.length > 2) {
        items.push({ kind: "milestone", icon: "star", at: `${best.session_date}T12:00:00`, text: t("bd.milestone.best", best.pages_read), highlight: true });
    }
    return items;
}

function historyPanelHTML(book, notes) {
    const editing = detailsState.editingNoteId ? notes.find(n => Number(n.id) === Number(detailsState.editingNoteId)) : null;
    const kind = editing ? editing.kind : detailsState.noteKind;
    const composerOpen = detailsState.composerOpen || Boolean(editing);

    const events = bookEvents.filter(e => Number(e.book_id) === Number(book.id));
    const items = events.map(e => ({ kind: "event", at: String(e.created_at), event: e }));
    if (!events.some(e => e.type === "created")) items.push({ kind: "event", at: String(book.created_at), event: { type: "created", created_at: book.created_at, details: {} } });
    notes.forEach(n => items.push({ kind: "note", at: String(n.created_at), note: n }));
    bookMilestones(book).forEach(m => items.push(m));
    items.sort((a, b) => b.at.localeCompare(a.at));

    const icons = { created: "plus", started: "play", resumed: "play", paused: "pause", finished: "flag", reopened: "refresh",
        status: "bookmark", page: "pen", edited: "edit", review: "star", session_edited: "clock", session_deleted: "trash" };
    const when = at => new Date(at).toLocaleString(currentLocale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const day = at => shortDate(String(at).slice(0, 10));

    const rows = items.map(item => {
        if (item.kind === "note") {
            const n = item.note;
            return `
                <li class="timeline-item note ${n.kind}">
                    <span class="timeline-icon"><svg><use href="#i-${n.kind === "quote" ? "quote" : "pen"}"/></svg></span>
                    <div class="timeline-note">
                        <span class="timeline-kind">${t(n.kind === "quote" ? "lib.notes.quote" : "lib.notes.note")}${n.page !== null && n.page !== undefined ? ` · ${t("lib.notes.page", n.page)}` : ""}</span>
                        <p class="prewrap">${escapeHTML(n.content)}</p>
                        <span class="hint">${when(n.created_at)}</span>
                    </div>
                    <div class="session-tools">
                        <button type="button" class="icon-action small" data-note-edit="${n.id}" aria-label="${t("lib.notes.edit")}" title="${t("lib.notes.edit")}"><svg><use href="#i-edit"/></svg></button>
                        <button type="button" class="icon-action small danger" data-note-delete="${n.id}" aria-label="${t("lib.notes.delete")}" title="${t("lib.notes.delete")}"><svg><use href="#i-trash"/></svg></button>
                    </div>
                </li>`;
        }
        if (item.kind === "milestone") {
            return `
                <li class="timeline-item milestone ${item.highlight ? "highlight" : ""}">
                    <span class="timeline-icon"><svg><use href="#i-${item.icon}"/></svg></span>
                    <div><p>${item.text}</p><span class="hint">${day(item.at)}</span></div>
                </li>`;
        }
        const e = item.event;
        return `
            <li class="timeline-item type-${e.type}">
                <span class="timeline-icon"><svg><use href="#i-${icons[e.type] || "history"}"/></svg></span>
                <div><p>${eventText(e)}</p><span class="hint">${when(e.created_at)}</span></div>
            </li>`;
    }).join("");

    const composer = composerOpen ? `
        <form id="noteForm" class="note-form" novalidate>
            <div class="note-form-top">
                <div class="segmented small" id="noteKind">
                    <button type="button" data-kind="note" class="${kind === "note" ? "active" : ""}">${t("lib.notes.note")}</button>
                    <button type="button" data-kind="quote" class="${kind === "quote" ? "active" : ""}">${t("lib.notes.quote")}</button>
                </div>
                <input type="number" id="notePage" min="0" ${book.total_pages ? `max="${book.total_pages}"` : ""} inputmode="numeric" placeholder="${t("lib.notes.pagePh")}" aria-label="${t("lib.notes.pagePh")}" value="${editing && editing.page !== null && editing.page !== undefined ? editing.page : ""}">
            </div>
            <textarea id="noteContent" rows="3" maxlength="5000" placeholder="${t(kind === "quote" ? "lib.ph.quote" : "lib.ph.note")}" aria-label="${t("lib.notes.content")}">${editing ? escapeHTML(editing.content) : ""}</textarea>
            <p id="noteError" class="error-message" role="alert"></p>
            <div class="modal-actions">
                <button type="button" class="secondary-button compact" id="noteCancel">${t("lib.cancel")}</button>
                <button type="submit" class="primary-button compact" data-busy-key="note-save">${t(editing ? "btn.saveChanges" : "lib.notes.add")}</button>
            </div>
        </form>` : `
        <button type="button" class="note-compose" id="noteComposeOpen"><svg><use href="#i-pen"/></svg>${t("bd.compose")}</button>`;

    return `${composer}<ul class="timeline">${rows}</ul>`;
}

function eventText(e) {
    const d = e.details || {};
    const status = s => s ? t(`lib.status.${s}`) : "";
    switch (e.type) {
        case "created": return t("lib.event.created") + (d.status ? ` (${status(d.status)})` : "");
        case "started": return t("lib.event.started");
        case "paused": return t("lib.event.paused");
        case "resumed": return t("lib.event.resumed");
        case "finished": return t("lib.event.finished", d.date ? shortDate(d.date) : "");
        case "reopened": return t(d.restart ? "lib.event.reopenedRestart" : "lib.event.reopened");
        case "status": return t("lib.event.status", status(d.from), status(d.to));
        case "page": return t("lib.event.page", d.from ?? "?", d.to ?? "?");
        case "edited": return t("lib.event.edited");
        case "review": return d.rating ? t("lib.event.reviewRated", d.rating) : t("lib.event.review");
        case "session_edited": return t("lib.event.sessionEdited", d.pages_before ?? 0, d.pages_after ?? 0);
        case "session_deleted": return t("lib.event.sessionDeleted", d.date ? shortDate(d.date) : "", d.pages ?? 0);
        default: return e.type;
    }
}

function wireDetailsPanel(book) {
    const root = $("bookDetailsContent");

    root.querySelectorAll("[data-session-edit]").forEach(b => b.addEventListener("click", () => openEditSession(Number(b.dataset.sessionEdit))));
    root.querySelectorAll("[data-session-delete]").forEach(b => b.addEventListener("click", () => deleteSession(Number(b.dataset.sessionDelete))));
    root.querySelector("[data-bd-review]")?.addEventListener("click", () => { detailsState.tab = "review"; renderBookDetails(); });

    if (detailsState.tab === "review") {
        wireReviewForm("dr");
        $("bdBack").addEventListener("click", () => { detailsState.tab = "overview"; renderBookDetails(); });
        $("drSave").addEventListener("click", () => withBusy("review-save", async () => {
            const ok = await saveReview("dr", bookById(book.id), $("drError"));
            if (ok) { detailsState.tab = "overview"; renderBookDetails(); }
        }));
    }

    if (detailsState.tab === "history") {
        $("noteComposeOpen")?.addEventListener("click", () => {
            detailsState.composerOpen = true;
            renderBookDetails();
            $("noteContent")?.focus();
        });
        if ($("noteForm")) {
            root.querySelectorAll("#noteKind button").forEach(b => b.addEventListener("click", () => {
                detailsState.noteKind = b.dataset.kind;
                root.querySelectorAll("#noteKind button").forEach(x => x.classList.toggle("active", x === b));
                $("noteContent").placeholder = t(b.dataset.kind === "quote" ? "lib.ph.quote" : "lib.ph.note");
            }));
            $("noteForm").addEventListener("submit", e => { e.preventDefault(); withBusy("note-save", () => saveNote(book)); });
            $("noteCancel")?.addEventListener("click", () => { detailsState.editingNoteId = null; detailsState.composerOpen = false; renderBookDetails(); });
        }
        root.querySelectorAll("[data-note-edit]").forEach(b => b.addEventListener("click", () => {
            detailsState.editingNoteId = Number(b.dataset.noteEdit);
            const note = bookNotes.find(n => Number(n.id) === detailsState.editingNoteId);
            if (note) detailsState.noteKind = note.kind;
            renderBookDetails();
            $("noteContent").focus();
        }));
        root.querySelectorAll("[data-note-delete]").forEach(b => b.addEventListener("click", () => deleteNote(Number(b.dataset.noteDelete))));
    }
}

async function saveNote(book) {
    const errorEl = $("noteError");
    errorEl.textContent = "";
    const content = $("noteContent").value.trim();
    const pageRaw = $("notePage").value.trim();
    const page = pageRaw === "" ? null : Number(pageRaw);
    const kind = $("noteKind").querySelector(".active")?.dataset.kind || "note";

    if (!content) { errorEl.textContent = t("lib.err.noteEmpty"); return; }
    if (page !== null && (!Number.isInteger(page) || page < 0 || (book.total_pages && page > book.total_pages))) {
        errorEl.textContent = book.total_pages ? t("lib.err.overTotal", book.total_pages) : t("lib.err.wholeNumbers");
        return;
    }

    try {
        if (detailsState.editingNoteId) {
            const row = await run(supabaseClient.from("book_notes")
                .update({ content, page, kind, updated_at: nowISO() })
                .eq("id", detailsState.editingNoteId).eq("user_id", currentUserId)
                .select().single());
            bookNotes = bookNotes.map(n => Number(n.id) === Number(row.id) ? row : n);
            showToast(t("lib.toast.noteUpdated"), "success");
        } else {
            const row = await run(supabaseClient.from("book_notes")
                .insert({ user_id: currentUserId, book_id: book.id, content, page, kind })
                .select().single());
            bookNotes.unshift(row);
            showToast(t(kind === "quote" ? "lib.toast.quoteAdded" : "lib.toast.noteAdded"), "success");
        }
        detailsState.editingNoteId = null;
        detailsState.composerOpen = false;
        renderBookDetails();
    } catch (error) {
        console.error(error);
        errorEl.textContent = dbErrorMessage(error, "lib.err.save");
    }
}

async function deleteNote(noteId) {
    const note = bookNotes.find(n => Number(n.id) === Number(noteId));
    if (!note) return;
    const ok = await confirmDialog(t("lib.notes.delete"), `<p>${t("lib.notes.deleteMessage")}</p>`, t("lib.delete.confirm"), true);
    if (!ok) return;

    try {
        await run(supabaseClient.from("book_notes").delete().eq("id", noteId).eq("user_id", currentUserId));
        bookNotes = bookNotes.filter(n => Number(n.id) !== Number(noteId));
        if (detailsState.editingNoteId === noteId) detailsState.editingNoteId = null;
        renderBookDetails();
        showToast(t("lib.toast.noteDeleted"), "success");
    } catch (error) {
        console.error(error);
        showToast(dbErrorMessage(error, "lib.err.save"), "error");
    }
}

// -----------------------------------------------------
// IDIOMA
// -----------------------------------------------------

function booksOnLanguageChange() {
    resetBookCoverField();
    refreshBookModalTexts();
    if (currentUserId) renderLibrary();
}

// -----------------------------------------------------
// DESAFIO DE LEITURA DO ANO (meta salva nas preferências da conta)
// -----------------------------------------------------

function challengeGoal(year) {
    return Number(prefs.readingChallenge?.[year]) || 0;
}

function challengeRing(pct) {
    const r = 34, c = 2 * Math.PI * r;
    return `
        <svg class="ch-ring" viewBox="0 0 80 80" aria-hidden="true">
            <circle cx="40" cy="40" r="${r}" class="ch-ring-track"/>
            <circle cx="40" cy="40" r="${r}" class="ch-ring-value" stroke-dasharray="${(c * Math.min(1, pct)).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 40 40)"/>
        </svg>`;
}

function renderChallenge() {
    const box = $("readingChallenge");
    if (!box) return;
    if (!libraryReady || !libraryLoaded) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");

    const now = new Date();
    const year = now.getFullYear();
    const goal = challengeGoal(year);

    if (!goal) {
        box.className = "challenge challenge-empty";
        box.innerHTML = `
            <span class="ch-cta-icon"><svg><use href="#i-flag"/></svg></span>
            <div class="ch-cta-text"><strong>${t("ch.setup", year)}</strong><span>${t("ch.setupDesc")}</span></div>
            <button type="button" class="secondary-button compact" data-action="challenge-edit">${t("ch.set")}</button>`;
        return;
    }

    const records = finishRecords()
        .filter(r => String(r.date || "").startsWith(String(year)))
        .sort((a, b) => a.date.localeCompare(b.date));
    const done = records.length;

    // Ritmo: quantos livros "deveriam" estar lidos até hoje
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    const expected = goal * ((now - start) / (end - start));

    let paceText, paceClass;
    if (done >= goal) {
        paceText = t("ch.doneMore", done - goal); paceClass = "done";
    } else if (done - expected >= 1) {
        paceText = t("ch.ahead", Math.floor(done - expected)); paceClass = "ahead";
    } else if (expected - done >= 1) {
        paceText = t("ch.behind", Math.floor(expected - done)); paceClass = "behind";
    } else {
        paceText = t("ch.onTrack"); paceClass = "ahead";
    }

    const monthsLeft = Math.max(1, 12 - now.getMonth() - (now.getDate() - 1) / 31);
    const perMonth = ((goal - done) / monthsLeft).toLocaleString(currentLocale(), { maximumFractionDigits: 1 });

    // Estante do ano: um espaço por livro da meta
    const total = Math.max(goal, done);
    const visible = Math.min(total, 24);
    let slots = "";
    for (let i = 0; i < visible; i++) {
        const rec = records[i];
        const book = rec ? bookById(rec.bookId) : null;
        if (rec) {
            slots += `<button type="button" class="ch-slot filled" ${book ? `data-action="details" data-id="${book.id}"` : "disabled"} title="${book ? escapeHTML(book.title) : ""} · ${shortDate(rec.date)}">
                ${book ? coverImg(book, "ch-cover") : ""}</button>`;
        } else {
            slots += `<span class="ch-slot ${i === done ? "next" : ""}" title="${i === done ? t("ch.slot") : ""}"><b>${i + 1}</b></span>`;
        }
    }
    if (total > visible) slots += `<span class="ch-slot more">+${total - visible}</span>`;

    box.className = `challenge ${paceClass}`;
    box.innerHTML = `
        <div class="ch-main">
            <div class="ch-ring-wrap">
                ${challengeRing(done / goal)}
                <div class="ch-ring-text"><strong>${Math.min(100, Math.round(done / goal * 100))}%</strong></div>
            </div>
            <div class="ch-text">
                <p class="eyebrow">${t("ch.eyebrow")} · ${year}</p>
                <h3>${done >= goal ? t("ch.done") : t("ch.progress", done, goal)}</h3>
                <p class="ch-pace ${paceClass}">${paceText}${done < goal ? ` <span>· ${t("ch.need", goal - done, perMonth)}</span>` : ""}</p>
            </div>
            <button type="button" class="icon-action ch-edit" data-action="challenge-edit" aria-label="${t("ch.edit")}" title="${t("ch.edit")}"><svg><use href="#i-edit"/></svg></button>
        </div>
        <div class="ch-shelf">${slots}</div>`;
}

async function editChallenge() {
    const year = new Date().getFullYear();
    const current = challengeGoal(year);

    const actions = [{ label: t("lib.cancel"), value: null, style: "secondary" }];
    if (current) actions.push({ label: t("ch.remove"), value: "remove", style: "secondary" });
    actions.push({ label: t("ch.save"), value: "save", style: "primary" });

    const pending = askDialog({
        title: t("ch.dialogTitle", year),
        message: `
            <div class="dialog-field">
                <label for="challengeInput">${t("ch.dialogLabel")}</label>
                <div class="ch-input-row">
                    <button type="button" class="ch-step" data-step="-1" aria-label="−">−</button>
                    <input type="number" id="challengeInput" min="1" max="365" step="1" value="${current || 12}" inputmode="numeric">
                    <button type="button" class="ch-step" data-step="1" aria-label="+">+</button>
                </div>
            </div>
            <p class="hint">${t("ch.setupDesc")}</p>`,
        actions
    });

    const input = $("challengeInput");
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); finishDialog("save"); } });
    $("dialogMessage").querySelectorAll(".ch-step").forEach(btn => btn.addEventListener("click", () => {
        input.value = Math.min(365, Math.max(1, (Number(input.value) || 0) + Number(btn.dataset.step)));
    }));
    setTimeout(() => { input.focus(); input.select(); }, 80);

    const result = await pending;
    const goals = { ...(prefs.readingChallenge || {}) };

    if (result === "remove") {
        delete goals[year];
        setPref("readingChallenge", goals);
        renderChallenge();
        renderBookHeroStats();
        showToast(t("ch.removed"), "success");
    } else if (result === "save") {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < 1 || value > 365) { showToast(t("ch.invalid"), "error"); return; }
        goals[year] = value;
        setPref("readingChallenge", goals);
        renderChallenge();
        renderBookHeroStats();
        showToast(t("ch.saved"), "success");
    }
}

// -----------------------------------------------------
// MAPA DE LEITURA — último ano, dia a dia
// -----------------------------------------------------

function renderHeatmap() {
    const box = $("readingHeatmap");
    if (!box) return;

    const byDay = {};
    completedSessions().forEach(s => {
        const d = byDay[s.session_date] || (byDay[s.session_date] = { pages: 0, seconds: 0 });
        d.pages += Number(s.pages_read || 0);
        d.seconds += Number(s.duration_seconds || 0);
    });

    const today = todayISO();
    const todayDate = parseLocalDate(today);
    const first = addDays(today, -(52 * 7) - todayDate.getDay());   // começa num domingo
    const days = [];
    for (let key = first; key <= today; key = addDays(key, 1)) days.push(key);

    const values = days.map(k => byDay[k]?.pages || 0).filter(v => v > 0).sort((a, b) => a - b);
    const q = p => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 0;
    const t1 = q(.25), t2 = q(.5), t3 = q(.8);
    const level = d => {
        if (!d || (!d.pages && !d.seconds)) return 0;
        if (!d.pages) return 1;
        return d.pages <= t1 ? 1 : d.pages <= t2 ? 2 : d.pages <= t3 ? 3 : 4;
    };

    const locale = currentLocale();
    const weeks = Math.ceil(days.length / 7);
    let months = "";
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
        const d = parseLocalDate(days[w * 7]);
        if (d.getMonth() !== lastMonth && d.getDate() <= 7) {
            months += `<span style="grid-column:${w + 1}">${d.toLocaleDateString(locale, { month: "short" }).replace(".", "")}</span>`;
            lastMonth = d.getMonth();
        }
    }

    const cells = days.map(key => {
        const d = byDay[key];
        const lv = level(d);
        const label = parseLocalDate(key).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
        const tip = lv ? t("hm.tip", label, d.pages, Math.round(d.seconds / 60)) : t("hm.none", label);
        return `<span class="hm-cell l${lv} ${key === today ? "today" : ""}" data-hm-tip="${escapeHTML(tip)}"></span>`;
    }).join("");

    const activeDays = days.filter(k => level(byDay[k]) > 0).length;
    $("heatmapSummary").textContent = `${t("hm.days", activeDays)} · ${t("stats.bestStreak")}: ${t("unit.days", computeBestStreak())}`;

    box.innerHTML = `
        <div class="hm-scroll">
            <div class="hm-inner" style="--weeks:${weeks}">
                <div class="hm-months">${months}</div>
                <div class="hm-grid">${cells}</div>
            </div>
        </div>
        <div class="hm-legend"><span>${t("hm.less")}</span>${[0, 1, 2, 3, 4].map(l => `<span class="hm-cell l${l}"></span>`).join("")}<span>${t("hm.more")}</span></div>`;

    const scroller = box.querySelector(".hm-scroll");
    scroller.scrollLeft = scroller.scrollWidth;
}

// Dica flutuante do mapa (não é cortada pela rolagem)
(function setupHeatmapTip() {
    const tip = document.createElement("div");
    tip.className = "hm-tip hidden";
    document.body.appendChild(tip);
    document.addEventListener("mouseover", e => {
        const cell = e.target.closest("[data-hm-tip]");
        if (!cell) { tip.classList.add("hidden"); return; }
        tip.textContent = cell.dataset.hmTip;
        tip.classList.remove("hidden");
        const r = cell.getBoundingClientRect();
        const w = tip.offsetWidth;
        tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
        tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
    });
})();

// -----------------------------------------------------
// MODO FOCO — tela cheia só com o livro e o cronômetro
// -----------------------------------------------------

let focusOpen = false;

function openFocusMode() {
    if (!activeSession) return;
    focusOpen = true;
    document.body.classList.add("focus-lock");
    $("focusMode").classList.remove("hidden");
    renderFocusMode();
    setTimeout(() => $("focusMode").querySelector(".focus-btn.main")?.focus(), 60);
}

function closeFocusMode() {
    if (!focusOpen) return;
    focusOpen = false;
    document.body.classList.remove("focus-lock");
    $("focusMode").classList.add("hidden");
    $("focusMode").innerHTML = "";
}

function renderFocusMode() {
    if (!focusOpen) return;
    const book = activeSession ? bookById(activeSession.book_id) : null;
    if (!book) { closeFocusMode(); return; }

    const running = isSessionRunning();
    const goal = Number(prefs.sessionGoalMin || 0);
    const box = $("focusMode");
    const hadFocus = box.contains(document.activeElement);
    const r = 104, c = 2 * Math.PI * r;

    box.className = `focus-mode ${running ? "running" : "paused"}`;
    box.innerHTML = `
        <div class="focus-backdrop" ${book.cover ? `style="background-image:${cssUrl(book.cover)}"` : ""}></div>
        <button type="button" class="focus-exit" data-action="focus-exit" aria-label="${t("focus.exit")}" title="${t("focus.exit")}">×</button>
        <div class="focus-center">
            <div class="focus-cover">${coverImg(book, "focus-cover-img")}</div>
            <p class="focus-status"><span class="focus-dot"></span>${t(running ? "lib.session.readingNow" : "focus.paused")}</p>
            <h2 class="focus-title">${escapeHTML(book.title)}</h2>
            ${book.author ? `<p class="focus-author">${escapeHTML(book.author)}</p>` : ""}
            <div class="focus-timer-wrap ${goal ? "has-goal" : ""}">
                ${goal ? `<svg class="focus-ring" viewBox="0 0 220 220" aria-hidden="true">
                    <circle cx="110" cy="110" r="${r}" class="focus-ring-track"/>
                    <circle cx="110" cy="110" r="${r}" class="focus-ring-value" id="focusRingValue" stroke-dasharray="0 ${c.toFixed(2)}" transform="rotate(-90 110 110)"/>
                </svg>` : ""}
                <div class="focus-timer" data-session-timer>${formatDuration(sessionElapsed(activeSession))}</div>
            </div>
            ${goal ? `<p class="focus-goal">${t("focus.goal", goal)}</p>` : ""}
            <p class="focus-page">${book.total_pages ? t("lib.pageOf", book.current_page || 0, book.total_pages) : t("lib.pageOnly", book.current_page || 0)}</p>
            <div class="focus-actions">
                <button type="button" class="focus-btn main" data-action="${running ? "pause-session" : "resume-session"}" data-busy-key="session">
                    <svg><use href="#i-${running ? "pause" : "play"}"/></svg>${t(running ? "books.pause" : "books.resume")}</button>
                <button type="button" class="focus-btn" data-action="focus-finish" data-busy-key="session">${t("lib.session.finish")}</button>
            </div>
            <p class="focus-hint">${t("focus.hint")}</p>
        </div>`;

    updateFocusRing();
    if (hadFocus) box.querySelector(".focus-btn.main")?.focus();
}

function updateFocusRing() {
    if (!focusOpen || !activeSession) return;
    const ring = $("focusRingValue");
    const goal = Number(prefs.sessionGoalMin || 0);
    if (!ring || !goal) return;
    const c = 2 * Math.PI * 104;
    const pct = Math.min(1, sessionElapsed(activeSession) / (goal * 60));
    ring.setAttribute("stroke-dasharray", `${(c * pct).toFixed(2)} ${c.toFixed(2)}`);
    ring.classList.toggle("complete", pct >= 1);
}

document.addEventListener("keydown", event => {
    if (!focusOpen || document.querySelector(".modal-overlay.show")) return;
    if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeFocusMode();
    } else if (event.key === " " && !["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        $("focusMode").querySelector(".focus-btn.main")?.click();
    }
}, true);

// -----------------------------------------------------
// SORTEAR O PRÓXIMO LIVRO (lista "Quero ler", com peso pela prioridade)
// -----------------------------------------------------

async function pickNextBook(excludeId = null) {
    const pool = books.filter(b => b.status === "want");
    if (!pool.length) return;
    const candidates = pool.length > 1 ? pool.filter(b => Number(b.id) !== Number(excludeId)) : pool;
    const weighted = candidates.flatMap(b => Array(4 - (b.priority || 2)).fill(b));
    const book = weighted[Math.floor(Math.random() * weighted.length)];

    const result = await askDialog({
        title: t("pick.title"),
        message: `
            <div class="pick-card">
                ${coverImg(book, "pick-cover")}
                <div>
                    <strong>${escapeHTML(book.title)}</strong>
                    ${book.author ? `<span>${escapeHTML(book.author)}</span>` : ""}
                    <div class="pick-chips">
                        <span class="chip priority-${book.priority || 2}">${t(`lib.priority.${book.priority || 2}`)}</span>
                        ${book.total_pages ? `<span class="chip">${t("lib.unit.pages", book.total_pages)}</span>` : ""}
                    </div>
                    ${book.notes ? `<p class="pick-notes">${escapeHTML(book.notes)}</p>` : ""}
                </div>
            </div>`,
        actions: [
            ...(pool.length > 1 ? [{ label: t("pick.again"), value: "again", style: "secondary" }] : []),
            { label: t("pick.start"), value: "start", style: "primary" }
        ]
    });

    if (result === "again") pickNextBook(book.id);
    else if (result === "start") startBookFromWant(book.id);
}


// Mantém a prévia do livro (ao passar o mouse) dentro da estante
libraryList.addEventListener("mouseover", event => {
    const slot = event.target.closest(".spine-slot");
    if (!slot || slot.dataset.peeked) return;
    slot.dataset.peeked = "1";
    const peek = slot.querySelector(".spine-peek");
    const shelf = slot.closest(".bookshelf");
    if (!peek || !shelf) return;
    const s = shelf.getBoundingClientRect(), r = slot.getBoundingClientRect();
    const half = peek.offsetWidth / 2, center = r.left + r.width / 2;
    const shift = Math.max(s.left + 8 - (center - half), Math.min(0, s.right - 8 - (center + half)));
    peek.style.setProperty("--shift", `${Math.round(shift)}px`);
});
