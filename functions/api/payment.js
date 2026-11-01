import handler from "../../netlify/functions/payment.mjs";
export async function onRequest(context) {
  return handler(context.request, { env: context.env });
}
