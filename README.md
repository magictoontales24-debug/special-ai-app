# SPECIAL — AI-enabled web app

## Deploy to Netlify
1. Keep the Netlify environment variable `GEMINI_API_KEY` configured for Production and Functions. Never put the key in `index.html` or share it.
2. Upload the **contents of this folder** (the `index.html`, `manifest.json`, `sw.js`, `icons` folder, and `netlify` folder) to the existing Netlify site's manual deploy area.
3. Wait for the production deploy to finish, then open the existing site URL.
4. If the installed app still shows the old version, close it fully and reopen; if needed, clear the site's cached data in Chrome and reinstall.

The chat function uses Gemini 3.8 Flash via a Netlify Function. API availability, free-tier eligibility, quotas and charges are controlled by Google. Do not promise unlimited free use.

## Privacy and safety
This prototype stores chat history locally in the browser. Messages are sent to Google's Gemini API for replies. Do not enter highly sensitive personal information. SPECIAL is not a therapist, medical service, or emergency service. Before inviting the public, add a privacy policy, terms, abuse reporting, rate limits, moderation, and appropriate age controls.
