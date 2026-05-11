import asyncio
import json
import logging
import os
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("weather_bot")

# Reduce noisy HTTP logs (and avoid leaking credentials in request URLs).
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


class RedactSecretsFilter(logging.Filter):
    def __init__(self, secrets: list[str]) -> None:
        super().__init__()
        self._secrets = [s for s in secrets if s]

    def filter(self, record: logging.LogRecord) -> bool:
        if not self._secrets:
            return True

        try:
            if isinstance(record.msg, str):
                record.msg = self._redact_str(record.msg)

            if record.args:
                if isinstance(record.args, tuple):
                    record.args = tuple(self._redact_arg(a) for a in record.args)
                elif isinstance(record.args, dict):
                    record.args = {k: self._redact_arg(v) for k, v in record.args.items()}
        except Exception:
            # Never break logging.
            return True

        return True

    def _redact_arg(self, value: object) -> object:
        if isinstance(value, str):
            return self._redact_str(value)
        return value

    def _redact_str(self, value: str) -> str:
        out = value
        for s in self._secrets:
            out = out.replace(s, "<redacted>")
        return out


def load_dotenv_file() -> None:
    env_path = Path(__file__).resolve().with_name(".env")
    if not env_path.is_file():
        return

    try:
        from dotenv import load_dotenv  # type: ignore[import-not-found]
    except Exception:
        text = env_path.read_text(encoding="utf-8-sig", errors="ignore")
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]

            os.environ.setdefault(key, value)
    else:
        load_dotenv(dotenv_path=env_path, override=False)


load_dotenv_file()

user_ids_logger: logging.Logger | None = None
seen_user_ids: set[int] = set()
inflight_user_ids: set[int] = set()
seen_users_path: Path | None = None
admin_chat_id: int | None = None
admin_notify_new_user_enabled: bool = False
admin_chat_id_auto: bool = False
admin_state_path: Path | None = None


def env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default

    s = value.strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return default


def getenv_int(name: str) -> int | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        logger.warning("Invalid %s (expected int): %r", name, s)
        return None


def resolve_admin_state_path() -> Path:
    raw = os.getenv("ADMIN_STATE_PATH", "").strip()
    base_dir = Path(__file__).resolve().parent
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (base_dir / p)
    return base_dir / "admin_state.json"


def load_admin_chat_id_from_state(path: Path) -> int | None:
    try:
        if not path.is_file():
            return None
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if isinstance(data, int):
            return int(data)
        if isinstance(data, dict):
            raw = data.get("admin_chat_id")
            if raw is None:
                return None
            return int(raw)
    except Exception as e:
        logger.warning("Failed to load ADMIN_STATE_PATH (%s): %s", path, e)
        return None
    return None


def save_admin_chat_id_to_state(path: Path, chat_id: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        payload = {"admin_chat_id": int(chat_id), "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except Exception as e:
        logger.warning("Failed to save ADMIN_STATE_PATH (%s): %s", path, e)


def resolve_user_ids_log_path() -> Path:
    raw = os.getenv("USER_IDS_LOG_PATH", "").strip()
    base_dir = Path(__file__).resolve().parent
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (base_dir / p)
    return base_dir / "user_ids.jsonl"


def setup_user_ids_logger() -> None:
    global user_ids_logger

    if not env_flag("USER_IDS_LOG_ENABLED", True):
        user_ids_logger = None
        return

    path = resolve_user_ids_log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        logger.warning("Failed to create USER_IDS_LOG_PATH directory (%s). User IDs logging disabled.", e)
        user_ids_logger = None
        return

    l = logging.getLogger("weather_bot.user_ids")
    l.setLevel(logging.INFO)
    l.propagate = False

    for handler in list(l.handlers):
        l.removeHandler(handler)

    try:
        handler = logging.FileHandler(path, encoding="utf-8")
    except Exception as e:
        logger.warning("Failed to open USER_IDS_LOG_PATH (%s). User IDs logging disabled.", e)
        user_ids_logger = None
        return

    handler.setFormatter(logging.Formatter("%(message)s"))
    l.addHandler(handler)
    user_ids_logger = l

    logger.info("User IDs logging enabled: %s", path)


def log_user_event(update: Update, event: str) -> None:
    if not user_ids_logger:
        return

    user = update.effective_user
    chat = update.effective_chat

    payload = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "event": event,
        "user_id": getattr(user, "id", None),
        "username": getattr(user, "username", None),
        "chat_id": getattr(chat, "id", None),
        "chat_type": getattr(chat, "type", None),
    }

    try:
        user_ids_logger.info(json.dumps(payload, ensure_ascii=False))
    except Exception:
        # Never break bot flows due to analytics.
        return


def resolve_seen_users_path() -> Path:
    raw = os.getenv("SEEN_USERS_PATH", "").strip()
    base_dir = Path(__file__).resolve().parent
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (base_dir / p)
    return base_dir / "seen_users.json"


def load_seen_user_ids(path: Path) -> set[int]:
    try:
        if not path.is_file():
            return set()
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, list):
            return set()
        out: set[int] = set()
        for item in data:
            try:
                out.add(int(item))
            except Exception:
                continue
        return out
    except Exception as e:
        logger.warning("Failed to load SEEN_USERS_PATH (%s): %s", path, e)
        return set()


