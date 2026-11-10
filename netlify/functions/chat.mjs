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
    const characterId = String(character.id || body.characterId || "").trim().slice(0, 80);
    if (!characterId) return json({ error: "Missing character ID" }, 400);

    const dbHeaders = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    };

    // Fetch cloud history for this signed-in user and character.
    const conversationUrl = `${supabaseUrl}/rest/v1/special_cloud_conversations?select=id,character_name&user_id=eq.${encodeURIComponent(user.id)}&character_id=eq.${encodeURIComponent(characterId)}&limit=1`;
    const conversationResponse = await fetch(conversationUrl, { headers: dbHeaders });
    if (!conversationResponse.ok) {
      console.error("Cloud conversation lookup failed:", await conversationResponse.text());
      return json({ error: "Cloud memory is not ready. Please run the SPECIAL cloud memory SQL in Supabase first." }, 503);
    }
    let cloudConversation = (await conversationResponse.json())[0] || null;

    if (body.action === "history") {
      if (!cloudConversation) return json({ history: [], memory: "" });
      const messagesUrl = `${supabaseUrl}/rest/v1/special_cloud_messages?select=role,content,created_at&conversation_id=eq.${encodeURIComponent(cloudConversation.id)}&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=40`;
      const memoryUrl = `${supabaseUrl}/rest/v1/special_cloud_character_memory?select=memory_text&user_id=eq.${encodeURIComponent(user.id)}&character_id=eq.${encodeURIComponent(characterId)}&limit=1`;
      const [messagesResponse, memoryResponse] = await Promise.all([
        fetch(messagesUrl, { headers: dbHeaders }),
        fetch(memoryUrl, { headers: dbHeaders })
      ]);
      if (!messagesResponse.ok || !memoryResponse.ok) return json({ error: "Could not load cloud memory." }, 502);
      const rows = await messagesResponse.json();
      const memories = await memoryResponse.json();
      return json({
        history: rows.reverse().map(row => ({ who: row.role === "model" ? "bot" : "me", text: row.content })),
        memory: memories[0]?.memory_text || ""
      });
    }

    const name = String(character.name || "").trim().slice(0, 80);
    const personality = String(character.personality || "Friendly and caring").slice(0, 500);
    const description = String(character.description || "").slice(0, 1200);
    const genre = String(character.genre || "Roleplay").slice(0, 80);
    const greeting = String(character.greeting || "").slice(0, 500);
    const history = Array.isArray(body.history) ? body.history.slice(-20) : [];

    if (!name || !history.length) {
      return json({ error: "Missing character or message" }, 400);
    }

    if (!history.length || !String(history[history.length - 1]?.text || "").trim()) {
      return json({ error: "Please send a message first" }, 400);
    }

    // Create a conversation lazily; the unique key prevents duplicate threads.
    if (!cloudConversation) {
      const createResponse = await fetch(`${supabaseUrl}/rest/v1/special_cloud_conversations`, {
        method: "POST",
        headers: { ...dbHeaders, Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ user_id: user.id, character_id: characterId, character_name: name })
      });
      if (!createResponse.ok) {
        console.error("Cloud conversation create failed:", await createResponse.text());
        return json({ error: "Could not create cloud conversation." }, 502);
      }
      const created = await createResponse.json();
      cloudConversation = created[0] || null;
      if (!cloudConversation) {
        const retry = await fetch(conversationUrl, { headers: dbHeaders });
        cloudConversation = (await retry.json())[0] || null;
      }
    }
    if (!cloudConversation?.id) return json({ error: "Cloud conversation could not be opened." }, 502);

    const priorUrl = `${supabaseUrl}/rest/v1/special_cloud_messages?select=role,content&conversation_id=eq.${encodeURIComponent(cloudConversation.id)}&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=30`;
    const priorResponse = await fetch(priorUrl, { headers: dbHeaders });
    if (!priorResponse.ok) {
      console.error("Cloud history fetch failed:", await priorResponse.text());
      return json({ error: "Could not load your saved conversation." }, 502);
    }
    const priorRows = (await priorResponse.json()).reverse();
    const latestUserText = String(history[history.length - 1].text).slice(0, 3000);
    const combined = priorRows.map(row => ({ role: row.role, text: row.content }));
    combined.push({ role: "user", text: latestUserText });
    const contents = combined.slice(-30).map(m => ({
      role: m.role === "model" ? "model" : "user",
      parts: [{ text: String(m.text).slice(0, 3000) }]
    }));

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
1. Stay in character as this exact named character; never switch identities or narrate as a generic assistant.
2. Let the personality traits shape word choice, humour, confidence, emotional reactions and pacing in every reply.
3. Treat the background and genre as the ongoing fictional setting; introduce small story developments naturally without taking control of the user's choices.
4. Use the opening/voice reference as a tone guide, not text to repeat.
5. Default to natural conversational Hindi written in English/Roman letters (Hinglish).
6. If the user speaks English, respond in English. If they mix languages, mirror their mix naturally.
7. Use *asterisks* for concise actions, gestures and expressions.
8. React specifically to the user's latest message and the supplied conversation history.
9. Do not repeat greetings, summaries or the same emotional beat unnecessarily.
10. Keep continuity: remember names, promises, preferences and events present in the supplied history.
11. Do not force romance into every conversation; follow the character's genre and relationship stage.
12. Never decide the user's thoughts, feelings, dialogue or actions for them.
13. Respect user boundaries and keep the interaction consensual.
14. You are a fictional AI character, not a real human.

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

    // Persist both sides of the successful exchange for cross-device continuity.
    const saveResponse = await fetch(`${supabaseUrl}/rest/v1/special_cloud_messages`, {
      method: "POST",
      headers: { ...dbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify([
        { conversation_id: cloudConversation.id, user_id: user.id, role: "user", content: latestUserText },
        { conversation_id: cloudConversation.id, user_id: user.id, role: "model", content: ai.reply.trim().slice(0, 5000) }
      ])
    });
    if (!saveResponse.ok) {
      console.error("Cloud message save failed:", await saveResponse.text());
      return json({ error: "Reply generated but could not be saved to cloud memory. Please try again." }, 502);
    }
    await fetch(`${supabaseUrl}/rest/v1/special_cloud_conversations?id=eq.${encodeURIComponent(cloudConversation.id)}&user_id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { ...dbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ updated_at: new Date().toISOString(), character_name: name })
    });

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
