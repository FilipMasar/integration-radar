FROM apify/actor-node:24 AS builder

RUN npm ls @crawlee/core apify puppeteer playwright

COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

# --prod=false is required because the base image sets NODE_ENV=production,
# which would otherwise make pnpm skip devDependencies.
RUN pnpm install --frozen-lockfile --prod=false

COPY --chown=myuser:myuser . ./

RUN pnpm run build

FROM apify/actor-node:24

RUN npm ls @crawlee/core apify puppeteer playwright

COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

# The pnpm store is dropped in the same layer; node_modules entries are hard
# links, so the files stay intact.
RUN pnpm install --frozen-lockfile --prod \
    && echo "Installed packages:" \
    && (pnpm list --depth 0 || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "pnpm version:" \
    && pnpm --version \
    && rm -rf "$(pnpm store path 2>/dev/null || echo /root/.local/share/pnpm/store)" ~/.npm ~/.cache/node

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

COPY --chown=myuser:myuser . ./

CMD ["node", "dist/main.js"]
