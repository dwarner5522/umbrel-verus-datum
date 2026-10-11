# Verus solo mining stratum server + web dashboard for umbrelOS.
# The stratum server is verus-datum-cli, pinned by commit. The build ends with its self-test,
# which checks the hashing module against real Verus mainnet blocks.

FROM node:22-bookworm-slim AS stratum

RUN apt-get update \
	&& apt-get install -y --no-install-recommends build-essential ca-certificates git python3 \
	&& rm -rf /var/lib/apt/lists/*

ARG STRATUM_COMMIT=929acab1ae2fc25fe1d81e581c0450bc76f06731
RUN set -eux; \
	git clone https://github.com/dwarner5522/verus-datum-cli /opt/verus-datum-cli; \
	cd /opt/verus-datum-cli; \
	git checkout --detach "${STRATUM_COMMIT}"; \
	# builds the native verushash module; the server itself has no npm dependencies
	npm install; \
	npm test; \
	rm -rf .git build/Release/obj.target build/Release/.deps

FROM node:22-bookworm-slim

COPY --from=stratum /opt/verus-datum-cli /opt/verus-datum-cli
COPY server /app

ENV NODE_ENV=production

WORKDIR /app
USER 1000:1000
EXPOSE 3000 9999
VOLUME /data

CMD ["node", "server.js"]
