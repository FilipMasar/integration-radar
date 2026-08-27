FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

# The base image ships a preinstalled node_modules whose crawlee version drifts
# from the one this lockfile pins, which makes Actor.init() refuse to start.
# --prod=false is required because the base image sets NODE_ENV=production,
# which would otherwise make pnpm skip devDependencies.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod=false

COPY --chown=myuser:myuser . ./

RUN pnpm run build

FROM apify/actor-node:24

COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

# The inherited node_modules goes for the same reason as in the builder stage.
# The pnpm store is dropped in the same layer; node_modules entries are hard
# links, so the files stay intact.
RUN rm -rf node_modules \
    && pnpm install --frozen-lockfile --prod \
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
