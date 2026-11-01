const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

export default async (req) => {
  if (!["GET", "POST"].includes(req.method)) {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ error: "Wallet service configuration is incomplete" }, 503);
  }

  const authorization = req.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return json({ error: "Please sign in first" }, 401);

  try {
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
    });
    if (!authResponse.ok) return json({ error: "Your session expired. Please sign in again." }, 401);
    const user = await authResponse.json();
    if (!user?.id) return json({ error: "Account verification failed" }, 401);

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    };

    if (req.method === "POST") {
      const claimResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_weekly_reward`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_user_id: user.id })
      });
      const raw = await claimResponse.text();
      let result = null;
      try { result = raw ? JSON.parse(raw) : null; } catch {}
      if (!claimResponse.ok) {
        if (raw.includes("Already claimed today")) {
          return json({ error: "You have already claimed today's reward." }, 409);
        }
        console.error("Weekly reward claim failed:", claimResponse.status, raw);
        return json({ error: "Daily reward could not be claimed. Please try again." }, 502);
      }
      return json(result || {});
    }

    const userFilter = encodeURIComponent(`eq.${user.id}`);
    const [walletResponse, transactionsResponse, claimsResponse] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/coin_wallets?select=balance&user_id=${userFilter}`, { headers }),
      fetch(`${supabaseUrl}/rest/v1/coin_transactions?select=amount,kind,description,created_at&user_id=${userFilter}&order=created_at.desc&limit=20`, { headers }),
      fetch(`${supabaseUrl}/rest/v1/weekly_claims?select=claim_date,day_number,coins_awarded&user_id=${userFilter}&order=claim_date.desc&limit=8`, { headers })
    ]);

    if (!walletResponse.ok || !transactionsResponse.ok || !claimsResponse.ok) {
      const detail = await Promise.all([walletResponse, transactionsResponse, claimsResponse].map(async r => r.ok ? "" : await r.text()));
      console.error("Wallet read failed:", detail.filter(Boolean).join(" | "));
      return json({ error: "Could not load wallet data. Please refresh." }, 502);
    }

    const [walletRows, transactions, claims] = await Promise.all([
      walletResponse.json(), transactionsResponse.json(), claimsResponse.json()
    ]);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    const latest = claims[0] || null;
    const claimedToday = claims.some(c => c.claim_date === today);
    let nextDay = 1;
    if (latest) {
      if (latest.claim_date === today) nextDay = latest.day_number;
      else {
        const yesterday = new Date(new Date(today + "T00:00:00+05:30").getTime() - 86400000);
        const yesterdayText = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
        }).format(yesterday);
        nextDay = latest.claim_date === yesterdayText && latest.day_number < 7 ? latest.day_number + 1 : 1;
      }
      if (latest.day_number === 7 && latest.claim_date !== today) nextDay = 1;
    }

    return json({
      balance: Number(walletRows[0]?.balance ?? 0),
      transactions: Array.isArray(transactions) ? transactions : [],
      claims: Array.isArray(claims) ? claims : [],
      nextDay,
      claimedToday
    });
  } catch (error) {
    console.error("WALLET ERROR:", error.name, error.message);
    return json({ error: "Wallet server error. Please try again." }, 500);
  }
};