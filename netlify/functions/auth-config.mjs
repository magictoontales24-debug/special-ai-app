export default async (_req, runtimeContext = {}) => {
  const env = runtimeContext.env || process.env;
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return new Response(JSON.stringify({ error: "Supabase is not configured on the server." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
  return new Response(JSON.stringify({ url, anonKey }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
};