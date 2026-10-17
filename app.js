// =====================================================
// TRAMA — app.js
// =====================================================

// Proteção contra "clickjacking": o Trama não pode ser aberto dentro de outro site
if (window.top !== window.self) {
    document.documentElement.style.display = "none";
    try { window.top.location.replace(window.self.location.href); } catch (e) { /* bloqueado pelo navegador */ }
}

// Guardado antes de o Supabase ler (e limpar) o link de redefinição de senha
let recoveryMode = window.location.hash.includes("type=recovery");

const SUPABASE_URL = "https://kyimrrtaqwkyarbdifzb.supabase.co";
const SUPABASE_KEY = "sb_publishable_tG-YZqqagYFN_CNvafi2FA_gum7-h4Y";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = id => document.getElementById(id);

// =====================================================
// ESTADO
// =====================================================

let currentUser = null;
let currentUserId = null;
let currentUserEmail = null;
let lastFocusedElement = null;
let toastTimer = null;

let showFavoritesOnly = false;

let authMode = "login";
let authView = "auth"; // "auth" | "forgot" | "reset"

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const BASE_TITLE = document.title;

// =====================================================
// PREFERÊNCIAS (salvas no navegador e na conta)
// =====================================================

const DEFAULT_PREFS = {
    lang: null,             // null = detectar pelo navegador
    theme: "light",         // light | dark | system
    reduceMotion: false,
    displayName: "",
    avatarColor: "sky",
    sessionGoalMin: 0,
    sessionSound: true,
    timerInTab: true,
    defaultDailyGoal: null,
    booksView: {},          // visualização escolhida em cada aba da biblioteca
    readingChallenge: {},   // meta de livros por ano: { "2026": 12 }
    autoLockMin: 0          // sair automaticamente após X minutos sem uso (0 = nunca)
};

const AVATAR_COLORS = {
    sky: "linear-gradient(135deg, #c99a62, #7d4a26)",       // sépia
    ocean: "linear-gradient(135deg, #7f8fa6, #2f3a4f)",     // tinta azul-ferro
    mint: "linear-gradient(135deg, #aab27a, #56632e)",      // oliva
    lavender: "linear-gradient(135deg, #b893a8, #5e3a55)",  // ameixa
    sunset: "linear-gradient(135deg, #c97a62, #6e2420)",    // vinho
    graphite: "linear-gradient(135deg, #a69a86, #3d342a)"   // grafite
};

let prefs = loadLocalPrefs();

function loadLocalPrefs() {
    try {
        return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("trama.prefs") || "{}") };
    } catch (e) {
        return { ...DEFAULT_PREFS };
    }
}

function saveLocalPrefs() {
    try { localStorage.setItem("trama.prefs", JSON.stringify(prefs)); } catch (e) { /* navegador sem armazenamento */ }
}

// Envia as preferências para a conta (com atraso, para agrupar várias mudanças seguidas)
const syncPrefsToAccount = debounce(async () => {
    if (!currentUserId) return;
    try {
        const { error } = await supabaseClient.auth.updateUser({ data: { prefs } });
        if (error) throw error;
    } catch (error) {
        console.error(error);
        showToast(t("set.saveError"), "error");
    }
}, 800);

function setPref(key, value) {
    prefs[key] = value;
    saveLocalPrefs();
    syncPrefsToAccount();
    if (typeof flashSaved === "function") flashSaved();
}

function detectLanguage() {
    const nav = (navigator.language || "pt").slice(0, 2).toLowerCase();
    return I18N[nav] ? nav : "pt";
}

// ---------- Tema ----------
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
    const resolved = prefs.theme === "system" ? (darkQuery.matches ? "dark" : "light") : prefs.theme;
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]').content = resolved === "dark" ? "#1a140e" : "#efe3c6";

    if (prefs.reduceMotion) {
        document.documentElement.dataset.motion = "reduce";
    } else {
        delete document.documentElement.dataset.motion;
    }
}

darkQuery.addEventListener("change", () => { if (prefs.theme === "system") applyTheme(); });

// ---------- Idioma ----------
function applyLanguage() {
    currentLang = prefs.lang || detectLanguage();
    applyStaticTranslations();

    // Partes dinâmicas que dependem do idioma
    refreshAuthTexts();
    if (!loginScreen.classList.contains("hidden")) renderStageExtras();
    updateUserUI();
    if (typeof booksOnLanguageChange === "function") booksOnLanguageChange();
    if (typeof renderAchievements === "function" && currentUserId) renderAchievements();
    $("deleteConfirmLabel").textContent = t("set.data.typeToConfirm", { word: t("set.data.confirmWord") });
    validateDeleteConfirm();

    document.querySelectorAll(".lang-switch button").forEach(b => b.classList.toggle("active", b.dataset.lang === currentLang));
    document.querySelectorAll("[data-lang-option]").forEach(b => b.classList.toggle("active", b.dataset.langOption === currentLang));

    if (currentUserId) {
        renderDataSummary();
    }
}

function applyAvatarColor() {
    document.documentElement.style.setProperty("--avatar", AVATAR_COLORS[prefs.avatarColor] || AVATAR_COLORS.sky);
}

function applyAllPrefs() {
    applyTheme();
    applyAvatarColor();
    applyLanguage();
}

// Mescla preferências salvas na conta (valem mais que as do navegador)
function mergeAccountPrefs(user) {
    const remote = user?.user_metadata?.prefs;
    if (remote && typeof remote === "object") {
        prefs = { ...DEFAULT_PREFS, ...prefs, ...remote };
        saveLocalPrefs();
    }
    applyAllPrefs();
}

// =====================================================
// ELEMENTOS
// =====================================================

const loginScreen = $("loginScreen");
const app = $("app");

const authTabs = $("authTabs");
const showLoginTab = $("showLoginTab");
const showSignupTab = $("showSignupTab");
const loginEyebrow = $("loginEyebrow");
const loginHeading = $("loginHeading");
const loginDescription = $("loginDescription");
const loginForm = $("loginForm");
const loginEmail = $("loginEmail");
const loginPassword = $("loginPassword");
const loginConfirmPassword = $("loginConfirmPassword");
const confirmPasswordLabel = $("confirmPasswordLabel");
const loginButton = $("loginButton");
const loginError = $("loginError");
const loginInfo = $("loginInfo");
const forgotPasswordLink = $("forgotPasswordLink");
const passwordStrength = $("passwordStrength");

const forgotPasswordForm = $("forgotPasswordForm");
const forgotEmail = $("forgotEmail");
const forgotPasswordButton = $("forgotPasswordButton");

const resetPasswordForm = $("resetPasswordForm");
const resetNewPassword = $("resetNewPassword");
const resetConfirmPassword = $("resetConfirmPassword");
const resetPasswordButton = $("resetPasswordButton");
const resetPasswordStrength = $("resetPasswordStrength");

const accountModal = $("accountModal");
const accountForm = $("accountForm");
const accountNewPassword = $("accountNewPassword");
const accountConfirmPassword = $("accountConfirmPassword");
const saveAccountButton = $("saveAccountButton");
const accountFormError = $("accountFormError");
const accountFormInfo = $("accountFormInfo");
const accountPasswordStrength = $("accountPasswordStrength");

