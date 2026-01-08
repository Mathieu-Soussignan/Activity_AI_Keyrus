import { createRouter, createWebHistory } from "vue-router";
import Login from "./views/Login.vue";
import Activity from "./views/Activity.vue";
import ResetPassword from "./views/ResetPassword.vue";
import PmDashboard from "./views/PmDashboard.vue";
import CompleteProfile from "./views/CompleteProfile.vue";
import { supabase } from "./lib/supabase";
import { api } from "./lib/api";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/activity" },
    { path: "/login", component: Login },
    { path: "/reset-password", component: ResetPassword },
    { path: "/complete-profile", component: CompleteProfile },
    { path: "/activity", component: Activity },

    // PM
    { path: "/pm", redirect: "/pm-dashboard" },
    { path: "/pm-dashboard", component: PmDashboard },
    // fallback
    { path: "/:pathMatch(.*)*", redirect: "/activity" },
  ],
});

const publicRoutes = ["/login", "/reset-password"];
const profileRoute = "/complete-profile";

router.beforeEach(async (to) => {
  const { data } = await supabase.auth.getSession();
  const isAuthed = !!data?.session;

  if (!isAuthed && !publicRoutes.includes(to.path)) {
    return "/login";
  }

  if (isAuthed && to.path === "/login") {
    return "/activity";
  }

  if (isAuthed && !publicRoutes.includes(to.path)) {
    if (to.path === profileRoute) return true;

    try {
      const me = await api.get("/api/me");

      const fullName = String(me?.data?.full_name ?? "").trim();
      const role = String(me?.data?.role ?? "");

      // force completion profil
      if (!fullName) {
        return profileRoute;
      }

      // routes PM uniquement
      if (to.path === "/pm" || to.path === "/pm-dashboard") {
        if (role !== "pm") return "/activity";
      }
    } catch {
      return "/login";
    }
  }

  return true;
});

export default router;