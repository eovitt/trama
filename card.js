// =====================================================
// TRAMA — CARTÃO DO LIVRO CONCLUÍDO
// Gera uma imagem (PNG) para baixar ou compartilhar nas redes.
// Tudo é desenhado no próprio navegador, sem serviços externos.
// =====================================================

const CARD_FORMATS = {
    stories: { w: 1080, h: 1920 },
    feed: { w: 1080, h: 1350 }
};

const CARD_COLORS = {
    ink: "#1b2d42",
    ink2: "#3d5672",
    muted: "#7189a6",
    line: "#d3e2f2",
    sky: "#a9d2f3",
    blue: "#2f73b8",
    deep: "#1f5a95",
    panel: "#ffffff",
    soft: "#eaf2fb",
    star: "#cfe0f2"
};

const cardState = { bookId: null, format: "stories", blob: null, token: 0 };

// ---------- utilidades de desenho ----------

function cardRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

function cardGlow(ctx, x, y, r, color) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function cardSpacing(ctx, px) {
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`;
}

// Quebra o texto em linhas (com reticências quando passa do limite)
function cardWrap(ctx, text, maxWidth, maxLines) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (let i = 0; i < words.length; i++) {
        const test = line ? `${line} ${words[i]}` : words[i];
        if (ctx.measureText(test).width <= maxWidth) { line = test; continue; }
        if (line) lines.push(line);
        line = words[i];
        if (lines.length === maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    const used = lines.join(" ").split(/\s+/).length;
    if (used < words.length && lines.length) {
        let last = lines[lines.length - 1];
        while (last.length && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
        lines[lines.length - 1] = `${last.trimEnd()}…`;
    }
    return lines;
}

// Números pseudoaleatórios estáveis (o mesmo livro gera sempre o mesmo desenho)
function cardRandom(seed) {
    let s = 0;
    for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function loadCardImage(url) {
    return new Promise(resolve => {
        if (!url) { resolve(null); return; }
        const img = new Image();
        let done = false;
        const finish = value => { if (!done) { done = true; resolve(value); } };
        img.crossOrigin = "anonymous";       // permite exportar a imagem (se o servidor deixar)
        img.referrerPolicy = "no-referrer";
        img.onload = () => finish(img);
        img.onerror = () => finish(null);
        img.src = url;
        setTimeout(() => finish(null), 7000);
    });
}

async function loadCardFonts() {
    if (!document.fonts?.load) return;
    try {
        await Promise.all([
            document.fonts.load('700 80px "Bricolage Grotesque"'),
            document.fonts.load('500 32px "Bricolage Grotesque"'),
            document.fonts.load('italic 500 80px Newsreader'),
            document.fonts.load('italic 400 34px Newsreader')
        ]);
    } catch (e) { /* usa as fontes do sistema */ }
}

// ---------- dados do cartão ----------

function cardData(book) {
    const stats = bookStats(book.id);
    const sessions = [...sessionsForBook(book.id)].reverse();   // da mais antiga para a mais recente
    const year = (book.finished_at || todayISO()).slice(0, 4);
    const yearFinishes = finishRecords()
        .filter(r => String(r.date || "").startsWith(year))
        .sort((a, b) => a.date.localeCompare(b.date) || Number(a.bookId) - Number(b.bookId));
    const index = yearFinishes.findIndex(r => Number(r.bookId) === Number(book.id) && r.date === book.finished_at);

    return {
        book,
        pages: book.total_pages || book.current_page || stats.pages || 0,
        seconds: stats.seconds,
        days: book.started_at && book.finished_at ? daysBetween(book.started_at, book.finished_at) + 1 : null,
        sessionCount: stats.count,
        sessionPages: sessions.map(s => Number(s.pages_read || 0)),
        ordinal: index >= 0 ? index + 1 : null,
        year,
        goal: challengeGoal(Number(year)),
        yearDone: yearFinishes.length,
        name: typeof displayName === "function" ? displayName() : "",
        reader: typeof readerNameFor === "function" ? readerNameFor(book) : "",
        quote: book.favorite_quote || "",
        pace: stats.pagesPerHour || null
    };
}

// ---------- desenho ----------

// Cor de destaque tirada da própria capa (média das cores vivas)
function cardAccent(img) {
    if (!img) return null;
    try {
        const c = document.createElement("canvas");
        c.width = 32; c.height = 32;
        const x = c.getContext("2d", { willReadFrequently: true });
        x.drawImage(img, 0, 0, 32, 32);
        const d = x.getImageData(0, 0, 32, 32).data;
        let r = 0, g = 0, b = 0, n = 0, ar = 0, ag = 0, ab = 0, an = 0;
        for (let i = 0; i < d.length; i += 4) {
            const R = d[i], G = d[i + 1], B = d[i + 2];
            const max = Math.max(R, G, B), min = Math.min(R, G, B);
            const sat = max ? (max - min) / max : 0;
            const light = (max + min) / 510;
            ar += R; ag += G; ab += B; an++;
            if (sat > 0.22 && light > 0.2 && light < 0.8) { r += R; g += G; b += B; n++; }
        }
        const pick = n > 20 ? [r / n, g / n, b / n] : [ar / an, ag / an, ab / an];
        return pick.map(v => Math.round(v));
    } catch (error) {
        return null;   // capa de outro site sem permissão de leitura
    }
}

function cardMix(rgb, toRgb, t) {
    return rgb.map((v, i) => Math.round(v + (toRgb[i] - v) * t));
}
const cardHex = rgb => "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");
const cardRgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

// "PÁGINAS" → "páginas", "LIVRO CONCLUÍDO" → "Livro concluído"
const cardLower = s => String(s || "").toLowerCase();
const cardSentence = s => { const l = cardLower(s); return l.charAt(0).toUpperCase() + l.slice(1); };

// Maior tamanho de fonte em que o texto cabe em até maxLines linhas
function cardFit(ctx, text, maxWidth, maxLines, startSize, minSize, fontOf) {
    let size = startSize, lines = [];
    for (; size >= minSize; size -= 4) {
        ctx.font = fontOf(size);
        lines = cardWrap(ctx, text, maxWidth, maxLines + 1);
        if (lines.length <= maxLines) break;
    }
    if (lines.length > maxLines) { ctx.font = fontOf(minSize); size = minSize; lines = cardWrap(ctx, text, maxWidth, maxLines); }
    return { size, lines };
}

function drawBookCard(canvas, data, format, cover) {
    const { w, h } = CARD_FORMATS[format];
    const story = format === "stories";
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const M = 84;
    const book = data.book;
    const SANS = '"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif';
    const SERIF = 'Newsreader, Georgia, serif';
    const BLUE = "#4361ee";
    const white = a => `rgba(255,255,255,${a})`;

    // ---------- Fundo: a capa desfocada (ou o azul da Trama) ----------
    ctx.fillStyle = BLUE;
    ctx.fillRect(0, 0, w, h);
    const immersive = Boolean(cover && "filter" in ctx);
    if (immersive) {
        ctx.save();
        ctx.filter = "blur(70px) saturate(1.7)";
        const s = Math.max(w / cover.width, h / cover.height) * 1.3;
        ctx.drawImage(cover, w / 2 - cover.width * s / 2, h / 2 - cover.height * s / 2, cover.width * s, cover.height * s);
        ctx.restore();
        ctx.fillStyle = "rgba(6,8,20,0.34)";
        ctx.fillRect(0, 0, w, h);
    } else {
        // círculos grandes, tom sobre tom
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.beginPath(); ctx.arc(w * 0.95, h * 0.12, w * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(10,12,60,0.16)";
        ctx.beginPath(); ctx.arc(w * 0.05, h * 0.95, w * 0.62, 0, Math.PI * 2); ctx.fill();
    }
    const shade = ctx.createLinearGradient(0, h * 0.4, 0, h);
    shade.addColorStop(0, "rgba(6,8,20,0)");
    shade.addColorStop(1, immersive ? "rgba(6,8,20,0.78)" : "rgba(10,14,70,0.5)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, w, h);

    // ---------- Topo: marca e etiqueta ----------
    const headY = story ? 126 : 96;
    ctx.textBaseline = "middle";
    cardRoundRect(ctx, M, headY - 27, 54, 54, 15);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.fillStyle = BLUE;
    ctx.beginPath();   // o "T" com ponta de marcador
    const tx = M + 27, ty = headY;
    ctx.moveTo(tx - 15, ty - 14); ctx.lineTo(tx + 15, ty - 14); ctx.lineTo(tx + 15, ty - 6); ctx.lineTo(tx + 5, ty - 6);
    ctx.lineTo(tx + 5, ty + 16); ctx.lineTo(tx, ty + 11); ctx.lineTo(tx - 5, ty + 16); ctx.lineTo(tx - 5, ty - 6); ctx.lineTo(tx - 15, ty - 6);
    ctx.closePath(); ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 36px ${SANS}`;
    ctx.fillText("trama", M + 70, headY + 1);

    const label = cardSentence(t("card.label"));
    ctx.font = `600 24px ${SANS}`;
    const lw = ctx.measureText(label).width + 44;
    cardRoundRect(ctx, w - M - lw, headY - 25, lw, 50, 25);
    ctx.fillStyle = white(0.18);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.fillText(label, w - M - lw / 2, headY + 1);

    // ---------- Capa inclinada ----------
    const coverW = story ? 540 : 400;
    const coverH = coverW * 1.5;
    const coverCX = story ? w / 2 : M + 18 + coverW / 2;
    const coverTop = story ? 232 : 186;
    const coverCY = coverTop + coverH / 2;
    const tilt = -0.07;

    ctx.save();
    ctx.translate(coverCX, coverCY);
    ctx.rotate(tilt);
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 90;
    ctx.shadowOffsetY = 46;
    cardRoundRect(ctx, -coverW / 2, -coverH / 2, coverW, coverH, 14);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.save();
    cardRoundRect(ctx, -coverW / 2, -coverH / 2, coverW, coverH, 14);
    ctx.clip();
    if (cover) {
        const scale = Math.max(coverW / cover.width, coverH / cover.height);
        ctx.drawImage(cover, -cover.width * scale / 2, -cover.height * scale / 2, cover.width * scale, cover.height * scale);
    } else {
        // capa tipográfica: branca, com o título em azul
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(-coverW / 2, -coverH / 2, coverW, coverH);
        ctx.fillStyle = BLUE;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        const fit = cardFit(ctx, book.title, coverW * 0.78, 5, Math.round(coverW * 0.17), Math.round(coverW * 0.09), s => `italic 500 ${s}px ${SERIF}`);
        fit.lines.forEach((l, i) => ctx.fillText(l, -coverW / 2 + coverW * 0.11, -coverH / 2 + coverH * 0.13 + fit.size * 0.8 + i * fit.size * 1.04));
        if (book.author) {
            ctx.font = `500 ${Math.round(coverW * 0.062)}px ${SANS}`;
            ctx.fillStyle = "#0a0c1a";
            ctx.fillText(cardWrap(ctx, book.author, coverW * 0.78, 1)[0] || "", -coverW / 2 + coverW * 0.11, coverH / 2 - coverH * 0.08);
        }
        ctx.textBaseline = "middle";
    }
    // vinco da lombada e brilho
    const fold = ctx.createLinearGradient(-coverW / 2, 0, -coverW / 2 + 36, 0);
    fold.addColorStop(0, "rgba(0,0,0,0.26)"); fold.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = fold;
    ctx.fillRect(-coverW / 2, -coverH / 2, 36, coverH);
    const shine = ctx.createLinearGradient(-coverW / 2, -coverH / 2, coverW / 2, coverH * 0.2);
    shine.addColorStop(0, "rgba(255,255,255,0.2)"); shine.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.fillStyle = shine;
    ctx.fillRect(-coverW / 2, -coverH / 2, coverW, coverH);
    ctx.restore();
    ctx.restore();

    // ---------- Selo "lido" ----------
    const sr = story ? 104 : 86;
    const sx = coverCX + coverW / 2 - (story ? 8 : 4), sy = coverTop + coverH - (story ? 96 : 84);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(0.2);
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 16;
    ctx.beginPath(); ctx.arc(0, 0, sr, 0, Math.PI * 2);
    ctx.fillStyle = immersive || cover ? BLUE : "#0a0c1a";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = white(0.45);
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 9]);
    ctx.beginPath(); ctx.arc(0, 0, sr - 12, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.font = `700 ${Math.round(sr * 0.62)}px ${SANS}`;
    ctx.fillText(cardLower(t("card.read")), 0, -sr * 0.1);
    if (book.finished_at) {
        ctx.font = `500 ${Math.round(sr * 0.2)}px ${SANS}`;
        ctx.fillStyle = white(0.85);
        ctx.fillText(parseLocalDate(book.finished_at).toLocaleDateString(currentLocale(), { day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "").replace(/ de /g, " "), 0, sr * 0.42);
    }
    ctx.restore();

    // ---------- Título, autor, avaliação ----------
    const textX = story ? M : M + 18 + coverW + 78;
    const textW = w - M - textX;
    let y = story ? coverTop + coverH + 118 : 262;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    const title = cardFit(ctx, book.title, textW, story ? 3 : 5, story ? 96 : 76, story ? 56 : 44, s => `italic 500 ${s}px ${SERIF}`);
    title.lines.forEach((l, i) => ctx.fillText(l, textX, y + i * title.size * 1.02));
    y += (title.lines.length - 1) * title.size * 1.02;

    if (book.author) {
        y += story ? 58 : 50;
        ctx.font = `500 ${story ? 34 : 28}px ${SANS}`;
        ctx.fillStyle = white(0.85);
        ctx.fillText(cardWrap(ctx, book.author, textW, 1)[0] || "", textX, y);
    }
    if (book.rating) {
        y += story ? 62 : 54;
        const size = story ? 34 : 28, gap = 10;
        for (let i = 0; i < 5; i++) drawCardStar(ctx, textX + size / 2 + i * (size + gap), y - size * 0.35, size / 2, i < book.rating ? "#ffffff" : white(0.28));
    }

    // ---------- Números ----------
    const statsTop = story ? h - 352 : h - 322;
    const metrics = [
        [cardLower(t("card.pages")), data.pages ? Number(data.pages).toLocaleString(currentLocale()) : null],
        [cardLower(t("card.time")), data.seconds ? humanDuration(data.seconds) : null],
        [cardLower(t("card.days")), data.days],
        [cardLower(t("card.sessions")), data.sessionCount || null]
    ].filter(m => m[1] !== null && m[1] !== undefined).slice(0, story ? 3 : 4);

    // citação, quando sobra espaço
    if (data.quote) {
        const qSize = story ? 36 : 32;
        ctx.font = `italic 400 ${qSize}px ${SERIF}`;
        const qW = (story ? w - M * 2 : textW) - 34;
        const qLines = cardWrap(ctx, `“${data.quote}”`, qW, story ? 2 : 3);
        const qTop = y + (story ? 70 : 64);
        const limit = story ? statsTop - 40 : coverTop + coverH + 20;
        if (qTop + qLines.length * qSize * 1.3 < limit) {
            ctx.fillStyle = white(0.5);
            ctx.fillRect(textX, qTop - qSize * 0.85, 4, qLines.length * qSize * 1.3);
            ctx.fillStyle = white(0.92);
            qLines.forEach((l, i) => ctx.fillText(l, textX + 30, qTop + i * qSize * 1.3));
        }
    }

    if (metrics.length) {
        ctx.strokeStyle = white(0.3);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(M, statsTop); ctx.lineTo(w - M, statsTop); ctx.stroke();
        const colW = (w - M * 2) / metrics.length;
        metrics.forEach(([labelText, value], i) => {
            const x = M + colW * i;
            let size = story ? 76 : 64;
            ctx.font = `650 ${size}px ${SANS}`;
            while (size > 34 && ctx.measureText(String(value)).width > colW - 34) { size -= 4; ctx.font = `650 ${size}px ${SANS}`; }
            ctx.fillStyle = "#ffffff";
            ctx.fillText(String(value), x, statsTop + (story ? 104 : 90));
            ctx.font = `500 ${story ? 26 : 22}px ${SANS}`;
            ctx.fillStyle = white(0.75);
            ctx.fillText(labelText, x, statsTop + (story ? 146 : 126));
        });
    }

    // ---------- Rodapé ----------
    const footY = h - (story ? 96 : 66);
    ctx.font = `500 ${story ? 26 : 22}px ${SANS}`;
    ctx.fillStyle = white(0.85);
    ctx.textAlign = "left";
    const who = data.reader || data.name || "";
    const left = [who ? cardSentence(t("card.readBy", who).replace(who, "\u0000")).replace("\u0000", who) : "", data.ordinal ? t("card.nth", data.ordinal, data.year) : ""].filter(Boolean).join("   ·   ");
    ctx.fillText(left, M, footY);
    if (data.goal) {
        ctx.textAlign = "right";
        ctx.fillText(cardSentence(t("card.challenge", Math.min(data.yearDone, data.goal), data.goal)), w - M, footY);
    }
}

function drawCardStar(ctx, x, y, r, color) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 5;
        const radius = i % 2 === 0 ? r : r * 0.45;
        const px = x + Math.cos(angle) * radius, py = y + Math.sin(angle) * radius;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

// ---------- janela do cartão ----------

async function renderShareCard() {
    const book = bookById(cardState.bookId);
    if (!book) return;
    const token = ++cardState.token;
    const canvas = $("shareCardCanvas");
    const preview = canvas.parentElement;
    preview.classList.add("loading");
    preview.dataset.format = cardState.format;
    $("cardDownload").disabled = true;
    $("cardShare").disabled = true;

    await loadCardFonts();
    const cover = await loadCardImage(book.cover);
    if (token !== cardState.token) return;

    drawBookCard(canvas, cardData(book), cardState.format, cover);

    let blob = null;
    try {
        blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    } catch (error) {
        // Capa de outro site sem permissão de exportar: refaz sem a capa
        drawBookCard(canvas, cardData(book), cardState.format, null);
        blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    }
    if (token !== cardState.token) return;

    cardState.blob = blob;
    preview.classList.remove("loading");
    $("cardDownload").disabled = !blob;
    const file = blob ? new File([blob], cardFileName(book), { type: "image/png" }) : null;
    const canShare = Boolean(file && navigator.canShare && navigator.canShare({ files: [file] }));
    $("cardShare").classList.toggle("hidden", !canShare);
    $("cardShare").disabled = !canShare;
}

function cardFileName(book) {
    const slug = normalizeText(book.title || "livro").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "livro";
    return `trama-${slug}-${cardState.format}.png`;
}

function openShareCard(bookId) {
    const book = bookById(bookId);
    if (!book) return;
    cardState.bookId = bookId;
    document.querySelectorAll("#cardFormat button").forEach(b => b.classList.toggle("active", b.dataset.format === cardState.format));
    openOverlay($("shareCardModal"));
    renderShareCard();
}

document.querySelectorAll("#cardFormat button").forEach(button => {
    button.addEventListener("click", () => {
        cardState.format = button.dataset.format;
        document.querySelectorAll("#cardFormat button").forEach(b => b.classList.toggle("active", b === button));
        renderShareCard();
    });
});

$("cardDownload").addEventListener("click", () => {
    const book = bookById(cardState.bookId);
    if (!cardState.blob || !book) return;
    const url = URL.createObjectURL(cardState.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cardFileName(book);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(t("card.saved"), "success");
});

$("cardShare").addEventListener("click", async () => {
    const book = bookById(cardState.bookId);
    if (!cardState.blob || !book) return;
    const file = new File([cardState.blob], cardFileName(book), { type: "image/png" });
    try {
        await navigator.share({ files: [file], title: book.title, text: t("card.shareText", book.title) });
    } catch (error) {
        if (error?.name !== "AbortError") console.error(error);
    }
});

$("shareCardModal").addEventListener("click", event => {
    if (event.target === $("shareCardModal")) closeOverlay($("shareCardModal"));
});