def save_seen_user_ids(path: Path, user_ids: set[int]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(sorted(user_ids), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except Exception as e:
        logger.warning("Failed to save SEEN_USERS_PATH (%s): %s", path, e)


def setup_seen_users() -> None:
    global seen_users_path, seen_user_ids
    if not env_flag("SEEN_USERS_PERSIST", True):
        seen_users_path = None
        seen_user_ids = set()
        logger.info("Seen users persistence disabled (SEEN_USERS_PERSIST=0).")
        return
    seen_users_path = resolve_seen_users_path()
    seen_user_ids = load_seen_user_ids(seen_users_path)
    logger.info("Seen users loaded: %s", len(seen_user_ids))


def format_admin_new_user_text(update: Update) -> str:
    user = update.effective_user
    chat = update.effective_chat

    if not user:
        return "Новый пользователь (данные пользователя недоступны)."

    name = " ".join([p for p in [user.first_name, user.last_name] if p])
    username = f"@{user.username}" if user.username else "—"
    lang = getattr(user, "language_code", None) or "—"
    chat_type = getattr(chat, "type", None) or "—"
    chat_id = getattr(chat, "id", None)

    lines = [
        "Новый пользователь:",
        f"• id: {user.id}",
        f"• username: {username}",
        f"• name: {name or '—'}",
        f"• lang: {lang}",
        f"• chat: {chat_id} ({chat_type})",
    ]
    return "\n".join(lines)


async def maybe_notify_admin_new_user(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not admin_notify_new_user_enabled or not admin_chat_id:
        return

    user = update.effective_user
    if not user:
        return

    user_id = int(user.id)

    lock = context.application.bot_data.get("seen_users_lock")
    if lock is None:
        lock = asyncio.Lock()
        context.application.bot_data["seen_users_lock"] = lock

    async with lock:
        if user_id in seen_user_ids or user_id in inflight_user_ids:
            return
        inflight_user_ids.add(user_id)

    sent = False
    try:
        await context.bot.send_message(chat_id=admin_chat_id, text=format_admin_new_user_text(update))
        sent = True
    except Exception:
        # Don't break user flow.
        sent = False
    finally:
        async with lock:
            inflight_user_ids.discard(user_id)
            if sent:
                seen_user_ids.add(user_id)
                if seen_users_path:
                    save_seen_user_ids(seen_users_path, seen_user_ids)


async def on_channel_activity(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    global admin_chat_id

    if admin_chat_id or not admin_chat_id_auto:
        return

    chat = update.effective_chat
    if not chat or chat.type != "channel":
        return

    admin_chat_id = int(chat.id)
    if admin_state_path:
        save_admin_chat_id_to_state(admin_state_path, admin_chat_id)
    logger.info("Admin channel auto-configured: %s (%s)", admin_chat_id, getattr(chat, "title", None) or "—")


def getenv_required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


WEBAPP_URL = os.getenv("WEBAPP_URL", "").strip()


@dataclass(frozen=True)
class Location:
    name: str
    admin1: str | None = None
    country: str | None = None

    @staticmethod
    def from_payload(payload: dict[str, Any]) -> "Location":
        name = str(payload.get("name") or "Локация")
        admin1 = payload.get("admin1")
        country = payload.get("country")
        return Location(name=name, admin1=str(admin1) if admin1 else None, country=str(country) if country else None)

    def label(self) -> str:
        parts = [self.name, self.admin1, self.country]
        return ", ".join([p for p in parts if p])


def wmo_to_label(code: int) -> str:
    if code == 0:
        return "Ясно"
    if code == 1:
        return "Малооблачно"
    if code == 2:
        return "Переменная облачность"
    if code == 3:
        return "Пасмурно"
    if code in (45, 48):
        return "Туман"
    if 51 <= code <= 57:
        return "Морось"
    if 61 <= code <= 67:
        return "Дождь"
    if 71 <= code <= 77:
        return "Снег"
    if 80 <= code <= 82:
        return "Ливни"
    if 85 <= code <= 86:
        return "Снегопад"
    if 95 <= code <= 99:
        return "Гроза"
    return "Погода"


def parse_date(value: str) -> date | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except Exception:
        return None


def fmt_day(d: date | None) -> str:
    if not d:
        return "??.??"
    return d.strftime("%d.%m")


def fmt_weekday_ru(d: date | None) -> str:
    if not d:
        return "??"
    # 0=Mon
    names = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
    return names[d.weekday()]


def fmt_num(x: float | int | None) -> str:
    if x is None:
        return "—"
    try:
        v = float(x)
    except Exception:
        return "—"
    # Keep one decimal only when needed.
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:.1f}"


def iter_items(payload: dict[str, Any]) -> Iterable[dict[str, Any]]:
    items = payload.get("items")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict):
                yield item


def format_forecast_message(payload: dict[str, Any]) -> str:
    units = str(payload.get("units") or "metric")
    temp_u = "°C" if units == "metric" else "°F"
    pr_u = "мм" if units == "metric" else "in"
    w_u = "км/ч" if units == "metric" else "mph"

    loc = Location.from_payload(payload.get("location") or {})
    lines: list[str] = []
    lines.append(f"<b>Прогноз на 7 дней</b>")
    lines.append(f"<i>{html_escape(loc.label())}</i>")
    lines.append("")

    for item in list(iter_items(payload))[:7]:
        d = parse_date(str(item.get("date") or ""))
        wmo = int(item.get("wmo") or -1)
        label = wmo_to_label(wmo)

        tmax = fmt_num(item.get("tmax"))
        tmin = fmt_num(item.get("tmin"))
        pr = fmt_num(item.get("pr"))
        wind = fmt_num(item.get("wind"))

        lines.append(
            f"<b>{fmt_weekday_ru(d)} {fmt_day(d)}</b> — {html_escape(label)}; "
            f"{tmax}{temp_u}/{tmin}{temp_u}; осадки {pr} {pr_u}; ветер {wind} {w_u}"
        )

    lines.append("")
    lines.append("<i>Откройте мини‑приложение, чтобы выбрать город и единицы измерения.</i>")
    return "\n".join(lines)


def html_escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#039;")
    )


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return

    log_user_event(update, "start")

    url = WEBAPP_URL or getenv_required("WEBAPP_URL")
    keyboard = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("Открыть погоду", web_app=WebAppInfo(url=url))],
        ]
    )
    await update.message.reply_text(
        "Откройте мини‑приложение и выберите город. Затем нажмите «Отправить прогноз».",
        reply_markup=keyboard,
    )
    await maybe_notify_admin_new_user(update, context)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return

    log_user_event(update, "help")

    await update.message.reply_text(
        "Команды:\n"
        "/start — открыть мини‑приложение\n"
        "/help — помощь\n\n"
        "В мини‑приложении можно выбрать город, единицы измерения и отправить прогноз в чат.",
    )


