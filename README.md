# SPECIAL — AI roleplay and story app

SPECIAL is a mobile-friendly web app for fictional character chats, story discovery, account sign-in, cloud conversation history, a coin wallet, daily rewards and Razorpay checkout.

## Current deployment target: Cloudflare Workers

The repository includes a Cloudflare Worker entry point (`worker.js`) and Wrangler configuration (`wrangler.toml`). The Worker serves the static app from `public/` and forwards `/api/*` requests to the backend handlers in `netlify/functions/`.

### Cloudflare Workers Builds

- Connect this GitHub repository and use production branch `main`.
- Build/deploy command: `npx wrangler deploy`.
- Keep the repository root as the root directory.
- The static asset directory is configured as `./public` in `wrangler.toml`; do not set a separate output directory.

### Required Worker secrets / variables

Add these in the Cloudflare Worker settings. Netlify environment variables do not transfer automatically.

| Name | Type |
| --- | --- |
| `SUPABASE_URL` | Variable |
| `SUPABASE_ANON_KEY` | Variable |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret |
| `GEMINI_API_KEY` | Secret |
| `RAZORPAY_KEY_ID` | Variable (when enabling payments) |
| `RAZORPAY_KEY_SECRET` | Secret (when enabling payments) |

Never put service-role, Gemini, or Razorpay secret keys in frontend files or commit them to GitHub.

## Supabase

The migration in `supabase/migrations/20261110_special_cloud_memory.sql` creates the additive SPECIAL cloud conversation, message, and per-character memory tables. Run it in the existing Supabase project's SQL Editor if it has not already been applied.

The app also expects the existing wallet schema and RPC functions used by the wallet and chat handlers. Razorpay checkout additionally expects a `special_payment_orders` table and the `special_credit_razorpay_order` RPC. Verify those database objects exist before enabling live payments; the payment handler deliberately does not credit coins until the payment is signature-verified and confirmed captured by Razorpay.

## API routes

- `GET /api/auth-config` — public Supabase client configuration
- `POST /api/chat` — authenticated AI chat, cloud history, and 10-coin successful-reply charge
- `GET /api/wallet` — wallet balance, transactions and reward status
- `POST /api/wallet` — claim the daily reward
- `POST /api/payment` — create and verify Razorpay orders
- `POST /api/generate-image` — image generation endpoint

## Before inviting users

Run end-to-end checks for sign-up/sign-in, chat, cloud history across devices, wallet balance, daily rewards, and payment verification in Razorpay test mode. Confirm database policies and RPCs, add a privacy policy and terms, abuse reporting, moderation, rate limits, and suitable age controls. Do not promise unlimited free AI use: provider quotas and charges are controlled by Google.
