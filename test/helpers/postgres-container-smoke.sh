#!/usr/bin/env bash
# Test TLS réel, isolé des données/projets Compose. Exécuter depuis la racine du dépôt.
set -euo pipefail
image=postgres:18.6-bookworm
scratch=$(mktemp -d /tmp/histae-pg-smoke.XXXXXXXX)
name="histae-pg-smoke-$(basename "$scratch")"
network="$name"
client="$name-client"

cleanup() {
  docker rm -f "$client" "$name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  # Uniquement les fichiers générés dans le répertoire temporaire de ce test.
  rm -f "$scratch/ca.key" "$scratch/ca.crt" "$scratch/ca.srl" \
    "$scratch/server.key" "$scratch/server.crt" "$scratch/server.csr"
  rmdir "$scratch"
}
trap cleanup EXIT

# Certificats éphémères sans rapport avec les secrets de production.
docker run --rm --user 0 --mount "type=bind,src=$scratch,dst=/tls" \
  --entrypoint sh "$image" -ec '
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=smoke-ca \
    -keyout /tls/ca.key -out /tls/ca.crt >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj /CN=postgres -addext subjectAltName=DNS:postgres \
    -keyout /tls/server.key -out /tls/server.csr >/dev/null 2>&1
  openssl x509 -req -days 1 -in /tls/server.csr -CA /tls/ca.crt -CAkey /tls/ca.key \
    -CAcreateserial -copy_extensions copy -out /tls/server.crt >/dev/null 2>&1
  chown postgres:postgres /tls/server.key
  chmod 644 /tls/ca.crt /tls/server.crt
  chmod 755 /tls
  '
docker network create "$network" >/dev/null
# Réduire uniquement la mémoire pour le smoke test sur PC : aucun test de charge.
# tmpfs : aucune donnée du test ne persiste après suppression du conteneur.
docker run -d --name "$name" --network "$network" --network-alias postgres \
  --memory 512m --memory-swap 512m --shm-size 64m \
  --tmpfs /var/lib/postgresql:rw,size=256m \
  --mount "type=bind,src=$(pwd)/docker/postgres,dst=/etc/postgresql/histae,readonly" \
  --mount "type=bind,src=$scratch,dst=/etc/postgresql/tls,readonly" \
  -e POSTGRES_DB=smoke -e POSTGRES_USER=smoke -e POSTGRES_PASSWORD=smoke-only-password \
  -e 'POSTGRES_INITDB_ARGS=--data-checksums --auth-host=scram-sha-256' \
  -e PGDATA=/var/lib/postgresql/18/docker "$image" \
  postgres -c config_file=/etc/postgresql/histae/postgresql.conf \
  -c shared_buffers=128MB >/dev/null

sql() {
  docker run --rm --name "$client" --network "$network" \
    --mount "type=bind,src=$scratch/ca.crt,dst=/ca.crt,readonly" \
    -e PGPASSWORD="${password:-smoke-only-password}" -e PGSSLMODE="${mode:-verify-full}" \
    -e PGSSLROOTCERT=/ca.crt "$image" psql -h "${host:-postgres}" -U smoke -d smoke \
    -v ON_ERROR_STOP=1 -Atc "$1"
}

ready=false
for ((attempt=0; attempt<30; attempt++)); do
  if sql 'SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'PostgreSQL TLS did not become ready' >&2; exit 1; fi
[[ "$(sql 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')" == t ]]
[[ "$(sql 'SHOW work_mem')" == 4MB ]]
[[ "$(sql 'SHOW max_connections')" == 100 ]]
if mode=disable sql 'SELECT 1' >/dev/null 2>&1; then echo 'Plaintext TCP was accepted' >&2; exit 1; fi
if password=incorrect sql 'SELECT 1' >/dev/null 2>&1; then echo 'Incorrect password was accepted' >&2; exit 1; fi
if host="$name" sql 'SELECT 1' >/dev/null 2>&1; then echo 'Invalid TLS hostname was accepted' >&2; exit 1; fi
# Même client pg et même mécanisme de CA que les conteneurs applicatifs.
# L'image de développement doit déjà être construite.
docker run --rm --name "$client" --network "$network" \
  --mount "type=bind,src=$scratch/ca.crt,dst=/ca.crt,readonly" \
  -e NODE_EXTRA_CA_CERTS=/ca.crt --entrypoint node histae-api:development -e '
  const { Client } = require("pg");
  const client = new Client({host:"postgres", user:"smoke", database:"smoke",
    password:"smoke-only-password", ssl:true, connectionTimeoutMillis:5000});
  (async () => {
    try {
      await client.connect();
      const result = await client.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
      if (result.rows[0]?.ssl !== true) throw new Error("tls_required");
    } finally { await client.end(); }
  })().catch(() => { console.error("Node pg TLS smoke failed"); process.exitCode=1; });
  '
echo 'PASS: TLS verified with psql and Node pg; plaintext, incorrect password and incorrect hostname rejected.'
