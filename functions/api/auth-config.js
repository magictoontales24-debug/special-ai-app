import handler from "../../netlify/functions/auth-config.mjs";
export async function onRequest(context) {
  return handler(context.request, { env: context.env });
}
