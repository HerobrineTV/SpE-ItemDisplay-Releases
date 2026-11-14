const SESSION_DAYS = 30;
const GROUP_NEEDS = { force_battle: "force_item_battle", bingo_options: "item_bingo" };
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function signToken(env, payload) {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET, "sign"), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

async function readToken(env, token) {
  const [body, signature] = (token || "").split(".");
  if (!body || !signature) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET, "verify"), fromBase64url(signature), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

async function currentUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const payload = await readToken(env, header.slice(7));
  if (!payload) return null;
  // The role comes from the database on every request, so a removed admin loses access at once
  return env.DB.prepare("SELECT id, username, display_name, avatar, role, multi_submit FROM users WHERE id = ?").bind(payload.sub).first();
}

function requireUser(user) {
  if (!user) throw new HttpError(401, "Bitte zuerst mit Discord einloggen.");
}

function requireAdmin(user) {
  requireUser(user);
  if (user.role !== "admin") throw new HttpError(403, "Nur für Admins.");
}

async function ownerId(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'owner_id'").first();
  return row ? row.value : null;
}

function cookie(request, name) {
  const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? match[1] : null;
}

function login(request, env) {
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${url.origin}/auth/callback`,
    scope: "identify",
    state,
  });
  // The page to come back to is only ever a voting number, never a free URL
  const target = ["voting", "poll"].map((key) => [key, url.searchParams.get(key)]).find(([, value]) => /^\d+$/.test(value || ""));
  const headers = new Headers({ Location: authorize.toString() });
  headers.append("Set-Cookie", `oauth_state=${state}.${target ? `${target[0]}-${target[1]}` : ""}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`);
  return new Response(null, { status: 302, headers });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const [state, target] = (cookie(request, "oauth_state") || "").split(".");
  const code = url.searchParams.get("code");
  if (!state || !code || url.searchParams.get("state") !== state) {
    return Response.redirect(`${env.SITE_URL}#login-error`, 302);
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  if (!tokenResponse.ok) return Response.redirect(`${env.SITE_URL}#login-error`, 302);
  const { access_token: accessToken } = await tokenResponse.json();

  const meResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!meResponse.ok) return Response.redirect(`${env.SITE_URL}#login-error`, 302);
  const me = await meResponse.json();

  // Discord names can be given up and taken by someone else, so the account which first
  // logs in with the owner name is pinned by its id.
  let owner = await ownerId(env);
  if (!owner && me.username === env.OWNER_USERNAME && (me.discriminator === "0" || !me.discriminator)) {
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('owner_id', ?)").bind(me.id).run();
    owner = await ownerId(env);
  }
  const role = owner === me.id ? "admin" : "user";
  await env.DB.prepare(
    `INSERT INTO users (id, username, display_name, avatar, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(id) DO UPDATE SET username = ?2, display_name = ?3, avatar = ?4,
       role = CASE WHEN ?5 = 'admin' THEN 'admin' ELSE users.role END`
  ).bind(me.id, me.username, me.global_name || null, me.avatar || null, role, Date.now()).run();

  const token = await signToken(env, { sub: me.id, exp: Date.now() + SESSION_DAYS * 86400000 });
  const query = /^(voting|poll)-\d+$/.test(target || "") ? `?${target.replace("-", "=")}` : "";
  const headers = new Headers({ Location: `${env.SITE_URL}${query}#token=${token}` });
  headers.append("Set-Cookie", "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0");
  return new Response(null, { status: 302, headers });
}

function text(value, field, max, { required = false } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new HttpError(400, `${field} fehlt.`);
  if (result.length > max) throw new HttpError(400, `${field} ist zu lang (max. ${max} Zeichen).`);
  return result;
}

function integer(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new HttpError(400, `${field} ist ungültig.`);
  return value;
}

function checkConfig(config) {
  const toggles = config && config.toggles;
  if (!toggles || typeof toggles !== "object" || Array.isArray(toggles)) throw new HttpError(400, "Ungültige Konfiguration.");
  const entries = Object.entries(toggles);
  if (entries.length === 0 || entries.length > 200) throw new HttpError(400, "Ungültige Konfiguration.");
  const clean = {};
  for (const [id, entry] of entries) {
    if (!/^[a-z0-9_]{1,64}$/.test(id) || !entry || typeof entry.value !== "boolean") throw new HttpError(400, "Ungültige Konfiguration.");
    const item = { value: entry.value };
    for (const key of ["setAmount", "currentMode"]) {
      if (entry[key] === undefined) continue;
      if (!Number.isInteger(entry[key]) || entry[key] < 0 || entry[key] > 100000) throw new HttpError(400, "Ungültige Konfiguration.");
      item[key] = entry[key];
    }
    clean[id] = item;
  }
  return { toggles: clean, starter_kit: checkKit(config.starter_kit) };
}

