import { createRouter, createWebHistory } from "vue-router";
import Login from "./views/Login.vue";
import Activity from "./views/Activity.vue";
import ResetPassword from "./views/ResetPassword.vue";
import PmDashboard from "./views/PmDashboard.vue";
import CompleteProfile from "./views/CompleteProfile.vue";
import SharePointPoc from "./views/SharePointPoc.vue";
import { supabase } from "./lib/supabase";
import { ensureMe, clearMeCache } from "./lib/me";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/activities" },
    { path: "/login", component: Login },
    { path: "/reset-password", component: ResetPassword },
    { path: "/complete-profile", component: CompleteProfile },
    { path: "/activity", component: Activity },
    { path: "/activities", component: Activity },
    { path: "/sharepoint-poc", component: SharePointPoc },

    // PM
    { path: "/pm", redirect: "/pm-dashboard" },
    { path: "/pm-dashboard", component: PmDashboard },
    // fallback
    { path: "/:pathMatch(.*)*", redirect: "/activities" },
  ],
});

const publicRoutes = ["/login", "/reset-password", "/sharepoint-poc"];
const profileRoute = "/complete-profile";

function purgeAuthStorage() {
  clearMeCache();
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("sb-") || k.includes("supabase") || k === "me_cache_v1") {
        localStorage.removeItem(k);
      }
    }
  } catch {}
}

router.beforeEach(async (to) => {
  // Always allow public routes without auto-redirecting to /activities
  if (publicRoutes.includes(to.path)) {
    return true;
  }

  const { data } = await supabase.auth.getSession();
  const session = data?.session;
  const isAuthed = !!session;

  // Unauthenticated user -> redirect to /login
  if (!isAuthed) {
    return "/login";
  }

  // Profile completion route
  if (to.path === profileRoute) {
    return true;
  }

  try {
    const me = await ensureMe();
    const fullName = String(me?.full_name ?? "").trim();
    const role = String(me?.role ?? "");

    // Force profile completion if no name
    if (!fullName) {
      return profileRoute;
    }

    // PM only routes
    if (to.path === "/pm" || to.path === "/pm-dashboard") {
      if (role !== "pm") return "/activities";
    }
  } catch (err: any) {
    if (err?.response?.status === 401) {
      purgeAuthStorage();
      try { await supabase.auth.signOut(); } catch {}
      return "/login?session_expired=1";
    }
    // On network glitch, stay on page
    return true;
  }

  return true;
});

export default router;