<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { setApiKey, fetchApps } from "../composables/api.js";

const router = useRouter();
const apiKey = ref("");
const error = ref("");
const loading = ref(false);

async function handleLogin() {
  if (!apiKey.value.trim()) return;
  loading.value = true;
  error.value = "";

  setApiKey(apiKey.value.trim());

  try {
    await fetchApps();
    router.push("/apps");
  } catch {
    setApiKey("");
    error.value = "API Key 无效，请重试";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card card">
      <h1 class="login-title">Common Server</h1>
      <p class="login-desc">输入管理密钥登录后台</p>

      <form @submit.prevent="handleLogin">
        <div class="form-group">
          <label for="apiKey">API Key</label>
          <input
            id="apiKey"
            v-model="apiKey"
            type="password"
            placeholder="输入 ADMIN_API_KEY"
            autofocus
          />
        </div>

        <p v-if="error" class="login-error">{{ error }}</p>

        <button class="btn btn-primary login-btn" :disabled="loading || !apiKey.trim()">
          {{ loading ? "验证中..." : "登录" }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 40px 32px;
}

.login-title {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.5px;
  color: var(--primary);
  margin-bottom: 4px;
}

.login-desc {
  color: var(--text-dim);
  font-size: 14px;
  margin-bottom: 28px;
}

.login-btn {
  width: 100%;
  justify-content: center;
  padding: 12px;
  font-size: 15px;
}

.login-error {
  color: var(--danger);
  font-size: 13px;
  margin-bottom: 12px;
}
</style>
