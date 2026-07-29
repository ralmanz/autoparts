import {
  WEBSITE_SYSTEM_PROMPT,
  VOICE_MODE_SUFFIX,
  WEB_CHAT_FALLBACK,
} from "./prompt.js";
import { checkRateLimit, logMessage, updateMetadata } from "./conversations.js";

const WEB_CHAT_ROLES = new Set(["user", "assistant"]);
const WEB_CHAT_RATE_LIMIT = 20;
const WEB_CHAT_RATE_WINDOW = 60;

function clientIp(request) {
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function normalizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return null;
  }

  const cleaned = [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") return null;
    const role = msg.role;
    const content = msg.content;
    if (!WEB_CHAT_ROLES.has(role) || typeof content !== "string" || !content.trim()) {
      return null;
    }
    cleaned.push({ role, content: content.slice(0, 2000) });
  }

  return cleaned.slice(-20);
}

async function callAnthropic(env, systemPrompt, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Anthropic API error", res.status, data);
    throw new Error("Anthropic request failed");
  }

  const reply = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!reply.trim()) {
    throw new Error("Empty model response");
  }

  return reply;
}

export async function handleWebChat(request, env) {
  const ip = clientIp(request);
  const limited = await checkRateLimit(
    env,
    `ratelimit:webchat:${ip}`,
    WEB_CHAT_RATE_LIMIT,
    WEB_CHAT_RATE_WINDOW,
  );

  if (limited) {
    return Response.json({ reply: WEB_CHAT_FALLBACK });
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = normalizeMessages(data?.messages);
  if (!messages) {
    return Response.json({ error: "Invalid messages" }, { status: 400 });
  }

  let systemPrompt = WEBSITE_SYSTEM_PROMPT;
  if (data.mode === "voice") {
    systemPrompt += VOICE_MODE_SUFFIX;
  }

  const sessionId = `web:${ip}`;
  const latestUser = [...messages].reverse().find((m) => m.role === "user");

  let reply = WEB_CHAT_FALLBACK;
  try {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    reply = await callAnthropic(env, systemPrompt, messages);
  } catch (error) {
    console.error("web-chat error", error);
  }

  if (latestUser) {
    try {
      await logMessage(env, sessionId, "inbound", latestUser.content);
      await logMessage(env, sessionId, "outbound", reply);
      await updateMetadata(env, sessionId, {
        vertical: "website",
        customer_name: `Web · ${ip}`,
      });
    } catch (error) {
      console.error("web-chat log failed", error);
    }
  }

  return Response.json({ reply });
}
