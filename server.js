
const express = require("express");
const session = require("express-session");
const pg = require("pg");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");

const { Pool } = pg;
const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);

if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL. Configúrala en las variables de entorno.");
  process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function many(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

async function run(text, params = []) {
  return query(text, params);
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      cash DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      shares_outstanding BIGINT NOT NULL,
      health DOUBLE PRECISION NOT NULL,
      revenue DOUBLE PRECISION NOT NULL,
      expenses DOUBLE PRECISION NOT NULL,
      debt DOUBLE PRECISION NOT NULL,
      reputation DOUBLE PRECISION NOT NULL,
      growth DOUBLE PRECISION NOT NULL,
      volatility DOUBLE PRECISION NOT NULL,
      sentiment DOUBLE PRECISION NOT NULL DEFAULT 0,
      trend DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS holdings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      shares BIGINT NOT NULL DEFAULT 0,
      avg_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, company_id)
    );

    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
      shares BIGINT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      total DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      price DOUBLE PRECISION NOT NULL,
      volume BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      impact DOUBLE PRECISION NOT NULL,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const companyCount = Number((await one("SELECT COUNT(*)::int AS n FROM companies")).n);
  if (companyCount === 0) {
    const inserted = await many(`
      INSERT INTO companies
        (symbol, name, price, shares_outstanding, health, revenue, expenses, debt, reputation, growth, volatility)
      VALUES
       ('ACME', 'ACME Corporation', 100, 1000000, 72, 12000000, 8500000, 2500000, 78, 0.055, 0.018),
('NEX', 'NEXUS Technologies', 75, 750000, 61, 8000000, 6800000, 4200000, 66, 0.11, 0.035)
      RETURNING id, price
    `);
    for (const c of inserted) {
      await run("INSERT INTO price_history (company_id, price, volume) VALUES ($1, $2, 0)", [c.id, c.price]);
    }
  }

  const adminCount = Number((await one("SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE")).n);
  if (adminCount === 0) {
    const username = process.env.ADMIN_USER || "admin";
    const password = process.env.ADMIN_PASSWORD || "cambiar-esta-clave";
    const hash = bcrypt.hashSync(password, 12);
    await run(
      "INSERT INTO users (username, password_hash, is_admin, cash) VALUES ($1, $2, TRUE, 0)",
      [username, hash]
    );
    console.log(`Administrador inicial: ${username}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log("CONTRASEÑA INICIAL: cambiar-esta-clave");
      console.log("Cámbiala inmediatamente desde el panel de administración.");
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomNormal() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function safeInt(n) {
  return Number.isInteger(n) && n > 0 ? n : 0;
}

async function getUser(userId) {
  return one(`
    SELECT id, username, is_admin, cash, created_at
    FROM users WHERE id = $1
  `, [userId]);
}

async function getCompany(id) {
  return one("SELECT * FROM companies WHERE id = $1", [id]);
}

async function getActiveNews(companyId) {
  return many(`
    SELECT id, title, body, impact, created_at
    FROM news
    WHERE company_id = $1
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY id DESC
    LIMIT 8
  `, [companyId]);
}

async function portfolioForUser(userId) {
  const user = await getUser(userId);
  const rows = await many(`
    SELECT
      h.company_id,
      h.shares,
      h.avg_cost,
      c.symbol,
      c.name,
      c.price,
      ROUND((h.shares * c.price)::numeric, 2)::double precision AS market_value,
      ROUND((h.shares * (c.price - h.avg_cost))::numeric, 2)::double precision AS unrealized
    FROM holdings h
    JOIN companies c ON c.id = h.company_id
    WHERE h.user_id = $1 AND h.shares > 0
    ORDER BY c.symbol
  `, [userId]);

  const stockValue = rows.reduce((sum, r) => sum + Number(r.market_value), 0);
  return {
    cash: roundMoney(user.cash),
    stockValue: roundMoney(stockValue),
    netWorth: roundMoney(Number(user.cash) + stockValue),
    holdings: rows
  };
}

async function marketSnapshot(userId) {
  const companies = await many(`
    SELECT id, symbol, name, price, shares_outstanding, health, revenue, expenses,
           debt, reputation, growth, volatility, sentiment, trend, updated_at
    FROM companies ORDER BY symbol
  `);

  const result = [];
  for (const c of companies) {
    const history = (await many(`
      SELECT price, volume, created_at
      FROM price_history
      WHERE company_id = $1
      ORDER BY id DESC
      LIMIT 120
    `, [c.id])).reverse();

    const holding = await one(`
      SELECT shares, avg_cost FROM holdings
      WHERE user_id = $1 AND company_id = $2
    `, [userId, c.id]) || { shares: 0, avg_cost: 0 };

    const activeNews = await getActiveNews(c.id);
    const latest = history.length > 0 ? Number(history[history.length - 1].price) : Number(c.price);
    const first = history.length > 0 ? Number(history[0].price) : latest;
    const change = latest - first;
    const changePct = first ? (change / first) * 100 : 0;

    result.push({
      ...c,
      price: roundMoney(c.price),
      health: roundMoney(c.health),
      growthPct: roundMoney(c.growth * 100),
      volatilityPct: roundMoney(c.volatility * 100),
      sentiment: roundMoney(c.sentiment),
      trend: roundMoney(c.trend),
      change: roundMoney(change),
      changePct: roundMoney(changePct),
      holding: {
        shares: Number(holding.shares),
        avgCost: roundMoney(holding.avg_cost)
      },
      history: history.map(h => ({ ...h, price: Number(h.price), volume: Number(h.volume) })),
      news: activeNews
    });
  }

  return {
    serverTime: nowIso(),
    companies: result,
    portfolio: await portfolioForUser(userId)
  };
}

async function addNews(companyId, title, body, impact, hours = 24) {
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  await run(`
    INSERT INTO news (company_id, title, body, impact, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [companyId, title, body, clamp(Number(impact), -25, 25), expires]);
}

const genericPositive = [
  ["Resultados mejores de lo esperado", "La empresa publica resultados que superan las expectativas del mercado.", 2.4],
  ["Nuevo contrato importante", "La empresa consigue un contrato que mejora sus perspectivas de crecimiento.", 1.8],
  ["Buenas previsiones", "La dirección mejora sus previsiones para los próximos meses.", 1.4],
  ["Producto bien recibido", "Las primeras señales comerciales del nuevo producto son positivas.", 1.1]
];

const genericNegative = [
  ["Resultados decepcionantes", "Los resultados quedan por debajo de lo que esperaba el mercado.", -2.6],
  ["Problemas de suministro", "La empresa comunica dificultades que pueden aumentar costes y retrasar entregas.", -1.7],
  ["Previsiones recortadas", "La dirección reduce sus previsiones de crecimiento.", -2.0],
  ["Demanda más débil", "Los últimos datos apuntan a una demanda menor de la prevista.", -1.3]
];

async function generateCompanyEvent(company) {
  const chance = Math.random();
  if (chance > 0.055) return;

  const positive = Math.random() < 0.52;
  const pool = positive ? genericPositive : genericNegative;
  const event = pool[Math.floor(Math.random() * pool.length)];

  await addNews(company.id, event[0], `${company.name}: ${event[1]}`, event[2], 12 + Math.random() * 30);

  const healthDelta = positive ? 1 + Math.random() * 2 : -(1 + Math.random() * 2);
  const reputationDelta = positive ? 1 + Math.random() * 2 : -(1 + Math.random() * 2);

  await run(`
    UPDATE companies
    SET health = $1, reputation = $2, sentiment = sentiment + $3
    WHERE id = $4
  `, [
    clamp(Number(company.health) + healthDelta, 1, 99),
    clamp(Number(company.reputation) + reputationDelta, 1, 99),
    event[2],
    company.id
  ]);
}

async function simulateMarketTick() {
  const companies = await many("SELECT * FROM companies");

  for (const company of companies) {
    await generateCompanyEvent(company);

    const current = await getCompany(company.id);
    const activeNews = await getActiveNews(company.id);
    const newsImpact = activeNews.reduce((sum, n) => sum + Number(n.impact), 0);

    const healthPressure = (Number(current.health) - 50) / 50;
    const growthPressure = clamp(Number(current.growth) * 4, -0.5, 0.8);
    const newsPressure = clamp(newsImpact / 20, -1.2, 1.2);
    const sentimentTarget = clamp(newsImpact * 2 + healthPressure * 10, -100, 100);
    const sentiment = clamp(Number(current.sentiment) * 0.97 + sentimentTarget * 0.03, -100, 100);
    const trend = clamp(Number(current.trend) * 0.94 + (healthPressure * 0.02) + (newsPressure * 0.04), -0.15, 0.15);

    const investorBias = clamp(
      0.50
      + healthPressure * 0.13
      + growthPressure * 0.06
      + newsPressure * 0.17
      + sentiment / 100 * 0.10
      + trend * 0.40,
      0.03, 0.97
    );

    const totalOrders = Math.max(40, Math.round(250 + Math.random() * 500));
    const buyOrders = Math.max(0, Math.round(totalOrders * investorBias + randomNormal() * 12));
    const sellOrders = Math.max(0, totalOrders - buyOrders);
    const imbalance = (buyOrders - sellOrders) / Math.max(1, buyOrders + sellOrders);

    const randomShock = randomNormal() * Number(current.volatility);
    const fundamentalMove = healthPressure * 0.0008 + Number(current.growth) * 0.0007;
    const demandMove = imbalance * Number(current.volatility) * 0.95;
    const newsMove = newsPressure * Number(current.volatility) * 0.55;

    const meanReversion = -Math.log(Number(current.price) / 100) * 0.02;

let pctMove =
  fundamentalMove +
  demandMove +
  newsMove +
  trend * 0.10 +
  randomShock +
  meanReversion;

pctMove = clamp(pctMove, -0.09, 0.09);
    console.log("MARKET", current.symbol, "pctMove:", pctMove, "price:", current.price);

    let newPrice = Number(current.price) * (1 + pctMove);
    newPrice = clamp(newPrice, 0.10, 1000000);
    newPrice = roundMoney(newPrice);

    await run(`
      UPDATE companies
      SET price = $1, sentiment = $2, trend = $3, updated_at = $4
      WHERE id = $5
    `, [newPrice, sentiment, trend, nowIso(), current.id]);

    const volume = Math.max(1, Math.round(totalOrders * (0.6 + Math.abs(imbalance) * 0.8)));
    await run(`
      INSERT INTO price_history (company_id, price, volume)
      VALUES ($1, $2, $3)
    `, [current.id, newPrice, volume]);
  }

  await run(`
    DELETE FROM price_history
    WHERE id NOT IN (
      SELECT id FROM price_history
      ORDER BY id DESC LIMIT 5000
    )
  `);
}

let marketTimer = null;
let tickRunning = false;

function scheduleMarketTick() {
  const delay = 1500 + Math.random() * 3500;
  marketTimer = setTimeout(async () => {
    if (!tickRunning) {
      tickRunning = true;
      try {
        await simulateMarketTick();
      } catch (error) {
        console.error("Error en el motor de mercado:", error);
      } finally {
        tickRunning = false;
      }
    }
    scheduleMarketTick();
  }, delay);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "No autorizado." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).json({ error: "Se requiere una cuenta de administrador." });
  }
  next();
}

