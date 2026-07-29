import { checkRateLimit } from "./conversations.js";

const TTS_RATE_LIMIT = 40;
const TTS_RATE_WINDOW = 3600;
const TTS_CACHE_TTL = 86400;

function clientIp(request) {
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function cacheKey(text) {
  const data = new TextEncoder().encode(text.trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `tts:${hex}`;
}

export async function handleTts(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return Response.json({ error: "text must be a string" }, { status: 400 });
  }

  const text = data?.text;
  if (typeof text !== "string" || !text.trim()) {
    return Response.json({ error: "text must be a string" }, { status: 400 });
  }
  if (text.length > 600) {
    return Response.json({ error: "text too long" }, { status: 400 });
  }

  const key = await cacheKey(text);
  const cached = await env.CONVERSATIONS.get(key, "arrayBuffer");
  if (cached) {
    return new Response(cached, {
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Cache": "HIT",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const ip = clientIp(request);
  const limited = await checkRateLimit(
    env,
    `ratelimit:tts:${ip}`,
    TTS_RATE_LIMIT,
    TTS_RATE_WINDOW,
  );
  if (limited) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  const voiceId = env.ELEVENLABS_VOICE_ID;
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!voiceId || !apiKey) {
    console.error("Missing ElevenLabs credentials");
    return Response.json({ error: "TTS upstream error" }, { status: 502 });
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text: text.trim(),
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!res.ok) {
    console.error("ElevenLabs TTS error", res.status, await res.text());
    return Response.json({ error: "TTS upstream error" }, { status: 502 });
  }

  const audio = await res.arrayBuffer();
  await env.CONVERSATIONS.put(key, audio, { expirationTtl: TTS_CACHE_TTL });

  return new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "X-Cache": "MISS",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
