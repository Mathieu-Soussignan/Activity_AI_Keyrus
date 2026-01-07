import { createRouter, createWebHistory } from "vue-router";
import Login from "./views/Login.vue";
import Activity from "./views/Activity.vue";
import ResetPassword from "./views/ResetPassword.vue";
import { supabase } from "./lib/supabase";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/activity" },
    { path: "/login", component: Login },
    { path: "/activity", component: Activity },
    { path: "/reset-password", component: ResetPassword },
  ],
});

router.beforeEach(async (to) => {
  const { data } = await supabase.auth.getSession();
  const isAuthed = !!data?.session;

  // Routes accessibles sans être connecté
  const publicRoutes = ["/login", "/reset-password"];

  if (!isAuthed && !publicRoutes.includes(to.path)) {
    return "/login";
  }

  if (isAuthed && to.path === "/login") {
    return "/activity";
  }
});

export default router;