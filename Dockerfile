FROM apify/actor-node:24 AS builder

RUN npm install -g pnpm@10.28.0

RUN npm ls @crawlee/core apify puppeteer playwright

COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod=false

COPY --chown=myuser:myuser . ./

RUN pnpm run build

FROM apify/actor-node:24

RUN npm install -g pnpm@10.28.0

RUN npm ls @crawlee/core apify puppeteer playwright

COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod --no-optional \
    && echo "Installed packages:" \
    && (pnpm list --depth 0 || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "pnpm version:" \
    && pnpm --version \
    && rm -rf "$(pnpm store path 2>/dev/null || echo /root/.local/share/pnpm/store)" ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

COPY --chown=myuser:myuser . ./

CMD ["node", "dist/main.js"]
