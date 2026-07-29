import { corsHeaders, handleOptions, withCors } from "./cors.js";
import { handleApiConversations } from "./conversations.js";
import { handleTts } from "./tts.js";
import { handleWebChat } from "./webChat.js";
import { handleVerify, handleWebhook } from "./whatsapp.js";

async function serveAsset(env, pathname, filename) {
  if (!env.ASSETS) {
    return new Response("Not Found", { status: 404 });
  }
  const assetUrl = new URL(`/${filename}`, "https://assets.local");
  return env.ASSETS.fetch(new Request(assetUrl.toString()));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS" && ["/web-chat", "/tts"].includes(pathname)) {
      return handleOptions(request);
    }

    if (pathname === "/health" && method === "GET") {
      return Response.json({
        status: "running",
        service: "Zeli API Worker",
        phone_number_id: env.META_PHONE_NUMBER_ID || null,
        routes: [
          "/webhook",
          "/web-chat",
          "/tts",
          "/api/conversations",
          "/conversations",
        ],
      });
    }

    if (pathname === "/webhook") {
      if (method === "GET") return handleVerify(request, env);
      if (method === "POST") return handleWebhook(request, env);
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (pathname === "/web-chat" && method === "POST") {
      return withCors(await handleWebChat(request, env), request);
    }

    if (pathname === "/tts" && method === "POST") {
      return withCors(await handleTts(request, env), request);
    }

    if (pathname === "/api/conversations" && method === "GET") {
      const response = await handleApiConversations(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(request))) {
        headers.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    if (pathname === "/" && method === "GET") {
      return serveAsset(env, pathname, "index.html");
    }

    if (pathname === "/conversations" && method === "GET") {
      return serveAsset(env, pathname, "conversations.html");
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