app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new PgSession({
    pool,
    createTableIfMissing: true
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!username || !password) return res.status(400).json({ error: "Faltan datos." });

    const user = await one("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    req.session.userId = user.id;
    req.session.isAdmin = Boolean(user.is_admin);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno al iniciar sesión." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await getUser(req.session.userId);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado." });
    res.json({
      id: user.id,
      username: user.username,
      isAdmin: Boolean(user.is_admin),
      portfolio: await portfolioForUser(user.id)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo cargar el usuario." });
  }
});

app.get("/api/market", requireAuth, async (req, res) => {
  try {
    res.json(await marketSnapshot(req.session.userId));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo cargar el mercado." });
  }
});

app.post("/api/trade", requireAuth, async (req, res) => {
  const companyId = Number(req.body.companyId);
  const side = String(req.body.side || "").toUpperCase();
  const shares = safeInt(Number(req.body.shares));

  if (!Number.isInteger(companyId) || !["BUY", "SELL"].includes(side) || shares <= 0) {
    return res.status(400).json({ error: "Operación inválida." });
  }

  try {
    await withTransaction(async client => {
      const userResult = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [req.session.userId]);
      const user = userResult.rows[0];
      const companyResult = await client.query("SELECT * FROM companies WHERE id = $1", [companyId]);
      const company = companyResult.rows[0];
      if (!user || !company) throw new Error("Usuario o empresa no encontrados.");

      const price = Number(company.price);
      const total = roundMoney(price * shares);
      const holdingResult = await client.query(`
        SELECT shares, avg_cost FROM holdings
        WHERE user_id = $1 AND company_id = $2
        FOR UPDATE
      `, [user.id, company.id]);
      const holding = holdingResult.rows[0] || { shares: 0, avg_cost: 0 };

      if (side === "BUY") {
        if (total > Number(user.cash) + 0.000001) throw new Error("No tienes suficiente dinero virtual.");

        const newShares = Number(holding.shares) + shares;
        const newAvg = ((Number(holding.shares) * Number(holding.avg_cost)) + total) / newShares;

        await client.query("UPDATE users SET cash = cash - $1 WHERE id = $2", [total, user.id]);
        await client.query(`
          INSERT INTO holdings (user_id, company_id, shares, avg_cost)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT(user_id, company_id)
          DO UPDATE SET shares = EXCLUDED.shares, avg_cost = EXCLUDED.avg_cost
        `, [user.id, company.id, newShares, newAvg]);
      } else {
        if (shares > Number(holding.shares)) throw new Error("No tienes suficientes acciones para vender.");

        const remaining = Number(holding.shares) - shares;
        await client.query("UPDATE users SET cash = cash + $1 WHERE id = $2", [total, user.id]);

        if (remaining === 0) {
          await client.query("DELETE FROM holdings WHERE user_id = $1 AND company_id = $2", [user.id, company.id]);
        } else {
          await client.query("UPDATE holdings SET shares = $1 WHERE user_id = $2 AND company_id = $3", [remaining, user.id, company.id]);
        }
      }

      await client.query(`
        INSERT INTO trades (user_id, company_id, side, shares, price, total)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [user.id, company.id, side, shares, price, total]);
    });

    res.json({ ok: true, market: await marketSnapshot(req.session.userId) });
  } catch (error) {
    res.status(400).json({ error: error.message || "No se pudo completar la operación." });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    res.json(await many(`
      SELECT id, username, is_admin, cash, created_at
      FROM users ORDER BY id
    `));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudieron cargar los usuarios." });
  }
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const cash = Number(req.body.cash || 0);
  const isAdmin = Boolean(req.body.isAdmin);

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: "El usuario debe tener 3-32 caracteres y usar letras, números, _, . o -." });
  }
  if (password.length < 10) return res.status(400).json({ error: "La contraseña debe tener al menos 10 caracteres." });
  if (!Number.isFinite(cash) || cash < 0 || cash > 1000000000) {
    return res.status(400).json({ error: "Cantidad de dinero no válida." });
  }

  try {
    const hash = bcrypt.hashSync(password, 12);
    await run(`
      INSERT INTO users (username, password_hash, is_admin, cash)
      VALUES ($1, $2, $3, $4)
    `, [username, hash, isAdmin, roundMoney(cash)]);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Ese nombre de usuario ya existe." });
    console.error(error);
    res.status(500).json({ error: "No se pudo crear el usuario." });
  }
});

app.post("/api/admin/users/:id/cash", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const amount = Number(req.body.amount);

  if (!Number.isInteger(userId) || !Number.isFinite(amount)) return res.status(400).json({ error: "Datos inválidos." });

  try {
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    await run("UPDATE users SET cash = cash + $1 WHERE id = $2", [roundMoney(amount), userId]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo actualizar el dinero." });
  }
});

app.post("/api/admin/users/:id/password", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const password = String(req.body.password || "");

  if (!Number.isInteger(userId) || password.length < 10) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 10 caracteres." });
  }

  try {
    if (!await getUser(userId)) return res.status(404).json({ error: "Usuario no encontrado." });
    const hash = bcrypt.hashSync(password, 12);
    await run("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, userId]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo cambiar la contraseña." });
  }
});

app.post("/api/admin/news", requireAdmin, async (req, res) => {
  const companyId = Number(req.body.companyId);
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();
  const impact = Number(req.body.impact);
  const hours = Number(req.body.hours || 24);

  try {
    if (!Number.isInteger(companyId) || !await getCompany(companyId)) {
      return res.status(400).json({ error: "Empresa inválida." });
    }
    if (!title || !body || title.length > 100 || body.length > 500) {
      return res.status(400).json({ error: "Título o texto de noticia inválido." });
    }
    if (!Number.isFinite(impact) || impact < -25 || impact > 25) {
      return res.status(400).json({ error: "El impacto debe estar entre -25 y 25." });
    }
    await addNews(companyId, title, body, impact, clamp(hours, 1, 168));
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo publicar la noticia." });
  }
});

app.post("/api/admin/reset-market", requireAdmin, async (req, res) => {
  try {
    await withTransaction(async client => {
      const companies = (await client.query("SELECT id, symbol FROM companies")).rows;
      const defaults = {
        ACME: { price: 100, health: 72, reputation: 78, sentiment: 0, trend: 0 },
        NEX: { price: 75, health: 61, reputation: 66, sentiment: 0, trend: 0 }
      };

      for (const c of companies) {
        const d = defaults[c.symbol];
        if (!d) continue;

        await client.query(`
          UPDATE companies
          SET price = $1, health = $2, reputation = $3, sentiment = $4, trend = $5, updated_at = $6
          WHERE id = $7
        `, [d.price, d.health, d.reputation, d.sentiment, d.trend, nowIso(), c.id]);

        await client.query("DELETE FROM price_history WHERE company_id = $1", [c.id]);
        await client.query("DELETE FROM news WHERE company_id = $1", [c.id]);
        await client.query("INSERT INTO price_history (company_id, price, volume) VALUES ($1, $2, 0)", [c.id, d.price]);
      }

      await client.query("DELETE FROM holdings");
      await client.query("DELETE FROM trades");
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo reiniciar el mercado." });
  }
});

app.get("/api/admin/trades", requireAdmin, async (req, res) => {
  try {
    res.json(await many(`
      SELECT
        t.id, u.username, c.symbol, t.side, t.shares, t.price, t.total, t.created_at
      FROM trades t
      JOIN users u ON u.id = t.user_id
      JOIN companies c ON c.id = t.company_id
      ORDER BY t.id DESC
      LIMIT 100
    `));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudieron cargar las operaciones." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  await initDatabase();
  scheduleMarketTick();
  app.listen(PORT, () => console.log(`Bolsa privada funcionando en puerto ${PORT}`));
}

start().catch(error => {
  console.error("No se pudo iniciar la aplicación:", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  clearTimeout(marketTimer);
  await pool.end();
  process.exit(0);
});
