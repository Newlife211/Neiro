#!/usr/bin/env bash
# Ежедневный бэкап базы. Добавьте в crontab на сервере:
#   15 3 * * * /opt/neiro/deploy/backup.sh >> /var/log/neuro-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
DEST=${BACKUP_DIR:-/opt/neiro-backups}; mkdir -p "$DEST"
STAMP=$(date +%F-%H%M)
docker compose exec -T app node --disable-warning=ExperimentalWarning -e "
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/neurosfera.db');d.exec(\"VACUUM INTO '/data/backup.db'\");"
docker compose cp app:/data/backup.db "$DEST/neurosfera-$STAMP.db"
docker compose exec -T app rm -f /data/backup.db
gzip -f "$DEST/neurosfera-$STAMP.db"
find "$DEST" -name 'neurosfera-*.db.gz' -mtime +30 -delete
echo "$(date) backup ok: $DEST/neurosfera-$STAMP.db.gz"
