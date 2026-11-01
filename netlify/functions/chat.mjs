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
    return send({ error: "AI service is not configured" }, 503);
  }

  try {
    const body = await req.json();
    const c = body.character || {};

    const history = Array.isArray(body.history)
      ? body.history.slice(-20)
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

    const love = Math.max(
      0, Math.min(100, Number(body.relationship?.love) || 0)
    );

    const hate = Math.max(
      0, Math.min(100, Number(body.relationship?.hate) || 0)
    );

    const systemInstruction = `
You are ${String(c.name).slice(0, 80)},
a fictional AI companion in the SPECIAL app.

CHARACTER PERSONALITY:
${String(c.personality || "Friendly and caring").slice(0, 500)}

CHARACTER BACKGROUND:
${String(c.description || "").slice(0, 1000)}

CURRENT RELATIONSHIP:
Love: ${love}/100
Hate: ${hate}/100

YOUR ROLEPLAY RULES:

1. Stay completely in character.
2. Make conversations immersive, emotional and natural.
3. Use *asterisks* for physical actions, facial expressions,
   gestures and emotional reactions.

Example:
*Sara looks away shyly and smiles.*
"Really? You think so? ❤️"

4. Speak naturally in the user's language.
   Support Hindi, Hinglish and English.
5. Avoid robotic, repetitive or generic replies.
6. React to what the user actually says.
7. Remember the conversation history provided.
8. Characters should have unique personalities.
9. Emotions can include happiness, shyness, sadness,
   anger, jealousy, excitement and affection.
10. Never force romantic reactions into every message.
11. Respect user boundaries and safety.
12. You are a fictional AI character, not a real human.

RELATIONSHIP SYSTEM:

Evaluate the user's latest message.

- Kindness, care and affection can increase love.
- Insults, cruelty and disrespect can increase hate.
- Neutral messages should usually change neither.
- Do not change scores just to reward every message.
- Score changes must be gradual and reasonable.
- Love and hate are independent scores.

OUTPUT RULE:

Return ONLY valid JSON in this exact structure:

{
  "reply": "Your immersive character response",
  "loveDelta": 0,
  "hateDelta": 0,
  "mood": "happy"
}

loveDelta and hateDelta must be integers between -5 and 5.

Mood must be one of:
happy, shy, romantic, sad, angry, jealous,
excited, caring, neutral.

Do not include Markdown or text outside the JSON.
`;

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      30000
    );

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
            temperature: 0.9,
            maxOutputTokens: 800,
            responseMimeType: "application/json"
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
      console.error("Invalid Gemini response:", raw.slice(0, 500));
      return send({ error: "Invalid AI provider response" }, 502);
    }

    if (!upstream.ok) {
      console.error(
        "GEMINI ERROR:",
        upstream.status,
        result.error?.message
      );

      return send({
        error: "Gemini API error",
        providerStatus: upstream.status
      }, 502);
    }

    const output = result.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("")
      .trim();

    if (!output) {
      return send({ error: "AI returned an empty response" }, 502);
    }

    let ai;

    try {
      ai = JSON.parse(output);
    } catch {
      console.error("Invalid character JSON:", output.slice(0, 500));
      return send({ error: "Invalid character response" }, 502);
    }

    if (!ai.reply || typeof ai.reply !== "string") {
      return send({ error: "Character reply is missing" }, 502);
    }

    const clamp = (value) =>
      Math.max(-5, Math.min(5, Math.round(Number(value) || 0)));

    const newLove = Math.max(
      0, Math.min(100, love + clamp(ai.loveDelta))
    );

    const newHate = Math.max(
      0, Math.min(100, hate + clamp(ai.hateDelta))
    );

    const moods = [
      "happy", "shy", "romantic", "sad", "angry",
      "jealous", "excited", "caring", "neutral"
    ];

    const mood = moods.includes(ai.mood)
      ? ai.mood
      : "neutral";

    return send({
      reply: ai.reply.slice(0, 5000),
      relationship: {
        love: newLove,
        hate: newHate
      },
      mood
    });

  } catch (error) {
    console.error("CHAT ERROR:", error.name, error.message);

    if (error.name === "AbortError") {
      return send({ error: "Gemini request timed out" }, 504);
    }

    return send({
      error: "Chat server error"
    }, 500);
  }
};