const toast = $("toast");

const bookHero = $("bookHero");
const statsHero = $("statsHero");


// =====================================================
// UTILITÁRIOS
// =====================================================

function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function normalizeText(value) {
    return (value ?? "")
        .toString()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .trim();
}

function escapeHTML(value) {
    const div = document.createElement("div");
    div.textContent = value ?? "";
    // Também escapa aspas: o texto pode ir para dentro de atributos (alt, title, style…)
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function localISO(date) {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
}

function todayISO() {
    return localISO(new Date());
}

function pad(value) {
    return String(value).padStart(2, "0");
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
    return `${pad(minutes)}:${pad(secs)}`;
}

function formatTotalTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours === 0 && minutes === 0) return "0min";
    if (hours === 0) return `${minutes}min`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}min`;
}

function formatDate(value, options = { day: "numeric", month: "short", year: "numeric" }) {
    if (!value) return "—";
    return new Date(value).toLocaleDateString(currentLocale(), options);
}

function sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

// Imagem reserva gerada no próprio navegador (não depende de site externo)
function placeholderImage(width, height) {
    const dark = document.documentElement.dataset.theme === "dark";
    const bg = dark ? "#33271c" : "#e2d3ae";
    const fg = dark ? "#b07a4f" : "#8b4a2b";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 30 45">
        <rect width="30" height="45" fill="${bg}"/>
        <path d="M15 19.5c-1.6-1.2-3.8-1.6-7-1.6v10.6c3.2 0 5.4.4 7 1.6 1.6-1.2 3.8-1.6 7-1.6V17.9c-3.2 0-5.4.4-7 1.6Zm0 0v10.6"
              fill="none" stroke="${fg}" stroke-width="1" stroke-linejoin="round" opacity=".8"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Troca imagens quebradas sem usar atributos onerror (compatível com a política de segurança)
document.addEventListener("error", event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.hasAttribute("data-remove-on-error")) { img.remove(); return; }
    const fallback = img.dataset.fallback;
    if (fallback && img.getAttribute("src") !== fallback) img.src = fallback;
}, true);

const focusStack = [];

function openOverlay(el) {
    if (el.classList.contains("show")) return;
    focusStack.push(document.activeElement);
    el.classList.add("show");
    // A janela aberta por último fica por cima das outras
    el.parentNode.appendChild(el);
    document.body.classList.add("modal-open");
}

function closeOverlay(el) {
    if (!el.classList.contains("show")) return;
    el.classList.remove("show");
    if (!document.querySelector(".modal-overlay.show")) document.body.classList.remove("modal-open");
    const previous = focusStack.pop();
    if (previous && document.contains(previous)) previous.focus();
}

function displayName() {
    const custom = (prefs.displayName || "").trim();
    if (custom) return custom;
    const fromEmail = (currentUserEmail || "").split("@")[0].split(/[._-]/)[0];
    return fromEmail ? fromEmail.charAt(0).toUpperCase() + fromEmail.slice(1) : "";
}

function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Som curto e suave, gerado no navegador (sem arquivo de áudio)
function playChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [659.25, 880, 1318.5].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = ctx.currentTime + i * 0.16;
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.9);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 1);
        });
        setTimeout(() => ctx.close(), 1800);
    } catch (e) { /* navegador sem áudio */ }
}

// =====================================================
// FORÇA DE SENHA
// =====================================================

function evaluatePasswordStrength(password) {
    if (!password) return { score: 0, label: "", color: "" };

    let score = 0;
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;

    const normalized = Math.min(4, score);
    const levels = [
        { key: "pw.veryWeak", color: "#9b2f2f" },
        { key: "pw.weak", color: "#9b2f2f" },
        { key: "pw.fair", color: "#b8862b" },
        { key: "pw.strong", color: "#5e7a3a" },
        { key: "pw.veryStrong", color: "#5e7a3a" }
    ];

    return { score: normalized, label: t(levels[normalized].key), color: levels[normalized].color };
}

function wirePasswordStrengthMeter(inputId, wrapperId, fillId, labelId) {
    const input = $(inputId);
    const wrapper = $(wrapperId);

    input.addEventListener("input", () => {
        // No login a força não importa (só ao criar ou trocar a senha)
        if (!input.value || (inputId === "loginPassword" && authMode !== "signup")) {
            wrapper.classList.add("hidden");
            return;
        }

        wrapper.classList.remove("hidden");
        const { score, label, color } = evaluatePasswordStrength(input.value);
        $(fillId).style.width = `${(score / 4) * 100}%`;
        $(fillId).style.background = color;
        $(labelId).textContent = label;
    });
}

wirePasswordStrengthMeter("loginPassword", "passwordStrength", "passwordStrengthFill", "passwordStrengthLabel");
wirePasswordStrengthMeter("resetNewPassword", "resetPasswordStrength", "resetPasswordStrengthFill", "resetPasswordStrengthLabel");
wirePasswordStrengthMeter("accountNewPassword", "accountPasswordStrength", "accountPasswordStrengthFill", "accountPasswordStrengthLabel");

function passwordProblem(password) {
    if (password.length < 8) return t("pw.tooShort");
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return t("pw.needMix");
    return null;
}

// =====================================================
// INICIALIZAÇÃO
// =====================================================

function isPasswordRecoveryLink() {
    return recoveryMode;
}

async function enterApp(session) {
    currentUser = session.user;
    currentUserId = session.user.id;
    currentUserEmail = session.user.email;

    mergeAccountPrefs(session.user);
    const start = prefs.startPage === "last" ? readLastPage() : (prefs.startPage || "livrosPage");
    if (start && $(start) && start !== currentPage()) goToPage(start);
    showApp();
    await loadBooks();
}

async function init() {
    applyAllPrefs();

    if (isPasswordRecoveryLink()) {
        showLogin();
        showOnlyForm("reset");
    }

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();

        if (session && !isPasswordRecoveryLink() && inactivityExpired()) {
            await supabaseClient.auth.signOut({ scope: "local" });
            showLogin();
            loginInfo.textContent = t("auth.autoLogout");
        } else if (session && !isPasswordRecoveryLink()) {
            markActivity(true);
            await enterApp(session);
        } else if (!isPasswordRecoveryLink()) {
            showLogin();
        }
    } catch (error) {
        console.error(error);
        if (!isPasswordRecoveryLink()) showLogin();
    }

    // Importante: o callback do Supabase NÃO pode ser async nem chamar o banco
    // diretamente — isso trava o signInWithPassword (deadlock conhecido do supabase-js v2).
    // Por isso o trabalho é adiado com setTimeout.
    supabaseClient.auth.onAuthStateChange((event, session) => {
        setTimeout(() => handleAuthEvent(event, session), 0);
    });
}

async function handleAuthEvent(event, session) {
    {
        if (event === "PASSWORD_RECOVERY") {
            recoveryMode = true;
            showLogin();
            showOnlyForm("reset");
            return;
        }

        if (event === "SIGNED_OUT") {
            currentUser = null;
            currentUserId = null;
            currentUserEmail = null;
            resetBooksState();
            document.querySelectorAll(".modal-overlay.show").forEach(closeOverlay);
            showLogin();
            return;
        }

        if (event === "USER_UPDATED" && session) {
            currentUser = session.user;
            currentUserEmail = session.user.email;
            updateUserUI();
            return;
        }

        if (event === "SIGNED_IN" && session && !isPasswordRecoveryLink() && session.user.id !== currentUserId) {
            await enterApp(session);
        }
    }
}

// =====================================================
// TELA DE LOGIN — textos e troca de formulários
// =====================================================

function refreshAuthTexts() {
    const texts = {
        reset: ["reset.eyebrow", "reset.heading", "reset.desc"],
        magic: ["magic.eyebrow", "magic.heading", "magic.desc"],
        forgot: ["forgot.eyebrow", "forgot.heading", "forgot.desc"],
        signup: ["signup.eyebrow", "signup.heading", "signup.desc"],
        login: ["login.eyebrow", "login.heading", "login.desc"]
    };

    const key = authView === "auth" ? authMode : authView;
    const [eyebrow, heading, desc] = texts[key];

    loginEyebrow.textContent = t(eyebrow);
    loginHeading.innerHTML = t(heading);
    loginDescription.textContent = t(desc);

    if (!loginButton.disabled) loginButton.textContent = t(authMode === "signup" ? "btn.signup" : "btn.login");
}

function showOnlyForm(which) {
    authView = which;
    loginError.textContent = "";
    loginInfo.textContent = "";

    authTabs.classList.toggle("hidden", which !== "auth");
    loginForm.classList.toggle("hidden", which !== "auth");
    forgotPasswordForm.classList.toggle("hidden", which !== "forgot");
    resetPasswordForm.classList.toggle("hidden", which !== "reset");
    $("magicLinkForm").classList.toggle("hidden", which !== "magic");

    refreshAuthTexts();
}

function setAuthMode(mode) {
    authMode = mode;
    loginError.textContent = "";
    loginInfo.textContent = "";

    const isSignup = mode === "signup";

    showLoginTab.classList.toggle("active", !isSignup);
    showLoginTab.setAttribute("aria-selected", String(!isSignup));
    showSignupTab.classList.toggle("active", isSignup);
    showSignupTab.setAttribute("aria-selected", String(isSignup));

    confirmPasswordLabel.classList.toggle("hidden", !isSignup);
    loginConfirmPassword.required = isSignup;
    loginPassword.autocomplete = isSignup ? "new-password" : "current-password";
    // No login, aceita senhas antigas (criadas antes da regra de 8 caracteres)
    if (isSignup) loginPassword.minLength = 8; else loginPassword.removeAttribute("minlength");
    forgotPasswordLink.classList.toggle("hidden", isSignup);
    $("magicLinkLink").classList.toggle("hidden", isSignup);
    authTabs.classList.toggle("signup", isSignup);

    if (!isSignup) passwordStrength.classList.add("hidden");

    refreshAuthTexts();
}

showLoginTab.addEventListener("click", () => setAuthMode("login"));
showSignupTab.addEventListener("click", () => setAuthMode("signup"));

forgotPasswordLink.addEventListener("click", () => {
    forgotEmail.value = loginEmail.value;
    showOnlyForm("forgot");
});

$("backToLoginLink").addEventListener("click", () => showOnlyForm("auth"));
$("magicBackLink").addEventListener("click", () => showOnlyForm("auth"));
$("magicLinkLink").addEventListener("click", () => {
    $("magicEmail").value = loginEmail.value;
    showOnlyForm("magic");
    setTimeout(() => $("magicEmail").focus(), 50);
});

// Seletor de idioma da tela de login
document.querySelectorAll(".lang-switch button").forEach(button => {
    button.addEventListener("click", () => {
        prefs.lang = button.dataset.lang;
        saveLocalPrefs();
        applyLanguage();
    });
});

loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    loginError.textContent = "";
    loginInfo.textContent = "";

    const email = loginEmail.value.trim().toLowerCase();
    const password = loginPassword.value;

    if (!email || !password) { loginError.textContent = t("auth.fillAll"); return; }
    if (!isValidEmail(email)) { loginError.textContent = t("auth.invalidEmail"); return; }

    if (authMode === "signup") {
        const problem = passwordProblem(password);
        if (problem) { loginError.textContent = problem; return; }
        if (password !== loginConfirmPassword.value) { loginError.textContent = t("pw.mismatch"); return; }

        loginButton.disabled = true;
        loginButton.textContent = t("pw.checking");
        const leaked = await pwnedCount(password);
        loginButton.disabled = false;
        loginButton.textContent = t("btn.signup");
        if (leaked) { loginError.textContent = t("pw.pwned", leaked); return; }

        loginButton.disabled = true;
        loginButton.textContent = t("btn.signingUp");

        try {
            // As preferências escolhidas antes do cadastro (ex.: idioma) já vão para a conta
            const { data, error } = await supabaseClient.auth.signUp({
                email,
                password,
                options: { data: { prefs }, emailRedirectTo: window.location.origin + window.location.pathname }
            });

            if (error) {
                console.error(error);
                const msg = (error.message || "").toLowerCase();
                const code = String(error.code || "");
                if (msg.includes("already registered") || code === "user_already_exists") loginError.textContent = t("auth.alreadyRegistered");
                else if (error.status === 429 || msg.includes("rate limit") || code.includes("rate_limit")) loginError.textContent = t("auth.signupRateLimit");
                else if (msg.includes("sending") || msg.includes("confirmation email") || code === "unexpected_failure") loginError.textContent = t("auth.signupEmailFail");
                else if (msg.includes("signups not allowed") || msg.includes("signup is disabled") || code === "signup_disabled") loginError.textContent = t("auth.signupDisabled");
                else if (msg.includes("invalid") && msg.includes("email")) loginError.textContent = t("auth.invalidEmail");
                else if (msg.includes("password")) loginError.textContent = t("auth.passwordRule");
                else loginError.textContent = `${t("auth.signupFailed")} (${error.message || code || error.status})`;
                return;
            }

            loginForm.reset();
            passwordStrength.classList.add("hidden");

            if (data.session) {
                showToast(t("auth.created"), "success");
                if (data.session.user.id !== currentUserId) await enterApp(data.session);
            } else {
                setAuthMode("login");
                loginInfo.textContent = t("auth.confirmEmail");
            }
        } catch (error) {
            console.error(error);
            loginError.textContent = t("auth.signupNetwork");
        } finally {
            loginButton.disabled = false;
            loginButton.textContent = t(authMode === "signup" ? "btn.signup" : "btn.login");
        }

        return;
    }

    // Muitas tentativas erradas seguidas: espera antes de tentar de novo
    if (loginLockRemaining() > 0) { startLoginLockCountdown(); return; }

    loginButton.disabled = true;
    loginButton.textContent = t("btn.loggingIn");
    let locked = false;

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

        if (error) {
            console.error(error);
            const msg = (error.message || "").toLowerCase();
            if (msg.includes("email not confirmed")) {
                loginError.textContent = t("auth.notConfirmed");
            } else {
                loginError.textContent = t("auth.wrong");
                registerLoginFailure();
                locked = loginLockRemaining() > 0;
            }
        } else {
            resetLoginGuard();
            loginPassword.value = "";
            markActivity(true);
            if (data && data.session && data.session.user.id !== currentUserId) {
                // Entra direto, sem depender só do evento SIGNED_IN
                await enterApp(data.session);
            }
        }
    } catch (error) {
        console.error(error);
        loginError.textContent = t("auth.network");
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = t("btn.login");
        if (locked) startLoginLockCountdown();
    }
});

forgotPasswordForm.addEventListener("submit", async event => {
    event.preventDefault();
    loginError.textContent = "";
    loginInfo.textContent = "";

    forgotPasswordButton.disabled = true;
    forgotPasswordButton.textContent = t("btn.sending");

    try {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(forgotEmail.value.trim().toLowerCase(), {
            redirectTo: window.location.origin + window.location.pathname
        });

        if (error) {
            console.error(error);
            loginError.textContent = t("auth.linkFailed");
            return;
        }

        forgotPasswordForm.reset();
        showOnlyForm("auth");
        loginInfo.textContent = t("auth.linkSent");
    } catch (error) {
        console.error(error);
        loginError.textContent = t("auth.linkNetwork");
    } finally {
        forgotPasswordButton.disabled = false;
        forgotPasswordButton.textContent = t("btn.sendLink");
    }
});

resetPasswordForm.addEventListener("submit", async event => {
    event.preventDefault();
    loginError.textContent = "";

    const newPassword = resetNewPassword.value;
    const problem = passwordProblem(newPassword);
    if (problem) { loginError.textContent = problem; return; }
    if (newPassword !== resetConfirmPassword.value) { loginError.textContent = t("pw.mismatch"); return; }

    resetPasswordButton.disabled = true;
    resetPasswordButton.textContent = t("pw.checking");
    const leaked = await pwnedCount(newPassword);
    if (leaked) {
        loginError.textContent = t("pw.pwned", leaked);
        resetPasswordButton.disabled = false;
        resetPasswordButton.textContent = t("btn.savePassword");
        return;
    }
    resetPasswordButton.textContent = t("btn.saving");

    try {
        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });

        if (error) {
            console.error(error);
            loginError.textContent = t("auth.resetFailed");
            return;
        }

        recoveryMode = false;
        history.replaceState(null, "", window.location.pathname + window.location.search);
        resetPasswordForm.reset();
        resetPasswordStrength.classList.add("hidden");

        const { data: { session } } = await supabaseClient.auth.getSession();

        if (session) {
            await enterApp(session);
            showToast(t("auth.resetDone"), "success");
        } else {
            showOnlyForm("auth");
            loginInfo.textContent = t("auth.resetDoneLogin");
        }
    } catch (error) {
        console.error(error);
        loginError.textContent = t("auth.resetNetwork");
    } finally {
        resetPasswordButton.disabled = false;
        resetPasswordButton.textContent = t("btn.savePassword");
    }
});

async function performLogout() {
    if (!confirm(t("auth.confirmLogout"))) return;
    await supabaseClient.auth.signOut();
}

$("logoutButton").addEventListener("click", performLogout);

function showLogin() {
    loginScreen.classList.remove("hidden");
    app.classList.add("hidden");
    stopHeroThreads();
    startLoginStage();
    if (loginLockRemaining() > 0) startLoginLockCountdown();
}

function showApp() {
    loginScreen.classList.add("hidden");
    app.classList.remove("hidden");
    stopLoginStage();
    updateUserUI();
    requestAnimationFrame(() => startHeroThreads(currentPage()));
}

// =====================================================
// BARRA SUPERIOR — saudação, data e avatar
// =====================================================

function updateUserUI() {
    const hour = new Date().getHours();
    const greeting = t(hour < 12 ? "greet.morning" : hour < 18 ? "greet.afternoon" : "greet.evening");
    const name = displayName();
    const initial = (name.charAt(0) || "?").toUpperCase();

    $("greetingText").textContent = name ? `${greeting}, ${name}` : greeting;

    const dateText = new Date().toLocaleDateString(currentLocale(), { weekday: "long", day: "numeric", month: "long" });
    $("todayDate").textContent = dateText.charAt(0).toUpperCase() + dateText.slice(1);

    $("avatarInitial").textContent = initial;
    $("settingsAvatar").textContent = initial;
    $("profileAvatarPreview").textContent = initial;
    $("settingsUserName").textContent = name || "—";
    $("settingsUserEmail").textContent = currentUserEmail || "—";
    $("accountCurrentEmail").textContent = currentUserEmail || "—";
    $("idCardName").textContent = name || (currentUserEmail || "").split("@")[0] || "—";
    $("idCardEmail").textContent = currentUserEmail || "—";
}

// =====================================================
// CONFIGURAÇÕES
// =====================================================

function openSettings(panel = "profile") {
    // Preenche os controles com as preferências atuais
    $("profileName").value = prefs.displayName || "";
    $("profileMemberSince").textContent = formatDate(currentUser?.created_at);
    $("profileLastLogin").textContent = formatDate(currentUser?.last_sign_in_at, {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
    $("securityLastAccess").textContent = formatDate(currentUser?.last_sign_in_at, {
        weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit"
    });
    $("autoLockSelect").value = String(prefs.autoLockMin || 0);
    markActiveColor(prefs.avatarColor);
    markActiveTheme();
    $("reduceMotionToggle").checked = !!prefs.reduceMotion;
    $("soundToggle").checked = !!prefs.sessionSound;
    $("tabTitleToggle").checked = !!prefs.timerInTab;
    $("defaultDailyGoal").value = prefs.defaultDailyGoal ?? "";
    $("startPageSelect").value = ["last", "livrosPage", "statsPage", "achievementsPage"].includes(prefs.startPage) ? prefs.startPage : "livrosPage";
    document.querySelectorAll(".set-acc").forEach(d => { d.open = false; });
    markActiveSessionGoal();

    accountForm.reset();
    accountFormError.textContent = "";
    accountFormInfo.textContent = "";
    accountPasswordStrength.classList.add("hidden");
    $("emailForm").reset();
    $("emailFormError").textContent = "";
    $("emailFormInfo").textContent = "";
    $("deleteConfirmInput").value = "";
    validateDeleteConfirm();

    updateUserUI();
    renderDataSummary();
    renderIdCard();
    showSettingsPanel(panel);
    openOverlay(accountModal);
}

function closeSettings() {
    closeOverlay(accountModal);
    idCardThreads?.stop();
    idCardThreads = null;
}

// Cartão de identidade do Trama: seus números num cartão vivo
let idCardThreads = null;
function renderIdCard() {
    const levels = typeof evaluateAchievements === "function" ? evaluateAchievements().reduce((a, x) => a + x.level, 0) : 0;
    const items = [
        [books.filter(b => b.status === "finished").length, t("set.id.read")],
        [readingSessions.reduce((a, x) => a + Number(x.pages_read || 0), 0), t("set.id.pages")],
        [Math.round(readingSessions.reduce((a, x) => a + Number(x.duration_seconds || 0), 0) / 3600), t("set.id.hours")],
        [levels, t("set.id.levels")]
    ];
    $("idCardStats").innerHTML = items.map(([n, label]) => `<div><strong>${Number(n).toLocaleString(currentLocale())}</strong><span>${label}</span></div>`).join("");
    idCardThreads?.stop();
    idCardThreads = null;
    requestAnimationFrame(() => {
        const canvas = document.querySelector(".id-card-threads");
        if (canvas && canvas.offsetWidth) idCardThreads = createThreads(canvas, { count: 7, knots: 4, strength: .6 });
    });
}

// "Salvo ✓" discreto sempre que uma preferência muda com as configurações abertas
let savedTimer = null;
function flashSaved() {
    const el = $("setSaved");
    if (!el || !accountModal.classList.contains("show")) return;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

function showSettingsPanel(panel) {
    document.querySelectorAll(".settings-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.panel === panel));
    document.querySelectorAll(".settings-panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== panel));
    document.querySelector(".settings-content").scrollTop = 0;
    if (panel === "profile" && accountModal.classList.contains("show")) renderIdCard();
    else { idCardThreads?.stop(); idCardThreads = null; }
}

document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => showSettingsPanel(tab.dataset.panel));
});

$("accountSettingsButton").addEventListener("click", () => openSettings());
$("sidebarSettingsButton").addEventListener("click", () => openSettings());
$("closeAccountModal").addEventListener("click", closeSettings);
accountModal.addEventListener("click", event => { if (event.target === accountModal) closeSettings(); });

// ---------- Perfil ----------
function markActiveColor(color) {
    document.querySelectorAll("#avatarColorPicker .swatch").forEach(s => s.classList.toggle("active", s.dataset.color === color));
}

function saveProfile() {
    prefs.displayName = $("profileName").value.trim();
    saveLocalPrefs();
    syncPrefsToAccount();
    applyAvatarColor();
    updateUserUI();
    flashSaved();
}

document.querySelectorAll("#avatarColorPicker .swatch").forEach(swatch => {
    swatch.addEventListener("click", () => {
        prefs.avatarColor = swatch.dataset.color;
        markActiveColor(prefs.avatarColor);
        saveProfile();
    });
});

const saveProfileSoon = debounce(saveProfile, 500);
$("profileName").addEventListener("input", () => {
    const initial = ($("profileName").value.trim().charAt(0) || "?").toUpperCase();
    $("profileAvatarPreview").textContent = initial;
    saveProfileSoon();
});
$("profileForm").addEventListener("submit", event => { event.preventDefault(); saveProfile(); });

// ---------- Aparência ----------
function markActiveTheme() {
    document.querySelectorAll("[data-theme-option]").forEach(card => card.classList.toggle("active", card.dataset.themeOption === prefs.theme));
}

document.querySelectorAll("[data-theme-option]").forEach(card => {
    card.addEventListener("click", () => {
        setPref("theme", card.dataset.themeOption);
        applyTheme();
        markActiveTheme();
        renderLibrary();
    });
});

$("startPageSelect").addEventListener("change", e => setPref("startPage", e.target.value));

$("reduceMotionToggle").addEventListener("change", event => {
    setPref("reduceMotion", event.target.checked);
    applyTheme();
});

// ---------- Idioma ----------
document.querySelectorAll("[data-lang-option]").forEach(card => {
    card.addEventListener("click", () => {
        setPref("lang", card.dataset.langOption);
        applyLanguage();
    });
});

// ---------- Leitura ----------
function markActiveSessionGoal() {
    document.querySelectorAll("#sessionGoalOptions button").forEach(b =>
        b.classList.toggle("active", Number(b.dataset.minutes) === Number(prefs.sessionGoalMin || 0)));
}

document.querySelectorAll("#sessionGoalOptions button").forEach(button => {
    button.addEventListener("click", () => {
        setPref("sessionGoalMin", Number(button.dataset.minutes));
        markActiveSessionGoal();
    });
});

$("soundToggle").addEventListener("change", e => setPref("sessionSound", e.target.checked));
$("tabTitleToggle").addEventListener("change", e => { setPref("timerInTab", e.target.checked); updateTabTitle(); });
$("testSoundButton").addEventListener("click", playChime);

$("defaultDailyGoal").addEventListener("change", e => {
    const value = Number(e.target.value);
    setPref("defaultDailyGoal", value > 0 ? value : null);
});

// ---------- Segurança: senha ----------
accountForm.addEventListener("submit", async event => {
    event.preventDefault();
    accountFormError.textContent = "";
    accountFormInfo.textContent = "";

    const currentPassword = $("accountCurrentPassword").value;
    const newPassword = accountNewPassword.value;
    if (!currentPassword) { accountFormError.textContent = t("set.security.currentRequired"); return; }
    const problem = passwordProblem(newPassword);
    if (problem) { accountFormError.textContent = problem; return; }
    if (newPassword !== accountConfirmPassword.value) { accountFormError.textContent = t("pw.mismatch"); return; }

    saveAccountButton.disabled = true;
    saveAccountButton.textContent = t("pw.checking");

    try {
        // Confirma que é você mesmo antes de trocar a senha
        if (!(await verifyCurrentPassword(currentPassword))) { accountFormError.textContent = t("set.security.currentWrong"); return; }

        const leaked = await pwnedCount(newPassword);
        if (leaked) { accountFormError.textContent = t("pw.pwned", leaked); return; }

        saveAccountButton.textContent = t("btn.saving");
        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });

        if (error) {
            console.error(error);
            accountFormError.textContent = t("set.security.passwordError");
            return;
        }

        accountForm.reset();
        accountPasswordStrength.classList.add("hidden");
        accountFormInfo.textContent = t("set.security.passwordUpdated");
    } catch (error) {
        console.error(error);
        accountFormError.textContent = t("set.security.passwordNetwork");
    } finally {
        saveAccountButton.disabled = false;
        saveAccountButton.textContent = t("btn.savePassword");
    }
});

// ---------- Segurança: e-mail ----------
$("emailForm").addEventListener("submit", async event => {
    event.preventDefault();
    $("emailFormError").textContent = "";
    $("emailFormInfo").textContent = "";

    const newEmail = $("newEmailInput").value.trim().toLowerCase();
    const currentPassword = $("emailCurrentPassword").value;

    if (!isValidEmail(newEmail)) { $("emailFormError").textContent = t("auth.invalidEmail"); return; }
    if (newEmail === (currentUserEmail || "").toLowerCase()) {
        $("emailFormError").textContent = t("set.security.emailSame");
        return;
    }
    if (!currentPassword) { $("emailFormError").textContent = t("set.security.currentRequired"); return; }

    const button = $("saveEmailButton");
    button.disabled = true;
    button.textContent = t("btn.sending");

    try {
        if (!(await verifyCurrentPassword(currentPassword))) { $("emailFormError").textContent = t("set.security.currentWrong"); return; }

        const { error } = await supabaseClient.auth.updateUser(
            { email: newEmail },
            { emailRedirectTo: window.location.origin + window.location.pathname }
        );

        if (error) {
            console.error(error);
            $("emailFormError").textContent = t("set.security.emailError");
            return;
        }

        $("emailForm").reset();
        $("emailFormInfo").textContent = t("set.security.emailSent");
    } catch (error) {
        console.error(error);
        $("emailFormError").textContent = t("set.security.emailError");
    } finally {
        button.disabled = false;
        button.textContent = t("set.security.saveEmail");
    }
});

// ---------- Segurança: sessões ----------
$("logoutAllButton").addEventListener("click", async () => {
    const ok = await confirmDialog(t("set.security.logoutAll"), `<p>${t("set.security.confirmLogoutAll")}</p>`, t("set.security.logoutAll"), true);
    if (!ok) return;
    await supabaseClient.auth.signOut({ scope: "global" });
});

$("accountLogoutButton").addEventListener("click", performLogout);

// ---------- Dados ----------
function renderDataSummary() {
    const items = [
        [books.length, t("nav.books"), "i-book"],
        [readingSessions.filter(s => !s.active).length, t("set.data.sessions"), "i-clock"],
        [bookNotes.length, t("set.data.notes"), "i-edit"],
        [bookEvents.length, t("set.data.events"), "i-list"]
    ];
    $("dataSummary").innerHTML = items.map(([n, label, icon]) => `
        <div><svg><use href="#${icon}"/></svg><strong>${Number(n).toLocaleString(currentLocale())}</strong><span>${label}</span></div>`).join("");
}

$("exportJsonButton").addEventListener("click", () => {
    const backup = {
        app: "Trama",
        exported_at: new Date().toISOString(),
        account: currentUserEmail,
        preferences: prefs,
        books,
        reading_sessions: readingSessions,
        book_notes: bookNotes,
        book_events: bookEvents
    };

    downloadFile(`trama-backup-${todayISO()}.json`, JSON.stringify(backup, null, 2), "application/json");
    showToast(t("set.data.exported"), "success");
});

$("exportCsvButton").addEventListener("click", () => {
    const headers = ["title", "author", "genre", "status", "total_pages", "current_page", "rating", "started_at", "finished_at"];
    const cell = value => {
        const text = String(value ?? "");
        return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = books.map(book => headers.map(h => cell(book[h])).join(","));

    // ﻿ faz o Excel reconhecer acentos corretamente
    downloadFile(`trama-livros-${todayISO()}.csv`, "﻿" + [headers.join(","), ...rows].join("\n"), "text/csv;charset=utf-8");
    showToast(t("set.data.exported"), "success");
});

function validateDeleteConfirm() {
    const ok = $("deleteConfirmInput").value.trim().toUpperCase() === t("set.data.confirmWord");
    $("deleteAllButton").disabled = !ok;
}

$("deleteConfirmInput").addEventListener("input", validateDeleteConfirm);

$("deleteAllButton").addEventListener("click", async () => {
    const button = $("deleteAllButton");
    button.disabled = true;
    button.textContent = t("set.data.deleting");

    try {
        // Notas e sessões primeiro, depois os livros.
        // Filmes e séries de versões antigas do Trama também são apagados (se as tabelas existirem).
        for (const table of ["book_notes", "reading_book_events", "reading_sessions", "reading_books", "series_logs", "series", "movies"]) {
            const { error } = await supabaseClient.from(table).delete().eq("user_id", currentUserId);
            const legacy = ["series_logs", "series", "movies"].includes(table);
            if (error && !legacy) throw error;
        }
        resetBooksState();
        renderLibrary();
        renderDataSummary();

        $("deleteConfirmInput").value = "";
        showToast(t("set.data.deleted"), "success");
    } catch (error) {
        console.error(error);
        showToast(t("set.data.deleteError"), "error");
    } finally {
        button.textContent = t("set.data.deleteButton");
        validateDeleteConfirm();
    }
});

// =====================================================
// UPLOAD DE IMAGENS (poster / capa)
// =====================================================

async function uploadImageToBucket(file) {
    const path = `${currentUserId}/${Date.now()}-${sanitizeFileName(file.name)}`;

    const { error } = await supabaseClient.storage.from("posters").upload(path, file, { upsert: false });
    if (error) throw error;

    return supabaseClient.storage.from("posters").getPublicUrl(path).data.publicUrl;
}

function validateImageFile(file, errorEl) {
    if (!file.type.startsWith("image/")) { errorEl.textContent = t("upload.notImage"); return false; }
    if (file.size > MAX_IMAGE_SIZE_BYTES) { errorEl.textContent = t("upload.tooBig"); return false; }
    errorEl.textContent = "";
    return true;
}

function cssUrl(url) {
    return escapeHTML(`url("${String(url).replace(/["\\\n\r()']/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))}")`);
}

