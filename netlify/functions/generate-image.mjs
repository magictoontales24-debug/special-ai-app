const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  }
});

const safe = (value, max = 500) =>
  String(value || "").trim().slice(0, max);

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
    return json({ error: "Image service is not fully configured" }, 503);
  }

  const bearer = req.headers.get("authorization") || "";
  const accessToken = bearer.startsWith("Bearer ")
    ? bearer.slice(7)
    : "";

  if (!accessToken) {
    return json({ error: "Please sign in first" }, 401);
  }

  try {
    const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!authRes.ok) {
      return json({ error: "Please sign in again" }, 401);
    }

    const user = await authRes.json();

    if (!user?.id) {
      return json({ error: "Account verification failed" }, 401);
    }

    const body = await req.json();

    const conversationId = safe(body.conversationId, 80);
    const characterName = safe(body.character?.name, 80);
    const personality = safe(body.character?.personality, 240);
    const scenePrompt = safe(body.scenePrompt, 900);
    const kind = body.kind === "selfie" ? "selfie" : "story";

    if (!conversationId || !characterName || !scenePrompt) {
      return json({ error: "Missing conversation or scene details" }, 400);
    }

    const conversationRes = await fetch(
      `${supabaseUrl}/rest/v1/conversations?id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
        }
      }
    );

    if (!conversationRes.ok) {
      return json({ error: "Could not verify conversation" }, 502);
    }

    const conversations = await conversationRes.json();

    if (!Array.isArray(conversations) || !conversations.length) {
      return json({ error: "Conversation not found" }, 404);
    }

    const prompt = [
      "Create a photorealistic cinematic image for a fictional AI roleplay chat.",
      `Character: ${characterName}.`,
      `Personality: ${personality || "warm and expressive"}.`,
      kind === "selfie"
        ? "Create a cheerful, natural personal selfie like a real phone photograph."
        : "Create a cinematic image showing the described story moment.",
      "Use natural lighting and expressive, pleasant facial features.",
      `Scene: ${scenePrompt}`
    ].join("\n");

    const imageRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiKey
        },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"]
          }
        }),
        signal: AbortSignal.timeout(90000)
      }
    );

    const imageData = await imageRes.json();

    if (!imageRes.ok) {
      console.error("Gemini image error:", imageData?.error?.message);
      return json({ error: "Image generation is unavailable" }, 502);
    }

    const parts = imageData.candidates?.[0]?.content?.parts || [];

    const imagePart = parts.find(part =>
      part.inlineData?.data &&
      /^image\/(png|jpeg|webp)$/.test(part.inlineData.mimeType || "")
    );

    if (!imagePart) {
      return json({ error: "No image was returned" }, 502);
    }

    const mime = imagePart.inlineData.mimeType;
    const extension =
      mime === "image/jpeg" ? "jpg" :
      mime === "image/webp" ? "webp" : "png";

    const binary = atob(imagePart.inlineData.data);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));

    if (bytes.length > 10 * 1024 * 1024) {
      return json({ error: "Image is too large" }, 502);
    }

    const fileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const objectPath = `${user.id}/${conversationId}/${fileName}`;

    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/special-chat-media/${objectPath}`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": mime,
          "x-upsert": "false"
        },
        body: bytes
      }
    );

    if (!uploadRes.ok) {
      return json({ error: "Could not save image" }, 502);
    }

    const messageRes = await fetch(
      `${supabaseUrl}/rest/v1/messages`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          user_id: user.id,
          role: "assistant",
          content: kind === "selfie"
            ? `${characterName} shared a selfie.`
            : `${characterName} shared a story picture.`,
          media_path: objectPath,
          media_type: mime,
          media_prompt: scenePrompt,
          media_alt: `${characterName} - ${kind}`
        })
      }
    );

    if (!messageRes.ok) {
      await fetch(
        `${supabaseUrl}/storage/v1/object/special-chat-media/${objectPath}`,
        {
          method: "DELETE",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`
          }
        }
      ).catch(() => {});

      return json({ error: "Could not save image message" }, 502);
    }

    const signedRes = await fetch(
      `${supabaseUrl}/storage/v1/object/sign/special-chat-media/${objectPath}`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expiresIn: 604800 })
      }
    );

    if (!signedRes.ok) {
      return json({ error: "Could not create image preview" }, 502);
    }

    const signed = await signedRes.json();

    const imageUrl = signed.signedURL?.startsWith("http")
      ? signed.signedURL
      : `${supabaseUrl}/storage/v1${signed.signedURL}`;

    return json({
      ok: true,
      imageUrl,
      mediaPath: objectPath,
      mediaType: mime,
      alt: `${characterName} - ${kind}`
    });

  } catch (error) {
    console.error("Image generation error:", error);

    return json({
      error: "Image generation failed. Please try again."
    }, 500);
  }
};
