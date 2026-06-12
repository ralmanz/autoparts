import os
import json
import time
from collections import defaultdict

import anthropic
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import cross_origin
from dotenv import load_dotenv

from prompts.web_prompt import WEBSITE_SYSTEM_PROMPT
from utils.conversation_store import (
    get_all_conversations,
    get_conversation,
    log_message,
    update_metadata,
)

# ── DORMANT VERTICAL IMPORTS (kept for future use) ───────────────
# from agent.parser import parse_request
# from agent.sourcing import source_parts
# from agent.recommender import build_options
# from agent.approval import send_for_approval, handle_approval
# from connectors.whatsapp_supplier import handle_supplier_response, get_registered_suppliers
# from utils.logger import log_request

load_dotenv()

app = Flask(__name__)

# ── WHATSAPP SENDER ───────────────────────────────────────────────
# Carried forward from auto parts vertical — core utility
import requests as http_requests

def _normalize_wa_number(number: str) -> str:
    return number.replace("whatsapp:", "").replace("+", "").replace(" ", "").strip()


def send_whatsapp(to: str, message: str) -> str | None:
    token = os.getenv("META_ACCESS_TOKEN")
    phone_number_id = os.getenv("META_PHONE_NUMBER_ID")
    if not token or not phone_number_id:
        print("❌ send_whatsapp: META_ACCESS_TOKEN or META_PHONE_NUMBER_ID not set")
        return None

    to_digits = _normalize_wa_number(to)
    url = f"https://graph.facebook.com/v18.0/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to_digits,
        "type": "text",
        "text": {"body": message}
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    try:
        res = http_requests.post(url, json=payload, headers=headers, timeout=30)
        data = res.json()
        if not res.ok:
            print(f"❌ send_whatsapp API error ({res.status_code}): {data}")
            return None
        msg_id = data.get("messages", [{}])[0].get("id")
        if not msg_id:
            print(f"❌ send_whatsapp: no message id in response: {data}")
            return None
        print(f"📤 Sent to {to_digits}: {message[:60]}...")
        _log_conv_message(to_digits, "outbound", message)
        return msg_id
    except Exception as e:
        print(f"❌ send_whatsapp error: {e}")
        return None


def _owner_digits() -> str:
    return _normalize_wa_number(os.getenv("YOUR_PERSONAL_WHATSAPP", ""))


def _log_conv_message(number: str, direction: str, body: str) -> None:
    try:
        digits = _normalize_wa_number(number)
        if digits == _owner_digits():
            return
        log_message(digits, direction, body)
    except Exception as e:
        print(f"⚠️ conversation log failed: {e}")


def _get_client(phone_number_id: str) -> dict | None:
    if phone_number_id != os.getenv("META_PHONE_NUMBER_ID"):
        return None
    return {
        "name": "Zeli",
        "mode": "demo",
        "escalation_number": os.getenv("YOUR_PERSONAL_WHATSAPP"),
    }

WELCOME_MESSAGE = """Hola, gracias por escribir. Soy Zeli.

Zeli Technologies crea asistentes con inteligencia artificial para el sitio web de tu negocio: responden preguntas de tus clientes 24/7, conocen tu catálogo y servicios, y te conectan contigo cuando hace falta.

En un momento te escribe alguien del equipo para ayudarte personalmente."""

# ── STATE ─────────────────────────────────────────────────────────
# Carried forward pattern from auto parts escalation flow
escalation_message_map = {}       # msg_sid → prospect number (for owner reply forwarding)
live_mode_numbers = set()         # prospects already handed off — bot stays silent


# ── CORE MESSAGE HANDLER ──────────────────────────────────────────

def process_message(phone_number_id: str, incoming_number: str, incoming_message: str):
    client = _get_client(phone_number_id)
    if not client:
        print(f"⚠️ No client config for phone_number_id: {phone_number_id}")
        return

    prospect = _normalize_wa_number(incoming_number)
    live_mode_numbers.add(prospect)

    send_whatsapp(prospect, WELCOME_MESSAGE)
    _escalate(client, prospect, incoming_message, reason="lead")


def _escalate(client: dict, incoming_number: str, incoming_message: str, reason: str):
    """Notify owner and enter live mode so the founder can reply directly."""
    escalation_number = client.get("escalation_number")
    if not escalation_number:
        print(f"⚠️ YOUR_PERSONAL_WHATSAPP not set — live mode active but owner won't be notified")
        return

    msg_sid = send_whatsapp(
        escalation_number,
        f"📩 *Nuevo lead* — {client['name']}\n"
        f"Número: {incoming_number}\n"
        f"Mensaje: \"{incoming_message}\"\n\n"
        f"_Responde aquí para hablarle directamente._"
    )

    if msg_sid:
        escalation_message_map[msg_sid] = incoming_number
        print(f"📋 Live mode: {msg_sid} → {incoming_number} (reason: {reason})")
    else:
        print(f"⚠️ Owner notification failed for {incoming_number} — live mode still active")


# ── WEBHOOK ───────────────────────────────────────────────────────

@app.route("/webhook", methods=["GET"])
def verify():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")
    if mode == "subscribe" and token == os.getenv("META_VERIFY_TOKEN"):
        return challenge, 200
    return "Forbidden", 403


