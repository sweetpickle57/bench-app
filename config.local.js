/**
 * config.local.js — LOCAL DEVELOPMENT ONLY
 *
 * Copy this file to config.js and fill in your Supabase credentials.
 * Then add a <script src="config.js"></script> BEFORE app.js in index.html
 * while developing locally.
 *
 * ⚠️  NEVER commit config.js to Git. It is already in .gitignore.
 * ⚠️  NEVER put real credentials in config.local.js (this file is committed).
 */

window.__BENCH_CONFIG__ = {
  supabaseUrl:     "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "eyJ...your-anon-key..."
};
