const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  }
});

export default async (req, runtimeContext = {}) => {
  const env = runtimeContext.env || process.env;
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const geminiKey = env.GEMINI_API_KEY;

  if (!supabaseUrl || !anonKey || !serviceKey || !geminiKey) {
    return json({ error: "Server configuration is incomplete" }, 503);
  }

  const authorization = req.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    return json({ error: "Please sign in first" }, 401);
  }

  try {
    // Verify Supabase account
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`
      }
    });

    if (!authResponse.ok) {
      return json({ error: "Your session expired. Please sign in again." }, 401);
    }

    const user = await authResponse.json();

    if (!user?.id) {
      return json({ error: "Account verification failed" }, 401);
    }

    const body = await req.json();
    const character = body.character || {};

    const name = String(character.name || "").trim().slice(0, 80);
    const personality = String(character.personality || "Friendly and caring").slice(0, 500);
    const description = String(character.description || "").slice(0, 1200);

    const history = Array.isArray(body.history)
      ? body.history.slice(-20)
      : [];

    if (!name || !history.length) {
      return json({ error: "Missing character or message" }, 400);
    }

    const contents = history
      .filter(m => m && String(m.text || "").trim())
      .map(m => ({
        role: ["model", "assistant"].includes(m.role) ? "model" : "user",
        parts: [{ text: String(m.text).slice(0, 3000) }]
      }));

    if (!contents.length || contents[contents.length - 1].role !== "user") {
      return json({ error: "Please send a message first" }, 400);
    }

    const love = Math.max(0, Math.min(100, Number(body.relationship?.love) || 0));
    const hate = Math.max(0, Math.min(100, Number(body.relationship?.hate) || 0));

    const systemInstruction = `
You are ${name}, a fictional adult AI roleplay character in SPECIAL.

PERSONALITY:
${personality}

BACKGROUND:
${description}

RELATIONSHIP:
Love: ${love}/100
Hate: ${hate}/100

ROLEPLAY RULES:
1. Stay in character and make every conversation immersive.
2. Default to natural conversational Hindi written in English/Roman letters (Hinglish).
3. If the user speaks English, respond in English.
4. Understand Hindi, Hinglish and English.
5. Write actions and expressions in Romanized Hindi by default.
6. Use *asterisks* for actions, gestures and expressions.
7. React naturally to the user's actual message.
8. Remember the conversation history provided.
9. Avoid repetitive, robotic replies.
10. Keep your personality consistent.
11. Do not force romance into every conversation.
12. Respect user boundaries.
13. You are a fictional AI character, not a real human.

RELATIONSHIP:
Kindness and affection may increase love.
Cruelty and insults may increase hate.
Neutral messages should usually change neither.
Keep changes gradual and reasonable.
Love and hate are independent.

Return ONLY valid JSON:
{
  "reply": "Character response",
  "loveDelta": 0,
  "hateDelta": 0,
  "mood": "happy"
}

loveDelta and hateDelta must be integers between -5 and 5.
Mood must be one of:
happy, shy, romantic, sad, angry, jealous, excited, caring, neutral.
`;

    // Generate AI reply first. No coins are charged if this fails.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    let aiResponse;

    try {
      aiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": geminiKey
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemInstruction }]
            },
            contents,
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 900,
              responseMimeType: "application/json"
            }
          }),
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = await aiResponse.text();
    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid AI provider response" }, 502);
    }

    if (!aiResponse.ok) {
      console.error("Gemini error:", aiResponse.status, result.error?.message);
      return json({ error: "AI service is temporarily unavailable" }, 502);
    }

    const output = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!output) {
      return json({ error: "AI returned an empty response" }, 502);
    }

    let ai;

    try {
      ai = JSON.parse(output);
    } catch {
      return json({ error: "AI response could not be processed" }, 502);
    }

    if (typeof ai.reply !== "string" || !ai.reply.trim()) {
      return json({ error: "Character reply is missing" }, 502);
    }

    // Charge 10 coins atomically, only after a valid AI reply.
    const spendResponse = await fetch(
      `${supabaseUrl}/rest/v1/rpc/special_spend_coins`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_user_id: user.id,
          p_amount: 10,
          p_description: `AI reply with ${name}`
        })
      }
    );

    const spendRaw = await spendResponse.text();
    let spendResult = null;

    try {
      spendResult = spendRaw ? JSON.parse(spendRaw) : null;
    } catch {
      spendResult = null;
    }

    if (!spendResponse.ok) {
      if (spendRaw.includes("NOT_ENOUGH_COINS")) {
        return json({
          error: "Not enough coins. Please recharge your wallet.",
          code: "INSUFFICIENT_COINS"
        }, 402);
      }

      console.error("Coin charge failed:", spendResponse.status, spendRaw);
      return json({ error: "Coin payment could not be completed" }, 502);
    }

    const balance = Number(spendResult?.balance);

    const clamp = value =>
      Math.max(-5, Math.min(5, Math.round(Number(value) || 0)));

    const moods = [
      "happy", "shy", "romantic", "sad", "angry",
      "jealous", "excited", "caring", "neutral"
    ];

    return json({
      reply: ai.reply.trim().slice(0, 5000),
      relationship: {
        love: Math.max(0, Math.min(100, love + clamp(ai.loveDelta))),
        hate: Math.max(0, Math.min(100, hate + clamp(ai.hateDelta)))
      },
      mood: moods.includes(ai.mood) ? ai.mood : "neutral",
      balance: Number.isFinite(balance) ? balance : null,
      coinsCharged: 10
    });

  } catch (error) {
    console.error("CHAT ERROR:", error.name, error.message);

    if (error.name === "AbortError") {
      return json({ error: "AI request timed out. Please try again." }, 504);
    }

    return json({ error: "Chat server error. Please try again." }, 500);
  }
};
