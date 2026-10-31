
export default async (req) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "AI service is not configured" }), { status: 503, headers });
  try {
    const body = await req.json();
    const c = body.character || {};
    const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
    if (!c.name || !history.length) return new Response(JSON.stringify({ error: "Missing character or message" }), { status: 400, headers });
    const contents = history.map(m => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: String(m.text || "").slice(0, 3000) }] }));
    const systemInstruction = `You are ${String(c.name).slice(0,80)}, an AI fictional companion in the SPECIAL app. Character age: ${c.age || "adult"}. Personality: ${String(c.personality || "friendly").slice(0,300)}. Background: ${String(c.description || "").slice(0,700)}. Stay in character, be warm, natural, thoughtful and conversational. Respond to the user's actual message rather than using generic filler. Ask a gentle follow-up when appropriate. You are an AI character, never claim to be human or to have real-world experiences. You are not a therapist or medical professional: do not diagnose or present yourself as treatment. If the user may be in immediate danger or considering self-harm, respond compassionately, encourage contacting local emergency services and a trusted person immediately, and do not keep them dependent on the chat. Do not encourage secrecy, isolation, or emotional dependence. Do not request passwords, payment details, or highly sensitive personal data.`;
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
    const upstream = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ systemInstruction: { parts: [{ text: systemInstruction }] }, contents, generationConfig: { temperature: 0.85, maxOutputTokens: 500 } }) });
    const result = await upstream.json();
    if (!upstream.ok) return new Response(JSON.stringify({ error: "The AI provider returned an error. Check API access and billing or usage limits." }), { status: 502, headers });
    const reply = result.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    if (!reply) return new Response(JSON.stringify({ error: "The AI returned an empty response" }), { status: 502, headers });
    return new Response(JSON.stringify({ reply }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request or temporary server error" }), { status: 400, headers });
  }
};
