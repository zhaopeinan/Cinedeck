#!/usr/bin/env bash
# Generate a self-signed TLS cert with IP/DNS SANs for LAN HTTPS (microphone).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${CERT_DIR:-$ROOT_DIR/certs}"
DAYS="${DAYS:-825}"
# Default SAN list; override with CERT_IP / EXTRA_SAN
CERT_IP="${CERT_IP:-172.31.246.72}"
EXTRA_SAN="${EXTRA_SAN:-IP:127.0.0.1,DNS:localhost}"

mkdir -p "$CERT_DIR"
KEY="$CERT_DIR/privkey.pem"
CRT="$CERT_DIR/fullchain.pem"
CFG="$CERT_DIR/openssl.cnf"

SAN="IP:${CERT_IP}"
if [[ -n "$EXTRA_SAN" ]]; then
  SAN="${SAN},${EXTRA_SAN}"
fi

cat > "$CFG" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ${CERT_IP}

[v3_req]
subjectAltName = ${SAN}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$KEY" \
  -out "$CRT" \
  -config "$CFG"

chmod 600 "$KEY"
chmod 644 "$CRT"
rm -f "$CFG"

echo "Wrote $CRT and $KEY (SAN: $SAN, days=$DAYS)"
