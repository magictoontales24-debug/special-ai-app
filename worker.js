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
    const handler = routes.get(url.pathname);
    if (handler) {
      return handler(request, { env });
    }
    return env.ASSETS.fetch(request);
  }
};
