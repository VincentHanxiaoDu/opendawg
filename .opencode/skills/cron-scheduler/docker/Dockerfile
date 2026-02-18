FROM node:18-alpine

RUN apk add --no-cache bash curl git procps openssl jq

# Install Cronicle from source
RUN mkdir -p /opt/cronicle \
    && cd /opt/cronicle \
    && curl -sL https://github.com/jhuckaby/Cronicle/archive/master.tar.gz | tar xz --strip-components=1 \
    && npm install --production \
    && node bin/build.js dist

WORKDIR /opt/cronicle

COPY entrypoint.sh /opt/cronicle/entrypoint.sh
RUN chmod +x /opt/cronicle/entrypoint.sh

VOLUME ["/opt/cronicle/data", "/opt/cronicle/logs"]

EXPOSE 3012

ENTRYPOINT ["/opt/cronicle/entrypoint.sh"]
