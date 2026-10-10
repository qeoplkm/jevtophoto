#!/bin/sh
# Write OPENROUTER_API_KEY from the project's .env into the app's Secrets.plist (git-ignored).
# Optional: you can instead paste the key into the app's Settings after installing.
set -e
cd "$(dirname "$0")"
ENV_FILE="../.env"
[ -f "$ENV_FILE" ] || { echo "No .env in the project root. Copy .env.example to .env and add your OpenRouter key."; exit 1; }
KEY=$(grep -E '^OPENROUTER_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d ' \r')
[ -n "$KEY" ] || { echo "OPENROUTER_API_KEY is empty in $ENV_FILE"; exit 1; }
cat > JevPhoto/JevPhoto/Resources/Secrets.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>OPENROUTER_API_KEY</key><string>$KEY</string></dict></plist>
PLIST
echo "Wrote JevPhoto/JevPhoto/Resources/Secrets.plist (key prefix $(echo "$KEY" | cut -c1-8)…)"
