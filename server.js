// ╔══════════════════════════════════════════════════════╗
// ║  TELESHARE — server.js                              ║
// ║  Tutto in un file: API + Dashboard HTML             ║
// ╚══════════════════════════════════════════════════════╝

const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── DATABASE ──────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connesso"))
  .catch(e  => console.error("❌ MongoDB errore:", e));

const FileSchema = new mongoose.Schema({
  token:            { type: String, unique: true, required: true },
  telegram_file_id: { type: String, required: true },
  type:             { type: String, default: "video" },
  caption:          { type: String, default: "" },
  uploaded_by:      Number,
  views:            { type: Number, default: 0 },
  created_at:       { type: Date, default: Date.now },
});

const UserSchema = new mongoose.Schema({
  user_id:    { type: Number, unique: true, required: true },
  username:   { type: String, default: "" },
  first_name: { type: String, default: "" },
  is_blocked: { type: Boolean, default: false },
  first_seen: { type: Date, default: Date.now },
  last_seen:  { type: Date, default: Date.now },
});

const BroadcastSchema = new mongoose.Schema({
  text:      String,
  sent_at:   { type: Date, default: Date.now },
  total:     Number,
  delivered: Number,
  blocked:   Number,
});

const File      = mongoose.model("File",      FileSchema);
const User      = mongoose.model("User",      UserSchema);
const Broadcast = mongoose.model("Broadcast", BroadcastSchema);

