import handler from "../../netlify/functions/generate-image.mjs";
export async function onRequest(context) {
  return handler(context.request, { env: context.env });
}