async def on_web_app_data(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.web_app_data:
        return

    log_user_event(update, "web_app_data")
    await maybe_notify_admin_new_user(update, context)

    raw = update.message.web_app_data.data or ""
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        await update.message.reply_text("Получены данные из приложения, но формат не распознан.")
        return

    if not isinstance(payload, dict) or payload.get("type") != "forecast_v1":
        await update.message.reply_text("Получены данные из приложения, но они не поддерживаются этой версией бота.")
        return

    msg = format_forecast_message(payload)
    await update.message.reply_text(msg, parse_mode=ParseMode.HTML, disable_web_page_preview=True)


def main() -> None:
    token = getenv_required("BOT_TOKEN")

    # Ensure secrets don't end up in logs (e.g., transport debug URLs).
    root = logging.getLogger()
    for handler in list(root.handlers):
        handler.addFilter(RedactSecretsFilter([token]))

    setup_user_ids_logger()

    global admin_chat_id, admin_notify_new_user_enabled, admin_chat_id_auto, admin_state_path
    admin_notify_new_user_enabled = env_flag("ADMIN_NOTIFY_NEW_USER_ENABLED", True)
    admin_chat_id_auto = env_flag("ADMIN_CHAT_ID_AUTO", False)

    admin_state_path = resolve_admin_state_path()
    admin_chat_id = getenv_int("ADMIN_CHAT_ID") or load_admin_chat_id_from_state(admin_state_path)
    if admin_notify_new_user_enabled:
        setup_seen_users()
        logger.info("Admin notifications enabled. ADMIN_CHAT_ID=%s", admin_chat_id or "—")
        if not admin_chat_id and admin_chat_id_auto:
            logger.info("Waiting for first channel activity to auto-detect ADMIN_CHAT_ID...")

    application = Application.builder().token(token).build()

    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("help", cmd_help))
    application.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, on_web_app_data))
    application.add_handler(MessageHandler(filters.ChatType.CHANNEL, on_channel_activity))

    logger.info("Bot started. WebApp URL: %s", WEBAPP_URL or "<env WEBAPP_URL>")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
