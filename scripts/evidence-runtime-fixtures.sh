#!/usr/bin/env bash
set -euo pipefail

postgres_fixture=${EVIDENCE_POSTGRES_CONTAINER:?Expected the CI PostgreSQL service container}
postgres_port=${EVIDENCE_POSTGRES_PORT:?Expected the CI PostgreSQL service port}
scratch=$(mktemp -d "${RUNNER_TEMP:?}/readily-tls.XXXXXX")
cache_fixture=
cleanup() {
  if [[ -n "$cache_fixture" ]]; then docker stop "$cache_fixture" >/dev/null || true; fi
  rm -f -- "$scratch/server.crt" "$scratch/server.key"
  rmdir -- "$scratch"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$scratch/server.key" -out "$scratch/server.crt" \
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
docker cp "$scratch/server.crt" "$postgres_fixture:/tmp/readily-server.crt"
docker cp "$scratch/server.key" "$postgres_fixture:/tmp/readily-server.key"
docker exec -u root "$postgres_fixture" chown postgres:postgres /tmp/readily-server.crt /tmp/readily-server.key
docker exec -u root "$postgres_fixture" chmod 600 /tmp/readily-server.key
docker exec "$postgres_fixture" psql -X -v ON_ERROR_STOP=1 -U readily_test -d readily_v1_test \
  -c "ALTER SYSTEM SET ssl_cert_file='/tmp/readily-server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file='/tmp/readily-server.key'" \
  -c 'ALTER SYSTEM SET ssl=on' -c 'SELECT pg_reload_conf()' >/dev/null

cache_password=$(openssl rand -hex 24)
cache_fixture=$(docker run --rm -d --user "$(id -u):$(id -g)" -p 127.0.0.1::6379 \
  --mount "type=bind,source=$scratch,target=/readily-certs,readonly" \
  redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe \
  redis-server --save '' --port 0 --tls-port 6379 --tls-cert-file /readily-certs/server.crt \
  --tls-key-file /readily-certs/server.key --tls-ca-cert-file /readily-certs/server.crt \
  --tls-auth-clients no --requirepass "$cache_password")
cache_address=$(docker port "$cache_fixture" 6379/tcp)
cache_port=${cache_address##*:}
for attempt in {1..20}; do
  if docker exec -e "REDISCLI_AUTH=$cache_password" "$cache_fixture" \
    redis-cli --tls --cacert /readily-certs/server.crt ping 2>/dev/null | grep -qx PONG; then break; fi
  if [[ "$attempt" == 20 ]]; then echo 'TLS Redis fixture did not start' >&2; exit 1; fi
  sleep 0.5
done
docker exec "$postgres_fixture" psql -AtX -U readily_test -d readily_v1_test -c 'SHOW ssl' | grep -qx on

NODE_EXTRA_CA_CERTS="$scratch/server.crt" \
  READILY_V1_TEST_DATABASE_URL="postgresql://readily_test:readily_test@localhost:$postgres_port/readily_v1_test?sslmode=verify-full" \
  READILY_V1_TEST_REDIS_URL="rediss://default:$cache_password@localhost:$cache_port" \
  npm run test:evidence:http
