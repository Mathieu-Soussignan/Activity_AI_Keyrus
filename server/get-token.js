import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://mvnkhofnabtqvvtvqvjm.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12bmtob2ZuYWJ0cXZ2dHZxdmptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQxNjkzMzgsImV4cCI6MjA3OTc0NTMzOH0.3BDfL8rtmjIzF2Dk_LcmYAUj2sDB7SX2AMp0WdRLlU0"
);

const email = "mathieu.soussignan@keyrus.com";
const password = "Scp2026!";

const { data, error } = await supabase.auth.signInWithPassword({
  email,
  password,
});

if (error) {
  console.error(error);
  process.exit(1);
}

console.log("ACCESS TOKEN:\n", data.session.access_token);