"use strict";

const API = window.SPE_API;
const TOKEN_KEY = "spe_token";
const DRAFT_KEY = "spe_builder_draft";
const GROUP_TITLES = { timer: "Timer", health: "Leben", force_battle: "Force Battle", bingo_options: "Item Bingo", misc: "Allgemein" };
const GROUP_ORDER = ["timer", "health", "force_battle", "bingo_options", "misc"];
const GROUP_NEEDS = { force_battle: "force_item_battle", bingo_options: "item_bingo" };
const SUBMENUS = { force_item_battle: "force_battle", item_bingo: "bingo_options" };
const KIT_SLOTS = 36;
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

let catalog = [];
let byId = {};
let descriptions = {};
let kitOptions = { items: [], itemById: {}, enchantments: [], potions: [] };
let state = { user: null, is_owner: false, events: [], proposals: [], voting: null };
let linkedVoting = null;
let draft = null;
let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function store(action, key, value) {
  try {
    if (action === "get") return localStorage.getItem(key);
    if (action === "set") localStorage.setItem(key, value);
    if (action === "remove") localStorage.removeItem(key);
  } catch { /* private window */ }
  return null;
}

function plain(text) {
  return String(text ?? "").replace(/§./g, "");
}

function name(toggle) {
  return plain(toggle.display);
}

function toast(message, isError) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = ""; }, 4000);
}

async function api(path, method = "GET", body) {
  const headers = {};
  const token = store("get", TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Anfrage fehlgeschlagen.");
    Object.assign(error, data, { status: response.status });
    throw error;
  }
  return data;
}

async function run(action, success) {
  try {
    const result = await action();
    if (success) toast(success);
    return result;
  } catch (error) {
    if (error.status === 401) store("remove", TOKEN_KEY);
    toast(error.message, true);
    return undefined;
  }
}

function icon(id, big) {
  const toggle = byId[id];
  const letter = toggle ? name(toggle)[0] : "?";
  return `<span class="ico${big ? " big" : ""}" title="${esc(toggle ? name(toggle) : id)}">${esc(letter)}<img src="icons/${esc(id)}.png" alt="" onerror="this.remove()"></span>`;
}

function unknownIcon() {
  return `<span class="ico unknown" title="Noch keine Challenge ausgewählt">?</span>`;
}

function activeChallenges(config) {
  return catalog.filter((toggle) => toggle.kind === "challenge" && config?.toggles?.[toggle.id]?.value);
}

function modeName(toggle, config) {
  const index = config.toggles[toggle.id]?.currentMode ?? toggle.currentMode;
  return toggle.modes?.[index] ?? null;
}

function changedSettings(config) {
  const lines = [];
  for (const toggle of catalog) {
    const entry = config.toggles[toggle.id];
    if (toggle.kind !== "setting" || !entry) continue;
    if (!relevant(toggle, config.toggles)) continue;
    const amountChanged = toggle.hasAmount && entry.setAmount !== undefined && entry.setAmount !== toggle.setAmount;
    const modeChanged = toggle.modes && entry.currentMode !== undefined && entry.currentMode !== toggle.currentMode;
    if (entry.value === toggle.value && !amountChanged && !modeChanged) continue;
    if (!entry.value) { lines.push(`${name(toggle)}: aus`); continue; }
    const kitSize = config.starter_kit?.length ?? 0;
    const detail = toggle.id === "starter_kit" ? `: ${kitSize} ${kitSize === 1 ? "Stack" : "Stacks"}`
      : toggle.hasAmount ? `: ${entry.setAmount ?? toggle.setAmount}` : toggle.modes ? `: ${modeName(toggle, config)}` : "";
    lines.push(`${name(toggle)}${detail}`);
  }
  return lines;
}

function configTags(config) {
  const challenges = activeChallenges(config).map((toggle) => {
    const mode = toggle.modes ? ` (${modeName(toggle, config)})` : "";
    return `<span class="tag">${esc(name(toggle) + mode)}</span>`;
  });
  const settings = changedSettings(config).map((line) => `<span class="tag">${esc(line)}</span>`);
  return `<div class="tags">${challenges.concat(settings).join("")}</div>`;
}

function proposalById(id) {
  return state.proposals.find((proposal) => proposal.id === id) || null;
}

function isAdmin() {
  return state.user?.role === "admin";
}

/* Account */

function loginUrl() {
  const voting = new URLSearchParams(location.search).get("voting");
  return `${API}/auth/login${voting ? `?voting=${encodeURIComponent(voting)}` : ""}`;
}

function renderAccount() {
  const user = state.user;
  if (!user) {
    $("#account").innerHTML = `<a class="button" href="${esc(loginUrl())}">Mit Discord einloggen</a>`;
    return;
  }
  const avatar = user.avatar ? `<img src="https://cdn.discordapp.com/avatars/${esc(user.id)}/${esc(user.avatar)}.png?size=64" alt="">` : "";
  $("#account").innerHTML = `${avatar}<span>${esc(user.display_name || user.username)}</span><button class="ghost" id="logout">Logout</button>`;
  $("#logout").onclick = () => { store("remove", TOKEN_KEY); refresh(); };
}