function checkKit(kit) {
  if (kit === undefined) return [];
  if (!Array.isArray(kit) || kit.length > 36) throw new HttpError(400, "Ungültiges Starter Kit.");
  const id = /^[a-z0-9_]{1,64}$/;
  const slots = new Set();
  return kit.map((item) => {
    const valid = item && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36 && !slots.has(item.slot)
      && id.test(item.type || "") && Number.isInteger(item.amount) && item.amount >= 1 && item.amount <= 99;
    if (!valid) throw new HttpError(400, "Ungültiges Starter Kit.");
    slots.add(item.slot);
    const clean = { slot: item.slot, type: item.type, amount: item.amount };
    const name = text(item.name, "Item-Name", 50);
    if (name) clean.name = name;
    const enchantments = Object.entries(item.enchantments || {});
    if (enchantments.length) {
      if (enchantments.length > 40 || !enchantments.every(([key, level]) => id.test(key) && Number.isInteger(level) && level >= 1 && level <= 255)) {
        throw new HttpError(400, "Ungültiges Starter Kit.");
      }
      clean.enchantments = Object.fromEntries(enchantments);
    }
    if (item.potion !== undefined) {
      if (!id.test(item.potion)) throw new HttpError(400, "Ungültiges Starter Kit.");
      clean.potion = item.potion;
    }
    return clean;
  });
}

