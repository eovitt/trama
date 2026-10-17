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
    ink: "#2e2418",
    ink2: "#54442f",
    muted: "#9e8d7f",
    line: "#dccba3",
    sky: "#d6b27a",
    blue: "#8b4a2b",
    soft: "#ecdcc0"
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
    g.addColorStop(1, "rgba(251,243,223,0)");
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
        name: typeof displayName === "function" ? displayName() : ""
    };
}

// ---------- desenho ----------

function drawBookCard(canvas, data, format, cover) {
    const { w, h } = CARD_FORMATS[format];
    const story = format === "stories";
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const C = CARD_COLORS;
    const M = 84;
    const book = data.book;
    const rand = cardRandom(`${book.id}-${book.title}`);

    // Fundo branco com brilhos azul-claros
    ctx.fillStyle = "#fbf3df";
    ctx.fillRect(0, 0, w, h);
    cardGlow(ctx, w * 0.08, h * 0.06, w * 0.95, "rgba(214,178,122,0.38)");
    cardGlow(ctx, w * 1.0, h * 0.5, w * 0.75, "rgba(139,74,43,0.08)");
    cardGlow(ctx, w * 0.15, h * 1.02, w * 0.9, "rgba(214,178,122,0.26)");

    // Os "fios da trama" atravessando o cartão
    for (let i = 0; i < 9; i++) {
        const base = h * (0.08 + i * 0.1) + rand() * 40;
        const amp = 30 + rand() * 60;
        const freq = 0.003 + rand() * 0.003;
        const phase = rand() * Math.PI * 2;
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += 10) {
            const y = base + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 2.2 + phase) * amp * 0.3;
            x === -20 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(176,122,79,${0.07 + (i % 3) * 0.035})`;
        ctx.lineWidth = i % 4 === 0 ? 2.2 : 1.4;
        ctx.stroke();
    }

    // ---------- Cabeçalho ----------
    const headY = story ? 118 : 92;
    const logo = 58;
    const lg = ctx.createLinearGradient(M, headY - logo / 2, M + logo, headY + logo / 2);
    lg.addColorStop(0, C.sky);
    lg.addColorStop(1, C.blue);
    cardRoundRect(ctx, M, headY - logo / 2, logo, logo, 16);
    ctx.fillStyle = lg;
    ctx.fill();
    ctx.fillStyle = "#fbf3df";
    ctx.font = '700 36px "Cormorant Garamond", Georgia, serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("T", M + logo / 2, headY + 2);
    ctx.textAlign = "left";
    ctx.fillStyle = C.ink;
    ctx.font = '700 38px "Cormorant Garamond", Georgia, serif';
    ctx.fillText("Trama", M + logo + 18, headY + 2);

    ctx.textAlign = "right";
    ctx.font = '700 22px "Courier Prime", "Courier New", monospace';
    cardSpacing(ctx, 5);
    ctx.fillStyle = C.blue;
    ctx.fillText(t("card.label"), w - M, headY - 12);
    cardSpacing(ctx, 2);
    ctx.fillStyle = C.muted;
    ctx.font = '700 20px "Courier Prime", "Courier New", monospace';
    const finished = book.finished_at ? parseLocalDate(book.finished_at).toLocaleDateString(currentLocale(), { day: "2-digit", month: "short", year: "numeric" }).replace(/\./g, "").toUpperCase() : "";
    ctx.fillText(finished, w - M, headY + 20);
    cardSpacing(ctx, 0);

    // ---------- Capa em "órbita" ----------
    const coverW = story ? 450 : 300;
    const coverH = coverW * 1.5;
    const coverTop = story ? 250 : 175;
    const cx = w / 2;
    const cy = coverTop + coverH / 2;
    const orbit = coverH * 0.62;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.92);
    const og = ctx.createLinearGradient(-orbit, 0, orbit, 0);
    og.addColorStop(0, "rgba(214,178,122,0.15)");
    og.addColorStop(0.5, "rgba(139,74,43,0.55)");
    og.addColorStop(1, "rgba(214,178,122,0.15)");
    ctx.strokeStyle = og;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, orbit, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([3, 14]);
    ctx.strokeStyle = "rgba(139,74,43,0.28)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, orbit + 44, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    [[-0.9, 9], [0.35, 6], [2.4, 7]].forEach(([angle, r]) => {
        const px = Math.cos(angle) * orbit, py = Math.sin(angle) * orbit;
        cardGlow(ctx, px, py, r * 4, "rgba(214,178,122,0.6)");
        ctx.fillStyle = C.blue;
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.045);
    ctx.shadowColor = "rgba(80,50,25,0.32)";
    ctx.shadowBlur = 80;
    ctx.shadowOffsetY = 40;
    cardRoundRect(ctx, -coverW / 2, -coverH / 2, coverW, coverH, 26);
    ctx.fillStyle = "#fbf3df";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.save();
    cardRoundRect(ctx, -coverW / 2, -coverH / 2, coverW, coverH, 26);
    ctx.clip();
    if (cover) {
        const scale = Math.max(coverW / cover.width, coverH / cover.height);
        const dw = cover.width * scale, dh = cover.height * scale;
        ctx.drawImage(cover, -dw / 2, -dh / 2, dw, dh);
    } else {
        const cg = ctx.createLinearGradient(-coverW / 2, -coverH / 2, coverW / 2, coverH / 2);
        cg.addColorStop(0, C.sky);
        cg.addColorStop(1, C.blue);
        ctx.fillStyle = cg;
        ctx.fillRect(-coverW / 2, -coverH / 2, coverW, coverH);
        cardGlow(ctx, -coverW * 0.2, -coverH * 0.3, coverW * 0.8, "rgba(251,243,223,0.35)");
        ctx.fillStyle = "#fbf3df";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${Math.round(coverW * 0.42)}px "Cormorant Garamond", Georgia, serif`;
        ctx.fillText((book.title || "?").trim().charAt(0).toUpperCase(), 0, -coverH * 0.05);
        ctx.font = `700 ${Math.round(coverW * 0.07)}px Literata, Georgia, serif`;
        const tl = cardWrap(ctx, book.title, coverW * 0.8, 2);
        tl.forEach((l, i) => ctx.fillText(l, 0, coverH * 0.22 + i * coverW * 0.09));
    }
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(251,243,223,0.6)";
    cardRoundRect(ctx, -coverW / 2, -coverH / 2, coverW, coverH, 26);
    ctx.stroke();
    ctx.restore();

    // Selo "100% · LIDO"
    const sealR = story ? 74 : 58;
    const sx = cx + coverW / 2 - 6, sy = coverTop + coverH - (story ? 40 : 30);
    ctx.save();
    ctx.shadowColor = "rgba(139,74,43,0.3)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#fbf3df";
    ctx.beginPath(); ctx.arc(sx, sy, sealR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    const sg = ctx.createLinearGradient(sx - sealR, sy - sealR, sx + sealR, sy + sealR);
    sg.addColorStop(0, C.sky);
    sg.addColorStop(1, C.blue);
    ctx.strokeStyle = sg;
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(sx, sy, sealR - 8, 0, Math.PI * 2); ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.blue;
    ctx.font = `700 ${story ? 34 : 27}px "Courier Prime", "Courier New", monospace`;
    ctx.fillText("100%", sx, sy - (story ? 9 : 7));
    ctx.font = `700 ${story ? 16 : 13}px Literata, Georgia, serif`;
    cardSpacing(ctx, 4);
    ctx.fillStyle = C.muted;
    ctx.fillText(t("card.read"), sx + 2, sy + (story ? 22 : 17));
    cardSpacing(ctx, 0);

    // ---------- Título, autor e nota ----------
    let y = coverTop + coverH + (story ? 120 : 82);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.ink;
    const titleSize = story ? 72 : 56;
    ctx.font = `700 ${titleSize}px "Cormorant Garamond", Georgia, serif`;
    cardSpacing(ctx, -1.5);
    const titleLines = cardWrap(ctx, book.title, w - M * 2, 2);
    titleLines.forEach((line, i) => ctx.fillText(line, cx, y + i * titleSize * 1.1));
    cardSpacing(ctx, 0);
    y += (titleLines.length - 1) * titleSize * 1.1;

    if (book.author) {
        y += story ? 58 : 46;
        ctx.fillStyle = C.muted;
        ctx.font = `500 ${story ? 32 : 27}px Literata, Georgia, serif`;
        ctx.fillText(cardWrap(ctx, book.author, w - M * 2, 1)[0] || "", cx, y);
    }

    if (book.rating) {
        y += story ? 62 : 50;
        const size = story ? 30 : 25, gap = 12;
        const total = 5 * size + 4 * gap;
        for (let i = 0; i < 5; i++) {
            const x = cx - total / 2 + i * (size + gap) + size / 2;
            drawCardStar(ctx, x, y - size / 2.6, size / 2, i < book.rating ? C.blue : "#e4d6b8");
        }
    }

    // ---------- Números da leitura ----------
    y += story ? 70 : 52;
    const metrics = [
        [t("card.pages"), data.pages ? Number(data.pages).toLocaleString(currentLocale()) : null],
        [t("card.time"), data.seconds ? humanDuration(data.seconds) : null],
        [t("card.days"), data.days],
        [t("card.sessions"), data.sessionCount || null]
    ].filter(([, v]) => v !== null && v !== undefined && v !== "");
    const rowH = story ? 140 : 116;
    if (metrics.length) {
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(w - M, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(M, y + rowH); ctx.lineTo(w - M, y + rowH); ctx.stroke();
        const colW = (w - M * 2) / metrics.length;
        metrics.forEach(([label, value], i) => {
            const mx = M + colW * i + colW / 2;
            if (i > 0) {
                ctx.beginPath(); ctx.moveTo(M + colW * i, y + 28); ctx.lineTo(M + colW * i, y + rowH - 28); ctx.stroke();
            }
            ctx.fillStyle = C.ink;
            ctx.font = `700 ${story ? 46 : 38}px "Courier Prime", "Courier New", monospace`;
            cardSpacing(ctx, -1);
            ctx.fillText(String(value), mx, y + rowH * 0.52);
            cardSpacing(ctx, 3);
            ctx.fillStyle = C.muted;
            ctx.font = `700 ${story ? 18 : 15}px Literata, Georgia, serif`;
            ctx.fillText(label, mx, y + rowH * 0.78);
            cardSpacing(ctx, 0);
        });
        y += rowH;
    }

    // ---------- Assinatura de leitura (uma barra por sessão) ----------
    const footerY = h - (story ? 104 : 78);
    let bars = data.sessionPages.filter(v => v > 0);
    if (bars.length > 1) {
        const maxBars = 64;
        if (bars.length > maxBars) {
            const size = Math.ceil(bars.length / maxBars);
            const grouped = [];
            for (let i = 0; i < bars.length; i += size) grouped.push(bars.slice(i, i + size).reduce((a, v) => a + v, 0));
            bars = grouped;
        }
        y += story ? 70 : 50;
        ctx.textAlign = "left";
        ctx.fillStyle = C.muted;
        ctx.font = `700 ${story ? 18 : 15}px "Courier Prime", "Courier New", monospace`;
        cardSpacing(ctx, 3);
        ctx.fillText(t("card.signature", data.sessionCount), M, y);
        cardSpacing(ctx, 0);
        const areaH = story ? 110 : 74;
        const top = y + 22;
        const gap = bars.length > 40 ? 4 : 7;
        const barW = Math.max(3, (w - M * 2 - gap * (bars.length - 1)) / bars.length);
        const max = Math.max(...bars);
        const bg = ctx.createLinearGradient(0, top, 0, top + areaH);
        bg.addColorStop(0, C.sky);
        bg.addColorStop(1, C.blue);
        bars.forEach((v, i) => {
            const bh = Math.max(6, (v / max) * areaH);
            const bx = M + i * (barW + gap);
            cardRoundRect(ctx, bx, top + areaH - bh, barW, bh, Math.min(4, barW / 2));
            ctx.fillStyle = bg;
            ctx.globalAlpha = 0.45 + 0.55 * (v / max);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
        y = top + areaH;
    }

    // ---------- Citação favorita (se couber) ----------
    if (book.favorite_quote) {
        ctx.textAlign = "center";
        ctx.font = `italic 600 ${story ? 36 : 30}px "Cormorant Garamond", Georgia, serif`;
        const lh = story ? 46 : 36;
        const maxLines = story ? 3 : 2;
        const space = footerY - 70 - (y + (story ? 80 : 56));
        const fit = Math.min(maxLines, Math.floor(space / lh) + 1);
        if (fit >= 1) {
            const lines = cardWrap(ctx, `“${book.favorite_quote}”`, w - M * 2 - 40, fit);
            let qy = y + (story ? 90 : 62);
            ctx.fillStyle = C.ink2;
            lines.forEach((l, i) => ctx.fillText(l, cx, qy + i * lh));
        }
    }

    // ---------- Rodapé ----------
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(M, footerY - 40); ctx.lineTo(w - M, footerY - 40); ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (data.ordinal) {
        ctx.fillStyle = C.blue;
        ctx.font = `700 ${story ? 24 : 21}px "Courier Prime", "Courier New", monospace`;
        ctx.fillText(t("card.nth", data.ordinal, data.year), M, footerY);
        if (data.goal) {
            const label = t("card.challenge", Math.min(data.yearDone, data.goal), data.goal);
            const lx = M + ctx.measureText(t("card.nth", data.ordinal, data.year)).width + 26;
            ctx.fillStyle = C.muted;
            ctx.font = `700 ${story ? 20 : 17}px "Courier Prime", "Courier New", monospace`;
            ctx.fillText(`· ${label}`, lx, footerY);
        }
    }
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = `600 ${story ? 22 : 19}px Literata, Georgia, serif`;
    ctx.fillText(data.name ? `${t("card.readBy", data.name)} · trama` : "trama", w - M, footerY);
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
