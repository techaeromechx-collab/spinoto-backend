#!/bin/bash
set -e

APP_DIR="/var/www/html/spinoto-backend"
DEPLOY_DIR="/tmp/spinoto-backend"
PM2_APP="spinoto-backend"

echo "============================================================"
echo "        SPINOTO BACKEND DEPLOYMENT"
echo "============================================================"

export NVM_DIR="/home/ubuntu/.nvm"
source "$NVM_DIR/nvm.sh"

echo "Node:"
node -v

echo "NPM:"
npm -v

echo "Copying deployment files..."

rsync -a \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='node_modules' \
  "$DEPLOY_DIR/" "$APP_DIR/"

cd "$APP_DIR"

echo "Installing dependencies..."
npm install

echo "Running migrations..."
npm run db:migrate

echo "Restarting backend..."
pm2 restart "$PM2_APP"

echo "Saving PM2 configuration..."
pm2 save

echo "Backend deployment completed successfully."

pm2 status "$PM2_APP"