async function authorsByProposal(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.proposal_id, u.id, u.username, u.display_name FROM proposal_authors a
     JOIN users u ON u.id = a.user_id ORDER BY a.created_at, a.rowid`
  ).all();
  const authors = {};
  for (const row of results) {
    (authors[row.proposal_id] ||= []).push({ id: row.id, name: row.display_name || row.username });
  }
  return authors;
}

function proposalRow(row, authors) {
  const list = authors[row.id] || [];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: JSON.parse(row.config),
    created_at: row.created_at,
    authors: list,
    author: list.map((item) => item.name).join(", ") || "Unbekannt",
  };
}

const PROPOSAL_SELECT = "SELECT p.* FROM proposals p";

async function listProposals(env) {
  const { results } = await env.DB.prepare(`${PROPOSAL_SELECT} ORDER BY p.id DESC`).all();
  const authors = await authorsByProposal(env);
  return results.map((row) => proposalRow(row, authors));
}

async function loadCatalog(env) {
  const response = await fetch(`${env.SITE_URL}catalog.json`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new HttpError(503, "Der Challenge-Katalog ist gerade nicht erreichbar.");
  return (await response.json()).toggles;
}

// What the challenge really plays like: name, description and values of switched off
// or unused options don't make two setups different.
function setupKey(config, catalog) {
  const entryOf = (id) => config.toggles[id] || {};
  const isOn = (toggle) => entryOf(toggle.id).value ?? toggle.value;
  const byId = Object.fromEntries(catalog.map((toggle) => [toggle.id, toggle]));
  const parts = [];
  for (const toggle of [...catalog].sort((a, b) => a.id.localeCompare(b.id))) {
    const onlyForce = [toggle.lore1, toggle.lore2].some((line) => /ForceItemBattle Only/i.test(line || ""));
    const needed = GROUP_NEEDS[toggle.group] || (onlyForce ? "force_item_battle" : null);
    if (needed && byId[needed] && !isOn(byId[needed])) continue;
    if (!isOn(toggle)) continue;
    const entry = entryOf(toggle.id);
    parts.push([toggle.id, toggle.hasAmount ? entry.setAmount ?? toggle.setAmount : "", toggle.modes ? entry.currentMode ?? toggle.currentMode : ""].join(":"));
  }
  if (byId.starter_kit && isOn(byId.starter_kit)) {
    const kit = [...(config.starter_kit || [])].sort((a, b) => a.slot - b.slot)
      .map((item) => [item.slot, item.type, item.amount, item.name || "", Object.entries(item.enchantments || {}).sort(), item.potion || ""]);
    parts.push(JSON.stringify(kit));
  }
  return parts.join("|");
}

// The calendar week, Monday to Sunday in German time
function weekKey(time) {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(time).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

async function usedWeeklySubmission(env, user) {
  const { results } = await env.DB.prepare("SELECT created_at FROM proposal_authors WHERE user_id = ? AND created_at > ?")
    .bind(user.id, Date.now() - 8 * 86400000).all();
  const thisWeek = weekKey(Date.now());
  return results.some((row) => weekKey(row.created_at) === thisWeek);
}

async function submitProposal(env, user, body) {
  requireUser(user);
  const name = text(body.name, "Name", 64, { required: true });
  const description = text(body.description, "Beschreibung", 1000);
  const config = checkConfig(body.config);
  // Only admins may submit a challenge which keeps the server running
  if (user.role !== "admin") config.toggles.auto_stop = { value: true };

  const catalog = await loadCatalog(env);
  const key = setupKey(config, catalog);
  const { results } = await env.DB.prepare("SELECT id, config FROM proposals ORDER BY id").all();
  const existing = results.find((row) => setupKey(JSON.parse(row.config), catalog) === key);

  if (existing && (await env.DB.prepare("SELECT 1 FROM proposal_authors WHERE proposal_id = ? AND user_id = ?").bind(existing.id, user.id).first())) {
    throw new HttpError(409, "Genau dieses Setup hast du schon vorgeschlagen.");
  }
  if (!user.multi_submit && (await usedWeeklySubmission(env, user))) {
    throw new HttpError(429, "Du hast diese Woche schon etwas eingereicht. Ab Montag geht es wieder.");
  }

  const now = Date.now();
  if (existing) {
    await env.DB.prepare("INSERT INTO proposal_authors (proposal_id, user_id, created_at) VALUES (?, ?, ?)").bind(existing.id, user.id, now).run();
    return { id: existing.id, merged: true };
  }
  const row = await env.DB.prepare(
    "INSERT INTO proposals (author_id, name, description, config, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).bind(user.id, name, description, JSON.stringify(config), now).first();
  await env.DB.prepare("INSERT INTO proposal_authors (proposal_id, user_id, created_at) VALUES (?, ?, ?)").bind(row.id, user.id, now).run();
  return { id: row.id, merged: false };
}

async function deleteProposal(env, user, id) {
  requireUser(user);
  if (!(await env.DB.prepare("SELECT 1 FROM proposals WHERE id = ?").bind(id).first())) throw new HttpError(404, "Vorschlag nicht gefunden.");
  const isAuthor = await env.DB.prepare("SELECT 1 FROM proposal_authors WHERE proposal_id = ? AND user_id = ?").bind(id, user.id).first();
  if (!isAuthor && user.role !== "admin") throw new HttpError(403, "Nicht erlaubt.");
  const used = await env.DB.prepare(
    "SELECT 1 FROM voting_options o JOIN votings v ON v.id = o.voting_id WHERE o.proposal_id = ? AND v.status = 'open'"
  ).bind(id).first();
  if (used) throw new HttpError(409, "Der Vorschlag ist gerade im Voting.");

  // Someone who only co-proposed withdraws their name, the proposal stays for the others
  if (user.role !== "admin") {
    await env.DB.prepare("DELETE FROM proposal_authors WHERE proposal_id = ? AND user_id = ?").bind(id, user.id).run();
    const left = await env.DB.prepare("SELECT 1 FROM proposal_authors WHERE proposal_id = ?").bind(id).first();
    if (left) return { ok: true, withdrawn: true };
  }
  await env.DB.prepare("DELETE FROM proposals WHERE id = ?").bind(id).run();
  return { ok: true, withdrawn: false };
}

async function votingDetails(env, voting, user) {
  if (!voting) return null;
  const { results } = await env.DB.prepare(
    `${PROPOSAL_SELECT} JOIN voting_options o ON o.proposal_id = p.id WHERE o.voting_id = ? ORDER BY p.id`
  ).bind(voting.id).all();
  const { results: counts } = await env.DB.prepare(
    "SELECT proposal_id, COUNT(*) AS votes FROM votes WHERE voting_id = ? GROUP BY proposal_id"
  ).bind(voting.id).all();
  const countById = Object.fromEntries(counts.map((row) => [row.proposal_id, row.votes]));
  const authors = await authorsByProposal(env);
  let myVote = null;
  if (user) {
    const row = await env.DB.prepare("SELECT proposal_id FROM votes WHERE voting_id = ? AND user_id = ?").bind(voting.id, user.id).first();
    myVote = row ? row.proposal_id : null;
  }
  return {
    ...voting,
    my_vote: myVote,
    options: results.map((row) => ({ ...proposalRow(row, authors), votes: countById[row.id] || 0 })),
  };
}

async function listEvents(env) {
  const { results } = await env.DB.prepare("SELECT * FROM events ORDER BY date, id").all();
  return results;
}

async function state(env, user) {
  const open = await env.DB.prepare("SELECT * FROM votings WHERE status = 'open'").first();
  const latest = open || (await env.DB.prepare("SELECT * FROM votings ORDER BY id DESC LIMIT 1").first());
  return {
    user,
    is_owner: user ? user.id === (await ownerId(env)) : false,
    can_submit: user ? Boolean(user.multi_submit) || !(await usedWeeklySubmission(env, user)) : false,
    events: await listEvents(env),
    day_polls: await listDayPolls(env),
    proposals: await listProposals(env),
    voting: await votingDetails(env, latest, user),
  };
}

async function notifyDiscord(env, eventType, payload) {
  if (!env.GITHUB_DISPATCH_TOKEN) return false;
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "spe-challenges-api",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });
  return response.ok;
}

const ROUND_MINUTES = 90;
const STEP_MINUTES = 15;
const DAY_MINUTES = 1440;

function berlinToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(Date.now());
}

function clockTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// The block in which the most people have the complete 90 minutes, the earliest one on a tie
function bestWindow(responses) {
  const free = responses.filter((response) => response.available);
  let best = null;
  for (let start = 0; start + ROUND_MINUTES <= DAY_MINUTES; start += STEP_MINUTES) {
    const fits = free.filter((response) => response.start <= start && response.end >= start + ROUND_MINUTES);
    if (fits.length && (!best || fits.length > best.user_ids.length)) {
      best = { start, end: start + ROUND_MINUTES, user_ids: fits.map((response) => response.user_id) };
    }
  }
  return best;
}

async function pollDetails(env, poll) {
  const { results } = await env.DB.prepare(
    `SELECT r.user_id, r.available, r.start_min, r.end_min, u.username, u.display_name
     FROM day_poll_responses r JOIN users u ON u.id = r.user_id WHERE r.poll_id = ? ORDER BY r.updated_at`
  ).bind(poll.id).all();
  const responses = results.map((row) => ({
    user_id: row.user_id,
    name: row.display_name || row.username,
    available: Boolean(row.available),
    start: row.start_min,
    end: row.end_min,
  }));
  return { ...poll, responses, best: bestWindow(responses) };
}

async function listDayPolls(env) {
  const { results } = await env.DB.prepare("SELECT * FROM day_polls WHERE status = 'open' OR date >= ? ORDER BY date, id").bind(berlinToday()).all();
  return Promise.all(results.map((poll) => pollDetails(env, poll)));
}

async function startDayPoll(env, user, body) {
  requireAdmin(user);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") || Number.isNaN(Date.parse(body.date))) throw new HttpError(400, "Ungültiges Datum.");
  if (body.date < berlinToday()) throw new HttpError(400, "Das Datum liegt in der Vergangenheit.");
  const title = text(body.title, "Titel", 80);
  let poll;
  try {
    poll = await env.DB.prepare("INSERT INTO day_polls (date, title, started_by, created_at) VALUES (?, ?, ?, ?) RETURNING id").bind(body.date, title, user.id, Date.now()).first();
  } catch {
    throw new HttpError(409, "Für diesen Tag läuft bereits eine Terminabstimmung.");
  }
  return { id: poll.id, notified: await notifyDiscord(env, "day-poll-started", { poll_id: poll.id, date: body.date }).catch(() => false) };
}

async function respondDayPoll(env, user, id, body) {
  requireUser(user);
  if (!(await env.DB.prepare("SELECT id FROM day_polls WHERE id = ? AND status = 'open'").bind(id).first())) throw new HttpError(409, "Diese Terminabstimmung ist beendet.");
  let start = null;
  let end = null;
  if (body.available === true) {
    ({ start, end } = body);
    const valid = [start, end].every((value) => Number.isInteger(value) && value >= 0 && value <= DAY_MINUTES && value % STEP_MINUTES === 0);
    if (!valid) throw new HttpError(400, "Ungültige Uhrzeit.");
    if (end - start < ROUND_MINUTES) throw new HttpError(400, "Du brauchst mindestens 90 Minuten Zeit am Stück, so lange dauert eine Runde.");
  }
  await env.DB.prepare(
    `INSERT INTO day_poll_responses (poll_id, user_id, available, start_min, end_min, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(poll_id, user_id) DO UPDATE SET available = ?3, start_min = ?4, end_min = ?5, updated_at = ?6`
  ).bind(id, user.id, body.available === true ? 1 : 0, start, end, Date.now()).run();
  return { ok: true };
}

async function closeDayPoll(env, user, id) {
  requireAdmin(user);
  const poll = await env.DB.prepare("SELECT * FROM day_polls WHERE id = ? AND status = 'open'").bind(id).first();
  if (!poll) throw new HttpError(404, "Diese Terminabstimmung läuft nicht.");
  const { best } = await pollDetails(env, poll);
  if (!best) throw new HttpError(409, "Noch hat niemand Zeit eingetragen.");
  const time = clockTime(best.start);
  const event = await env.DB.prepare("SELECT id FROM events WHERE date = ? ORDER BY id LIMIT 1").bind(poll.date).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE day_polls SET status = 'closed', chosen_start = ? WHERE id = ?").bind(best.start, id),
    event
      ? env.DB.prepare("UPDATE events SET start_time = ? WHERE id = ?").bind(time, event.id)
      : env.DB.prepare("INSERT INTO events (date, title, start_time) VALUES (?, ?, ?)").bind(poll.date, poll.title, time),
  ]);
  return { start: best.start };
}

async function startVoting(env, user, body) {
  requireAdmin(user);
  const title = text(body.title, "Titel", 80, { required: true });
  const ids = [...new Set(Array.isArray(body.proposal_ids) ? body.proposal_ids : [])];
  if (ids.length < 2 || ids.length > 20) throw new HttpError(400, "Wähle 2 bis 20 Vorschläge aus.");
  ids.forEach((id) => integer(id, "Vorschlag"));
  const known = await env.DB.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).first();
  if (known.n !== ids.length) throw new HttpError(400, "Ein Vorschlag existiert nicht mehr.");
  const eventId = body.event_id == null ? null : integer(body.event_id, "Termin");
  if (eventId && !(await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(eventId).first())) {
    throw new HttpError(400, "Der Termin existiert nicht mehr.");
  }
  if (await env.DB.prepare("SELECT id FROM votings WHERE status = 'open'").first()) {
    throw new HttpError(409, "Es läuft bereits ein Voting.");
  }

  let voting;
  try {
    voting = await env.DB.prepare(
      "INSERT INTO votings (title, event_id, started_by, created_at) VALUES (?, ?, ?, ?) RETURNING id"
    ).bind(title, eventId, user.id, Date.now()).first();
  } catch {
    throw new HttpError(409, "Es läuft bereits ein Voting.");
  }
  await env.DB.batch(ids.map((id) => env.DB.prepare("INSERT INTO voting_options (voting_id, proposal_id) VALUES (?, ?)").bind(voting.id, id)));
  return { id: voting.id, notified: await notifyDiscord(env, "voting-started", { voting_id: voting.id }).catch(() => false) };
}

async function closeVoting(env, user, id, body) {
  requireAdmin(user);
  const voting = await env.DB.prepare("SELECT * FROM votings WHERE id = ? AND status = 'open'").bind(id).first();
  if (!voting) throw new HttpError(404, "Dieses Voting läuft nicht.");
  const details = await votingDetails(env, voting, user);
  const top = Math.max(...details.options.map((option) => option.votes), 0);
  const leaders = details.options.filter((option) => option.votes === top);
  let winner = leaders.length === 1 ? leaders[0].id : null;
  if (winner === null) {
    if (!leaders.some((option) => option.id === body.winner_id)) {
      throw new HttpError(409, "Gleichstand: Bitte den Gewinner auswählen.", { tied: leaders.map(({ id: optionId, name }) => ({ id: optionId, name })) });
    }
    winner = body.winner_id;
  }
  const statements = [env.DB.prepare("UPDATE votings SET status = 'closed', winner_id = ? WHERE id = ?").bind(winner, id)];
  if (voting.event_id) statements.push(env.DB.prepare("UPDATE events SET proposal_id = ? WHERE id = ?").bind(winner, voting.event_id));
  await env.DB.batch(statements);
  return { winner_id: winner };
}

// ---------------------------------------------------------------- Results (sent by the Minecraft plugin)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[a-z0-9_]{1,64}$/;
const MAX_RESULT_SIZE = 800000;

async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([given, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value || ""))));
  return crypto.subtle.timingSafeEqual(a, b);
}

function short(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function count(value, max = 1e15) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function cleanMember(member) {
  if (!member || !UUID_PATTERN.test(member.uuid || "")) throw new HttpError(400, "Ungültiger Spieler.");
  return { uuid: member.uuid, name: short(member.name, 32) || "?" };
}

function list(value, max, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, `${field} ist ungültig.`);
  return value;
}

function cleanResult(body) {
  if (!UUID_PATTERN.test(body.id || "")) throw new HttpError(400, "Ungültige Ergebnis-ID.");
  const startedAt = count(body.started_at);
  const endedAt = count(body.ended_at);
  if (startedAt === null || endedAt === null || endedAt < startedAt) throw new HttpError(400, "Ungültige Zeit.");
  const modes = list(body.modes, 20, "Modi").filter((mode) => ID_PATTERN.test(mode || ""));
  const ranking = list(body.ranking, 100, "Ranking").map((entry) => {
    const clean = {
      name: short(entry?.name, 64) || "?",
      place: count(entry?.place, 1000) ?? 0,
      score: short(entry?.score, 40),
      members: list(entry?.members, 100, "Mitglieder").map(cleanMember),
      details: list(entry?.details, 400, "Details").map((detail) => {
        const item = { text: short(detail?.text, 80) };
        if (ID_PATTERN.test(detail?.icon || "")) item.icon = detail.icon;
        for (const key of ["time", "by"]) if (detail?.[key]) item[key] = short(detail[key], 32);
        if (detail?.joker === true) item.joker = true;
        return item;
      }),
    };
    if (entry?.dnf === true) clean.dnf = true;
    return clean;
  });
  const players = list(body.players, 100, "Spieler").map((player) => {
    const clean = { ...cleanMember(player), deaths: count(player.deaths, 100000) ?? 0, won: player.won === true };
    if (count(player.place, 1000)) clean.place = player.place;
    if (player.team) clean.team = short(player.team, 32);
    return clean;
  });
  let config = null;
  try { config = body.config ? checkConfig(body.config) : null; } catch { config = null; }
  const result = {
    id: body.id,
    title: short(body.title, 120) || "Challenge",
    started_at: startedAt,
    ended_at: endedAt,
    play_seconds: count(body.play_seconds, 10000000) ?? 0,
    modes,
    outcome: short(body.outcome, 120) || null,
    success: typeof body.success === "boolean" ? body.success : null,
    dragon_killed_after: count(body.dragon_killed_after, 10000000),
    ranking,
    players,
    winners: players.filter((player) => player.won).map((player) => player.name),
    config,
  };
  if (JSON.stringify(result).length > MAX_RESULT_SIZE) throw new HttpError(413, "Das Ergebnis ist zu groß.");
  return result;
}

function berlinDate(time) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(time);
}

async function submitResult(request, env, body) {
  const header = request.headers.get("Authorization") || "";
  if (!env.RESULTS_TOKEN || !header.startsWith("Bearer ") || !(await sameSecret(header.slice(7), env.RESULTS_TOKEN))) {
    throw new HttpError(401, "Ungültiger Token.");
  }
  const result = cleanResult(body);
  // The challenge of the day in the calendar gives the result its name
  const event = await env.DB.prepare(
    "SELECT e.id, e.title, p.name AS proposal FROM events e LEFT JOIN proposals p ON p.id = e.proposal_id WHERE e.date = ? ORDER BY e.id LIMIT 1"
  ).bind(berlinDate(result.started_at)).first();
  const title = (event && (event.proposal || event.title)) || result.title;
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO results (id, title, started_at, ended_at, play_seconds, modes, outcome, data, event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(result.id, title, result.started_at, result.ended_at, result.play_seconds, JSON.stringify(result.modes), result.outcome,
    JSON.stringify(result), event ? event.id : null, Date.now()).run();
  if (inserted.meta.changes && result.players.length) {
    await env.DB.batch(result.players.map((player) => env.DB.prepare(
      "INSERT OR IGNORE INTO result_players (result_id, uuid, name, place, won) VALUES (?, ?, ?, ?, ?)"
    ).bind(result.id, player.uuid, player.name, player.place ?? null, player.won ? 1 : 0)));
  }
  return { ok: true, id: result.id, duplicate: !inserted.meta.changes };
}

async function listResults(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, started_at, ended_at, play_seconds, modes, outcome, event_id FROM results ORDER BY started_at DESC LIMIT 300"
  ).all();
  const { results: players } = await env.DB.prepare(
    "SELECT result_id, uuid, name, place, won FROM result_players WHERE result_id IN (SELECT id FROM results ORDER BY started_at DESC LIMIT 300)"
  ).all();
  const byResult = {};
  for (const player of players) (byResult[player.result_id] ||= []).push(player);
  return results.map((row) => {
    const entries = byResult[row.id] || [];
    return {
      ...row,
      modes: JSON.parse(row.modes),
      players: entries.length,
      winners: entries.filter((player) => player.won).map((player) => ({ uuid: player.uuid, name: player.name })),
    };
  });
}

async function resultDetails(env, id) {
  const row = await env.DB.prepare("SELECT id, title, event_id, data FROM results WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "Ergebnis nicht gefunden.");
  return { ...JSON.parse(row.data), title: row.title, event_id: row.event_id };
}

async function leaderboard(env, mode) {
  const filter = mode ? "WHERE r.modes LIKE ?" : "";
  const statement = env.DB.prepare(
    `SELECT rp.uuid,
       COUNT(*) AS games,
       SUM(rp.won) AS wins,
       SUM(CASE WHEN rp.place BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS podiums,
       MIN(rp.place) AS best_place,
       MAX(r.started_at) AS last_played,
       (SELECT p2.name FROM result_players p2 JOIN results r2 ON r2.id = p2.result_id WHERE p2.uuid = rp.uuid ORDER BY r2.started_at DESC LIMIT 1) AS name
     FROM result_players rp JOIN results r ON r.id = rp.result_id ${filter}
     GROUP BY rp.uuid
     ORDER BY wins DESC, podiums DESC, games DESC, name
     LIMIT 200`
  );
  const { results } = await (mode ? statement.bind(`%"${mode}"%`) : statement).all();
  return results;
}

function eventFields(body) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") || Number.isNaN(Date.parse(body.date))) throw new HttpError(400, "Ungültiges Datum.");
  return {
    date: body.date,
    title: text(body.title, "Titel", 80),
    proposal_id: body.proposal_id == null ? null : integer(body.proposal_id, "Vorschlag"),
    start_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(body.start_time || "") ? body.start_time : null,
  };
}

async function route(request, env, url, user) {
  const parts = url.pathname.replace(/^\/api\/|\/$/g, "").split("/");
  const method = request.method;
  const body = method === "POST" || method === "PUT" ? await request.json().catch(() => ({})) : {};
  const id = parts[1] ? Number(parts[1]) : null;

  if (parts[0] === "state" && method === "GET") return state(env, user);

  if (parts[0] === "results") {
    if (method === "POST" && !parts[1]) return submitResult(request, env, body);
    if (method === "GET" && !parts[1]) return { results: await listResults(env) };
    if (method === "GET" && UUID_PATTERN.test(parts[1])) return resultDetails(env, parts[1]);
    if (method === "DELETE" && UUID_PATTERN.test(parts[1])) {
      requireAdmin(user);
      await env.DB.prepare("DELETE FROM results WHERE id = ?").bind(parts[1]).run();
      return { ok: true };
    }
  }

  if (parts[0] === "leaderboard" && method === "GET") {
    const mode = url.searchParams.get("mode");
    return { players: await leaderboard(env, mode && ID_PATTERN.test(mode) ? mode : null) };
  }

  if (parts[0] === "proposals") {
    if (method === "POST" && !id) return submitProposal(env, user, body);
    if (method === "DELETE" && id) return deleteProposal(env, user, id);
  }

  if (parts[0] === "votings") {
    if (method === "POST" && !id) return startVoting(env, user, body);
    if (method === "GET" && id) {
      const voting = await env.DB.prepare("SELECT * FROM votings WHERE id = ?").bind(id).first();
      if (!voting) throw new HttpError(404, "Voting nicht gefunden.");
      return votingDetails(env, voting, user);
    }
    if (method === "POST" && id && parts[2] === "close") return closeVoting(env, user, id, body);
    if (method === "POST" && id && parts[2] === "vote") {
      requireUser(user);
      const voting = await env.DB.prepare("SELECT id FROM votings WHERE id = ? AND status = 'open'").bind(id).first();
      if (!voting) throw new HttpError(409, "Dieses Voting ist beendet.");
      const option = await env.DB.prepare("SELECT 1 FROM voting_options WHERE voting_id = ? AND proposal_id = ?").bind(id, body.proposal_id ?? 0).first();
      if (!option) throw new HttpError(400, "Dieser Vorschlag ist nicht im Voting.");
      await env.DB.prepare(
        "INSERT INTO votes (voting_id, user_id, proposal_id) VALUES (?1, ?2, ?3) ON CONFLICT(voting_id, user_id) DO UPDATE SET proposal_id = ?3"
      ).bind(id, user.id, body.proposal_id).run();
      return { ok: true };
    }
  }

  if (parts[0] === "day-polls") {
    if (method === "POST" && !id) return startDayPoll(env, user, body);
    if (method === "POST" && id && parts[2] === "respond") return respondDayPoll(env, user, id, body);
    if (method === "POST" && id && parts[2] === "close") return closeDayPoll(env, user, id);
    if (method === "DELETE" && id) {
      requireAdmin(user);
      await env.DB.prepare("DELETE FROM day_polls WHERE id = ?").bind(id).run();
      return { ok: true };
    }
  }

  if (parts[0] === "events") {
    requireAdmin(user);
    if (method === "POST" && !id) {
      const event = eventFields(body);
      const row = await env.DB.prepare("INSERT INTO events (date, title, proposal_id, start_time) VALUES (?, ?, ?, ?) RETURNING id").bind(event.date, event.title, event.proposal_id, event.start_time).first();
      return { id: row.id };
    }
    if (method === "PUT" && id) {
      const event = eventFields(body);
      await env.DB.prepare("UPDATE events SET date = ?, title = ?, proposal_id = ?, start_time = ? WHERE id = ?").bind(event.date, event.title, event.proposal_id, event.start_time, id).run();
      return { ok: true };
    }
    if (method === "DELETE" && id) {
      await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
      return { ok: true };
    }
  }

  if (parts[0] === "users") {
    requireAdmin(user);
    if (method === "GET" && !parts[1]) {
      const { results } = await env.DB.prepare("SELECT id, username, display_name, avatar, role, multi_submit FROM users ORDER BY role, username").all();
      return { users: results, owner_id: await ownerId(env) };
    }
    if (method === "POST" && parts[1] && parts[2] === "multi-submit") {
      await env.DB.prepare("UPDATE users SET multi_submit = ? WHERE id = ?").bind(body.enabled === true ? 1 : 0, parts[1]).run();
      return { ok: true };
    }
    if (method === "POST" && parts[1] && parts[2] === "role") {
      if (!["user", "admin"].includes(body.role)) throw new HttpError(400, "Unbekannte Rolle.");
      if (parts[1] === (await ownerId(env))) throw new HttpError(403, "Die Rolle des Besitzers kann nicht geändert werden.");
      await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(body.role, parts[1]).run();
      return { ok: true };
    }
  }

  throw new HttpError(404, "Nicht gefunden.");
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (origin && env.ALLOWED_ORIGINS.split(",").includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/auth/login") return login(request, env);
    if (url.pathname === "/auth/callback") return callback(request, env);

    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Nicht gefunden.");
      const result = await route(request, env, url, await currentUser(request, env));
      return new Response(JSON.stringify(result), { headers });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      const message = status === 500 ? "Serverfehler." : error.message;
      return new Response(JSON.stringify({ error: message, ...(error.extra || {}) }), { status, headers });
    }
  },
};
