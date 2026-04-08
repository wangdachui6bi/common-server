import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  changeUserPassword,
  createUserSession,
  invalidateSessionToken,
  listUsers,
  loginUser,
  registerUser,
  updateUserMenuPermissions,
} from "../services/authSession.js";

const router = Router();

function toCompatPayload(user, session, tokenFallback = "") {
  const token = session?.token || tokenFallback || "";
  const expiresAt = session?.expiresAt || "";
  return {
    token,
    expiresAt,
    user,
    session: {
      token,
      expiresAt,
    },
  };
}

router.post("/register", async (req, res) => {
  try {
    const user = await registerUser({
      username: req.body.username,
      displayName: req.body.displayName,
      password: req.body.password,
    });
    const session = await createUserSession(user.id);
    res.json(toCompatPayload(user, session));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "注册失败" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const user = await loginUser({
      username: req.body.username,
      password: req.body.password,
    });
    const session = await createUserSession(user.id);
    res.json(toCompatPayload(user, session));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "登录失败" });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  await invalidateSessionToken(req.authToken);
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const users = await listUsers();
  const currentUser = users.find((item) => String(item.id) === String(req.authUser.id)) || req.authUser;
  const payload = toCompatPayload(
    currentUser,
    {
      token: req.authToken,
      expiresAt: req.authSession?.expiresAt || "",
    },
    req.authToken
  );
  res.json({
    ...currentUser,
    ...payload,
  });
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    await changeUserPassword({
      userId: req.authUser.id,
      oldPassword: req.body.oldPassword,
      newPassword: req.body.newPassword,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "修改密码失败" });
  }
});

router.get("/users", requireAuth, async (_req, res) => {
  res.json({
    items: await listUsers(),
  });
});

router.patch("/users/:id/menu-permissions", requireAuth, async (req, res) => {
  if (!req.authUser?.isOwner && !req.authUser?.menuPermissions?.managePermissions) {
    return res.status(403).json({ error: "Forbidden: insufficient permission" });
  }

  try {
    await updateUserMenuPermissions({
      userId: String(req.params.id || "").trim(),
      menuPermissions: req.body.menuPermissions,
    });

    res.json({
      items: await listUsers(),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "更新权限失败" });
  }
});

export default router;
