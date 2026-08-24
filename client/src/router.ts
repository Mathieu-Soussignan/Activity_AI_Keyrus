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

router.beforeEach(async (to) => {
  const { data } = await supabase.auth.getSession();
  const isAuthed = !!data?.session;

  if (!isAuthed && !publicRoutes.includes(to.path)) {
    return "/login";
  }

  if (isAuthed && to.path === "/login") {
    return "/activities";
  }

  if (isAuthed && !publicRoutes.includes(to.path)) {
    if (to.path === profileRoute) return true;

    try {
      const me = await ensureMe();
      const fullName = String(me?.full_name ?? "").trim();
      const role = String(me?.role ?? "");

      // force completion profil
      if (!fullName) {
        return profileRoute;
      }

      // routes PM uniquement
      if (to.path === "/pm" || to.path === "/pm-dashboard") {
        if (role !== "pm") return "/activities";
      }
    } catch (err: any) {
      // If 401 Unauthorized, token is expired: sign out cleanly before redirecting to login to avoid loop
      if (err?.response?.status === 401) {
        clearMeCache();
        await supabase.auth.signOut();
        return "/login";
      }
      // If network error (backend starting up or temporary glitch), allow staying on page instead of infinite redirect bounce
      return true;
    }
  }

  return true;
});

export default router;