// ── API FILE ──────────────────────────────────────────
app.post("/file/save", async (req, res) => {
  try {
    const f = new File(req.body);
    await f.save();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/file/:token", async (req, res) => {
  try {
    const f = await File.findOne({ token: req.params.token });
    if (!f) return res.json({ error: "Not found" });
    f.views++; await f.save();
    res.json(f);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/files", async (req, res) => {
  try {
    const files = await File.find().sort({ created_at: -1 }).limit(100);
    res.json({ files });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/file/delete", async (req, res) => {
  try {
    const r = await File.deleteOne({ token: req.body.token });
    res.json({ ok: r.deletedCount > 0 });
  } catch(e) { res.status(500).json({ ok: false }); }
});

// ── API UTENTI ────────────────────────────────────────
app.post("/user/track", async (req, res) => {
  try {
    const { user_id, username, first_name } = req.body;
    await User.findOneAndUpdate(
      { user_id },
      { $set: { username, first_name, last_seen: new Date(), is_blocked: false },
        $setOnInsert: { first_seen: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false }); }
});

app.post("/user/blocked", async (req, res) => {
  try {
    await User.updateOne({ user_id: req.body.user_id }, { $set: { is_blocked: true } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false }); }
});

app.get("/users/all", async (req, res) => {
  try {
    const users = await User.find({ is_blocked: false }, { user_id: 1 });
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/users/stats", async (req, res) => {
  try {
    const now   = new Date();
    const d7    = new Date(now - 7  * 86400000);
    const d30   = new Date(now - 30 * 86400000);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [total, active_7d, active_30d, new_today, blocked] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ last_seen: { $gte: d7 }, is_blocked: false }),
      User.countDocuments({ last_seen: { $gte: d30 }, is_blocked: false }),
      User.countDocuments({ first_seen: { $gte: today } }),
      User.countDocuments({ is_blocked: true }),
    ]);
    const growth = await User.aggregate([
      { $match: { first_seen: { $gte: new Date(now - 14 * 86400000) } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$first_seen" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    res.json({ total, active_7d, active_30d, new_today, blocked, growth });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/users/list", async (req, res) => {
  try {
    const users = await User.find().sort({ last_seen: -1 }).limit(100);
    const total = await User.countDocuments();
    res.json({ users, total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API BROADCAST ─────────────────────────────────────
app.post("/broadcast/save", async (req, res) => {
  try {
    const b = new Broadcast(req.body);
    await b.save();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false }); }
});

app.get("/broadcast/history", async (req, res) => {
  try {
    const history = await Broadcast.find().sort({ sent_at: -1 }).limit(20);
    res.json({ history });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STATS GLOBALI ─────────────────────────────────────
app.get("/stats", async (req, res) => {
  try {
    const d7 = new Date(Date.now() - 7 * 86400000);
    const [total_files, photos, videos, total_users, active_7d, va] = await Promise.all([
      File.countDocuments(),
      File.countDocuments({ type: "photo" }),
      File.countDocuments({ type: "video" }),
      User.countDocuments(),
      User.countDocuments({ last_seen: { $gte: d7 }, is_blocked: false }),
      File.aggregate([{ $group: { _id: null, total: { $sum: "$views" } } }]),
    ]);
    res.json({ total_files, photos, videos, total_users, active_7d, total_views: va[0]?.total || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD HTML (tutto inline) ─────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeleShare Admin</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--s:#111118;--b:#1e1e2e;--blue:#5b8cff;--cyan:#06d6a0;--pink:#ff5b8c;--gold:#ffd166;--t:#e2e2f0;--m:#555570;--r:10px}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--t);font-family:'Syne',sans-serif;min-height:100vh}
.wrap{max-width:1100px;margin:0 auto;padding:36px 20px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px}
.logo{font-size:22px;font-weight:800;letter-spacing:-.5px}
.logo span{color:var(--cyan)}
.badge{padding:6px 14px;border-radius:20px;border:1px solid var(--b);font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--cyan);display:flex;align-items:center;gap:6px}
.badge::before{content:'';width:7px;height:7px;background:var(--cyan);border-radius:50%;animation:pulse 2s infinite}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:32px}
@media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr)}}
.card{background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:18px 20px}
.card-label{font-size:10px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.card-val{font-size:28px;font-weight:800;font-family:'JetBrains Mono',monospace}
.blue{color:var(--blue)}.cyan{color:var(--cyan)}.pink{color:var(--pink)}.gold{color:var(--gold)}
.panels{display:grid;grid-template-columns:340px 1fr;gap:18px}
@media(max-width:900px){.panels{grid-template-columns:1fr}}
.panel{background:var(--s);border:1px solid var(--b);border-radius:var(--r);padding:24px}
.panel-title{font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:18px}
.field{margin-bottom:14px}
.field label{display:block;font-size:10px;color:var(--m);font-family:'JetBrains Mono',monospace;margin-bottom:6px;text-transform:uppercase}
.field input,.field textarea{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--b);border-radius:7px;color:var(--t);font-family:'JetBrains Mono',monospace;font-size:12px;outline:none;transition:border-color .2s}
.field input:focus,.field textarea:focus{border-color:var(--blue)}
.field textarea{resize:vertical;min-height:100px}
.btn{width:100%;padding:12px;border:none;border-radius:7px;cursor:pointer;font-family:'Syne',sans-serif;font-weight:700;font-size:13px;transition:all .2s;margin-bottom:8px}
.btn-blue{background:linear-gradient(135deg,var(--blue),#3a6bff);color:#fff}
.btn-pink{background:linear-gradient(135deg,var(--pink),#d63e6b);color:#fff}
.btn-green{background:linear-gradient(135deg,var(--cyan),#04a57a);color:#000}
.btn:hover{opacity:.85;transform:translateY(-1px)}
.divider{border:none;border-top:1px solid var(--b);margin:18px 0}
.notif{padding:10px 14px;border-radius:7px;font-size:11px;font-family:'JetBrains Mono',monospace;margin-top:10px;display:none}
.notif.ok{background:rgba(6,214,160,.1);border:1px solid rgba(6,214,160,.3);color:var(--cyan);display:block}
.notif.err{background:rgba(255,91,140,.1);border:1px solid rgba(255,91,140,.3);color:var(--pink);display:block}
.file-list{display:flex;flex-direction:column;gap:8px;max-height:480px;overflow-y:auto}
.file-item{background:var(--bg);border:1px solid var(--b);border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:12px;transition:border-color .2s}
.file-item:hover{border-color:var(--blue)}
.fi-icon{width:34px;height:34px;border-radius:7px;display:grid;place-items:center;font-size:16px;flex-shrink:0}
.fi-info{flex:1;min-width:0}
.fi-token{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--blue);margin-bottom:2px}
.fi-meta{font-size:10px;color:var(--m)}
.icon-btn{width:28px;height:28px;border-radius:5px;border:none;cursor:pointer;display:grid;place-items:center;font-size:12px;background:var(--b);color:var(--m);transition:all .2s}
.icon-btn:hover{transform:scale(1.1);color:var(--t)}
.search{width:100%;padding:9px 12px;background:var(--bg);border:1px solid var(--b);border-radius:7px;color:var(--t);font-family:'JetBrains Mono',monospace;font-size:11px;outline:none;margin-bottom:12px}
.search:focus{border-color:var(--blue)}
.tabs{display:flex;gap:8px;margin-bottom:18px}
.tab{padding:7px 14px;border-radius:7px;border:1px solid var(--b);background:none;color:var(--m);font-family:'Syne',sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s}
.tab.active{background:var(--blue);color:#fff;border-color:var(--blue)}
.section{display:none}.section.active{display:block}
.toast{position:fixed;bottom:24px;right:24px;background:var(--s);border:1px solid var(--blue);color:var(--t);padding:10px 18px;border-radius:9px;font-size:12px;font-family:'JetBrains Mono',monospace;transform:translateY(60px);opacity:0;transition:all .3s cubic-bezier(.34,1.56,.64,1);z-index:999}
.toast.show{transform:translateY(0);opacity:1}
.users-table{width:100%;border-collapse:collapse;font-size:11px}
.users-table th{text-align:left;padding:7px 10px;color:var(--m);font-size:10px;text-transform:uppercase;border-bottom:1px solid var(--b)}
.users-table td{padding:9px 10px;border-bottom:1px solid var(--b);color:var(--t)}
.users-table tr:last-child td{border:none}
.users-table tr:hover td{background:rgba(255,255,255,.02)}
.tag{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px}
.tag-ok{background:rgba(6,214,160,.15);color:var(--cyan)}
.tag-no{background:rgba(255,91,140,.12);color:var(--pink)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">Tele<span>Share</span> Admin</div>
    <div class="badge">Online</div>
  </header>

  <div class="stats">
    <div class="card"><div class="card-label">Utenti</div><div class="card-val blue" id="sU">—</div></div>
    <div class="card"><div class="card-label">Attivi 7gg</div><div class="card-val cyan" id="sA">—</div></div>
    <div class="card"><div class="card-label">File</div><div class="card-val pink" id="sF">—</div></div>
    <div class="card"><div class="card-label">Views</div><div class="card-val gold" id="sV">—</div></div>
  </div>

  <div class="panels">
    <!-- SINISTRA -->
    <div class="panel">
      <div class="panel-title">⚙️ Configurazione</div>
      <div class="field"><label>Bot Username</label><input id="cfgBot" placeholder="miobot_bot"></div>
      <button class="btn btn-blue" onclick="saveConfig()">💾 Salva</button>
      <div class="notif" id="cfgNotif"></div>

      <hr class="divider">

      <div class="panel-title">📢 Broadcast</div>
      <div class="field"><label>Messaggio da inviare a tutti</label><textarea id="bcText" placeholder="Scrivi il messaggio..."></textarea></div>
      <button class="btn btn-pink" onclick="saveBroadcast()">📤 Salva broadcast</button>
      <div class="notif" id="bcNotif"></div>
      <p style="font-size:10px;color:var(--m);margin-top:8px">Dopo aver salvato, usa /broadcast TESTO sul bot Telegram per inviarlo</p>
    </div>

    <!-- DESTRA -->
    <div class="panel">
      <div class="tabs">
        <button class="tab active" onclick="showTab('files')">📂 File</button>
        <button class="tab" onclick="showTab('users')">👥 Utenti</button>
      </div>

      <!-- FILE -->
      <div class="section active" id="tab-files">
        <input class="search" placeholder="Cerca token..." oninput="filterFiles(this.value)">
        <div class="file-list" id="fileList"></div>
      </div>

      <!-- UTENTI -->
      <div class="section" id="tab-users">
        <input class="search" placeholder="Cerca username o ID..." oninput="filterUsers(this.value)">
        <div style="overflow-x:auto">
          <table class="users-table">
            <thead><tr><th>ID</th><th>Username</th><th>Nome</th><th>Prima visita</th><th>Stato</th></tr></thead>
            <tbody id="usersBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let cfg = { bot: localStorage.getItem('bot') || '' };
let allFiles = [], allUsers = [];
document.getElementById('cfgBot').value = cfg.bot;

function saveConfig() {
  cfg.bot = document.getElementById('cfgBot').value.trim().replace('@','');
  localStorage.setItem('bot', cfg.bot);
  showNotif('cfgNotif','ok','✅ Salvato!');
  loadAll();
}

async function api(path, method='GET', body=null) {
  const opts = { method, headers: {'Content-Type':'application/json'} };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  return r.json();
}

async function loadAll() {
  try {
    const [stats, files, users] = await Promise.all([
      api('/stats'), api('/files'), api('/users/list')
    ]);
    document.getElementById('sU').textContent = stats.total_users ?? '—';
    document.getElementById('sA').textContent = stats.active_7d   ?? '—';
    document.getElementById('sF').textContent = stats.total_files ?? '—';
    document.getElementById('sV').textContent = stats.total_views ?? '—';
    allFiles = files.files || [];
    allUsers = users.users || [];
    renderFiles(allFiles);
    renderUsers(allUsers);
  } catch(e) {}
}

function renderFiles(files) {
  const el = document.getElementById('fileList');
  if (!files.length) { el.innerHTML = '<div style="color:var(--m);font-size:12px;text-align:center;padding:24px">Nessun file caricato</div>'; return; }
  el.innerHTML = files.map(f => {
    const icons = {video:'🎬', photo:'🖼️', document:'📄'};
    const link = cfg.bot ? 'https://t.me/' + cfg.bot + '?start=' + f.token : '#';
    return '<div class="file-item">'
      + '<div class="fi-icon" style="background:rgba(91,140,255,.15)">' + (icons[f.type]||'📦') + '</div>'
      + '<div class="fi-info"><div class="fi-token">' + f.token + '</div>'
      + '<div class="fi-meta">' + f.type + ' · 👁 ' + f.views + ' · ' + new Date(f.created_at).toLocaleDateString('it-IT') + '</div></div>'
      + '<button class="icon-btn" onclick="copyL(\'' + link + '\')" title="Copia link">📋</button>'
      + '<button class="icon-btn" onclick="delFile(\'' + f.token + '\')" title="Elimina">🗑</button>'
      + '</div>';
  }).join('');
}

function renderUsers(users) {
  const el = document.getElementById('usersBody');
  if (!users.length) { el.innerHTML = '<tr><td colspan="5" style="color:var(--m);text-align:center;padding:20px">Nessun utente</td></tr>'; return; }
  el.innerHTML = users.map(u => '<tr>'
    + '<td style="color:var(--m)">' + u.user_id + '</td>'
    + '<td style="color:var(--blue)">' + (u.username ? '@'+u.username : '—') + '</td>'
    + '<td>' + (u.first_name||'—') + '</td>'
    + '<td style="color:var(--m)">' + new Date(u.first_seen).toLocaleDateString('it-IT') + '</td>'
    + '<td><span class="tag ' + (u.is_blocked ? 'tag-no' : 'tag-ok') + '">' + (u.is_blocked ? 'bloccato' : 'attivo') + '</span></td>'
    + '</tr>').join('');
}

function filterFiles(q) { renderFiles(allFiles.filter(f => f.token.includes(q) || f.type.includes(q))); }
function filterUsers(q) { renderUsers(allUsers.filter(u => String(u.user_id).includes(q) || (u.username||'').toLowerCase().includes(q))); }

async function delFile(token) {
  if (!confirm('Eliminare questo file?')) return;
  const d = await api('/file/delete','POST',{token});
  if (d.ok) { showToast('✅ Eliminato'); loadAll(); }
}

function copyL(link) {
  if (link === '#') return showToast('⚠️ Salva prima il bot username!');
  navigator.clipboard.writeText(link).then(() => showToast('📋 Link copiato!'));
}

async function saveBroadcast() {
  const text = document.getElementById('bcText').value.trim();
  if (!text) return showNotif('bcNotif','err','⚠️ Scrivi un messaggio');
  const users = (await api('/users/all')).users || [];
  await api('/broadcast/save','POST',{ text, total: users.length, delivered: 0, blocked: 0 });
  showNotif('bcNotif','ok','✅ Salvato! Ora invia /broadcast ' + text.substring(0,20) + '... sul bot');
}

function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  event.target.classList.add('active');
}

function showNotif(id, type, msg) {
  const el = document.getElementById(id);
  el.className = 'notif ' + type;
  el.textContent = msg;
  setTimeout(() => el.className = 'notif', 4000);
}

let tt;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2500);
}

loadAll();
setInterval(loadAll, 30000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log("🚀 Server avviato su porta " + PORT));
