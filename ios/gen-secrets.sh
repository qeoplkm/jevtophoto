#!/bin/sh
# 把 ~/jev/.env（或项目根 .env）里的 OPENROUTER_API_KEY 写成 app 的 Secrets.plist（不进 git）。也可以不生成，在 app 设置里手动粘。
set -e
cd "$(dirname "$0")"
ENV_FILE="../.env"; [ -f "$ENV_FILE" ] || ENV_FILE="$HOME/jev/.env"
KEY=$(grep -E '^OPENROUTER_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d ' \r')
[ -n "$KEY" ] || { echo "在 $ENV_FILE 里没找到 OPENROUTER_API_KEY"; exit 1; }
cat > JevPhoto/JevPhoto/Resources/Secrets.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>OPENROUTER_API_KEY</key><string>$KEY</string></dict></plist>
PLIST
echo "写入 JevPhoto/JevPhoto/Resources/Secrets.plist（key 前缀 $(echo "$KEY" | cut -c1-8)…）"
