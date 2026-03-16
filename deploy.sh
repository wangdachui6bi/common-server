#!/usr/bin/env bash
set -euo pipefail

# ========================================
# 手动部署 common-server 到 /srv/common-server
# Usage: ./deploy.sh [ssh-host]
#   ssh-host: SSH config 里的 Host 别名或 user@ip（默认 niuniu）
# ========================================

SERVER="${1:-niuniu}"
DEPLOY_PATH="/srv/common-server"

echo "==> 同步文件到 $SERVER:$DEPLOY_PATH"
ssh "$SERVER" "mkdir -p $DEPLOY_PATH"

rsync -avz --delete \
  --exclude node_modules \
  --exclude admin-ui/node_modules \
  --exclude admin-ui/dist \
  --exclude .git \
  --exclude .env \
  --exclude uploads \
  --exclude '*.log' \
  ./ "$SERVER:$DEPLOY_PATH/"

echo "==> 构建并启动"
ssh "$SERVER" "cd $DEPLOY_PATH && docker compose up -d --build --remove-orphans && docker image prune -f"

echo "==> 完成！"