// ---------- Painéis de filtros (filmes e livros) ----------
function setupFilterPop(buttonId, popId) {
    const button = $(buttonId);
    const pop = $(popId);
    const close = () => { pop.classList.add("hidden"); button.setAttribute("aria-expanded", "false"); };
    button.addEventListener("click", event => {
        event.stopPropagation();
        const open = pop.classList.contains("hidden");
        document.querySelectorAll(".filter-pop").forEach(p => p.classList.add("hidden"));
        document.querySelectorAll(".filter-button").forEach(b => b.setAttribute("aria-expanded", "false"));
        if (open) {
            pop.classList.remove("hidden");
            button.setAttribute("aria-expanded", "true");
            pop.querySelector("select, button")?.focus();
        }
    });
    document.addEventListener("click", event => {
        if (!pop.classList.contains("hidden") && !pop.contains(event.target) && event.target !== button) close();
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !pop.classList.contains("hidden")) {
            event.stopImmediatePropagation();
            close();
            button.focus();
        }
    }, true);
}

function setFilterCount(id, count) {
    const el = $(id);
    if (!el) return;
    el.textContent = count || "";
    el.classList.toggle("hidden", !count);
    el.closest(".filter-button")?.classList.toggle("has-filters", count > 0);
}

// =====================================================
// SEGURANÇA — validações, senhas vazadas, tentativas, inatividade
// =====================================================

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

