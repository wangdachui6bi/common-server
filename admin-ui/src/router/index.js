import { createRouter, createWebHashHistory } from "vue-router";
import { isLoggedIn } from "../composables/api.js";

import Login from "../views/Login.vue";
import Apps from "../views/Apps.vue";
import AppDetail from "../views/AppDetail.vue";

const routes = [
  { path: "/", redirect: "/apps" },
  { path: "/login", name: "Login", component: Login, meta: { public: true } },
  { path: "/apps", name: "Apps", component: Apps },
  { path: "/apps/:appId", name: "AppDetail", component: AppDetail, props: true },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  if (!to.meta.public && !isLoggedIn()) {
    return { name: "Login" };
  }
});

export default router;
