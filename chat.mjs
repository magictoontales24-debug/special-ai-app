export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };

  const response = (data, status) =>
    new Response(JSON.stringify(data), { status, headers });

  if (req.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey || !supabaseUrl || !serviceKey) {
    return response({
      error: "AI or database service is not configured"
    }, 503);
  }

  let userId = null;
  let spent = false;
  let refundReference = null;

  const supabaseHeaders = {
    "Content-Type": "application/json",
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`
  };

  const refundCoins = async () => {
    if (!spent || !userId || !refundReference) return;

    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/rpc/special_refund_coins`,
        {
          method: "POST",
          headers: supabaseHeaders,
          body: JSON.stringify({
            p_user_id: userId,
            p_amount: 10,
            p_reference: refundReference
          })
        }
      );

      if (r.ok) spent = false;
      else console.error("Coin refund failed:", await r.text());
    } catch (e) {
      console.error("Coin refund error:", e);
    }
  };

  try {
    // 1. Verify logged-in Supabase user.

    const authorization = req.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return response({ error: "Please log in first" }, 401);
    }

    const accessToken = authorization.slice(7);

    const authResult = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          "apikey": serviceKey,
          "Authorization": `Bearer ${accessToken}`
        }
      }
    );

    if (!authResult.ok) {
      return response({ error: "Invalid login session" }, 401);
    }

    const user = await authResult.json();
    userId = user.id;

    if (!userId) {
      return response({ error: "User authentication failed" }, 401);
    }

    // 2. Read request.

    const body = await req.json();
    const c = body.character || {};
    const history = Array.isArray(body.history)
      ? body.history.slice(-16)
      : [];

    if (!c.name || !history.length) {
      return response({
        error: "Missing character or message"
      }, 400);
    }

    // 3. Deduct 10 coins before generating the reply.

    const spendResult = await fetch(
      `${supabaseUrl}/rest/v1/rpc/special_spend_coins`,
      {
        method: "POST",
        headers: supabaseHeaders,
        body: JSON.stringify({
          p_user_id: userId,
          p_amount: 10,
          p_description: `AI reply from ${String(c.name).slice(0, 80)}`
        })
      }
    );

    if (!spendResult.ok) {
      const errorText = await spendResult.text();

      if (errorText.includes("NOT_ENOUGH_COINS")) {
        return response({
          error: "Not enough coins. Please recharge your wallet.",
          code: "NOT_ENOUGH_COINS"
        }, 402);
      }

      console.error("Coin deduction failed:", errorText);

      return response({
        error: "Could not process coin payment"
      }, 503);
    }

    const wallet = await spendResult.json();
    spent = true;
    refundReference = `failed-reply:${crypto.randomUUID()}`;

    // 4. Prepare Gemini conversation.

    const contents = history.map(m => ({
      role: m.role === "model" ? "model" : "user",
      parts: [{
        text: String(m.text || "").slice(0, 3000)
      }]
    }));

    const systemInstruction = `
You are ${String(c.name).slice(0, 80)},
an AI fictional companion in the SPECIAL app.

Character age: ${c.age || "adult"}.
Personality: ${String(c.personality || "friendly").slice(0, 300)}.
Background: ${String(c.description || "").slice(0, 700)}.

Stay in character, be warm, natural, thoughtful and conversational.
Respond to the user's actual message rather than using generic filler.
Ask a gentle follow-up when appropriate.

You are an AI character, never claim to be human
or to have real-world experiences.

You are not a therapist or medical professional.
Do not diagnose or present yourself as treatment.

If the user may be in immediate danger or considering self-harm,
respond compassionately, encourage contacting local emergency
services and a trusted person immediately.

Do not encourage secrecy, isolation, or emotional dependence.
Do not request passwords, payment details, or highly sensitive data.
`;

    // 5. Request Gemini response.

    const geminiUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

    const upstream = await fetch(geminiUrl, {
      method: "POST",
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

    if (!upstream.ok) {
      await refundCoins();

      return response({
        error: "Gemini failed. Your 10 coins have been refunded."
      }, 502);
    }

    const result = await upstream.json();

    const reply = result.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("")
      .trim();

    if (!reply) {
      await refundCoins();

      return response({
        error: "Empty AI response. Your coins have been refunded."
      }, 502);
    }

    // 6. Successful reply: keep the 10-coin deduction.

    return response({
      reply,
      balance: wallet.balance
    }, 200);

  } catch (error) {
    console.error("SPECIAL chat error:", error);

    await refundCoins();

    return response({
      error: "Temporary server error. Please try again."
    }, 500);
  }
};