// Confere se a senha já apareceu em vazamentos (Have I Been Pwned).
// Só os 5 primeiros caracteres do "resumo" SHA-1 saem do navegador — a senha nunca é enviada.
async function pwnedCount(password) {
    try {
        if (!window.crypto?.subtle) return 0;
        const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
        const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
            signal: controller.signal, referrerPolicy: "no-referrer", credentials: "omit", cache: "no-store"
        });
        clearTimeout(timer);
        if (!response.ok) return 0;
        const suffix = hash.slice(5);
        for (const line of (await response.text()).split("\n")) {
            const [candidate, count] = line.trim().split(":");
            if (candidate === suffix) return Number(count) || 0;
        }
        return 0;
    } catch (error) {
        return 0;   // sem internet ou serviço fora do ar: não bloqueia
    }
}

// Pede a senha atual antes de mudanças sensíveis (senha e e-mail)
async function verifyCurrentPassword(password) {
    if (!currentUserEmail) return false;
    try {
        const { error } = await supabaseClient.auth.signInWithPassword({ email: currentUserEmail, password });
        return !error;
    } catch (error) {
        return false;
    }
}

// ---------- Limite de tentativas de login (neste navegador) ----------
const LOGIN_GUARD_KEY = "trama.loginGuard";
let loginLockTimer = null;

