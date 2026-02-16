FROM alpine:3.21

RUN apk add --no-cache bash openssl coreutils

WORKDIR /app

# Minimal HTTP server that exposes config-cli vault operations over HTTP.
# Endpoints:
#   GET  /health          → 200 OK
#   GET  /list            → key names (one per line)
#   GET  /get?key=<name>  → decrypted value
#   POST /set             → body: key=<name>&value=<val>  → stores encrypted value
COPY config-cli-server.sh /app/config-cli-server.sh
RUN chmod +x /app/config-cli-server.sh

EXPOSE 9100

CMD ["/app/config-cli-server.sh"]
