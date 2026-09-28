#!/usr/bin/env bash
# Voidswarm - consistent online backup of the SQLite database (accounts, loot, chat log); keeps 14 days.
# Runs nightly from /etc/cron.d/voidswarm-backup (03:17 server time) and before every voidswarm-update.
# By hand: sudo voidswarm-backup
#
# Optional off-box copy: set BACKUP_REMOTE in /etc/voidswarm/voidswarm.env (or in the environment for one
# run) and each new backup is also copied there. Leave it unset for no copy. It can be:
#   s3://bucket/folder/            uses the AWS CLI, which must be installed and set up for root
#                                  (sudo aws configure) with keys that may write to that bucket
#   user@host:/existing/folder/    copied with scp as root: root needs an SSH key that the other machine
#                                  accepts (the first copy saves the host's key). The other machine needs
#                                  only SSH/SFTP (not rsync), so SFTP-only accounts and Windows work too.
#   /mnt/somewhere/                a local or mounted folder
# Only this server's copies are pruned (after 14 days). Prune the off-box copies there, e.g. with an S3
# lifecycle rule. If the off-box copy fails, the local backup is still made and this exits with 1.
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
DATA_DIR=/var/lib/voidswarm
DB="$DATA_DIR/voidswarm.db"
OUT_DIR="$DATA_DIR/backups"
ENV_FILE=/etc/voidswarm/voidswarm.env
# No prompts, and give up on a stalled connection after about a minute (voidswarm-update waits for this).
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
  -o StrictHostKeyChecking=accept-new)

# ---- env file reader ----
# Print one setting from a NAME=value env file the way systemd's EnvironmentFile= reads it, so this script
# sees exactly what the server sees. Nothing in the file is run or expanded (the file is never sourced, so
# an unquoted value with spaces can't break anything): quotes are removed (inside double quotes, \" \\ \$
# and \` stand for the plain character), unquoted text runs to the end of the line with trailing spaces
# trimmed, and the last line for a name wins. Returns 1 when the name isn't set.
env_get() {
  local want=$1 file=$2 line val out result='' found=1 i n c state ws
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    [[ ${BASH_REMATCH[1]} == "$want" ]] || continue
    val=${BASH_REMATCH[2]%$'\r'} out='' state=pre ws=-1 n=${#val}
    for (( i = 0; i < n; i++ )); do
      c=${val:i:1}
      case $state in
        pre) # after the = or a closing quote
          case $c in
            ' ' | $'\t') ;;
            "'") state=sq ;;
            '"') state=dq ;;
            '\') i=$((i + 1)); out+=${val:i:1}; state=plain ;;
            *) out+=$c; state=plain ;;
          esac ;;
        plain)
          case $c in
            '\') i=$((i + 1)); out+=${val:i:1}; ws=-1 ;;
            ' ' | $'\t') if (( ws < 0 )); then ws=${#out}; fi; out+=$c ;;
            *) out+=$c; ws=-1 ;;
          esac ;;
        sq) if [[ $c == "'" ]]; then state=pre; else out+=$c; fi ;;
        dq)
          case $c in
            '"') state=pre ;;
            '\') if [[ ${val:i+1:1} == [\"\\\`\$] ]]; then i=$((i + 1)); out+=${val:i:1}; else out+=$c; fi ;;
            *) out+=$c ;;
          esac ;;
      esac
    done
    if [[ $state == plain ]] && (( ws >= 0 )); then out=${out:0:ws}; fi
    result=$out found=0
  done <"$file"
  if (( found == 0 )); then printf '%s' "$result"; fi
  return "$found"
}
# ---- end env file reader ----

# ---- off-box copy ----
# Messages go to the terminal when run by hand, and always to the system log (journalctl -t voidswarm-backup).
note() {
  if [[ -t 1 ]]; then printf '%s\n' "$*"; fi
  if command -v logger >/dev/null 2>&1; then logger -t voidswarm-backup -- "$*" || true; fi
}
complain() {
  printf 'voidswarm-backup: %s\n' "$*" >&2
  if command -v logger >/dev/null 2>&1; then logger -t voidswarm-backup -p user.err -- "$*" || true; fi
}

# Copy one backup file to BACKUP_REMOTE (see the top of this file).
copy_offbox() {
  local src=$1 dest=$2
  case $dest in
    -*)
      complain "BACKUP_REMOTE can't start with '-' (got: $dest)"
      return 1
      ;;
    s3://*)
      if ! command -v aws >/dev/null 2>&1; then
        complain "BACKUP_REMOTE is an S3 address, but the AWS CLI (aws) isn't installed"
        return 1
      fi
      if [[ $dest != */ ]]; then dest+=/; fi
      aws s3 cp --only-show-errors "$src" "$dest${src##*/}"
      ;;
    /*)
      # a local or mounted folder
      cp -- "$src" "$dest"
      ;;
    *:*)
      # [user@]host:folder/ (or an scp:// address). OpenSSH's scp speaks SFTP, so it needs nothing but
      # SSH on the other machine.
      scp -q "${SSH_OPTS[@]}" "$src" "$dest"
      ;;
    *)
      cp -- "$src" "$dest"
      ;;
  esac
}
# ---- end off-box copy ----

[[ -f "$DB" ]] || exit 0
stamp=$(date +%F)
file="$OUT_DIR/voidswarm-$stamp.db"
sqlite3 "$DB" ".backup '$file'"
chown voidswarm:voidswarm "$file"
chmod 640 "$file"
find "$OUT_DIR" -name 'voidswarm-*.db' -type f -mtime +14 -delete
note "backed up the database to $file"

remote="${BACKUP_REMOTE:-}"
if [[ -z $remote && -r $ENV_FILE ]]; then remote=$(env_get BACKUP_REMOTE "$ENV_FILE" || true); fi
if [[ -z $remote ]]; then exit 0; fi
if copy_offbox "$file" "$remote"; then
  note "copied ${file##*/} to $remote"
else
  complain "the off-box copy to $remote failed (the backup on this server, $file, is fine)"
  exit 1
fi
