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
            document.fonts.load('700 80px "Cormorant Garamond"'),
            document.fonts.load('italic 600 48px "Cormorant Garamond"'),
            document.fonts.load('700 48px "Courier Prime"'),
            document.fonts.load('400 32px Literata'),
            document.fonts.load('600 22px Literata')
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

function drawBookCard(canvas, data, format, cover) {
    const { w, h } = CARD_FORMATS[format];
    const story = format === "stories";
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const C = CARD_COLORS;
    const M = 84;
    const cx = w / 2;
    const book = data.book;

    // Cor de destaque da capa (ou azul padrão, se não houver capa)
    const tint = cardAccent(cover) || [47, 115, 184];
    const accent = cardMix(tint, [21, 52, 90], 0.25);     // um pouco mais escura para ler bem
    const accentHex = cardHex(accent);

    // ---------- Fundo: a própria capa, desfocada, sobre branco ----------
    ctx.fillStyle = "#f7fafd";
    ctx.fillRect(0, 0, w, h);
    if (cover && "filter" in ctx) {
        ctx.save();
        ctx.filter = "blur(90px) saturate(1.4)";
        const s = Math.max(w / cover.width, h / cover.height) * 1.25;
        ctx.globalAlpha = 0.55;
        ctx.drawImage(cover, cx - cover.width * s / 2, h * 0.5 - cover.height * s / 2, cover.width * s, cover.height * s);
        ctx.restore();
    } else {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, cardRgba(tint, 0.22));
        g.addColorStop(1, cardRgba(tint, 0.05));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
    }
    // véu branco para manter o texto legível
    const veil = ctx.createLinearGradient(0, 0, 0, h);
    veil.addColorStop(0, "rgba(255,255,255,0.78)");
    veil.addColorStop(0.5, "rgba(255,255,255,0.7)");
    veil.addColorStop(1, "rgba(255,255,255,0.9)");
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, w, h);
    cardGlow(ctx, w * 0.9, h * 0.02, w * 0.5, cardRgba(tint, 0.25));

    // ---------- Cabeçalho ----------
    const headY = story ? 128 : 92;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = accentHex;
    ctx.font = '700 46px "Cormorant Garamond", Georgia, serif';
    ctx.fillText("Trama", M, headY);
    const brandW = ctx.measureText("Trama").width;
    ctx.beginPath(); ctx.arc(M + brandW + 14, headY - 17, 5, 0, Math.PI * 2); ctx.fill();

    ctx.textAlign = "right";
    cardSpacing(ctx, 4);
    ctx.fillStyle = accentHex;
    ctx.font = '700 19px "Courier Prime", "Courier New", monospace';
    ctx.fillText(t("card.label"), w - M, headY - 14);
    cardSpacing(ctx, 1);
    ctx.fillStyle = C.muted;
    ctx.font = '400 18px "Courier Prime", "Courier New", monospace';
    const finished = book.finished_at ? parseLocalDate(book.finished_at).toLocaleDateString(currentLocale(), { day: "2-digit", month: "short", year: "numeric" }).replace(/\./g, "").toUpperCase() : "";
    ctx.fillText(finished, w - M, headY + 16);
    cardSpacing(ctx, 0);
    ctx.strokeStyle = cardRgba(tint, 0.35);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(M, headY + 54); ctx.lineTo(w - M, headY + 54); ctx.stroke();

    // ---------- Capa, com as "folhas" do miolo na lateral ----------
    const coverW = story ? 470 : 300;
    const coverH = coverW * 1.5;
    const coverTop = story ? 240 : 196;
    const coverX = cx - coverW / 2 - (story ? 0 : 0);
    ctx.save();
    ctx.shadowColor = cardRgba(accent, 0.35);
    ctx.shadowBlur = 90;
    ctx.shadowOffsetY = 40;
    cardRoundRect(ctx, coverX, coverTop, coverW, coverH, 16);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();
    // folhas (tons claros do próprio cartão, espaçadas)
    for (let i = 4; i >= 1; i--) {
        cardRoundRect(ctx, coverX + coverW - 6 + i * 3, coverTop + 8 + i * 2, 12, coverH - 16 - i * 4, 3);
        ctx.fillStyle = i % 2 ? "#eef4fb" : "#ffffff";
        ctx.fill();
        ctx.strokeStyle = cardRgba(accent, 0.12);
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    ctx.save();
    cardRoundRect(ctx, coverX, coverTop, coverW, coverH, 16);
    ctx.clip();
    if (cover) {
        const scale = Math.max(coverW / cover.width, coverH / cover.height);
        const dw = cover.width * scale, dh = cover.height * scale;
        ctx.drawImage(cover, cx - dw / 2, coverTop + coverH / 2 - dh / 2, dw, dh);
        // lombada: vinco sutil à esquerda e brilho
        const spineG = ctx.createLinearGradient(coverX, 0, coverX + 34, 0);
        spineG.addColorStop(0, "rgba(0,0,0,0.28)");
        spineG.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = spineG;
        ctx.fillRect(coverX, coverTop, 34, coverH);
        const shine = ctx.createLinearGradient(coverX, coverTop, coverX + coverW, coverTop + coverH * 0.6);
        shine.addColorStop(0, "rgba(255,255,255,0.22)");
        shine.addColorStop(0.45, "rgba(255,255,255,0)");
        ctx.fillStyle = shine;
        ctx.fillRect(coverX, coverTop, coverW, coverH);
    } else {
        const cg = ctx.createLinearGradient(coverX, coverTop, coverX + coverW, coverTop + coverH);
        cg.addColorStop(0, cardHex(tint));
        cg.addColorStop(1, accentHex);
        ctx.fillStyle = cg;
        ctx.fillRect(coverX, coverTop, coverW, coverH);
        cardGlow(ctx, coverX + coverW * 0.3, coverTop + coverH * 0.2, coverW * 0.8, "rgba(255,255,255,0.3)");
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.font = `700 ${Math.round(coverW * 0.42)}px "Cormorant Garamond", Georgia, serif`;
        ctx.fillText((book.title || "?").trim().charAt(0).toUpperCase(), cx, coverTop + coverH * 0.42);
        ctx.font = `600 ${Math.round(coverW * 0.075)}px Literata, Georgia, serif`;
        cardWrap(ctx, book.title, coverW * 0.78, 2).forEach((l, i) => ctx.fillText(l, cx, coverTop + coverH * 0.78 + i * coverW * 0.095));
    }
    ctx.restore();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    cardRoundRect(ctx, coverX, coverTop, coverW, coverH, 16);
    ctx.stroke();

    // ---------- Citação favorita ----------
    let y = coverTop + coverH + (story ? 108 : 96);
    ctx.textAlign = "center";
    if (data.quote) {
        const qSize = story ? 34 : 28;
        ctx.fillStyle = accentHex;
        ctx.font = `700 ${story ? 96 : 76}px "Cormorant Garamond", Georgia, serif`;
        ctx.fillText("“", cx, y - (story ? 46 : 36));
        ctx.fillStyle = C.ink2;
        ctx.font = `italic 400 ${qSize}px Literata, Georgia, serif`;
        const lines = cardWrap(ctx, data.quote, w - M * 2 - 80, story ? 4 : 2);
        lines.forEach((l, i) => ctx.fillText(l, cx, y + 18 + i * qSize * 1.45));
        y += 18 + (lines.length - 1) * qSize * 1.45 + (story ? 72 : 56);
    }

    // ---------- Título, autor, avaliação ----------
    ctx.fillStyle = C.ink;
    const titleSize = story ? 72 : 52;
    ctx.font = `700 ${titleSize}px "Cormorant Garamond", Georgia, serif`;
    const titleLines = cardWrap(ctx, book.title, w - M * 2, 2);
    titleLines.forEach((line, i) => ctx.fillText(line, cx, y + i * titleSize * 1.04));
    y += (titleLines.length - 1) * titleSize * 1.04;

    if (book.author) {
        y += story ? 56 : 44;
        ctx.fillStyle = C.ink2;
        ctx.font = `italic 500 ${story ? 32 : 26}px Literata, Georgia, serif`;
        ctx.fillText(cardWrap(ctx, book.author, w - M * 2, 1)[0] || "", cx, y);
    }
    if (book.rating) {
        y += story ? 54 : 42;
        const size = story ? 26 : 20, gap = 12;
        const total = 5 * size + 4 * gap;
        for (let i = 0; i < 5; i++) {
            const x = cx - total / 2 + i * (size + gap) + size / 2;
            drawCardStar(ctx, x, y, size / 2, i < book.rating ? accentHex : C.star);
        }
    }

    // ---------- Números: painel branco ----------
    const panelTop = y + (story ? 64 : 48);
    const panelH = story ? 176 : 132;
    ctx.save();
    ctx.shadowColor = cardRgba(accent, 0.18);
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 18;
    cardRoundRect(ctx, M, panelTop, w - M * 2, panelH, 26);
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fill();
    ctx.restore();
    cardRoundRect(ctx, M, panelTop, w - M * 2, panelH, 26);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cardRgba(accent, 0.15);
    ctx.stroke();

    const metrics = [
        [t("card.pages"), data.pages ? Number(data.pages).toLocaleString(currentLocale()) : "—"],
        [t("card.time"), data.seconds ? humanDuration(data.seconds) : "—"],
        [t("card.pace"), data.pace ? `${Math.round(data.pace)}` : "—"],
        [t("card.days"), data.days ?? "—"]
    ];
    const colW = (w - M * 2) / metrics.length;
    metrics.forEach(([label, value], i) => {
        const mx = M + colW * i + colW / 2;
        if (i > 0) {
            ctx.strokeStyle = C.line;
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(M + colW * i, panelTop + 30); ctx.lineTo(M + colW * i, panelTop + panelH - 30); ctx.stroke();
        }
        ctx.textAlign = "center";
        ctx.fillStyle = C.ink;
        let size = story ? 44 : 34;
        ctx.font = `700 ${size}px "Courier Prime", "Courier New", monospace`;
        while (size > 20 && ctx.measureText(String(value)).width > colW * 0.84) {
            size -= 2;
            ctx.font = `700 ${size}px "Courier Prime", "Courier New", monospace`;
        }
        ctx.fillText(String(value), mx, panelTop + panelH * 0.44);
        cardSpacing(ctx, 2);
        ctx.fillStyle = C.muted;
        ctx.font = `700 ${story ? 16 : 13}px Literata, Georgia, serif`;
        ctx.fillText(label, mx, panelTop + panelH * 0.74);
        cardSpacing(ctx, 0);
    });
    y = panelTop + panelH;

    // ---------- Desafio do ano ----------
    if (data.goal) {
        const barY = y + (story ? 78 : 56);
        const pct = Math.min(1, data.yearDone / data.goal);
        ctx.textAlign = "left";
        ctx.fillStyle = C.muted;
        ctx.font = `700 ${story ? 19 : 16}px Literata, Georgia, serif`;
        cardSpacing(ctx, 2);
        ctx.fillText(t("card.challenge", Math.min(data.yearDone, data.goal), data.goal).toUpperCase(), M, barY - (story ? 26 : 22));
        cardSpacing(ctx, 0);
        cardRoundRect(ctx, M, barY, w - M * 2, story ? 16 : 12, 8);
        ctx.fillStyle = cardRgba(accent, 0.14);
        ctx.fill();
        if (pct > 0) {
            cardRoundRect(ctx, M, barY, Math.max(16, (w - M * 2) * pct), story ? 16 : 12, 8);
            ctx.fillStyle = accentHex;
            ctx.fill();
        }
        y = barY + (story ? 16 : 12);
    }

    // ---------- Ritmo das sessões (barras) ----------
    if (story || !data.goal) {
        const bars = data.sessionPages.filter(v => v > 0).slice(-14);
        if (bars.length) {
            const barTop = y + (story ? 110 : 70);
            const barH = story ? 130 : 90;
            const barBase = barTop + barH;
            const max = Math.max(...bars);
            const slot = (w - M * 2) / bars.length;
            const bw = Math.min(slot * 0.58, 52);
            ctx.textAlign = "left";
            ctx.fillStyle = C.muted;
            ctx.font = `700 ${story ? 19 : 16}px Literata, Georgia, serif`;
            cardSpacing(ctx, 2);
            ctx.fillText(t("card.signature", data.sessionCount), M, barTop - 26);
            cardSpacing(ctx, 0);
            bars.forEach((v, i) => {
                const bh = Math.max(12, (v / max) * barH);
                const bx = M + slot * i + (slot - bw) / 2;
                cardRoundRect(ctx, bx, barBase - bh, bw, bh, 10);
                ctx.fillStyle = v === max ? accentHex : cardRgba(accent, 0.3);
                ctx.fill();
            });
            ctx.strokeStyle = C.line;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(M, barBase + 1); ctx.lineTo(w - M, barBase + 1); ctx.stroke();
        }
    }

    // ---------- Rodapé ----------
    const footerY = h - (story ? 120 : 70);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = C.ink2;
    ctx.font = `600 ${story ? 24 : 20}px Literata, Georgia, serif`;
    if (data.ordinal) ctx.fillText(t("card.nth", data.ordinal, data.year), M, footerY);
    ctx.textAlign = "right";
    ctx.fillStyle = accentHex;
    ctx.font = `700 ${story ? 22 : 18}px "Courier Prime", "Courier New", monospace`;
    const who = data.reader || data.name || "";
    ctx.fillText(who ? t("card.readBy", who) : "trama", w - M, footerY);
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