function readLoginGuard() {
    try { return JSON.parse(localStorage.getItem(LOGIN_GUARD_KEY)) || { fails: 0, until: 0 }; }
    catch (e) { return { fails: 0, until: 0 }; }
}

function writeLoginGuard(guard) {
    try { localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify(guard)); } catch (e) { /* sem armazenamento */ }
}

function registerLoginFailure() {
    const guard = readLoginGuard();
    guard.fails = (guard.fails || 0) + 1;
    // A partir da 5ª tentativa errada: 30s, 60s, 120s… (máximo 15 min)
    if (guard.fails >= 5) guard.until = Date.now() + Math.min(900, 30 * 2 ** (guard.fails - 5)) * 1000;
    writeLoginGuard(guard);
}

function resetLoginGuard() {
    writeLoginGuard({ fails: 0, until: 0 });
}

function loginLockRemaining() {
    return Math.max(0, Math.ceil((readLoginGuard().until - Date.now()) / 1000));
}

function startLoginLockCountdown() {
    clearInterval(loginLockTimer);
    const tick = () => {
        const left = loginLockRemaining();
        if (left <= 0) {
            clearInterval(loginLockTimer);
            loginButton.disabled = false;
            loginButton.textContent = t(authMode === "signup" ? "btn.signup" : "btn.login");
            if (loginError.dataset.lock) { loginError.textContent = ""; delete loginError.dataset.lock; }
            return;
        }
        loginButton.disabled = true;
        loginButton.textContent = t("guard.wait", left);
        loginError.textContent = t("guard.locked", left);
        loginError.dataset.lock = "1";
    };
    tick();
    loginLockTimer = setInterval(tick, 1000);
}

