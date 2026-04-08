import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  createManagedUser,
  deleteManagedUser,
  listAdminUsers,
  resetManagedUserPassword,
  updateManagedUserRole,
} from "../services/authSession.js";

const router = Router();

function requireRoleAdmin(req, res, next) {
  if (!req.authUser || req.authUser.role !== "admin") {
    return res.status(403).json({ error: "需要管理员权限" });
  }
  next();
}

router.use(requireAuth, requireRoleAdmin);

router.get("/users", async (_req, res) => {
  try {
    const rows = await listAdminUsers();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "获取用户失败" });
  }
});

router.post("/users", async (req, res) => {
  try {
    const result = await createManagedUser({
      username: req.body?.username,
      password: req.body?.password,
      nickname: req.body?.nickname,
      role: req.body?.role,
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建用户失败";
    const statusCode = message.includes("已存在") ? 409 : 400;
    res.status(statusCode).json({ error: message });
  }
});

router.put("/users/:id/role", async (req, res) => {
  try {
    await updateManagedUserRole({
      targetUserId: req.params.id,
      role: req.body?.role,
      operatorUserId: req.authUser.id,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "更新角色失败" });
  }
});

router.post("/users/:id/reset-password", async (req, res) => {
  try {
    await resetManagedUserPassword({
      targetUserId: req.params.id,
      newPassword: req.body?.newPassword,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "重置密码失败" });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    await deleteManagedUser({
      targetUserId: req.params.id,
      operatorUserId: req.authUser.id,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除用户失败" });
  }
});

export default router;
