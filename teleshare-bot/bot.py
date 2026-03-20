import os
import asyncio
import logging
import uuid
from datetime import datetime, timezone
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    filters, ContextTypes, CallbackQueryHandler
)
import aiohttp

# ─── CONFIG ───────────────────────────────────────────────────────────────────
BOT_TOKEN   = os.environ["BOT_TOKEN"]
ADMIN_IDS   = [int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x]
BACKEND_URL = os.environ["BACKEND_URL"].rstrip("/")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
log = logging.getLogger(__name__)

# ─── HELPERS ──────────────────────────────────────────────────────────────────

def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_IDS

async def api_get(path: str):
    async with aiohttp.ClientSession() as s:
        async with s.get(f"{BACKEND_URL}{path}") as r:
            return await r.json()

async def api_post(path: str, payload: dict):
    async with aiohttp.ClientSession() as s:
        async with s.post(f"{BACKEND_URL}{path}", json=payload) as r:
            return await r.json()

async def track_user(user):
    """Registra/aggiorna l'utente nel database."""
    try:
        await api_post("/user/track", {
            "user_id":    user.id,
            "username":   user.username or "",
            "first_name": user.first_name or "",
            "last_name":  user.last_name or "",
        })
    except Exception as e:
        log.warning(f"Errore tracking utente: {e}")

# ─── COMMANDS ────────────────────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await track_user(user)
    args = ctx.args

    if args:
        token = args[0]
        await handle_token(update, ctx, token)
        return

    if is_admin(user.id):
        txt = (
            "👋 *Pannello Admin*\n\n"
            "📤 Invia un *video* o una *foto* → link unico\n\n"
            "📋 /lista — file caricati\n"
            "👥 /iscritti — statistiche utenti\n"
            "📢 /broadcast — messaggio a tutti\n"
            "🗑 /elimina `<token>` — rimuovi file"
        )
    else:
        txt = (
            "👋 Benvenuto!\n\n"
            "Usa un link condiviso per visualizzare un file.\n"
            "Esempio: `t.me/IlTuoBot?start=TOKEN`"
        )

    await update.message.reply_text(txt, parse_mode="Markdown")


async def handle_token(update: Update, ctx: ContextTypes.DEFAULT_TYPE, token: str):
    data = await api_get(f"/file/{token}")

    if data.get("error"):
        await update.message.reply_text("❌ Link non valido o file rimosso.")
        return

    file_id   = data["telegram_file_id"]
    file_type = data["type"]
    caption   = data.get("caption", "")

    if file_type == "photo":
        await update.message.reply_photo(file_id, caption=caption)
    elif file_type == "video":
        await update.message.reply_video(file_id, caption=caption)
    else:
        await update.message.reply_document(file_id, caption=caption)