// ---------- Saída automática por inatividade ----------
const ACTIVITY_KEY = "trama.lastActivity";
let lastActivityWrite = 0;

function markActivity(force = false) {
    const now = Date.now();
    if (!force && now - lastActivityWrite < 15000) return;
    lastActivityWrite = now;
    try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch (e) { /* sem armazenamento */ }
}

function inactivityExpired() {
    const minutes = Number(prefs.autoLockMin || 0);
    if (!minutes) return false;
    let last = 0;
    try { last = Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch (e) { return false; }
    return Boolean(last) && Date.now() - last > minutes * 60000;
}

["pointerdown", "keydown", "scroll", "touchstart", "mousemove"].forEach(type =>
    window.addEventListener(type, () => { if (currentUserId) markActivity(); }, { passive: true, capture: true }));

setInterval(async () => {
    if (!currentUserId) return;
    // Lendo com o cronômetro ligado não é "inatividade"
    if (typeof isSessionRunning === "function" && isSessionRunning()) { markActivity(true); return; }
    if (!inactivityExpired()) return;
    await supabaseClient.auth.signOut({ scope: "local" });
    loginInfo.textContent = t("auth.autoLogout");
}, 30000);

$("autoLockSelect").addEventListener("change", event => {
    setPref("autoLockMin", Number(event.target.value) || 0);
    markActivity(true);
});

// ---------- Mostrar/ocultar senha e aviso de Caps Lock ----------
document.querySelectorAll("[data-pw-toggle]").forEach(button => {
    button.addEventListener("click", () => {
        const input = button.parentElement.querySelector("input");
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
        const label = t(show ? "pw.hide" : "pw.show");
        button.setAttribute("aria-label", label);
        button.title = label;
        button.setAttribute("aria-pressed", String(show));
        input.focus();
    });
});

["loginPassword", "loginConfirmPassword"].forEach(id => {
    ["keydown", "keyup"].forEach(type => $(id).addEventListener(type, event => {
        if (typeof event.getModifierState !== "function") return;
        $("loginCaps").classList.toggle("hidden", !event.getModifierState("CapsLock"));
    }));
    $(id).addEventListener("blur", () => $("loginCaps").classList.add("hidden"));
});

// ---------- Entrar com link por e-mail (sem senha) ----------
$("magicLinkForm").addEventListener("submit", async event => {
    event.preventDefault();
    loginError.textContent = "";
    loginInfo.textContent = "";

    const email = $("magicEmail").value.trim().toLowerCase();
    if (!isValidEmail(email)) { loginError.textContent = t("auth.invalidEmail"); return; }

    const button = $("magicLinkButton");
    button.disabled = true;
    button.textContent = t("btn.sending");

    try {
        const { error } = await supabaseClient.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false, emailRedirectTo: window.location.origin + window.location.pathname }
        });
        // Mesmo se o e-mail não tiver conta, a resposta é igual (não revela quem é cadastrado)
        if (error && !/signups? not allowed|user not found/i.test(error.message || "")) {
            console.error(error);
            loginError.textContent = t("magic.failed");
            return;
        }
        $("magicLinkForm").reset();
        showOnlyForm("auth");
        loginInfo.textContent = t("magic.sent");
    } catch (error) {
        console.error(error);
        loginError.textContent = t("auth.linkNetwork");
    } finally {
        button.disabled = false;
        button.textContent = t("magic.send");
    }
});

