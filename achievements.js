// =====================================================
// TRAMA — CONQUISTAS (com níveis: bronze, prata, ouro e platina)
// Calculadas a partir dos seus próprios dados (nada extra no banco).
// =====================================================

const ACH_TIERS = ["bronze", "silver", "gold", "platinum"];

// tiers = metas de bronze, prata, ouro e platina · value(d) = progresso atual
const ACHIEVEMENTS = [
    // ---------- Livros ----------
    { id: "b_finished",   cat: "books", icon: "book",     tiers: [1, 10, 30, 75],          value: d => d.finished },
    { id: "b_pages",      cat: "books", icon: "list",     tiers: [1000, 5000, 20000, 50000], value: d => d.pages, unit: "pages" },
    { id: "b_focus",      cat: "books", icon: "focus",    tiers: [30, 60, 120, 180],       value: d => d.longestMinutes, unit: "min" },
    { id: "b_streak",     cat: "books", icon: "flame",    tiers: [7, 30, 90, 180],         value: d => d.bestStreak, unit: "days" },
    { id: "b_day",        cat: "books", icon: "chart",    tiers: [100, 200, 350, 500],     value: d => d.bestDayPages, unit: "pages" },
    { id: "b_brick",      cat: "books", icon: "layers",   tiers: [1, 3, 10, 20],           value: d => d.bricks },
    { id: "b_sessions",   cat: "books", icon: "pen",      tiers: [10, 100, 300, 750],      value: d => d.sessions },
    { id: "b_hours",      cat: "books", icon: "clock",    tiers: [10, 50, 150, 500],       value: d => d.hours, unit: "hours" },
    { id: "b_notes",      cat: "books", icon: "quote",    tiers: [5, 25, 75, 200],         value: d => d.notes },
    { id: "b_reviews",    cat: "books", icon: "sparkle",  tiers: [3, 15, 40, 80],          value: d => d.reviewedBooks },
    { id: "b_authors",    cat: "books", icon: "user",     tiers: [3, 10, 25, 50],          value: d => d.authors },
    { id: "b_genres",     cat: "books", icon: "palette",  tiers: [3, 6, 10, 15],           value: d => d.genresRead },
    { id: "b_quotes",     cat: "books", icon: "bookmark", tiers: [3, 15, 50, 120],         value: d => d.quotes },
    { id: "b_year",       cat: "books", icon: "calendar", tiers: [6, 12, 24, 52],          value: d => d.finishedThisYear },
    { id: "b_dawn",       cat: "books", icon: "sun",      tiers: [5, 20, 50, 100],         value: d => d.dawnSessions },
    { id: "b_night",      cat: "books", icon: "moon",     tiers: [5, 20, 50, 100],         value: d => d.nightSessions }
];

const achState = { filter: "all", timer: null, queue: [], showing: false };

function achievementData() {
    const done = completedSessions();
    const pagesByDay = {};
    done.forEach(s => { pagesByDay[s.session_date] = (pagesByDay[s.session_date] || 0) + Number(s.pages_read || 0); });
    const finishedIds = new Set(finishRecords().map(r => Number(r.bookId)));
    const finishedBooks = books.filter(b => finishedIds.has(Number(b.id)) || b.status === "finished");

    const thisYear = String(new Date().getFullYear());
    const hourOf = x => { const d = new Date(x.created_at || x.session_date); return Number.isNaN(d.getTime()) ? 12 : d.getHours(); };
    const notesAll = typeof bookNotes !== "undefined" ? bookNotes : [];

    return {
        // livros
        finished: finishRecords().length,
        pages: done.reduce((a, s) => a + Number(s.pages_read || 0), 0),
        longestMinutes: Math.floor(Math.max(0, ...done.map(s => Number(s.duration_seconds || 0))) / 60),
        bestStreak: computeBestStreak(),
        bestDayPages: Math.max(0, ...Object.values(pagesByDay)),
        bricks: finishedBooks.filter(b => Number(b.total_pages) >= 500).length,
        sessions: done.length,
        hours: Math.floor(done.reduce((a, s) => a + Number(s.duration_seconds || 0), 0) / 3600),
        notes: typeof bookNotes !== "undefined" ? bookNotes.length : 0,
        reviewedBooks: books.filter(b => b.rating).length,
        authors: new Set(finishedBooks.map(b => normalizeText(b.author || "")).filter(Boolean)).size,
        genresRead: new Set(finishedBooks.map(b => normalizeText(b.genre || "")).filter(Boolean)).size,
        quotes: notesAll.filter(n => n.kind === "quote").length,
        finishedThisYear: finishRecords().filter(r => String(r.date || "").startsWith(thisYear)).length,
        dawnSessions: done.filter(x => hourOf(x) < 8 && hourOf(x) >= 4).length,
        nightSessions: done.filter(x => hourOf(x) >= 22 || hourOf(x) < 4).length
    };
}

