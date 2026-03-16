<script setup>
import { ref, onMounted } from "vue";
import { fetchApps } from "../composables/api.js";

const apps = ref([]);
const loading = ref(true);
const newAppId = ref("");
const showNewApp = ref(false);

onMounted(async () => {
  try {
    apps.value = await fetchApps();
  } catch {
    /* auth guard handles 401 */
  } finally {
    loading.value = false;
  }
});

function formatDate(dateStr) {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <div>
    <div class="flex-between mb-16">
      <h1 class="page-title" style="margin-bottom: 0">应用管理</h1>
      <router-link
        v-if="showNewApp && newAppId.trim()"
        :to="`/apps/${newAppId.trim()}`"
        class="btn btn-primary"
      >
        前往上传
      </router-link>
    </div>

    <div v-if="loading" class="empty">加载中...</div>

    <div v-else-if="apps.length === 0 && !showNewApp" class="card empty">
      <p style="font-size: 16px; margin-bottom: 12px">暂无应用</p>
      <p style="margin-bottom: 16px">上传第一个版本后，应用会自动出现在这里</p>
      <button class="btn btn-primary" @click="showNewApp = true">
        添加应用
      </button>
    </div>

    <template v-else>
      <div v-if="!showNewApp" style="margin-bottom: 16px">
        <button class="btn btn-outline btn-sm" @click="showNewApp = true">
          + 新应用
        </button>
      </div>

      <div v-if="showNewApp" class="card new-app-bar">
        <input
          v-model="newAppId"
          type="text"
          placeholder="输入 App ID，例如 my-new-app"
          autofocus
        />
        <router-link
          v-if="newAppId.trim()"
          :to="`/apps/${newAppId.trim()}`"
          class="btn btn-primary btn-sm"
        >
          前往上传
        </router-link>
        <button class="btn btn-outline btn-sm" @click="showNewApp = false">
          取消
        </button>
      </div>

      <div class="apps-grid">
        <router-link
          v-for="app in apps"
          :key="app.appId"
          :to="`/apps/${app.appId}`"
          class="app-card card"
        >
          <div class="app-icon">{{ app.appId.charAt(0).toUpperCase() }}</div>
          <div class="app-info">
            <div class="app-name">{{ app.appId }}</div>
            <div class="app-meta">
              {{ app.releaseCount }} 个版本 · 最近更新
              {{ formatDate(app.lastRelease) }}
            </div>
          </div>
          <div class="app-arrow">→</div>
        </router-link>
      </div>
    </template>
  </div>
</template>

<style scoped>
.apps-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.app-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 20px;
  text-decoration: none;
  color: inherit;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.app-card:hover {
  border-color: var(--primary);
  box-shadow: 0 2px 8px rgba(59, 91, 219, 0.08);
}

.app-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--primary), #5c7cfa);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
  flex-shrink: 0;
}

.app-info {
  flex: 1;
  min-width: 0;
}

.app-name {
  font-size: 16px;
  font-weight: 600;
}

.app-meta {
  font-size: 13px;
  color: var(--text-dim);
  margin-top: 2px;
}

.app-arrow {
  color: var(--text-dim);
  font-size: 18px;
  flex-shrink: 0;
}

.new-app-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 16px;
}

.new-app-bar input {
  flex: 1;
}
</style>
