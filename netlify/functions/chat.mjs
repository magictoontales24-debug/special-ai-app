export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  const send = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers });

  if (req.method !== "POST") {
    return send({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("GEMINI_API_KEY is missing");
    return send({ error: "AI service is not configured" }, 503);
  }

  try {
    const body = await req.json();
    const c = body.character || {};
    const history = Array.isArray(body.history)
      ? body.history.slice(-16)
      : [];

    if (!c.name || !history.length) {
      return send({ error: "Missing character or message" }, 400);
    }

    const contents = history
      .filter(m => String(m.text || "").trim())
      .map(m => ({
        role: ["model", "assistant"].includes(m.role)
          ? "model"
          : "user",
        parts: [{
          text: String(m.text || "").slice(0, 3000)
        }]
      }));

    if (!contents.length) {
      return send({ error: "No valid messages" }, 400);
    }

    const systemInstruction = `
You are ${String(c.name).slice(0, 80)},
an AI fictional companion in the SPECIAL app.

Personality: ${String(c.personality || "friendly").slice(0, 300)}
Background: ${String(c.description || "").slice(0, 700)}

Stay in character. Be warm, natural, thoughtful and conversational.
Respond to the actual message. Ask gentle follow-up questions.
You are an AI character, never claim to be human.
Respect user safety, privacy and personal boundaries.
`;

    const url =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let upstream;

    try {
      upstream = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents,
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 500
          }
        })
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await upstream.text();

    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      console.error("Gemini returned invalid JSON:", raw.slice(0, 500));
      return send({ error: "Invalid response from AI provider" }, 502);
    }

    if (!upstream.ok) {
      const message = result.error?.message || "Unknown provider error";

      console.error("GEMINI API ERROR:", upstream.status, message);

      return send({
        error: "Gemini API error",
        providerStatus: upstream.status,
        details: message.slice(0, 500)
      }, 502);
    }

    const reply = result.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("")
      .trim();

    if (!reply) {
      console.error("Gemini returned no text:", JSON.stringify(result).slice(0, 1000));
      return send({ error: "AI returned an empty response" }, 502);
    }

    return send({ reply });

  } catch (error) {
    console.error("CHAT FUNCTION ERROR:", error.name, error.message);

    if (error.name === "AbortError") {
      return send({ error: "Gemini request timed out" }, 504);
    }

    return send({
      error: "Chat server error",
      details: error.message.slice(0, 300)
    }, 500);
  }
};