// level: 0 = nenhum · 1 bronze · 2 prata · 3 ouro · 4 platina
function evaluateAchievements() {
    const data = achievementData();
    return ACHIEVEMENTS.map(a => {
        const value = Number(a.value(data)) || 0;
        const level = a.tiers.filter(target => value >= target).length;
        const nextTarget = a.tiers[level] ?? null;
        const prevTarget = level ? a.tiers[level - 1] : 0;
        const pct = nextTarget === null ? 1 : Math.max(0, Math.min(1, (value - prevTarget) / (nextTarget - prevTarget)));
        return { ...a, value, level, nextTarget, pct, totalPct: Math.min(1, value / a.tiers[3]) };
    });
}

function tierName(level) {
    return level ? t(`ach.tier.${ACH_TIERS[level - 1]}`) : "";
}

// ---------- Emblema (hexágono na cor do nível + anel até o próximo nível) ----------
let achGradSeq = 0;
const TIER_STOPS = {
    bronze:   ["#f6d2b0", "#cf8f5f", "#9a5b33"],
    silver:   ["#fbf8f0", "#cfc8bb", "#857c6d"],
    gold:     ["#fff0b8", "#f2b84b", "#c27c12"],
    platinum: ["#fbf8f0", "#b8c4c2", "#56686a"]
};

function achEmblem(a, size = 84) {
    const r = 46, c = 2 * Math.PI * r;
    const gid = `achGrad${++achGradSeq}`;
    const tier = a.level ? ACH_TIERS[a.level - 1] : null;
    const stops = tier ? TIER_STOPS[tier] : null;
    const hex = "M50 8 L86.4 29 L86.4 71 L50 92 L13.6 71 L13.6 29 Z";
    return `
        <span class="ach-emblem ${tier ? `on tier-${tier}` : ""}" style="--size:${size}px">
            <svg viewBox="0 0 100 100" aria-hidden="true">
                ${stops ? `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="${stops[0]}"/><stop offset=".55" stop-color="${stops[1]}"/><stop offset="1" stop-color="${stops[2]}"/>
                </linearGradient></defs>` : ""}
                ${a.level < 4 ? `<circle cx="50" cy="50" r="${r}" class="ach-ring-track"/>
                <circle cx="50" cy="50" r="${r}" class="ach-ring-value next-${ACH_TIERS[a.level]}" stroke-dasharray="${(c * a.pct).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 50 50)"/>` : ""}
                <path d="${hex}" class="ach-hex" ${stops ? `style="fill:url(#${gid})"` : ""} stroke-linejoin="round"/>
            </svg>
            <svg class="ach-icon"><use href="#i-${a.icon}"/></svg>
        </span>`;
}

function achFmt(a, n) {
    const value = Number(n).toLocaleString(currentLocale());
    if (!a.unit) return value;
    return `${value} ${t(`ach.unit.${a.unit}`)}`;
}

function achProgressText(a) {
    if (a.nextTarget === null) return t("ach.maxed");
    return `${Number(Math.min(a.value, a.nextTarget)).toLocaleString(currentLocale())}/${achFmt(a, a.nextTarget)}`;
}

// Descrição muda conforme a meta do próximo nível
function achDesc(a) {
    const target = a.nextTarget ?? a.tiers[3];
    return t(`ach.${a.id}.desc`, target.toLocaleString(currentLocale()));
}