@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json(silent=True)
    if not data:
        return "ok", 200

    try:
        entry = data["entry"][0]
        change = entry["changes"][0]["value"]
        phone_number_id = change["metadata"]["phone_number_id"]

        if "messages" not in change:
            return "ok", 200

        msg = change["messages"][0]
        incoming_number = msg["from"]

        # Handle text messages only for now
        if msg.get("type") != "text":
            return "ok", 200

        incoming_message = msg["text"]["body"].strip()
        if not incoming_message:
            return "ok", 200

        print(f"\n📨 [{phone_number_id}] From {incoming_number}: {incoming_message}")

        owner = _owner_digits()
        prospect = _normalize_wa_number(incoming_number)
        if prospect != owner:
            try:
                log_message(prospect, "inbound", incoming_message)
                update_metadata(prospect, vertical="demo")
            except Exception as e:
                print(f"⚠️ conversation log failed: {e}")

        # 1. OWNER REPLY → forward to prospect in live mode
        if prospect == owner:
            # Check if this is a reply to an escalation notification
            # (reply forwarding via message context — handled by Meta thread)
            context = msg.get("context", {})
            replied_to_id = context.get("id")
            if replied_to_id and replied_to_id in escalation_message_map:
                prospect_number = escalation_message_map[replied_to_id]
                send_whatsapp(prospect_number, incoming_message)
                print(f"📤 Forwarded owner reply to {prospect_number}")
            return "ok", 200

        # 2. LIVE MODE → bot stays silent; forward new messages to owner
        if prospect in live_mode_numbers:
            owner_number = os.getenv("YOUR_PERSONAL_WHATSAPP")
            if owner_number:
                msg_sid = send_whatsapp(
                    owner_number,
                    f"💬 *{prospect}*\n{incoming_message}",
                )
                if msg_sid:
                    escalation_message_map[msg_sid] = prospect
            print(f"🔕 Live mode active for {prospect} — forwarded to owner")
            return "ok", 200

        # 3. NEW LEAD → welcome + notify owner (sync so live mode is set before return)
        process_message(phone_number_id, prospect, incoming_message)

    except Exception as e:
        print(f"❌ Webhook error: {e}")
        import traceback
        traceback.print_exc()

    return "ok", 200


# ── HEALTH ────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return {
        "status": "running",
        "service": "Zeli Customer Service MVP",
        "clients": [os.getenv("META_PHONE_NUMBER_ID")]
    }, 200


# ── DASHBOARD ─────────────────────────────────────────────────────

@app.route("/")
def hub():
    return send_from_directory("static", "hub.html")


@app.route("/conversations")
def conversations_page():
    return send_from_directory("static", "conversations.html")


@app.route("/api/conversations", methods=["GET"])
def api_conversations():
    password = request.args.get("password") or request.headers.get("X-Dashboard-Password")
    if password != os.getenv("DASHBOARD_PASSWORD"):
        return jsonify({"error": "unauthorized"}), 401

    number = request.args.get("number")
    if number:
        convo = get_conversation(number)
        if convo:
            return jsonify({number: convo}), 200
        return jsonify({"error": "not found"}), 404

    return jsonify(get_all_conversations(max_age_hours=168)), 200


# ── WEBSITE CHAT ──────────────────────────────────────────────────

_WEB_CHAT_ROLES = {"user", "assistant"}
_WEB_CHAT_RATE_LIMIT = 20
_WEB_CHAT_RATE_WINDOW = 60
_web_chat_rate_buckets = defaultdict(list)
_WEB_CHAT_FALLBACK = "Se me fue la señal un momento. ¿Me lo repites?"


def _client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _web_chat_rate_limited(ip: str) -> bool:
    now = time.time()
    window_start = now - _WEB_CHAT_RATE_WINDOW
    recent = [t for t in _web_chat_rate_buckets[ip] if t > window_start]
    if len(recent) >= _WEB_CHAT_RATE_LIMIT:
        _web_chat_rate_buckets[ip] = recent
        return True
    recent.append(now)
    _web_chat_rate_buckets[ip] = recent
    return False


def _normalize_web_chat_messages(raw_messages):
    if not isinstance(raw_messages, list) or not raw_messages:
        return None

    cleaned = []
    for msg in raw_messages:
        if not isinstance(msg, dict):
            return None
        role = msg.get("role")
        content = msg.get("content")
        if role not in _WEB_CHAT_ROLES or not isinstance(content, str) or not content.strip():
            return None
        cleaned.append({"role": role, "content": content[:2000]})

    return cleaned[-20:]


@app.route("/web-chat", methods=["POST"])
@cross_origin(origins=["https://zeli.lat", "https://www.zeli.lat"])
def web_chat():
    if _web_chat_rate_limited(_client_ip()):
        return jsonify({"reply": _WEB_CHAT_FALLBACK}), 200

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON body"}), 400

    messages = _normalize_web_chat_messages(data.get("messages"))
    if messages is None:
        return jsonify({"error": "Invalid messages"}), 400

    session_id = f"web:{_client_ip()}"
    latest_user = next((m for m in reversed(messages) if m["role"] == "user"), None)

    try:
        claude = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
        response = claude.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1000,
            system=WEBSITE_SYSTEM_PROMPT,
            messages=messages,
        )
        reply = "".join(
            block.text for block in response.content if block.type == "text"
        )
        if not reply.strip():
            raise ValueError("Empty model response")
    except Exception as e:
        print(f"❌ web-chat error: {e}")
        reply = _WEB_CHAT_FALLBACK

    if latest_user:
        try:
            log_message(session_id, "inbound", latest_user["content"])
            log_message(session_id, "outbound", reply)
            update_metadata(
                session_id,
                vertical="website",
                customer_name=f"Web · {_client_ip()}",
            )
        except Exception as e:
            print(f"⚠️ web-chat log failed: {e}")

    return jsonify({"reply": reply}), 200


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(debug=True, port=port)