/* Calendar */

function pad(number) {
  return String(number).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function eventIcons(event) {
  const proposal = proposalById(event.proposal_id);
  if (!proposal) return unknownIcon();
  const challenges = activeChallenges(proposal.config);
  return challenges.length ? challenges.slice(0, 4).map((toggle) => icon(toggle.id)).join("") : unknownIcon();
}

function renderCalendar() {
  $("#month-label").textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;
  const start = new Date(month);
  start.setDate(1 - ((month.getDay() + 6) % 7));
  const today = dateKey(new Date());
  let html = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((day) => `<div class="cal-head">${day}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i >= 35 && date.getMonth() !== month.getMonth()) break;
    const key = dateKey(date);
    const events = state.events.filter((event) => event.date === key).map((event) => {
      const proposal = proposalById(event.proposal_id);
      const title = event.title || proposal?.name || "Geplant";
      return `<span class="day-event" role="button" tabindex="0" data-event="${event.id}" title="${esc(title)}"><span class="day-icons">${eventIcons(event)}</span><span class="day-title">${esc(title)}</span></span>`;
    }).join("");
    const classes = `day${date.getMonth() !== month.getMonth() ? " other" : ""}${key === today ? " today" : ""}`;
    const tag = isAdmin() ? "button" : "div";
    html += `<${tag} class="${classes}" data-date="${key}" aria-label="${date.getDate()}. ${MONTHS[date.getMonth()]}"><span class="day-num">${date.getDate()}</span>${events}</${tag}>`;
  }
  $("#calendar").innerHTML = `<div class="cal">${html}</div>`;
  $("#calendar-hint").textContent = isAdmin()
    ? "Klicke auf einen Tag, um einen Termin zu planen. Ein ? bedeutet: Der Termin steht, die Challenge noch nicht."
    : "Ein ? bedeutet: Der Termin steht, die Challenge noch nicht.";
}

function openDialog(html) {
  const dialog = $("#dialog");
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  return dialog;
}

function proposalOptions(selected) {
  return `<option value="">? – noch offen</option>${state.proposals.map((proposal) =>
    `<option value="${proposal.id}"${proposal.id === selected ? " selected" : ""}>${esc(proposal.name)}</option>`).join("")}`;
}

function showEvent(event) {
  const proposal = proposalById(event.proposal_id);
  const title = event.title || proposal?.name || "Geplant";
  const body = proposal
    ? `<p class="meta">Vorschlag von ${esc(proposal.author)}</p>${proposal.description ? `<p>${esc(proposal.description)}</p>` : ""}${configTags(proposal.config)}`
    : `<p class="meta">Für diesen Termin wurde noch keine Challenge ausgewählt.</p>`;
  const dialog = openDialog(`<h3>${esc(title)}</h3><p class="meta">${esc(event.date.split("-").reverse().join("."))}</p>${body}
    <div class="dialog-actions">${isAdmin() ? `<button class="ghost" id="edit-event">Bearbeiten</button>` : ""}<button id="close-dialog">Schließen</button></div>`);
  dialog.querySelector("#close-dialog").onclick = () => dialog.close();
  const edit = dialog.querySelector("#edit-event");
  if (edit) edit.onclick = () => editEvent(event, event.date);
}

function editEvent(event, date) {
  const dialog = openDialog(`<h3>${event ? "Termin bearbeiten" : "Termin planen"}</h3>
    <form method="dialog" id="event-form">
      <label class="field"><span>Datum</span><input type="date" name="date" value="${esc(date)}" required></label>
      <label class="field"><span>Titel (optional)</span><input type="text" name="title" maxlength="80" value="${esc(event?.title)}"></label>
      <label class="field"><span>Challenge</span><select name="proposal">${proposalOptions(event?.proposal_id ?? null)}</select></label>
      <div class="dialog-actions">
        ${event ? `<button type="button" class="danger" id="delete-event">Löschen</button>` : ""}
        <button type="button" class="ghost" id="cancel-event">Abbrechen</button>
        <button type="submit">Speichern</button>
      </div>
    </form>`);
  dialog.querySelector("#cancel-event").onclick = () => dialog.close();
  const remove = dialog.querySelector("#delete-event");
  if (remove) remove.onclick = async () => {
    await run(() => api(`events/${event.id}`, "DELETE"), "Termin gelöscht.");
    dialog.close();
    refresh();
  };
  dialog.querySelector("#event-form").onsubmit = async (submit) => {
    submit.preventDefault();
    const form = new FormData(submit.target);
    const body = { date: form.get("date"), title: form.get("title"), proposal_id: form.get("proposal") ? Number(form.get("proposal")) : null };
    const saved = await run(() => (event ? api(`events/${event.id}`, "PUT", body) : api("events", "POST", body)), "Termin gespeichert.");
    if (saved) { dialog.close(); refresh(); }
  };
}

/* Voting */

function renderVoting() {
  const voting = linkedVoting || state.voting;
  const body = $("#voting-body");
  if (!voting) {
    body.innerHTML = `<div class="panel empty">Gerade läuft kein Voting.</div>`;
    return;
  }
  const open = voting.status === "open";
  const total = voting.options.reduce((sum, option) => sum + option.votes, 0);
  const options = voting.options.map((option) => {
    const percent = total ? Math.round((option.votes / total) * 100) : 0;
    let action = "";
    if (open && state.user) {
      action = voting.my_vote === option.id ? `<button disabled>Deine Stimme</button>` : `<button data-vote="${option.id}">Abstimmen</button>`;
    }
    if (isAdmin() && voting.winner_id === option.id) {
      action = `<button class="ghost" data-winner-preset="${option.id}">Preset herunterladen</button>`;
    }
    const classes = `panel option${voting.my_vote === option.id ? " mine" : ""}${voting.winner_id === option.id ? " won" : ""}`;
    return `<article class="${classes}">
      <div>
        <div class="option-title">${activeChallenges(option.config).slice(0, 4).map((toggle) => icon(toggle.id)).join("")}<h3>${esc(option.name)}</h3>${voting.winner_id === option.id ? `<span class="tag">Gewinner</span>` : ""}</div>
        <div class="meta">von ${esc(option.author)}</div>
        ${option.description ? `<div>${esc(option.description)}</div>` : ""}
        ${configTags(option.config)}
      </div>
      <div>${action}</div>
      <div class="bar"><div class="bar-track"><div class="bar-fill" style="width:${percent}%"></div></div><span>${option.votes} ${option.votes === 1 ? "Stimme" : "Stimmen"}</span></div>
    </article>`;
  }).join("");
  const login = open && !state.user ? `<a class="button" href="${esc(loginUrl())}">Zum Abstimmen mit Discord einloggen</a>` : "";
  const close = open && isAdmin() ? `<button class="ghost" id="close-voting">Voting beenden</button>` : "";
  const event = state.events.find((item) => item.id === voting.event_id);
  const status = open ? "Läuft" : "Beendet";
  body.innerHTML = `<div class="section-head"><div><h3>${esc(voting.title)}</h3><div class="meta">${status}${event ? ` · für den ${esc(event.date.split("-").reverse().join("."))}` : ""}</div></div><div class="row-actions">${login}${close}</div></div><div class="options">${options}</div>`;
  body.querySelectorAll("[data-vote]").forEach((button) => {
    button.onclick = async () => {
      await run(() => api(`votings/${voting.id}/vote`, "POST", { proposal_id: Number(button.dataset.vote) }), "Stimme gespeichert.");
      refresh();
    };
  });
  body.querySelectorAll("[data-winner-preset]").forEach((button) => {
    button.onclick = () => downloadPreset(voting.options.find((option) => option.id === Number(button.dataset.winnerPreset)));
  });
  if (close) $("#close-voting").onclick = () => closeVoting(voting.id);
}

async function closeVoting(id, winner) {
  try {
    await api(`votings/${id}/close`, "POST", winner ? { winner_id: winner } : {});
    toast("Voting beendet.");
    $("#dialog").close();
    refresh();
  } catch (error) {
    if (!error.tied) { toast(error.message, true); return; }
    const dialog = openDialog(`<h3>Gleichstand</h3><p class="meta">Wähle den Gewinner aus:</p><div class="row-list">${error.tied.map((item) =>
      `<button class="ghost" data-winner="${item.id}">${esc(item.name)}</button>`).join("")}</div><div class="dialog-actions"><button class="ghost" id="close-dialog">Abbrechen</button></div>`);
    dialog.querySelector("#close-dialog").onclick = () => dialog.close();
    dialog.querySelectorAll("[data-winner]").forEach((button) => { button.onclick = () => closeVoting(id, Number(button.dataset.winner)); });
  }
}

/* Builder */

function freshDraft() {
  const toggles = {};
  for (const toggle of catalog) {
    toggles[toggle.id] = { value: toggle.value };
    if (toggle.hasAmount) toggles[toggle.id].setAmount = toggle.setAmount;
    if (toggle.modes) toggles[toggle.id].currentMode = toggle.currentMode;
  }
  return { name: "", description: "", toggles, starter_kit: [] };
}

function loadDraft() {
  draft = freshDraft();
  try {
    const saved = JSON.parse(store("get", DRAFT_KEY) || "null");
    if (!saved) return;
    draft.name = saved.name || "";
    draft.description = saved.description || "";
    // Only ids which still exist: the catalog changes with the plugin
    for (const id of Object.keys(draft.toggles)) if (saved.toggles?.[id]) Object.assign(draft.toggles[id], saved.toggles[id]);
    draft.starter_kit = (saved.starter_kit || []).filter((item) => kitOptions.itemById[item.type]);
  } catch { /* old draft */ }
}

function saveDraft() {
  store("set", DRAFT_KEY, JSON.stringify(draft));
}

function requiredChallenge(toggle) {
  if (GROUP_NEEDS[toggle.group]) return GROUP_NEEDS[toggle.group];
  return [toggle.lore1, toggle.lore2].some((line) => /ForceItemBattle Only/i.test(plain(line))) ? "force_item_battle" : null;
}

function relevant(toggle, toggles) {
  const needed = requiredChallenge(toggle);
  return !needed || toggles[needed]?.value;
}

function blockReason(toggle) {
  const toggles = draft.toggles;
  const entry = toggles[toggle.id];
  if (toggle.kind === "challenge" && !entry.value) {
    const conflict = (toggle.conflicts || []).find((id) => toggles[id]?.value);
    if (conflict) return `Nicht kombinierbar mit ${name(byId[conflict])}.`;
  }
  if (toggle.id === "timer_count_up" && !entry.value) {
    const limited = catalog.find((item) => item.needsTimeLimit && toggles[item.id].value);
    if (limited) return `${name(limited)} braucht ein Zeitlimit.`;
  }
  if (toggle.kind === "challenge" && toggle.needsTimeLimit && !entry.value && toggles.timer_count_up?.value) {
    return "Braucht ein Zeitlimit, Count Up ist aktiv.";
  }
  if (toggle.group === "force_battle" && entry.value) {
    const others = catalog.filter((item) => item.group === "force_battle" && toggles[item.id].value);
    if (others.length === 1) return "Mindestens eine Aufgabenart muss aktiv bleiben.";
  }
  return null;
}

function description(toggle) {
  return descriptions[toggle.id] || { summary: [toggle.lore1, toggle.lore2].map(plain).filter((line) => line && !/^Click to/.test(line)).join(" ") };
}

function cardHtml(toggle) {
  const entry = draft.toggles[toggle.id];
  const info = description(toggle);
  const block = blockReason(toggle);
  const alwaysOn = toggle.hasAmount && toggle.value;
  const modeList = info.modes ? `<ul>${toggle.modes.map((mode) => info.modes[mode] ? `<li><strong>${esc(mode)}:</strong> ${esc(info.modes[mode])}</li>` : "").join("")}</ul>` : "";
  const more = info.details || modeList ? `<details data-detail="${toggle.id}"><summary>Details</summary>${info.details ? `<div>${esc(info.details)}</div>` : ""}${modeList}</details>` : "";
  const switcher = alwaysOn ? "" : `<label class="switch"><input type="checkbox" aria-label="${esc(name(toggle))}" data-toggle="${toggle.id}"${entry.value ? " checked" : ""}${block ? " disabled" : ""}><span></span></label>`;
  const controls = [];
  if (toggle.hasAmount && entry.value) controls.push(`<input type="number" min="1" max="100000" aria-label="Wert für ${esc(name(toggle))}" data-amount="${toggle.id}" value="${entry.setAmount}">`);
  if (toggle.modes && entry.value) controls.push(`<select aria-label="Modus für ${esc(name(toggle))}" data-mode="${toggle.id}">${toggle.modes.map((mode, index) => `<option value="${index}"${index === entry.currentMode ? " selected" : ""}>${esc(mode)}</option>`).join("")}</select>`);
  const submenuItems = SUBMENUS[toggle.id] && entry.value ? catalog.filter((item) => item.group === SUBMENUS[toggle.id]).sort((a, b) => a.page - b.page || a.slot - b.slot) : [];
  const submenu = submenuItems.length ? `<div class="submenu"><div class="cards">${submenuItems.map(cardHtml).join("")}</div></div>` : "";
  const kit = toggle.id === "starter_kit" && entry.value ? kitHtml() : "";
  return `<article class="card${entry.value ? " on" : ""}${block && !entry.value ? " blocked" : ""}${submenu || kit ? " wide" : ""}">
    <div class="card-head">${icon(toggle.id, toggle.kind === "challenge")}<h3>${esc(name(toggle))}</h3>${switcher}</div>
    ${info.summary ? `<p>${esc(info.summary)}</p>` : ""}
    ${more}
    ${block ? `<div class="warn">${esc(block)}</div>` : ""}
    ${controls.length ? `<div class="controls">${controls.join("")}</div>` : ""}
    ${submenu}${kit}
  </article>`;
}

function prettyId(id) {
  return id.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function kitHtml() {
  let slots = "";
  for (let slot = 0; slot < KIT_SLOTS; slot++) {
    const item = draft.starter_kit.find((entry) => entry.slot === slot);
    const label = item ? item.type.split("_").slice(0, 2).map((word) => word[0].toUpperCase()).join("") : "";
    const title = item ? `${prettyId(item.type)} x${item.amount}${item.name ? ` (${item.name})` : ""}` : `Feld ${slot + 1}: leer`;
    slots += `<button type="button" class="slot${item ? " filled" : ""}" data-slot="${slot}" title="${esc(title)}" aria-label="${esc(title)}">${esc(label)}${item && item.amount > 1 ? `<small>${item.amount}</small>` : ""}${item && Object.keys(item.enchantments || {}).length ? "<i></i>" : ""}</button>`;
  }
  return `<div class="submenu"><div class="kit">${slots}</div><p class="hint">Klicke auf ein Feld, um ein Item zu wählen. Die Anordnung entspricht dem Kistenmenü im Spiel.</p></div>`;
}

function editSlot(slot) {
  const existing = draft.starter_kit.find((entry) => entry.slot === slot);
  const item = existing ? JSON.parse(JSON.stringify(existing)) : { slot, type: "", amount: 1, enchantments: {} };
  item.enchantments ||= {};
  const isPotion = () => /potion|tipped_arrow/.test(item.type);

  const sync = (dialog) => {
    item.type = dialog.querySelector("#kit-type").value.trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
    item.amount = Math.round(Number(dialog.querySelector("#kit-amount").value)) || 1;
    item.name = dialog.querySelector("#kit-name").value.trim();
    const potion = dialog.querySelector("#kit-potion");
    if (potion) item.potion = potion.value;
    dialog.querySelectorAll("[data-ench-level]").forEach((input) => { item.enchantments[input.dataset.enchLevel] = Number(input.value) || 1; });
  };

  const draw = () => {
    const free = kitOptions.enchantments.filter((enchantment) => !(enchantment.id in item.enchantments));
    const dialog = openDialog(`<h3>Feld ${slot + 1}</h3>
      <label class="field"><span>Item (tippen zum Suchen)</span><input type="text" id="kit-type" list="kit-items" value="${esc(item.type)}" autocomplete="off"></label>
      <datalist id="kit-items">${kitOptions.items.map((entry) => `<option value="${entry.id}"></option>`).join("")}</datalist>
      <label class="field"><span>Menge</span><input type="number" id="kit-amount" min="1" max="99" value="${item.amount}"></label>
      <label class="field"><span>Name (optional)</span><input type="text" id="kit-name" maxlength="50" value="${esc(item.name)}"></label>
      ${isPotion() ? `<label class="field"><span>Trank</span><select id="kit-potion">${kitOptions.potions.map((potion) => `<option value="${potion}"${potion === item.potion ? " selected" : ""}>${esc(prettyId(potion))}</option>`).join("")}</select></label>` : ""}
      <div class="field"><span class="meta">Verzauberungen</span>
        <div class="row-list">${Object.entries(item.enchantments).map(([id, level]) => {
          const max = kitOptions.enchantments.find((enchantment) => enchantment.id === id)?.maxLevel ?? 255;
          return `<div class="row"><span class="grow">${esc(prettyId(id))}</span><input type="number" min="1" max="${Math.max(max, 255)}" value="${level}" data-ench-level="${esc(id)}" aria-label="Stufe" style="width:80px"><button type="button" class="ghost" data-ench-remove="${esc(id)}" aria-label="Entfernen">×</button></div>`;
        }).join("")}</div>
        <div class="row" style="margin-top:6px"><select id="kit-ench-new" class="grow" style="flex:1" aria-label="Verzauberung">${free.map((enchantment) => `<option value="${enchantment.id}">${esc(prettyId(enchantment.id))}</option>`).join("")}</select><button type="button" class="ghost" id="kit-ench-add">Hinzufügen</button></div>
      </div>
      <div class="dialog-actions">
        ${existing ? `<button type="button" class="danger" id="kit-clear">Leeren</button>` : ""}
        <button type="button" class="ghost" id="kit-cancel">Abbrechen</button>
        <button type="button" id="kit-save">Übernehmen</button>
      </div>`);
    dialog.querySelector("#kit-cancel").onclick = () => dialog.close();
    dialog.querySelector("#kit-type").onchange = () => { sync(dialog); draw(); };
    dialog.querySelector("#kit-ench-add").onclick = () => {
      sync(dialog);
      const id = dialog.querySelector("#kit-ench-new").value;
      if (id) item.enchantments[id] = 1;
      draw();
    };
    dialog.querySelectorAll("[data-ench-remove]").forEach((button) => {
      button.onclick = () => { sync(dialog); delete item.enchantments[button.dataset.enchRemove]; draw(); };
    });
    const commit = (entries) => {
      draft.starter_kit = entries.sort((a, b) => a.slot - b.slot);
      saveDraft();
      dialog.close();
      renderBuilder();
    };
    const others = () => draft.starter_kit.filter((entry) => entry.slot !== slot);
    const clear = dialog.querySelector("#kit-clear");
    if (clear) clear.onclick = () => commit(others());
    dialog.querySelector("#kit-save").onclick = () => {
      sync(dialog);
      const known = kitOptions.itemById[item.type];
      if (!known) { toast("Dieses Item gibt es nicht.", true); return; }
      const result = { slot, type: item.type, amount: Math.max(1, Math.min(item.amount, known.maxStack)) };
      if (item.name) result.name = item.name;
      if (Object.keys(item.enchantments).length) result.enchantments = item.enchantments;
      if (isPotion()) result.potion = item.potion || kitOptions.potions[0];
      commit([...others(), result]);
    };
  };
  draw();
}

function renderBuilder() {
  const open = new Set([...document.querySelectorAll("#builder-body details[open]")].map((item) => item.dataset.detail));
  const challenges = catalog.filter((toggle) => toggle.kind === "challenge").sort((a, b) => a.page - b.page || a.slot - b.slot);
  const submenuGroups = Object.values(SUBMENUS);
  const groups = [...new Set(catalog.filter((toggle) => toggle.kind === "setting" && !submenuGroups.includes(toggle.group)).map((toggle) => toggle.group))]
    .sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
  let html = `<h3 class="group-title">Challenges</h3><div class="cards">${challenges.map(cardHtml).join("")}</div>`;
  for (const group of groups) {
    const items = catalog.filter((toggle) => toggle.kind === "setting" && toggle.group === group && relevant(toggle, draft.toggles));
    if (items.length) html += `<h3 class="group-title">${esc(GROUP_TITLES[group] || group)}</h3><div class="cards">${items.map(cardHtml).join("")}</div>`;
  }
  const selected = activeChallenges(draft);
  const canPropose = selected.length > 0 && draft.name.trim() && state.can_submit;
  const action = state.user
    ? `<button id="propose"${canPropose ? "" : " disabled"}>Challenge vorschlagen</button>`
    : `<a class="button" href="${esc(loginUrl())}">Zum Vorschlagen einloggen</a>`;
  const limitHint = state.user && !state.can_submit ? `<div class="warn">Du hast diese Woche schon etwas eingereicht. Ab Montag geht es wieder.</div>` : "";
  const summary = `<aside class="panel summary">
    <label class="field"><span>Name der Challenge</span><input type="text" id="draft-name" maxlength="64" value="${esc(draft.name)}"></label>
    <label class="field"><span>Beschreibung</span><textarea id="draft-description" rows="3" maxlength="1000">${esc(draft.description)}</textarea></label>
    ${selected.length ? configTags(draft) : `<p class="meta">Wähle mindestens eine Challenge aus.</p>`}
    <div class="row-actions" style="margin-top:12px">${action}<button class="ghost" id="reset-draft">Zurücksetzen</button></div>
    ${limitHint}
    <p class="hint">Eine Einreichung pro Woche. Gibt es dasselbe Setup schon, wirst du dort als weitere Person eingetragen.</p>
  </aside>`;
  const body = $("#builder-body");
  body.innerHTML = `<div class="builder"><div>${html}</div>${summary}</div>`;
  body.querySelectorAll("details[data-detail]").forEach((item) => { if (open.has(item.dataset.detail)) item.open = true; });
  body.querySelectorAll("[data-slot]").forEach((button) => { button.onclick = () => editSlot(Number(button.dataset.slot)); });
  body.querySelectorAll("[data-toggle]").forEach((input) => {
    input.onchange =() => { draft.toggles[input.dataset.toggle].value = input.checked; saveDraft(); renderBuilder(); };
  });
  body.querySelectorAll("[data-amount]").forEach((input) => {
    input.onchange = () => {
      draft.toggles[input.dataset.amount].setAmount = Math.min(100000, Math.max(1, Math.round(Number(input.value)) || 1));
      saveDraft();
      renderBuilder();
    };
  });
  body.querySelectorAll("[data-mode]").forEach((input) => {
    input.onchange = () => { draft.toggles[input.dataset.mode].currentMode = Number(input.value); saveDraft(); renderBuilder(); };
  });
  $("#draft-name").oninput = (event) => {
    draft.name = event.target.value;
    saveDraft();
    const button = $("#propose");
    if (button) button.disabled = !(activeChallenges(draft).length && draft.name.trim() && state.can_submit);
  };
  $("#draft-description").oninput = (event) => { draft.description = event.target.value; saveDraft(); };
  $("#reset-draft").onclick = () => { draft = freshDraft(); saveDraft(); renderBuilder(); };
  const propose = $("#propose");
  if (propose) propose.onclick = async () => {
    const created = await run(() => api("proposals", "POST", { name: draft.name, description: draft.description, config: { toggles: draft.toggles, starter_kit: draft.starter_kit } }));
    if (created) {
      toast(created.merged ? "Dieses Setup gab es schon, du stehst jetzt mit auf dem Vorschlag." : "Vorschlag eingereicht.");
      draft = freshDraft();
      saveDraft();
      refresh();
      $("#vorschlaege").scrollIntoView();
    }
  };
}

/* Proposals */

function presetJson(proposal) {
  const preset = {};
  for (const toggle of catalog) {
    const chosen = proposal.config.toggles[toggle.id] || {};
    const entry = { display: toggle.display, value: chosen.value ?? toggle.value, setAmount: chosen.setAmount ?? toggle.setAmount };
    if (toggle.modes) entry.currentMode = Math.min(chosen.currentMode ?? toggle.currentMode, toggle.modes.length - 1);
    if (toggle.lore1) entry.lore1 = toggle.lore1;
    if (toggle.lore2) entry.lore2 = toggle.lore2;
    preset[toggle.id] = entry;
  }
  preset._starter_kit = proposal.config.starter_kit || [];
  return JSON.stringify(preset, null, 2);
}

function presetFileName(proposal) {
  const base = proposal.name.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return `${base || `challenge_${proposal.id}`}.json`;
}

function downloadPreset(proposal) {
  const url = URL.createObjectURL(new Blob([presetJson(proposal)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = presetFileName(proposal);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderProposals() {
  const body = $("#proposals-body");
  if (!state.proposals.length) {
    body.innerHTML = `<div class="panel empty">Noch keine Vorschläge. Baue oben die erste Challenge.</div>`;
    return;
  }
  body.innerHTML = `<div class="row-list">${state.proposals.map((proposal) => {
    const canDelete = isAdmin() || proposal.authors.some((author) => author.id === state.user?.id);
    const withdraws = !isAdmin() && proposal.authors.length > 1;
    return `<article class="panel row">
      <div class="grow">
        <div class="option-title">${activeChallenges(proposal.config).slice(0, 4).map((toggle) => icon(toggle.id)).join("")}<h3>${esc(proposal.name)}</h3></div>
        <div class="meta">von ${esc(proposal.author)}</div>
        ${proposal.description ? `<div>${esc(proposal.description)}</div>` : ""}
        ${configTags(proposal.config)}
      </div>
      <div class="row-actions">
        ${isAdmin() ? `<button class="ghost" data-preset="${proposal.id}">Preset herunterladen</button>` : ""}
        ${canDelete ? `<button class="danger" data-delete="${proposal.id}">${withdraws ? "Zurückziehen" : "Löschen"}</button>` : ""}
      </div>
    </article>`;
  }).join("")}</div>`;
  body.querySelectorAll("[data-preset]").forEach((button) => { button.onclick = () => downloadPreset(proposalById(Number(button.dataset.preset))); });
  body.querySelectorAll("[data-delete]").forEach((button) => {
    const withdraws = button.textContent === "Zurückziehen";
    button.onclick = () => confirmAction(withdraws ? "Deinen Namen von diesem Vorschlag entfernen?" : "Vorschlag löschen?", async () => {
      await run(() => api(`proposals/${button.dataset.delete}`, "DELETE"), withdraws ? "Name entfernt." : "Vorschlag gelöscht.");
      refresh();
    });
  });
}

function confirmAction(question, action) {
  const dialog = openDialog(`<h3>${esc(question)}</h3><div class="dialog-actions"><button class="ghost" id="no">Abbrechen</button><button class="danger" id="yes">Löschen</button></div>`);
  dialog.querySelector("#no").onclick = () => dialog.close();
  dialog.querySelector("#yes").onclick = () => { dialog.close(); action(); };
}

/* Admin */

async function renderAdmin() {
  const admin = isAdmin();
  $("#admin").hidden = !admin;
  $("#nav-admin").hidden = !admin;
  if (!admin) return;
  const running = state.voting?.status === "open";
  const today = dateKey(new Date());
  const events = state.events.filter((event) => event.date >= today);
  const form = running
    ? `<p class="meta">Es läuft bereits ein Voting. Beende es, bevor du ein neues startest.</p>`
    : state.proposals.length < 2
      ? `<p class="meta">Für ein Voting braucht es mindestens zwei Vorschläge.</p>`
      : `<form id="voting-form">
        <label class="field"><span>Titel</span><input type="text" name="title" maxlength="80" required></label>
        <label class="field"><span>Für Termin (optional, der Gewinner wird dort eingetragen)</span><select name="event"><option value="">Kein Termin</option>${events.map((event) => `<option value="${event.id}">${esc(event.date.split("-").reverse().join("."))} ${esc(event.title)}</option>`).join("")}</select></label>
        <div class="field">${state.proposals.map((proposal) => `<label class="check"><input type="checkbox" name="proposal" value="${proposal.id}"><span>${esc(proposal.name)}</span></label>`).join("")}</div>
        <button type="submit">Voting starten</button>
      </form>`;
  $("#admin-body").innerHTML = `<div class="admin-grid">
    <div class="panel"><h3 style="margin-bottom:12px">Voting starten</h3>${form}</div>
    <div class="panel"><h3 style="margin-bottom:12px">Benutzer und Rollen</h3><div class="row-list" id="users">Lädt …</div></div>
  </div>`;
  const votingForm = $("#voting-form");
  if (votingForm) votingForm.onsubmit = async (submit) => {
    submit.preventDefault();
    const data = new FormData(votingForm);
    const body = { title: data.get("title"), event_id: data.get("event") ? Number(data.get("event")) : null, proposal_ids: data.getAll("proposal").map(Number) };
    const started = await run(() => api("votings", "POST", body));
    if (started) {
      toast(started.notified ? "Voting gestartet, Discord wird benachrichtigt." : "Voting gestartet, aber die Discord-Benachrichtigung ist fehlgeschlagen.", !started.notified);
      await refresh();
      $("#voting").scrollIntoView();
    }
  };
  const users = await run(() => api("users"));
  if (!users) return;
  const list = $("#users");
  list.innerHTML = users.users.map((user) => {
    const owner = user.id === users.owner_id;
    const button = owner ? `<span class="tag">Besitzer</span>` : user.role === "admin"
      ? `<button class="danger" data-role="user" data-user="${esc(user.id)}">Admin entziehen</button>`
      : `<button class="ghost" data-role="admin" data-user="${esc(user.id)}">Zum Admin machen</button>`;
    const multi = `<button class="ghost" data-multi="${user.multi_submit ? "off" : "on"}" data-user="${esc(user.id)}">${user.multi_submit ? "Wochenlimit aktivieren" : "Mehrere Einreichungen freigeben"}</button>`;
    return `<div class="row"><div class="grow">${esc(user.display_name || user.username)} <span class="meta">@${esc(user.username)}</span></div><div class="row-actions">${multi}${button}</div></div>`;
  }).join("");
  list.querySelectorAll("[data-multi]").forEach((button) => {
    button.onclick = async () => {
      await run(() => api(`users/${button.dataset.user}/multi-submit`, "POST", { enabled: button.dataset.multi === "on" }), "Freigabe geändert.");
      refresh();
    };
  });
  list.querySelectorAll("[data-role]").forEach((button) => {
    button.onclick = async () => {
      await run(() => api(`users/${button.dataset.user}/role`, "POST", { role: button.dataset.role }), "Rolle geändert.");
      renderAdmin();
    };
  });
}

/* Start */

function renderShared() {
  renderAccount();
  renderCalendar();
  renderVoting();
}

async function refresh() {
  const next = await run(() => api("state"));
  if (next) state = next;
  const linked = new URLSearchParams(location.search).get("voting");
  linkedVoting = null;
  if (linked && Number(linked) !== state.voting?.id) {
    linkedVoting = (await run(() => api(`votings/${encodeURIComponent(linked)}`))) || null;
  }
  renderShared();
  renderBuilder();
  renderProposals();
  await renderAdmin();
}

async function poll() {
  if (document.hidden || $("#dialog").open) return;
  try {
    state = await api("state");
    if (linkedVoting) linkedVoting = await api(`votings/${linkedVoting.id}`);
    renderCalendar();
    renderVoting();
  } catch { /* the next poll tries again */ }
}

function takeTokenFromUrl() {
  const hash = location.hash;
  if (hash.startsWith("#token=")) {
    store("set", TOKEN_KEY, hash.slice(7));
    history.replaceState(null, "", location.pathname + location.search);
  } else if (hash === "#login-error") {
    history.replaceState(null, "", location.pathname + location.search);
    toast("Der Discord-Login ist fehlgeschlagen.", true);
  }
}

function bindCalendar() {
  $("#prev-month").onclick = () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); renderCalendar(); };
  $("#next-month").onclick = () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); renderCalendar(); };
  const open = (target) => {
    const eventElement = target.closest("[data-event]");
    if (eventElement) {
      showEvent(state.events.find((event) => event.id === Number(eventElement.dataset.event)));
      return;
    }
    const day = target.closest("button[data-date]");
    if (day) editEvent(null, day.dataset.date);
  };
  $("#calendar").onclick = (event) => open(event.target);
  $("#calendar").onkeydown = (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-event]")) {
      event.preventDefault();
      event.stopPropagation();
      open(event.target);
    }
  };
}

async function init() {
  takeTokenFromUrl();
  const [catalogData, descriptionData] = await Promise.all([
    fetch("catalog.json", { cache: "no-cache" }).then((response) => response.json()),
    fetch("descriptions.json", { cache: "no-cache" }).then((response) => response.json()),
  ]);
  catalog = catalogData.toggles;
  byId = Object.fromEntries(catalog.map((toggle) => [toggle.id, toggle]));
  descriptions = descriptionData;
  const items = catalogData.items || [];
  kitOptions = {
    items,
    itemById: Object.fromEntries(items.map((item) => [item.id, item])),
    enchantments: catalogData.enchantments || [],
    potions: catalogData.potions || [],
  };
  loadDraft();
  bindCalendar();
  await refresh();
  if (new URLSearchParams(location.search).has("voting")) $("#voting").scrollIntoView();
  setInterval(poll, 20000);
}

init();
