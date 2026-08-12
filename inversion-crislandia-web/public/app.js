const $ = (id) => document.getElementById(id);

let me = null;
let market = null;
let marketTimer = null;
let selectedCompanyId = null;

function money(n) {
  return Number(n || 0).toLocaleString("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2
  });
}

function number(n) {
  return Number(n || 0).toLocaleString("es-ES", {
    maximumFractionDigits: 2
  });
}

function pct(n) {
  const value = Number(n || 0);
  return `${value >= 0 ? "+" : ""}${value.toFixed(2).replace(".", ",")}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  let data = {};
  try { data = await response.json(); } catch (_) {}

  if (!response.ok) {
    if (response.status === 401) {
      showLogin();
    }
    throw new Error(data.error || "Ha ocurrido un error.");
  }
  return data;
}

function showLogin() {
  $("loginView").classList.remove("hidden");
  $("appView").classList.add("hidden");
  $("adminView").classList.add("hidden");
  clearInterval(marketTimer);
}

function showApp() {
  $("loginView").classList.add("hidden");
  $("adminView").classList.add("hidden");
  $("appView").classList.remove("hidden");
}

function drawChart(canvas, history) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, Math.floor(rect.width * dpr));
  canvas.height = Math.max(180, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  if (!history || history.length < 2) return;

  const prices = history.map(x => Number(x.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = Math.max((max - min) * 0.12, max * 0.002, 0.01);
  const lo = min - pad;
  const hi = max + pad;

  ctx.strokeStyle = "rgba(148,163,184,.12)";
  ctx.lineWidth = 1;

  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.beginPath();
  prices.forEach((price, i) => {
    const x = (i / (prices.length - 1)) * w;
    const y = h - ((price - lo) / (hi - lo)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = prices[prices.length - 1] >= prices[0] ? "#45d483" : "#ff6b78";
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

function renderMarket() {
  if (!market) return;
  if (
  selectedCompanyId === null ||
  !market.companies.some(c => c.id === selectedCompanyId)
) {
  selectedCompanyId = market.companies[0]?.id ?? null;
}

  $("cashValue").textContent = money(market.portfolio.cash);
  $("stockValue").textContent = money(market.portfolio.stockValue);
  $("netWorthValue").textContent = money(market.portfolio.netWorth);
  $("marketTime").textContent = `Servidor: ${new Date(market.serverTime).toLocaleTimeString("es-ES")}`;

  const selectedCompany = market.companies.find(c => c.id === selectedCompanyId);

$("companyTabs").innerHTML = market.companies.map(c => `
  <button
    class="company-tab ${c.id === selectedCompanyId ? "active" : ""}"
    data-id="${c.id}"
  >
    ${escapeHtml(c.symbol)}
  </button>
`).join("");

$("companies").innerHTML = selectedCompany ? [selectedCompany].map(c => {
    const changeClass = c.changePct >= 0 ? "up" : "down";
    const newsHtml = c.news.length
      ? c.news.map(n => `
          <div class="news-item">
            <strong>${escapeHtml(n.title)}</strong>
            <span>${escapeHtml(n.body)} · impacto ${pct(n.impact)}</span>
          </div>
        `).join("")
      : `<div class="news-item"><span>Sin noticias recientes.</span></div>`;

    return `
      <article class="company-card">
        <div class="company-top">
          <div>
            <div class="company-symbol">${escapeHtml(c.symbol)}</div>
            <div class="company-name">${escapeHtml(c.name)}</div>
            <div class="price">${money(c.price)}</div>
          </div>
          <div class="change ${changeClass}">
            ${pct(c.changePct)}
          </div>
        </div>

        <div class="chart-wrap">
          <canvas class="price-chart" data-company="${c.id}"></canvas>
        </div>

        <div class="company-info">
          <div class="metric"><small>Salud</small><strong>${number(c.health)}/100</strong></div>
          <div class="metric"><small>Crecimiento</small><strong>${pct(c.growthPct)}</strong></div>
          <div class="metric"><small>Volatilidad</small><strong>${pct(c.volatilityPct)}</strong></div>
          <div class="metric"><small>Tus acciones</small><strong>${number(c.holding.shares)}</strong></div>
          <div class="metric"><small>Precio medio</small><strong>${money(c.holding.avgCost)}</strong></div>
          <div class="metric"><small>Tendencia</small><strong>${number(c.trend)}</strong></div>
        </div>

        <div class="trade-box">
          <div class="trade-controls">
            <input id="shares-${c.id}" type="number" min="1" step="1" value="1" aria-label="Cantidad de acciones">
            <button class="primary buy-btn" data-id="${c.id}">Comprar</button>
            <button class="secondary sell-btn" data-id="${c.id}">Vender</button>
          </div>
          <p class="trade-summary">Coste estimado: <strong id="estimate-${c.id}">${money(c.price)}</strong></p>
        </div>

        <div class="news-list">
          ${newsHtml}
        </div>
      </article>
    `;
  }).join("");

  document.querySelectorAll(".company-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    selectedCompanyId = Number(btn.dataset.id);
    renderMarket();
  });
});
  for (const c of market.companies) {
    const input = $(`shares-${c.id}`);
    const estimate = $(`estimate-${c.id}`);
    input.addEventListener("input", () => {
      const shares = Math.max(0, Number(input.value || 0));
      estimate.textContent = money(shares * c.price);
    });
  }

  document.querySelectorAll(".price-chart").forEach(canvas => {
    const id = Number(canvas.dataset.company);
    const company = market.companies.find(c => c.id === id);
    drawChart(canvas, company.history);
  });

  document.querySelectorAll(".buy-btn").forEach(btn => {
    btn.addEventListener("click", () => trade(Number(btn.dataset.id), "BUY"));
  });
  document.querySelectorAll(".sell-btn").forEach(btn => {
    btn.addEventListener("click", () => trade(Number(btn.dataset.id), "SELL"));
  });

  renderPortfolio();
}

function renderPortfolio() {
  const rows = market.portfolio.holdings;

  if (!rows.length) {
    $("portfolioTable").innerHTML = `<p class="muted">Todavía no tienes acciones. La bolsa, por una vez, no puede acusarte de especular.</p>`;
    return;
  }

  $("portfolioTable").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Empresa</th>
          <th>Acciones</th>
          <th>Precio medio</th>
          <th>Precio actual</th>
          <th>Valor</th>
          <th>Resultado</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><strong>${escapeHtml(r.symbol)}</strong> · ${escapeHtml(r.name)}</td>
            <td>${number(r.shares)}</td>
            <td>${money(r.avg_cost)}</td>
            <td>${money(r.price)}</td>
            <td>${money(r.market_value)}</td>
            <td class="${r.unrealized >= 0 ? "up" : "down"}">${money(r.unrealized)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function trade(companyId, side) {
  const input = $(`shares-${companyId}`);
  const shares = Number(input.value);

  if (!Number.isInteger(shares) || shares <= 0) {
    showToast("Introduce una cantidad válida de acciones.");
    return;
  }

  try {
    const data = await api("/api/trade", {
      method: "POST",
      body: JSON.stringify({ companyId, side, shares })
    });
    market = data.market;
    renderMarket();
    showToast(side === "BUY" ? "Compra realizada." : "Venta realizada.");
  } catch (error) {
    showToast(error.message);
  }
}

async function loadMarket() {
  try {
    market = await api("/api/market");
    renderMarket();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadMe() {
  try {
    me = await api("/api/me");
    $("userLabel").textContent = me.username;
    $("adminButton").classList.toggle("hidden", !me.isAdmin);
    showApp();
    await loadMarket();
    clearInterval(marketTimer);
    marketTimer = setInterval(loadMarket, 2200);
  } catch (_) {
    showLogin();
  }
}

async function login(event) {
  event.preventDefault();
  $("loginError").textContent = "";

  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("loginUsername").value,
        password: $("loginPassword").value
      })
    });
    $("loginPassword").value = "";
    await loadMe();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

async function logout() {
  try { await api("/api/logout", { method: "POST" }); } catch (_) {}
  me = null;
  market = null;
  showLogin();
}

async function openAdmin() {
  $("appView").classList.add("hidden");
  $("adminView").classList.remove("hidden");
  await Promise.all([loadUsers(), loadTrades()]);
  populateNewsCompanies();
}

async function loadUsers() {
  try {
    const users = await api("/api/admin/users");
    $("usersTable").innerHTML = `
      <table>
        <thead><tr><th>Usuario</th><th>Rol</th><th>Dinero</th><th>Añadir/restar dinero</th><th>Contraseña</th></tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${escapeHtml(u.username)}</td>
              <td>${u.is_admin ? "Admin" : "Usuario"}</td>
              <td>${money(u.cash)}</td>
              <td>
                <button class="secondary cash-btn" data-id="${u.id}">Modificar</button>
              </td>
              <td>
                <button class="secondary pass-btn" data-id="${u.id}">Cambiar</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    document.querySelectorAll(".cash-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const amount = Number(prompt("Cantidad a añadir/restar. Usa negativo para quitar dinero:"));
        if (!Number.isFinite(amount)) return;
        try {
          await api(`/api/admin/users/${btn.dataset.id}/cash`, {
            method: "POST",
            body: JSON.stringify({ amount })
          });
          await loadUsers();
          showToast("Dinero actualizado.");
        } catch (error) {
          showToast(error.message);
        }
      });
    });

    document.querySelectorAll(".pass-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const password = prompt("Nueva contraseña (mínimo 10 caracteres):");
        if (password === null) return;
        try {
          await api(`/api/admin/users/${btn.dataset.id}/password`, {
            method: "POST",
            body: JSON.stringify({ password })
          });
          showToast("Contraseña actualizada.");
        } catch (error) {
          showToast(error.message);
        }
      });
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function loadTrades() {
  try {
    const trades = await api("/api/admin/trades");
    $("tradesTable").innerHTML = `
      <table>
        <thead><tr><th>Hora</th><th>Usuario</th><th>Empresa</th><th>Tipo</th><th>Acciones</th><th>Precio</th><th>Total</th></tr></thead>
        <tbody>
          ${trades.map(t => `
            <tr>
              <td>${new Date(t.created_at).toLocaleString("es-ES")}</td>
              <td>${escapeHtml(t.username)}</td>
              <td>${escapeHtml(t.symbol)}</td>
              <td class="${t.side === "BUY" ? "up" : "down"}">${t.side === "BUY" ? "Compra" : "Venta"}</td>
              <td>${number(t.shares)}</td>
              <td>${money(t.price)}</td>
              <td>${money(t.total)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (error) {
    showToast(error.message);
  }
}

function populateNewsCompanies() {
  if (!market) return;
  $("newsCompany").innerHTML = market.companies.map(c =>
    `<option value="${c.id}">${escapeHtml(c.symbol)} · ${escapeHtml(c.name)}</option>`
  ).join("");
}

async function createUser(event) {
  event.preventDefault();
  try {
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username: $("newUsername").value.trim(),
        password: $("newPassword").value,
        cash: Number($("newCash").value),
        isAdmin: $("newIsAdmin").checked
      })
    });
    event.target.reset();
    $("newCash").value = "10000";
    await loadUsers();
    showToast("Usuario creado.");
  } catch (error) {
    showToast(error.message);
  }
}

