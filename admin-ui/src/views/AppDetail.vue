<script setup>
import { ref, onMounted } from "vue";
import {
  fetchReleases,
  uploadRelease,
  deleteRelease,
} from "../composables/api.js";

const props = defineProps({ appId: String });

const releases = ref([]);
const total = ref(0);
const loading = ref(true);

const showUpload = ref(false);
const uploading = ref(false);
const form = ref({
  version: "",
  platform: "android",
  changelog: "",
  forceUpdate: false,
});
const selectedFile = ref(null);
const dragover = ref(false);

const toast = ref({ show: false, type: "", msg: "" });

const PLATFORMS = [
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
  { value: "electron-win", label: "Electron Windows" },
  { value: "electron-mac", label: "Electron macOS" },
  { value: "electron-linux", label: "Electron Linux" },
];

onMounted(() => loadReleases());

async function loadReleases() {
  loading.value = true;
  try {
    const data = await fetchReleases(props.appId);
    releases.value = data.releases;
    total.value = data.total;
  } catch {
    /* handled by api guard */
  } finally {
    loading.value = false;
  }
}

function onFileSelect(e) {
  const file = e.target.files?.[0];
  if (file) selectedFile.value = file;
}

function onDrop(e) {
  dragover.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) selectedFile.value = file;
}

async function handleUpload() {
  if (!selectedFile.value || !form.value.version.trim()) return;
  uploading.value = true;

  const fd = new FormData();
  fd.append("version", form.value.version.trim());
  fd.append("platform", form.value.platform);
  fd.append("changelog", form.value.changelog);
  fd.append("forceUpdate", form.value.forceUpdate ? "1" : "0");
  fd.append("file", selectedFile.value);

  try {
    await uploadRelease(props.appId, fd);
    showToast("success", "上传成功");
    resetForm();
    await loadReleases();
  } catch (err) {
    showToast("error", err.message);
  } finally {
    uploading.value = false;
  }
}

async function handleDelete(version, platform) {
  if (!confirm(`确定要删除 ${version} (${platform}) 吗？`)) return;
  try {
    await deleteRelease(props.appId, version, platform);
    showToast("success", "已删除");
    await loadReleases();
  } catch (err) {
    showToast("error", err.message);
  }
}

function resetForm() {
  showUpload.value = false;
  form.value = {
    version: "",
    platform: "android",
    changelog: "",
    forceUpdate: false,
  };
  selectedFile.value = null;
}

function showToast(type, msg) {
  toast.value = { show: true, type, msg };
  setTimeout(() => (toast.value.show = false), 3000);
}

function formatSize(bytes) {
  if (!bytes) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDate(dateStr) {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString("zh-CN");
}
</script>

<template>
  <div>
    <router-link to="/apps" class="back-link">← 返回应用列表</router-link>

    <div class="flex-between mb-16">
      <h1 class="page-title" style="margin-bottom: 0">{{ appId }}</h1>
      <button
        v-if="!showUpload"
        class="btn btn-primary"
        @click="showUpload = true"
      >
        上传新版本
      </button>
    </div>

    <!-- Upload Form -->
    <div v-if="showUpload" class="card upload-card">
      <h3 class="upload-title">上传新版本</h3>
      <form @submit.prevent="handleUpload">
        <div class="form-row">
          <div class="form-group" style="flex: 1">
            <label>版本号</label>
            <input
              v-model="form.version"
              type="text"
              placeholder="1.0.0"
              required
            />
          </div>
          <div class="form-group" style="flex: 1">
            <label>平台</label>
            <select v-model="form.platform">
              <option v-for="p in PLATFORMS" :key="p.value" :value="p.value">
                {{ p.label }}
              </option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label>更新日志</label>
          <textarea
            v-model="form.changelog"
            rows="3"
            placeholder="本次更新内容..."
          ></textarea>
        </div>

        <div class="form-group">
          <label>安装包文件</label>
          <div
            class="upload-zone"
            :class="{ dragover }"
            @dragover.prevent="dragover = true"
            @dragleave="dragover = false"
            @drop.prevent="onDrop"
            @click="$refs.fileInput.click()"
          >
            <div v-if="!selectedFile">拖拽文件到此处，或点击选择</div>
            <div v-else class="file-name">
              {{ selectedFile.name }} ({{ formatSize(selectedFile.size) }})
            </div>
          </div>
          <input ref="fileInput" type="file" hidden @change="onFileSelect" />
        </div>

        <div class="form-group">
          <label
            style="
              display: inline-flex;
              align-items: center;
              gap: 8px;
              cursor: pointer;
            "
          >
            <input v-model="form.forceUpdate" type="checkbox" />
            强制更新
          </label>
        </div>

        <div class="upload-actions">
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="uploading || !selectedFile || !form.version.trim()"
          >
            {{ uploading ? "上传中..." : "确认上传" }}
          </button>
          <button type="button" class="btn btn-outline" @click="resetForm">
            取消
          </button>
        </div>
      </form>
    </div>

    <!-- Releases Table -->
    <div v-if="loading" class="empty">加载中...</div>

    <div v-else-if="releases.length === 0 && !showUpload" class="card empty">
      <p>暂无版本，点击「上传新版本」发布第一个版本</p>
    </div>

    <div v-else-if="releases.length > 0" class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>平台</th>
              <th>大小</th>
              <th>更新日志</th>
              <th>发布时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in releases" :key="r.version + r.platform">
              <td>
                <strong>{{ r.version }}</strong>
                <span
                  v-if="r.forceUpdate"
                  class="tag tag-force"
                  style="margin-left: 6px"
                  >强制</span
                >
              </td>
              <td>
                <span class="tag tag-platform">{{ r.platform }}</span>
              </td>
              <td class="file-size">{{ formatSize(r.filesize) }}</td>
              <td class="changelog-cell">{{ r.changelog || "-" }}</td>
              <td style="white-space: nowrap">{{ formatDate(r.createdAt) }}</td>
              <td>
                <div class="action-btns">
                  <a
                    :href="r.downloadUrl"
                    target="_blank"
                    class="btn btn-outline btn-sm"
                    >下载</a
                  >
                  <button
                    class="btn btn-danger btn-sm"
                    @click="handleDelete(r.version, r.platform)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Toast -->
    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">
      {{ toast.msg }}
    </div>
  </div>
</template>

<style scoped>
.upload-card {
  padding: 24px;
  margin-bottom: 24px;
}

.upload-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 20px;
}

.form-row {
  display: flex;
  gap: 16px;
}

.upload-actions {
  display: flex;
  gap: 10px;
}

.changelog-cell {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-btns {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .form-row {
    flex-direction: column;
    gap: 0;
  }
}
</style>
