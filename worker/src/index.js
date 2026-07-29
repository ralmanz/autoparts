const AUTO_REPLY_MESSAGE =
  "Te comunicamos con uno de nuestros agentes. Pronto atenderemos tu solicitud.";

const ESCALATION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function normalizeNumber(number) {
  return String(number || "")
    .replace(/^whatsapp:/i, "")
    .replace(/\+/g, "")
    .replace(/\s/g, "")
    .trim();
}

async function sendWhatsApp(env, to, message, phoneNumberId) {
  const token = env.META_ACCESS_TOKEN;
  const id = phoneNumberId || env.META_PHONE_NUMBER_ID;
  if (!token || !id) {
    console.error("Missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID");
    return null;
  }

  const toDigits = normalizeNumber(to);
  const res = await fetch(`https://graph.facebook.com/v18.0/${id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "text",
      text: { body: message },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("sendWhatsApp API error", res.status, data);
    return null;
  }

  return data.messages?.[0]?.id ?? null;
}

async function storeEscalation(env, msgSid, prospectNumber) {
  if (!env.ESCALATIONS || !msgSid) return;
  await env.ESCALATIONS.put(`msg:${msgSid}`, normalizeNumber(prospectNumber), {
    expirationTtl: ESCALATION_TTL_SECONDS,
  });
}

async function lookupEscalation(env, msgSid) {
  if (!env.ESCALATIONS || !msgSid) return null;
  return env.ESCALATIONS.get(`msg:${msgSid}`);
}

function handleVerify(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.META_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

async function notifyOwner(env, clientName, prospectNumber, incomingMessage) {
  const owner = env.YOUR_PERSONAL_WHATSAPP;
  if (!owner) {
    console.warn("YOUR_PERSONAL_WHATSAPP not set");
    return;
  }

  const msgSid = await sendWhatsApp(
    env,
    owner,
    `📩 *Nuevo lead* — ${clientName}\n` +
      `Número: ${prospectNumber}\n` +
      `Mensaje: "${incomingMessage}"\n\n` +
      `_Responde aquí para hablarle directamente._`,
    env.META_PHONE_NUMBER_ID,
  );

  if (msgSid) {
    await storeEscalation(env, msgSid, prospectNumber);
    console.log(`Escalation stored: ${msgSid} → ${prospectNumber}`);
  }
}

async function handleCustomerMessage(env, phoneNumberId, prospect, incomingMessage) {
  if (phoneNumberId !== env.META_PHONE_NUMBER_ID) {
    console.warn(`Unhandled phone_number_id: ${phoneNumberId}`);
    return;
  }

  await sendWhatsApp(env, prospect, AUTO_REPLY_MESSAGE, phoneNumberId);
  await notifyOwner(env, "Zeli", prospect, incomingMessage);
}

async function handleOwnerReply(env, incomingMessage, repliedToId) {
  const prospectNumber = await lookupEscalation(env, repliedToId);
  if (!prospectNumber) return;

  await sendWhatsApp(env, prospectNumber, incomingMessage, env.META_PHONE_NUMBER_ID);
  console.log(`Forwarded owner reply to ${prospectNumber}`);
}

async function handleWebhook(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  if (!data?.entry?.[0]?.changes?.[0]?.value) {
    return new Response("ok", { status: 200 });
  }

  const change = data.entry[0].changes[0].value;
  const phoneNumberId = change.metadata?.phone_number_id;

  if (!change.messages?.[0]) {
    return new Response("ok", { status: 200 });
  }

  const msg = change.messages[0];
  if (msg.type !== "text") {
    return new Response("ok", { status: 200 });
  }

  const incomingMessage = msg.text?.body?.trim();
  if (!incomingMessage) {
    return new Response("ok", { status: 200 });
  }

  const prospect = normalizeNumber(msg.from);
  const owner = normalizeNumber(env.YOUR_PERSONAL_WHATSAPP || "");

  console.log(`[${phoneNumberId}] From ${prospect}: ${incomingMessage}`);

  if (owner && prospect === owner) {
    const repliedToId = msg.context?.id;
    if (repliedToId) {
      await handleOwnerReply(env, incomingMessage, repliedToId);
    }
    return new Response("ok", { status: 200 });
  }

  await handleCustomerMessage(env, phoneNumberId, prospect, incomingMessage);
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "running",
        service: "Zeli WhatsApp Worker",
        phone_number_id: env.META_PHONE_NUMBER_ID || null,
      });
    }

    if (url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "GET") {
      return handleVerify(request, env);
    }

    if (request.method === "POST") {
      return handleWebhook(request, env);
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};