async function createNews(event) {
  event.preventDefault();
  try {
    await api("/api/admin/news", {
      method: "POST",
      body: JSON.stringify({
        companyId: Number($("newsCompany").value),
        title: $("newsTitle").value.trim(),
        body: $("newsBody").value.trim(),
        impact: Number($("newsImpact").value),
        hours: Number($("newsHours").value)
      })
    });
    event.target.reset();
    $("newsImpact").value = "2";
    $("newsHours").value = "24";
    showToast("Noticia publicada.");
    await loadMarket();
  } catch (error) {
    showToast(error.message);
  }
}

async function resetMarket() {
  const answer = prompt('Escribe "REINICIAR" para confirmar. Esto borra carteras y operaciones.');
  if (answer !== "REINICIAR") return;

  try {
    await api("/api/admin/reset-market", { method: "POST" });
    await loadUsers();
    await loadTrades();
    await loadMarket();
    showToast("Mercado reiniciado.");
  } catch (error) {
    showToast(error.message);
  }
}

$("loginForm").addEventListener("submit", login);
$("logoutButton").addEventListener("click", logout);
$("adminButton").addEventListener("click", openAdmin);
$("closeAdminButton").addEventListener("click", async () => {
  $("adminView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  await loadMarket();
});
$("createUserForm").addEventListener("submit", createUser);
$("newsForm").addEventListener("submit", createNews);
$("resetMarketButton").addEventListener("click", resetMarket);

loadMe();
