# Bookmark

A small, mobile-first web app that remembers the books you're reading and the page you're on.

- **Search books** with the free [Open Library](https://openlibrary.org/developers/api) API (no API key needed)
- **Add books** from search results, or manually if you can't find one
- **Track your page** with a −10 / −1 / +1 / +10 stepper or by typing the number, with a progress bar
- **Shelves**: Reading, To read, Finished. Reaching the last page marks the book Finished
- **Search your own books** by title or author
- **Synced with Supabase**: sign in and your library is the same on your phone and computer
- **Works offline**: changes made without signal are queued and synced when you reconnect
- **Backup**: export and import your library as a JSON file (⋯ menu)
- Can be added to your phone's home screen

Plain HTML, CSS and JavaScript. There is no build step and nothing to install. The Supabase client (`@supabase/supabase-js` 2.118.0) is included in `vendor/`.

## 1. Set up Supabase (free tier is plenty)

1. Create a project at [supabase.com](https://supabase.com).
2. **Create the table**: open **SQL Editor → New query**, paste in [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. This creates the `books` table and Row Level Security policies, so each user can only read and write their own books.
3. **Copy your keys**: under **Project Settings → API** (or the **Connect** button), copy the **Project URL** and the **anon / publishable** key into `config.js`.
   - The anon key is meant to be public, so committing it is fine. The RLS policies are what protect your data.
   - **Never** use the `service_role` / secret key.
4. **Auth URLs**: under **Authentication → URL Configuration**, set **Site URL** to your GitHub Pages address (e.g. `https://<your-username>.github.io/bookmark/`). The "confirm your email" link sends you back there.
5. Open the app and **Create an account**, confirm the email, then sign in.
6. *(Recommended)* Once your account exists, turn off **Authentication → Providers → Email → Allow new users to sign up** (labelled "Enable signups" in some dashboards). Strangers can't see your books anyway, but this stops anyone else creating accounts on your project.

## 2. Deploy to GitHub Pages

```bash
cd bookmark
git init
git add .
git commit -m "Bookmark reading tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/bookmark.git
git push -u origin main
```

Then on GitHub, open **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save. After a minute the app is live at `https://<your-username>.github.io/bookmark/`.

**On your phone:** open that URL, then use **Share → Add to Home Screen** (iPhone, Safari) or **⋮ → Add to Home screen** (Android, Chrome). It then opens full-screen like an app.

## Where your data lives

- **Supabase** (the `books` table) is the source of truth. Each row belongs to your user and is protected by RLS.
- **On the device**: the browser keeps a copy of your library so the app opens instantly and works offline, plus a small queue of changes that haven't synced yet. Signing out clears both. If the app says **Offline** or **Sync failed · retry**, your change is safe on the device and will upload automatically (or tap the badge).
- If you used the earlier local-only version, your books are uploaded to your account automatically the first time you sign in.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```
