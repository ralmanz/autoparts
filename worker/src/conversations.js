const CONVO_PREFIX = "convo:";

function utcIso() {
  return new Date().toISOString().replace("+00:00", "Z");
}

function convoKey(number) {
  return `${CONVO_PREFIX}${number}`;
}

function emptyConversation() {
  const now = utcIso();
  return {
    messages: [],
    vertical: "unknown",
    first_message_at: now,
    last_message_at: null,
    intent_score: null,
    customer_name: null,
    re_profile: {},
  };
}

export async function logMessage(env, number, direction, body) {
  const key = convoKey(number);
  const convo = (await env.CONVERSATIONS.get(key, "json")) || emptyConversation();
  const now = utcIso();

  convo.messages.push({
    direction,
    body,
    timestamp: now,
    message_id: null,
  });
  convo.last_message_at = now;
  await env.CONVERSATIONS.put(key, JSON.stringify(convo));
}

export async function updateMetadata(env, number, metadata) {
  const key = convoKey(number);
  const convo = (await env.CONVERSATIONS.get(key, "json")) || emptyConversation();
  const now = utcIso();

  Object.assign(convo, metadata);
  convo.last_message_at = now;
  await env.CONVERSATIONS.put(key, JSON.stringify(convo));
}

export async function getConversation(env, number) {
  return env.CONVERSATIONS.get(convoKey(number), "json");
}

export async function getAllConversations(env, maxAgeHours = 168) {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000)
    .toISOString()
    .replace("+00:00", "Z");

  const listed = await env.CONVERSATIONS.list({ prefix: CONVO_PREFIX });
  const result = {};

  for (const item of listed.keys) {
    const number = item.name.slice(CONVO_PREFIX.length);
    const convo = await env.CONVERSATIONS.get(item.name, "json");
    if (convo?.last_message_at && convo.last_message_at > cutoff) {
      result[number] = convo;
    }
  }

  return Object.fromEntries(
    Object.entries(result).sort(([, a], [, b]) =>
      (b.last_message_at || "").localeCompare(a.last_message_at || ""),
    ),
  );
}

export async function checkRateLimit(env, bucketKey, limit, windowSeconds) {
  const now = Date.now();
  const raw = await env.CONVERSATIONS.get(bucketKey, "json");
  let bucket = raw || { count: 0, windowStart: now };

  if (now - bucket.windowStart > windowSeconds * 1000) {
    bucket = { count: 0, windowStart: now };
  }

  if (bucket.count >= limit) {
    return true;
  }

  bucket.count += 1;
  await env.CONVERSATIONS.put(bucketKey, JSON.stringify(bucket), {
    expirationTtl: windowSeconds,
  });
  return false;
}

export async function handleApiConversations(request, env) {
  const url = new URL(request.url);
  const password =
    url.searchParams.get("password") ||
    request.headers.get("X-Dashboard-Password");

  if (password !== env.DASHBOARD_PASSWORD) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const number = url.searchParams.get("number");
  if (number) {
    const convo = await getConversation(env, number);
    if (convo) {
      return Response.json({ [number]: convo });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return Response.json(await getAllConversations(env, 168));
}