// =====================================================
// TELA DE LOGIN — palco animado (os "fios" da trama)
// =====================================================

let stageTagTimer = null;
let stageClockTimer = null;
let loginThreads = null;
let heroThreads = null;

// Animação dos "fios da trama" — usada no login e no topo de cada aba
function createThreads(canvas, { count = 16, knots = 10, strength = 1 } = {}) {
    const ctx = canvas.getContext("2d");
    const reduce = prefs.reduceMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = null;
    let pointer = { x: -9999, y: -9999 };

    const threads = Array.from({ length: count }, (_, i) => ({
        base: (i + 1) / (count + 1),
        amp: 18 + (i * 37) % 40,
        freq: .0018 + ((i * 13) % 10) / 6000,
        speed: .00025 + ((i * 7) % 10) / 30000,
        phase: i * 1.7,
        hue: i % 3
    }));
    const lights = Array.from({ length: knots }, (_, i) => ({ thread: (i * 5) % count, pos: (i * 0.137) % 1, speed: .00004 + (i % 4) * .00001 }));
    const colors = ["rgba(214,178,122,", "rgba(176,122,79,", "rgba(236,215,173,"];

    const resize = () => {
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, rect.width * ratio);
        canvas.height = Math.max(1, rect.height * ratio);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        if (reduce) draw(4000);
    };

    const yAt = (th, x, time, h) => {
        let y = th.base * h + Math.sin(x * th.freq + time * th.speed + th.phase) * th.amp * Math.min(1, h / 500 + .35)
            + Math.sin(x * th.freq * 2.3 + time * th.speed * 1.6) * th.amp * .35;
        // Os fios se afastam do ponteiro, como se a mão passasse pela trama
        const dx = x - pointer.x, dy = y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 26000) y += (dy >= 0 ? 1 : -1) * (1 - d2 / 26000) * 26;
        return y;
    };

    function draw(time) {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 1;
        for (let x = 0; x < w; x += 46) {
            ctx.strokeStyle = `rgba(214,178,122,${0.045 * strength})`;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        threads.forEach((th, i) => {
            ctx.beginPath();
            for (let x = -10; x <= w + 10; x += 8) {
                const y = yAt(th, x, time, h);
                x === -10 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.strokeStyle = `${colors[th.hue]}${(0.10 + (i % 4) * 0.05) * strength})`;
            ctx.lineWidth = i % 5 === 0 ? 1.6 : 1;
            ctx.stroke();
        });
        lights.forEach(k => {
            const th = threads[k.thread];
            const x = ((k.pos + time * k.speed) % 1) * (w + 40) - 20;
            const y = yAt(th, x, time, h);
            const g = ctx.createRadialGradient(x, y, 0, x, y, 14);
            g.addColorStop(0, "rgba(246,232,200,.95)");
            g.addColorStop(.35, "rgba(214,178,122,.45)");
            g.addColorStop(1, "rgba(214,178,122,0)");
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
        });
        if (!reduce && frame !== null) frame = requestAnimationFrame(draw);
    }

    const host = canvas.parentElement;
    const onMove = event => {
        const rect = canvas.getBoundingClientRect();
        pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        host.style.setProperty("--px", ((event.clientX - rect.left) / rect.width - .5).toFixed(3));
        host.style.setProperty("--py", ((event.clientY - rect.top) / rect.height - .5).toFixed(3));
    };
    const onLeave = () => { pointer = { x: -9999, y: -9999 }; };

    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", resize);
    resize();
    if (reduce) draw(4000);
    else frame = requestAnimationFrame(draw);

    return {
        stop() {
            if (frame) cancelAnimationFrame(frame);
            frame = null;
            host.removeEventListener("pointermove", onMove);
            host.removeEventListener("pointerleave", onLeave);
            window.removeEventListener("resize", resize);
        }
    };
}

function startLoginStage() {
    renderStageExtras();
    if (!loginThreads && $("loginThreads")) loginThreads = createThreads($("loginThreads"));
}

function stopLoginStage() {
    loginThreads?.stop();
    loginThreads = null;
    clearInterval(stageTagTimer);
    clearInterval(stageClockTimer);
}

// Fios no topo da aba visível (só uma animação por vez)
function startHeroThreads(page) {
    heroThreads?.stop();
    heroThreads = null;
    const heroId = { livrosPage: "bookHero", achievementsPage: "achievementsHero", statsPage: "statsHero" }[page];
    const canvas = heroId ? document.querySelector(`#${heroId} .hero-threads`) : null;
    if (canvas && !app.classList.contains("hidden")) heroThreads = createThreads(canvas, { count: 11, knots: 5, strength: .85 });
}

function stopHeroThreads() {
    heroThreads?.stop();
    heroThreads = null;
}

// Frases que se alternam, mini "mapa de leitura" e cronômetro de demonstração
function renderStageExtras() {
    const tagEl = $("stageTagline");
    if (tagEl) {
        let index = 0;
        const show = () => {
            const tags = t("stage.tags");
            if (!Array.isArray(tags)) return;
            tagEl.classList.remove("in");
            void tagEl.offsetWidth;
            tagEl.textContent = tags[index % tags.length];
            tagEl.classList.add("in");
            index++;
        };
        clearInterval(stageTagTimer);
        show();
        stageTagTimer = setInterval(show, 4200);
    }

    const heat = $("stageHeat");
    if (heat && !heat.childElementCount) {
        heat.innerHTML = Array.from({ length: 70 }, (_, i) => {
            const v = (Math.sin(i * 1.7) + Math.sin(i * .37) + 2) / 4;
            const level = v > .78 ? 4 : v > .6 ? 3 : v > .45 ? 2 : v > .3 ? 1 : 0;
            return `<i class="l${level}"></i>`;
        }).join("");
    }

    const clock = $("stageTimer");
    if (clock) {
        let seconds = 24 * 60 + 13;
        clearInterval(stageClockTimer);
        stageClockTimer = setInterval(() => {
            seconds++;
            clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
        }, 1000);
    }
}

// =====================================================
// NAVEGAÇÃO
// =====================================================

const pageHeroes = { livrosPage: bookHero, achievementsPage: $("achievementsHero"), statsPage: statsHero };

function goToPage(page) {
    document.querySelectorAll(".nav-button[data-page]").forEach(item => item.classList.toggle("active", item.dataset.page === page));
    document.querySelectorAll(".page").forEach(p => p.classList.toggle("hidden", p.id !== page));
    Object.entries(pageHeroes).forEach(([key, hero]) => hero.classList.toggle("hidden", key !== page));
    window.scrollTo({ top: 0, behavior: prefs.reduceMotion ? "auto" : "smooth" });
    document.body.dataset.page = page;
    try { localStorage.setItem("trama.lastPage", page); } catch { /* navegação privada */ }
    startHeroThreads(page);
}

function readLastPage() {
    try {
        const page = localStorage.getItem("trama.lastPage");
        return pageHeroes[page] ? page : "livrosPage";
    } catch { return "livrosPage"; }
}

function currentPage() {
    return document.querySelector(".nav-button[data-page].active")?.dataset.page || "livrosPage";
}

document.querySelectorAll(".nav-button[data-page]").forEach(button => {
    button.addEventListener("click", () => goToPage(button.dataset.page));
});

// =====================================================
// TECLADO — Esc e atalhos
// =====================================================

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        // Fecha só a janela que está por cima (ou o menu de ações)
        if (typeof closeBookMenu === "function" && closeBookMenu()) return;
        const open = [...document.querySelectorAll(".modal-overlay.show")];
        const top = open[open.length - 1];
        if (!top) return;
        if (top.id === "accountModal") closeSettings();
        else if (typeof closeBooksOverlay === "function") closeBooksOverlay(top);
        return;
    }

    // Atalhos só funcionam dentro do app, fora de campos de texto e sem janelas abertas
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!currentUserId || document.querySelector(".modal-overlay.show")) return;

    const key = event.key.toLowerCase();

    if (key === "1") goToPage("livrosPage");
    else if (key === "2") goToPage("statsPage");
    else if (key === "3") goToPage("achievementsPage");
    else if (key === ",") openSettings();
    else if (key === "n") {
        event.preventDefault();
        openBookModalForCreate();
    } else if (key === "/") {
        event.preventDefault();
        goToPage("livrosPage");
        setTimeout(() => $("librarySearch").focus(), 50);
    }
});

// =====================================================
// TOAST
// =====================================================

function showToast(message, type = "success") {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// =====================================================
// START — espera books.js carregar antes de iniciar
// =====================================================

document.addEventListener("DOMContentLoaded", init);
