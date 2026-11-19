#!/usr/bin/env bash
# Ежедневный бэкап базы. Добавьте в crontab на сервере:
#   15 3 * * * /opt/neiro/deploy/backup.sh >> /var/log/neuro-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
# переменные BACKUP_* берутся из deploy/.env
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DEST=${BACKUP_DIR:-/opt/neiro-backups}; mkdir -p "$DEST"
STAMP=$(date +%F-%H%M)
docker compose exec -T app node --disable-warning=ExperimentalWarning -e "
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/neurosfera.db');d.exec(\"VACUUM INTO '/data/backup.db'\");"
docker compose cp app:/data/backup.db "$DEST/neurosfera-$STAMP.db"
docker compose exec -T app rm -f /data/backup.db
gzip -f "$DEST/neurosfera-$STAMP.db"
FILE="$DEST/neurosfera-$STAMP.db.gz"
# Шифрование: без пароля копию вне сервера прочитать нельзя (пароль храните отдельно от сервера)
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$FILE" -out "$FILE.enc"
  rm -f "$FILE"; FILE="$FILE.enc"
fi
# Копия вне сервера (rclone: Google Drive, Backblaze B2, S3, Cloudflare R2 и др.) — сервер может сгореть вместе с бэкапами
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$FILE" "$BACKUP_RCLONE_REMOTE" && echo "$(date) offsite ok: $BACKUP_RCLONE_REMOTE"
  rclone delete --min-age 90d "$BACKUP_RCLONE_REMOTE" --include 'neurosfera-*' || true
fi
find "$DEST" -name 'neurosfera-*.db.gz*' -mtime +30 -delete
echo "$(date) backup ok: $FILE"
# Восстановление: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in файл.enc | gunzip > neurosfera.db
