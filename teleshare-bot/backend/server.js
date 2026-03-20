// backend/server.js  — v2 con utenti + broadcast + stats avanzate
const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const path     = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── MONGOOSE CONNECTION ──────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).then(() => console.log("✅ MongoDB connesso"));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────

const FileSchema = new mongoose.Schema({
    token:            { type: String, unique: true, required: true },
    telegram_file_id: { type: String, required: true },
    type:             { type: String, enum: ["photo", "video", "document"], required: true },
    caption:          { type: String, default: "" },
    uploaded_by:      Number,
    views:            { type: Number, default: 0 },
    created_at:       { type: Date, default: Date.now },
});

const UserSchema = new mongoose.Schema({
    user_id:    { type: Number, unique: true, required: true },
    username:   { type: String, default: "" },
    first_name: { type: String, default: "" },
    last_name:  { type: String, default: "" },
    is_blocked: { type: Boolean, default: false },
    first_seen: { type: Date, default: Date.now },
    last_seen:  { type: Date, default: Date.now },
});

const BroadcastSchema = new mongoose.Schema({
    text:       String,
    sent_by:    Number,
    sent_at:    { type: Date, default: Date.now },
    total:      Number,
    delivered:  Number,
    blocked:    Number,
    failed:     Number,
});

const File      = mongoose.model("File",      FileSchema);
const User      = mongoose.model("User",      UserSchema);
const Broadcast = mongoose.model("Broadcast", BroadcastSchema);

// ─── FILE ROUTES ──────────────────────────────────────────────────────────────

app.post("/file/save", async (req, res) => {
    try {
        const { token, telegram_file_id, type, caption, uploaded_by } = req.body;
        const file = new File({ token, telegram_file_id, type, caption, uploaded_by });
        await file.save();
        res.json({ ok: true, token });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/file/:token", async (req, res) => {
    try {
        const file = await File.findOne({ token: req.params.token });
        if (!file) return res.json({ error: "Not found" });
        file.views += 1;
        await file.save();
        res.json(file);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/files", async (req, res) => {
    try {
        const files = await File.find().sort({ created_at: -1 }).limit(100);
        res.json({ files });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/file/delete", async (req, res) => {
    try {
        const result = await File.deleteOne({ token: req.body.token });
        if (result.deletedCount === 0) return res.json({ ok: false });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false }); }
});

// ─── USER ROUTES ──────────────────────────────────────────────────────────────

// Traccia / aggiorna utente
app.post("/user/track", async (req, res) => {
    try {
        const { user_id, username, first_name, last_name } = req.body;
        await User.findOneAndUpdate(
            { user_id },
            { $set: { username, first_name, last_name, last_seen: new Date(), is_blocked: false },
              $setOnInsert: { first_seen: new Date() } },
            { upsert: true, new: true }
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false }); }
});

// Segna utente come bloccato
app.post("/user/blocked", async (req, res) => {
    try {
        await User.updateOne({ user_id: req.body.user_id }, { $set: { is_blocked: true } });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false }); }
});

// Tutti gli utenti attivi (per broadcast)
app.get("/users/all", async (req, res) => {
    try {
        const users = await User.find({ is_blocked: false }, { user_id: 1 });
        res.json({ users });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lista utenti paginata (per dashboard)
app.get("/users/list", async (req, res) => {
    try {
        const page  = parseInt(req.query.page)  || 1;
        const limit = parseInt(req.query.limit) || 50;
        const users = await User.find()
            .sort({ last_seen: -1 })
            .skip((page - 1) * limit)
            .limit(limit);
        const total = await User.countDocuments();
        res.json({ users, total, page });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Statistiche utenti
app.get("/users/stats", async (req, res) => {
    try {
        const now    = new Date();
        const d7     = new Date(now - 7  * 86400000);
        const d30    = new Date(now - 30 * 86400000);
        const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const [total, active_7d, active_30d, new_today, new_7d, blocked] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ last_seen:  { $gte: d7 },    is_blocked: false }),
            User.countDocuments({ last_seen:  { $gte: d30 },   is_blocked: false }),
            User.countDocuments({ first_seen: { $gte: today } }),
            User.countDocuments({ first_seen: { $gte: d7 } }),
            User.countDocuments({ is_blocked: true }),
        ]);

        // Crescita giornaliera ultimi 14gg
        const growth = await User.aggregate([
            { $match: { first_seen: { $gte: new Date(now - 14 * 86400000) } } },
            { $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$first_seen" } },
                count: { $sum: 1 }
            }},
            { $sort: { _id: 1 } }
        ]);

        res.json({ total, active_7d, active_30d, new_today, new_7d, blocked, growth });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── BROADCAST ROUTES ─────────────────────────────────────────────────────────

// Salva storico broadcast
app.post("/broadcast/save", async (req, res) => {
    try {
        const b = new Broadcast(req.body);
        await b.save();
        res.json({ ok: true, id: b._id });
    } catch (err) { res.status(500).json({ ok: false }); }
});

// Storico broadcast
app.get("/broadcast/history", async (req, res) => {
    try {
        const history = await Broadcast.find().sort({ sent_at: -1 }).limit(20);
        res.json({ history });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GLOBAL STATS ─────────────────────────────────────────────────────────────

app.get("/stats", async (req, res) => {
    try {
        const now  = new Date();
        const d7   = new Date(now - 7 * 86400000);

        const [total_files, photos, videos, docs, total_users, active_7d, views_agg] = await Promise.all([
            File.countDocuments(),
            File.countDocuments({ type: "photo" }),
            File.countDocuments({ type: "video" }),
            File.countDocuments({ type: "document" }),
            User.countDocuments(),
            User.countDocuments({ last_seen: { $gte: d7 }, is_blocked: false }),
            File.aggregate([{ $group: { _id: null, total: { $sum: "$views" } } }]),
        ]);

        res.json({
            total_files, photos, videos, docs,
            total_users, active_7d,
            total_views: views_agg[0]?.total || 0,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`🚀 Server su porta ${PORT}`));
