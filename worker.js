import authConfig from "./netlify/functions/auth-config.mjs";
import chat from "./netlify/functions/chat.mjs";
import wallet from "./netlify/functions/wallet.mjs";
import payment from "./netlify/functions/payment.mjs";
import generateImage from "./netlify/functions/generate-image.mjs";

const routes = new Map([
  ["/api/auth-config", authConfig],
  ["/api/chat", chat],
  ["/api/wallet", wallet],
  ["/api/payment", payment],
  ["/api/generate-image", generateImage]
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Safe deployment smoke test: report only whether configuration exists,
    // never return keys, URLs, or secret values.
    if (url.pathname === "/api/health") {
      const checks = {
        supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY),
        gemini: Boolean(env.GEMINI_API_KEY),
        razorpay: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
        assets: Boolean(env.ASSETS)
      };
      return new Response(JSON.stringify({
        status: checks.supabase && checks.gemini && checks.assets ? "ready-for-smoke-tests" : "configuration-needed",
        checks
      }), {
        status: checks.supabase && checks.gemini && checks.assets ? 200 : 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    }

    const handler = routes.get(url.pathname);
    if (handler) {
      return handler(request, { env });
    }
    return env.ASSETS.fetch(request);
  }
};
