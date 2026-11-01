const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

const PACKAGES = {
  starter: { amount: 2000, coins: 1000 },
  plus: { amount: 4000, coins: 2250 },
  pro: { amount: 8000, coins: 5000 },
  mega: { amount: 70000, coins: 50000 }
};

async function getUser(req) {
  const supabaseUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) throw new Error("Supabase payment configuration is incomplete.");
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return { error: json({ error: "Please sign in first." }, 401) };
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return { error: json({ error: "Your session expired. Please sign in again." }, 401) };
  const user = await response.json();
  if (!user?.id) return { error: json({ error: "Account verification failed." }, 401) };
  return { user, supabaseUrl, serviceKey };
}

function razorpayAuth(keyId, secret) {
  return "Basic " + btoa(`${keyId}:${secret}`);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a || "") || !/^[a-f0-9]{64}$/i.test(b || "")) return false;
  let mismatch = 0;
  for (let i = 0; i < 64; i++) mismatch |= a.toLowerCase().charCodeAt(i) ^ b.toLowerCase().charCodeAt(i);
  return mismatch === 0;
}

export default async (req, runtimeContext = {}) => {
  const env = runtimeContext.env || process.env;
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return json({ error: "Razorpay is not configured yet. Add the Razorpay API keys in your hosting settings." }, 503);

  try {
    const auth = await getUser(req);
    if (auth.error) return auth.error;
    const { user, supabaseUrl, serviceKey } = auth;
    const body = await req.json();
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    };

    if (body.action === "create") {
      const pack = PACKAGES[String(body.packageId || "")];
      if (!pack) return json({ error: "Choose a valid coin package." }, 400);

      const orderResponse = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: razorpayAuth(keyId, keySecret),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: pack.amount,
          currency: "INR",
          receipt: `sp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
          notes: { app: "SPECIAL", user_id: user.id, package_id: body.packageId }
        })
      });
      const order = await orderResponse.json();
      if (!orderResponse.ok || !order.id) {
        console.error("Razorpay order creation failed:", orderResponse.status, order);
        return json({ error: "Razorpay could not create the order. Please try again." }, 502);
      }

      const saveResponse = await fetch(`${supabaseUrl}/rest/v1/special_payment_orders`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({
          razorpay_order_id: order.id,
          user_id: user.id,
          package_id: body.packageId,
          amount_paise: pack.amount,
          coins: pack.coins,
          status: "pending"
        })
      });
      if (!saveResponse.ok) {
        const detail = await saveResponse.text();
        console.error("Could not save payment order:", saveResponse.status, detail);
        return json({ error: "Could not securely save your order. Please try again." }, 502);
      }

      return json({
        keyId,
        orderId: order.id,
        amount: pack.amount,
        currency: "INR",
        coins: pack.coins
      });
    }

    if (body.action === "verify") {
      const orderId = String(body.razorpay_order_id || "");
      const paymentId = String(body.razorpay_payment_id || "");
      const signature = String(body.razorpay_signature || "");
      if (!orderId || !paymentId || !signature) return json({ error: "Payment verification details are incomplete." }, 400);

      const lookup = await fetch(
        `${supabaseUrl}/rest/v1/special_payment_orders?select=razorpay_order_id,user_id,amount_paise,coins,status,razorpay_payment_id&razorpay_order_id=eq.${encodeURIComponent(orderId)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
        { headers }
      );
      if (!lookup.ok) {
        console.error("Payment order lookup failed:", lookup.status, await lookup.text());
        return json({ error: "Could not find your payment order." }, 502);
      }
      const rows = await lookup.json();
      const savedOrder = rows[0];
      if (!savedOrder) return json({ error: "This payment order does not belong to your account." }, 403);

      const expected = await hmacHex(keySecret, `${savedOrder.razorpay_order_id}|${paymentId}`);
      if (!safeEqualHex(expected, signature)) return json({ error: "Payment signature verification failed." }, 400);

      const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: razorpayAuth(keyId, keySecret) }
      });
      const payment = await paymentResponse.json();
      if (!paymentResponse.ok || payment.order_id !== savedOrder.razorpay_order_id ||
          Number(payment.amount) !== Number(savedOrder.amount_paise) ||
          payment.currency !== "INR" || payment.status !== "captured") {
        console.error("Razorpay payment not eligible for credit:", paymentResponse.status, payment.status, payment.order_id);
        return json({ error: "Payment is not yet confirmed as captured. Please refresh your wallet in a moment." }, 409);
      }

      const creditResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/special_credit_razorpay_order`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_user_id: user.id,
          p_order_id: savedOrder.razorpay_order_id,
          p_payment_id: paymentId
        })
      });
      const creditRaw = await creditResponse.text();
      let credit = null;
      try { credit = creditRaw ? JSON.parse(creditRaw) : null; } catch {}
      if (!creditResponse.ok) {
        console.error("Coin credit failed:", creditResponse.status, creditRaw);
        return json({ error: "Payment is confirmed, but wallet credit needs attention. Contact support with payment ID " + paymentId }, 502);
      }
      return json({
        success: true,
        alreadyCredited: !!credit?.already_credited,
        coins: Number(credit?.coins ?? savedOrder.coins),
        balance: Number(credit?.balance)
      });
    }

    return json({ error: "Unknown payment action." }, 400);
  } catch (error) {
    console.error("PAYMENT ERROR:", error.name, error.message);
    return json({ error: "Payment service error. Please try again." }, 500);
  }
};
