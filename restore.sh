#!/bin/bash
# You-Chat restore script
# Clones from GitHub and sets up the app to survive Railway redeploys
# DEPENDS ON: gh-persist (for git authentication)
set -e

PERSIST_DIR="/data/.you-chat-persist"
APP_DIR="$PERSIST_DIR/app"
REPO="https://github.com/hiawoood/you-chat.git"
NGROK_BIN="$PERSIST_DIR/bin/ngrok"
NGROK_CONFIG="$PERSIST_DIR/ngrok/ngrok.yml"

echo "💬 You-Chat:"

# Ensure bun is available, install if missing
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun &> /dev/null; then
    echo "  📥 Installing Bun..."
    curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1
    export PATH="$HOME/.bun/bin:$PATH"
    if command -v bun &> /dev/null; then
        echo "  ✅ Bun $(bun --version) installed"
    else
        echo "  ❌ Failed to install Bun"
        exit 1
    fi
else
    echo "  ✅ Bun $(bun --version) found"
fi

# Restore ngrok if persisted
if [ -f "$NGROK_BIN" ]; then
    cp "$NGROK_BIN" /usr/local/bin/ngrok
    chmod +x /usr/local/bin/ngrok
    echo "  ✅ ngrok restored"
else
    echo "  📥 Installing ngrok..."
    curl -sSL -o /tmp/ngrok.tgz https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz
    tar xzf /tmp/ngrok.tgz -C /tmp
    mkdir -p "$PERSIST_DIR/bin"
    cp /tmp/ngrok "$PERSIST_DIR/bin/ngrok"
    cp /tmp/ngrok /usr/local/bin/ngrok
    chmod +x /usr/local/bin/ngrok "$PERSIST_DIR/bin/ngrok"
    rm -f /tmp/ngrok /tmp/ngrok.tgz
    echo "  ✅ ngrok installed"
fi

# Restore ngrok config (auth token)
if [ -f "$NGROK_CONFIG" ]; then
    mkdir -p "$HOME/.config/ngrok"
    cp "$NGROK_CONFIG" "$HOME/.config/ngrok/ngrok.yml"
    echo "  ✅ ngrok auth restored"
fi

# Restore cloudflared if persisted (legacy)
if [ -f "$PERSIST_DIR/bin/cloudflared" ]; then
    cp "$PERSIST_DIR/bin/cloudflared" /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
fi

# Clone or pull repo
if [ -d "$APP_DIR/.git" ]; then
    echo "  📥 Pulling latest..."
    cd "$APP_DIR"
    git pull -q origin main 2>/dev/null || true
else
    echo "  📦 Cloning from GitHub..."
    rm -rf "$APP_DIR"
    git clone -q "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
    echo "  📦 Installing dependencies..."
    bun install --silent
fi

# Build frontend
echo "  🔨 Building..."
bun run build > /dev/null 2>&1

# Create data directory for SQLite
mkdir -p "$APP_DIR/data"

# Copy .env if exists in persist dir but not in app
if [ -f "$PERSIST_DIR/.env" ] && [ ! -f "$APP_DIR/.env" ]; then
    cp "$PERSIST_DIR/.env" "$APP_DIR/.env"
    echo "  ✅ Restored .env"
fi

# Create .env if missing (with defaults)
if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" << 'ENVEOF'
PORT=3001
BETTER_AUTH_SECRET=change-me-to-something-secure
BETTER_AUTH_URL=http://localhost:3001
# YOU_API_KEY removed - now uses cookie-based auth
ENVEOF
    cp "$APP_DIR/.env" "$PERSIST_DIR/.env"
    echo "  ⚠️  Created default .env - update with your API keys!"
fi

# Create wrapper scripts
cat > /usr/local/bin/you-chat << 'EOFWRAPPER'
#!/bin/bash
# You-Chat server with ngrok tunnel
export PATH="$HOME/.bun/bin:$PATH"
cd /data/.you-chat-persist/app

PORT=${PORT:-3001}
NGROK="/data/.you-chat-persist/bin/ngrok"
NGROK_DOMAIN_FILE="/data/.you-chat-persist/ngrok-domain.txt"

# Start the server in background
echo "🚀 Starting You-Chat on port $PORT..."
PORT=$PORT bun run src/server/index.ts &
SERVER_PID=$!

# Wait for server to be ready
sleep 2
if ! curl -s http://localhost:$PORT/api/agents >/dev/null 2>&1; then
    echo "⚠️  Server may still be starting..."
    sleep 2
fi

# Start ngrok tunnel
if [ -f "$NGROK" ]; then
    echo "🌐 Starting ngrok tunnel..."
    
    # Check for static domain
    NGROK_ARGS="http $PORT"
    if [ -f "$NGROK_DOMAIN_FILE" ]; then
        DOMAIN=$(cat "$NGROK_DOMAIN_FILE")
        NGROK_ARGS="http --domain=$DOMAIN $PORT"
        echo "📌 Using static domain: $DOMAIN"
    fi
    
    $NGROK $NGROK_ARGS --log /tmp/ngrok.log &
    TUNNEL_PID=$!
    
    # Wait for tunnel URL
    sleep 4
    TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"[^"]*"' | sed 's/"public_url":"//;s/"//')
    
    if [ -n "$TUNNEL_URL" ]; then
        echo ""
        echo "✅ You-Chat is live!"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🔗 Public URL: $TUNNEL_URL"
        echo "🏠 Local URL:  http://localhost:$PORT"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "$TUNNEL_URL" > /data/.you-chat-persist/tunnel-url.txt
    else
        echo "⚠️  Tunnel starting... check: tail -f /tmp/ngrok.log"
    fi
else
    echo "⚠️  ngrok not found, running local only"
    echo "🏠 Local URL: http://localhost:$PORT"
fi

# Handle shutdown
cleanup() {
    echo ""
    echo "🛑 Shutting down..."
    kill $SERVER_PID 2>/dev/null
    kill $TUNNEL_PID 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

# Keep running
wait $SERVER_PID
EOFWRAPPER
chmod +x /usr/local/bin/you-chat

cat > /usr/local/bin/you-chat-dev << 'EOF'
#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"
cd /data/.you-chat-persist/app
echo "Starting backend on :3001 and frontend on :5173..."
PORT=3001 bun run src/server/index.ts &
bun run dev:client &
wait
EOF
chmod +x /usr/local/bin/you-chat-dev

echo "  ✅ Ready! Commands: you-chat (server+ngrok) | you-chat-dev (dev mode)"
