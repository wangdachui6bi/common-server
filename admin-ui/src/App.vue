<script setup>
import { useRouter, useRoute } from "vue-router";
import { isLoggedIn, clearApiKey } from "./composables/api.js";

const router = useRouter();
const route = useRoute();

function logout() {
  clearApiKey();
  router.push("/login");
}
</script>

<template>
  <div class="app-shell">
    <header v-if="route.name !== 'Login'" class="top-bar">
      <router-link to="/apps" class="brand">Common Server</router-link>
      <nav class="nav-links">
        <router-link to="/apps">应用管理</router-link>
        <button class="btn-text" @click="logout">退出</button>
      </nav>
    </header>
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>