// ---------- Página ----------
function renderAchievements() {
    const page = $("achievementsPage");
    if (!page) return;
    const list = evaluateAchievements();
    const maxLevels = list.length * 4;
    const levels = list.reduce((s, a) => s + a.level, 0);
    const byTier = lvl => list.filter(a => a.level === lvl).length;

    $("achTotal").innerHTML = `${levels}<small>/${maxLevels}</small>`;
    $("achBar").style.width = `${(levels / maxLevels) * 100}%`;
    $("achTierCounts").innerHTML = [4, 3, 2, 1].map(lvl => `
        <div class="tier-count tier-${ACH_TIERS[lvl - 1]}"><i></i><strong>${byTier(lvl)}</strong><span>${tierName(lvl)}</span></div>`).join("");

    // Próximo nível mais perto de sair
    const next = list.filter(a => a.level < 4).sort((a, b) => b.pct - a.pct || a.level - b.level)[0];
    $("achNext").innerHTML = next ? `
        <small class="hero-next-eyebrow">${t("ach.next")} · ${tierName(next.level + 1).toUpperCase()}</small>
        <div class="ach-next-row">
            ${achEmblem(next, 72)}
            <div class="ach-next-info">
                <strong>${t(`ach.${next.id}.name`)}</strong>
                <span>${achDesc(next)}</span>
                <div class="asb-progress"><span style="width:${next.pct * 100}%"></span></div>
                <em>${achProgressText(next)}</em>
            </div>
        </div>` : `<div class="ach-all-done"><svg><use href="#i-trophy"/></svg><strong>${t("ach.allDone")}</strong></div>`;

    document.querySelectorAll("#achFilter button").forEach(b => b.classList.toggle("active", b.dataset.filter === achState.filter));

    const shown = list.filter(a => achState.filter === "all" || (achState.filter === "unlocked" ? a.level > 0 : a.level === 0))
        .sort((a, b) => b.level - a.level || b.pct - a.pct);

    $("achGrid").innerHTML = shown.map((a, i) => `
        <article class="ach-card ${a.level ? `unlocked tier-${ACH_TIERS[a.level - 1]}` : "locked"}" style="--i:${Math.min(i, 12)}">
            <div class="ach-top">
                ${achEmblem(a)}
                <div class="ach-pips" aria-label="${a.level ? tierName(a.level) : t("ach.locked")}">
                    ${ACH_TIERS.map((tier, k) => `<i class="pip ${k < a.level ? `on tier-${tier}` : ""}" title="${tierName(k + 1)} · ${achFmt(a, a.tiers[k])}"></i>`).join("")}
                </div>
            </div>
            <div class="ach-body">
                <span class="ach-cat">${a.level ? `<b class="tier-label tier-${ACH_TIERS[a.level - 1]}">${tierName(a.level)}</b>` : t("ach.locked")}</span>
                <h3>${t(`ach.${a.id}.name`)}</h3>
                <p>${achDesc(a)}</p>
            </div>
            <div class="ach-status">
                ${a.level === 4
                    ? `<span class="ach-done"><svg><use href="#i-check"/></svg>${t("ach.maxed")}</span>`
                    : `<span class="ach-progress"><i><b class="next-${ACH_TIERS[a.level]}" style="width:${a.pct * 100}%"></b></i>${achProgressText(a)}</span>`}
            </div>
        </article>`).join("");
}

document.querySelectorAll("#achFilter button").forEach(button => {
    button.addEventListener("click", () => {
        achState.filter = button.dataset.filter;
        renderAchievements();
    });
});

// ---------- Aviso de nível novo ----------
function checkAchievements() {
    clearTimeout(achState.timer);
    achState.timer = setTimeout(runAchievementCheck, 500);
}

function runAchievementCheck() {
    if (!currentUserId || !libraryLoaded || !libraryReady) return;

    renderAchievements();
    const current = Object.fromEntries(evaluateAchievements().map(a => [a.id, a.level]));

    // Primeira vez (ou vindo da versão sem níveis): guarda o estado atual sem avisos
    const seen = prefs.achievementLevels;
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
        setPref("achievementLevels", current);
        return;
    }

    // Conquista que ainda não estava no mapa (ex.: criada numa versão nova) entra em silêncio
    const missing = Object.entries(current).filter(([id]) => !(id in seen));
    const fresh = Object.entries(current).filter(([id, lvl]) => id in seen && lvl > (Number(seen[id]) || 0));
    if (missing.length && !fresh.length) setPref("achievementLevels", { ...seen, ...Object.fromEntries(missing) });
    if (!fresh.length) return;

    setPref("achievementLevels", { ...seen, ...Object.fromEntries(missing), ...Object.fromEntries(fresh) });
    fresh.forEach(([id, lvl]) => achState.queue.push({ id, level: lvl }));
    $("achNavDot")?.classList.remove("hidden");
    showNextAchievementToast();
}

function showNextAchievementToast() {
    if (achState.showing || !achState.queue.length) return;
    const item = achState.queue.shift();
    const a = evaluateAchievements().find(x => x.id === item.id);
    if (!a) { showNextAchievementToast(); return; }
    achState.showing = true;
    const shown = { ...a, level: item.level, pct: 1 };

    const el = $("achToast");
    el.className = `ach-toast tier-${ACH_TIERS[item.level - 1]}`;
    el.innerHTML = `
        ${achEmblem(shown, 58)}
        <div>
            <small>${t("ach.popup")} · ${tierName(item.level).toUpperCase()}</small>
            <strong>${t(`ach.${a.id}.name`)}</strong>
            <span>${t(`ach.${a.id}.desc`, a.tiers[item.level - 1].toLocaleString(currentLocale()))}</span>
        </div>`;
    requestAnimationFrame(() => el.classList.add("show"));
    if (prefs.sessionSound && typeof playChime === "function") playChime();

    clearTimeout(el._timer);
    el._timer = setTimeout(hideAchievementToast, 4800);
}

function hideAchievementToast() {
    const el = $("achToast");
    el.classList.remove("show");
    setTimeout(() => {
        el.classList.add("hidden");
        achState.showing = false;
        showNextAchievementToast();
    }, 350);
}

$("achToast").addEventListener("click", () => {
    hideAchievementToast();
    goToPage("achievementsPage");
    $("achNavDot")?.classList.add("hidden");
});

document.querySelector('.nav-button[data-page="achievementsPage"]')?.addEventListener("click", () => {
    $("achNavDot")?.classList.add("hidden");
});