async def cmd_lista(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        return

    data  = await api_get("/files")
    files = data.get("files", [])

    if not files:
        await update.message.reply_text("📂 Nessun file caricato.")
        return

    lines = ["📋 *File caricati:*\n"]
    bot_username = (await ctx.bot.get_me()).username
    for f in files[:20]:
        emoji = "🎬" if f["type"] == "video" else "🖼"
        link  = f"t.me/{bot_username}?start={f['token']}"
        lines.append(f"{emoji} `{f['token'][:8]}…` — 👁 {f['views']}\n🔗 {link}\n")

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


async def cmd_iscritti(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        return

    data = await api_get("/users/stats")

    txt = (
        f"👥 *Statistiche Iscritti*\n\n"
        f"📊 Totale utenti: *{data.get('total', 0)}*\n"
        f"🟢 Attivi (7gg): *{data.get('active_7d', 0)}*\n"
        f"🔵 Attivi (30gg): *{data.get('active_30d', 0)}*\n"
        f"📅 Nuovi oggi: *{data.get('new_today', 0)}*\n"
        f"📈 Nuovi questa settimana: *{data.get('new_7d', 0)}*"
    )
    await update.message.reply_text(txt, parse_mode="Markdown")


async def cmd_broadcast(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        return

    if not ctx.args:
        await update.message.reply_text(
            "📢 *Uso broadcast:*\n`/broadcast Testo del messaggio`\n\n"
            "_Il messaggio verrà inviato a tutti gli utenti registrati._",
            parse_mode="Markdown"
        )
        return

    message_text = " ".join(ctx.args)

    # Recupera tutti gli utenti
    data  = await api_get("/users/all")
    users = data.get("users", [])

    if not users:
        await update.message.reply_text("❌ Nessun utente registrato.")
        return

    progress_msg = await update.message.reply_text(
        f"📢 Invio in corso a *{len(users)}* utenti…", parse_mode="Markdown"
    )

    sent = 0
    failed = 0
    blocked = 0

    for u in users:
        try:
            await ctx.bot.send_message(
                chat_id=u["user_id"],
                text=f"📢 *Messaggio dall'admin:*\n\n{message_text}",
                parse_mode="Markdown"
            )
            sent += 1
            await asyncio.sleep(0.05)   # Rate limit Telegram: ~20 msg/s
        except Exception as e:
            err = str(e).lower()
            if "blocked" in err or "deactivated" in err or "not found" in err:
                blocked += 1
                # Segna come bloccato nel DB
                await api_post("/user/blocked", {"user_id": u["user_id"]})
            else:
                failed += 1

    await progress_msg.edit_text(
        f"✅ *Broadcast completato!*\n\n"
        f"📨 Inviati: *{sent}*\n"
        f"🚫 Bot bloccato: *{blocked}*\n"
        f"❌ Errori: *{failed}*",
        parse_mode="Markdown"
    )


async def cmd_elimina(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        return

    if not ctx.args:
        await update.message.reply_text("Uso: /elimina <token>")
        return

    token = ctx.args[0]
    res   = await api_post("/file/delete", {"token": token})

    if res.get("ok"):
        await update.message.reply_text(f"✅ File `{token[:8]}…` eliminato.", parse_mode="Markdown")
    else:
        await update.message.reply_text("❌ Token non trovato.")


# ─── MEDIA HANDLER (solo admin) ──────────────────────────────────────────────

async def handle_media(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("🚫 Solo gli admin possono caricare file.")
        return

    msg   = update.message
    token = str(uuid.uuid4()).replace("-", "")[:16]

    if msg.video:
        file_id   = msg.video.file_id
        file_type = "video"
    elif msg.photo:
        file_id   = msg.photo[-1].file_id
        file_type = "photo"
    elif msg.document:
        file_id   = msg.document.file_id
        file_type = "document"
    else:
        return

    caption = msg.caption or ""

    res = await api_post("/file/save", {
        "token":            token,
        "telegram_file_id": file_id,
        "type":             file_type,
        "caption":          caption,
        "uploaded_by":      user.id,
    })

    if not res.get("ok"):
        await update.message.reply_text("❌ Errore nel salvataggio.")
        return

    bot_username = (await ctx.bot.get_me()).username
    link = f"https://t.me/{bot_username}?start={token}"

    keyboard    = [[InlineKeyboardButton("🔗 Copia link", url=link)]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    text = (
        f"✅ *File salvato!*\n\n"
        f"🔑 Token: `{token}`\n"
        f"🔗 Link diretto:\n{link}\n\n"
        f"_Condividi questo link agli utenti._"
    )
    await msg.reply_text(text, parse_mode="Markdown", reply_markup=reply_markup)


# ─── HANDLER testo generico (registra utente) ─────────────────────────────────

async def handle_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await track_user(update.effective_user)


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start",     cmd_start))
    app.add_handler(CommandHandler("lista",     cmd_lista))
    app.add_handler(CommandHandler("iscritti",  cmd_iscritti))
    app.add_handler(CommandHandler("broadcast", cmd_broadcast))
    app.add_handler(CommandHandler("elimina",   cmd_elimina))
    app.add_handler(MessageHandler(
        filters.VIDEO | filters.PHOTO | filters.Document.ALL,
        handle_media
    ))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    log.info("✅ Bot avviato con tracking utenti e broadcast.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
