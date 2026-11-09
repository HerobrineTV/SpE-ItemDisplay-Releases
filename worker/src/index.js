const SESSION_DAYS = 30;
const MAX_PROPOSALS_PER_USER = 25;
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
  return env.DB.prepare("SELECT id, username, display_name, avatar, role FROM users WHERE id = ?").bind(payload.sub).first();
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
  const voting = /^\d+$/.test(url.searchParams.get("voting") || "") ? url.searchParams.get("voting") : "";
  const headers = new Headers({ Location: authorize.toString() });
  headers.append("Set-Cookie", `oauth_state=${state}.${voting}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`);
  return new Response(null, { status: 302, headers });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const [state, voting] = (cookie(request, "oauth_state") || "").split(".");
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
  const target = voting ? `${env.SITE_URL}?voting=${voting}#token=${token}` : `${env.SITE_URL}#token=${token}`;
  const headers = new Headers({ Location: target });
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
  return { toggles: clean };
}

function proposalRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: JSON.parse(row.config),
    created_at: row.created_at,
    author_id: row.author_id,
    author: row.author_display || row.author_username || "Unbekannt",
  };
}

const PROPOSAL_SELECT = `SELECT p.*, u.username AS author_username, u.display_name AS author_display
  FROM proposals p LEFT JOIN users u ON u.id = p.author_id`;

async function listProposals(env) {
  const { results } = await env.DB.prepare(`${PROPOSAL_SELECT} ORDER BY p.id DESC`).all();
  return results.map(proposalRow);
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
  let myVote = null;
  if (user) {
    const row = await env.DB.prepare("SELECT proposal_id FROM votes WHERE voting_id = ? AND user_id = ?").bind(voting.id, user.id).first();
    myVote = row ? row.proposal_id : null;
  }
  return {
    ...voting,
    my_vote: myVote,
    options: results.map((row) => ({ ...proposalRow(row), votes: countById[row.id] || 0 })),
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
    events: await listEvents(env),
    proposals: await listProposals(env),
    voting: await votingDetails(env, latest, user),
  };
}

async function notifyDiscord(env, votingId) {
  if (!env.GITHUB_DISPATCH_TOKEN) return false;
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "spe-challenges-api",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "voting-started", client_payload: { voting_id: votingId } }),
  });
  return response.ok;
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
  return { id: voting.id, notified: await notifyDiscord(env, voting.id).catch(() => false) };
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

function eventFields(body) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") || Number.isNaN(Date.parse(body.date))) throw new HttpError(400, "Ungültiges Datum.");
  return {
    date: body.date,
    title: text(body.title, "Titel", 80),
    proposal_id: body.proposal_id == null ? null : integer(body.proposal_id, "Vorschlag"),
  };
}

async function route(request, env, url, user) {
  const parts = url.pathname.replace(/^\/api\/|\/$/g, "").split("/");
  const method = request.method;
  const body = method === "POST" || method === "PUT" ? await request.json().catch(() => ({})) : {};
  const id = parts[1] ? Number(parts[1]) : null;

  if (parts[0] === "state" && method === "GET") return state(env, user);

  if (parts[0] === "proposals") {
    if (method === "POST" && !id) {
      requireUser(user);
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE author_id = ?").bind(user.id).first();
      if (count.n >= MAX_PROPOSALS_PER_USER) throw new HttpError(429, `Maximal ${MAX_PROPOSALS_PER_USER} Vorschläge pro Person.`);
      const row = await env.DB.prepare(
        "INSERT INTO proposals (author_id, name, description, config, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id"
      ).bind(user.id, text(body.name, "Name", 64, { required: true }), text(body.description, "Beschreibung", 1000), JSON.stringify(checkConfig(body.config)), Date.now()).first();
      return { id: row.id };
    }
    if (method === "DELETE" && id) {
      requireUser(user);
      const proposal = await env.DB.prepare("SELECT author_id FROM proposals WHERE id = ?").bind(id).first();
      if (!proposal) throw new HttpError(404, "Vorschlag nicht gefunden.");
      if (proposal.author_id !== user.id && user.role !== "admin") throw new HttpError(403, "Nicht erlaubt.");
      const used = await env.DB.prepare(
        "SELECT 1 FROM voting_options o JOIN votings v ON v.id = o.voting_id WHERE o.proposal_id = ? AND v.status = 'open'"
      ).bind(id).first();
      if (used) throw new HttpError(409, "Der Vorschlag ist gerade im Voting.");
      await env.DB.prepare("DELETE FROM proposals WHERE id = ?").bind(id).run();
      return { ok: true };
    }
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

  if (parts[0] === "events") {
    requireAdmin(user);
    if (method === "POST" && !id) {
      const event = eventFields(body);
      const row = await env.DB.prepare("INSERT INTO events (date, title, proposal_id) VALUES (?, ?, ?) RETURNING id").bind(event.date, event.title, event.proposal_id).first();
      return { id: row.id };
    }
    if (method === "PUT" && id) {
      const event = eventFields(body);
      await env.DB.prepare("UPDATE events SET date = ?, title = ?, proposal_id = ? WHERE id = ?").bind(event.date, event.title, event.proposal_id, id).run();
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
      const { results } = await env.DB.prepare("SELECT id, username, display_name, avatar, role FROM users ORDER BY role, username").all();
      return { users: results, owner_id: await ownerId(env) };
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
