#!/usr/bin/env bash
# Redis TLS et S3 HTTPS réels, avec données et certificats temporaires uniquement.
set -euo pipefail
scratch=$(mktemp -d /tmp/histae-services-smoke.XXXXXXXX)
name="histae-services-$(basename "$scratch")"
network="$name"
volume="$name-data"
redis="$name-redis"
storage="$name-storage"
gateway="$name-gateway"
client="$name-client"
nginx=nginx:1.30.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
cleanup() {
  docker rm -f "$client" "$gateway" "$storage" "$redis" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [[ "$(docker volume inspect -f '{{index .Labels "histae-smoke"}}' "$volume" 2>/dev/null)" == "$name" ]]; then
    docker volume rm "$volume" >/dev/null
  fi
  rm -f "$scratch/ca.key" "$scratch/ca.crt" "$scratch/ca.srl" \
    "$scratch/server.key" "$scratch/server.crt" "$scratch/server.csr"
  rmdir "$scratch"
}
trap cleanup EXIT
docker run --rm --user 0 --mount "type=bind,src=$scratch,dst=/tls" \
  --entrypoint sh postgres:18.6-bookworm -ec '
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=smoke-ca \
    -keyout /tls/ca.key -out /tls/ca.crt >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj /CN=redis -addext subjectAltName=DNS:redis,DNS:storage-smoke.test \
    -keyout /tls/server.key -out /tls/server.csr >/dev/null 2>&1
  openssl x509 -req -days 1 -in /tls/server.csr -CA /tls/ca.crt -CAkey /tls/ca.key \
    -CAcreateserial -copy_extensions copy -out /tls/server.crt >/dev/null 2>&1
  chown 0:101 /tls/server.key
  chmod 640 /tls/server.key
  chmod 644 /tls/ca.crt /tls/server.crt
  chmod 755 /tls
  '
docker network create "$network" >/dev/null
docker volume create --label "histae-smoke=$name" "$volume" >/dev/null
docker run -d --name "$redis" --network "$network" --network-alias redis --user 999:101 \
  --memory 256m --entrypoint redis-server \
  --mount "type=bind,src=$(pwd)/docker/redis/redis.conf,dst=/etc/redis/histae.conf,readonly" \
  --mount "type=bind,src=$scratch,dst=/etc/redis/tls,readonly" \
  --mount "type=bind,src=$scratch/ca.crt,dst=/run/secrets/postgres_ca,readonly" \
  redis:7.4.2-alpine /etc/redis/histae.conf --requirepass smoke-password >/dev/null
docker run -d --name "$storage" --network "$network" --network-alias object-storage --memory 512m \
  --mount "type=volume,src=$volume,dst=/data" \
  --mount "type=bind,src=$(pwd)/docker/seaweedfs/filer.toml,dst=/etc/seaweedfs/filer.toml,readonly" \
  --mount "type=bind,src=$(pwd)/test/fixtures/production-s3-identity.json,dst=/run/secrets/s3_identity,readonly" \
  chrislusf/seaweedfs:4.45 server -dir=/data -ip=object-storage -ip.bind=0.0.0.0 \
  -master.telemetry=false -master.volumeSizeLimitMB=1024 -volume.max=0 -volume.index=leveldb \
  -filer -filer.exposeDirectoryData=false -s3 -s3.config=/run/secrets/s3_identity \
  -s3.iam=false -s3.port.iceberg=0 -s3.port.lance=0 \
  -s3.allowDeleteBucketNotEmpty=false -s3.concurrentUploadLimitMB=32 >/dev/null
docker run -d --name "$gateway" --network "$network" --network-alias storage-smoke.test \
  --user 101:101 --read-only --tmpfs /tmp:size=32m,noexec,nosuid,nodev \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true --memory 128m \
  --mount "type=bind,src=$(pwd)/docker/storage-gateway/nginx.conf,dst=/etc/nginx/nginx.conf,readonly" \
  --mount "type=bind,src=$scratch,dst=/etc/nginx/tls,readonly" \
  --entrypoint nginx "$nginx" -g 'daemon off;' >/dev/null
ready=false
for ((attempt=0; attempt<45; attempt++)); do
  if docker exec "$storage" wget -q --spider http://127.0.0.1:8333/healthz >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
docker run --rm --name "$client" --network "$network" --memory 512m \
  --mount "type=bind,src=$scratch/ca.crt,dst=/ca.crt,readonly" \
  --mount "type=bind,src=$(pwd)/container-dist,dst=/app/container-dist,readonly" \
  --mount "type=bind,src=$(pwd)/test/helpers/production-services-client.mjs,dst=/app/smoke.mjs,readonly" \
  -e NODE_EXTRA_CA_CERTS=/ca.crt --entrypoint node histae-api:development /app/smoke.mjs
