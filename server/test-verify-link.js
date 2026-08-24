// server/test-verify-link.js
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function testRecoveryFlow() {
  const testEmail = "mathieu.soussignan@keyrus.com";
  console.log(`Generating recovery link for: ${testEmail}...`);

  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: testEmail,
    options: {
      redirectTo: "http://localhost:5173/reset-password",
    },
  });

  if (linkErr) {
    console.error("Error generating link:", linkErr);
    return;
  }

  const actionLink = linkData.properties.action_link;
  console.log("\nAction Link:", actionLink);

  // Simulate HTTP GET on action_link (redirect from Supabase GoTrue to localhost:5173/reset-password)
  const res = await fetch(actionLink, { redirect: "manual" });
  console.log("\nSupabase GoTrue Verify Response Status:", res.status);
  console.log("Location header (Redirect Target):", res.headers.get("location"));
}

testRecoveryFlow().catch(console.error);
