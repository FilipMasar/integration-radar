# Specify the base Docker image. You can read more about
# the available images at https://docs.apify.com/sdk/js/docs/guides/docker-images
# You can also use any other image from Docker Hub.
FROM apify/actor-node:24 AS builder

# The base image ships only npm, so install the pinned pnpm.
# Keep this version in sync with "packageManager" in package.json.
RUN npm install -g pnpm@10.28.0

# Check preinstalled packages
RUN npm ls @crawlee/core apify puppeteer playwright

# Copy just the manifest and the lockfile
# to speed up the build using Docker layer cache.
COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

# Install all dependencies, including dev ones needed for the build.
# --prod=false is required because the base image sets NODE_ENV=production,
# which would otherwise make pnpm skip devDependencies.
RUN pnpm install --frozen-lockfile --prod=false

# Next, copy the source files using the user set
# in the base image.
COPY --chown=myuser:myuser . ./

# Build the project.
RUN pnpm run build

# Create final image
FROM apify/actor-node:24

RUN npm install -g pnpm@10.28.0

# Check preinstalled packages
RUN npm ls @crawlee/core apify puppeteer playwright

# Copy just the manifest and the lockfile
# to speed up the build using Docker layer cache.
COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./

# Install runtime packages only, skipping optional and development
# dependencies to keep the image small. The pnpm store is dropped in the same
# layer; node_modules entries are hard links, so the files stay intact.
RUN pnpm install --frozen-lockfile --prod --no-optional \
    && echo "Installed packages:" \
    && (pnpm list --depth 0 || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "pnpm version:" \
    && pnpm --version \
    && rm -rf "$(pnpm store path 2>/dev/null || echo /root/.local/share/pnpm/store)" ~/.npm

# Copy built JS files from builder image
COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

# Next, copy the remaining files and directories with the source code.
# Since we do this after the install, quick build will be really fast
# for most source file changes.
COPY --chown=myuser:myuser . ./

# Run the image.
CMD ["node", "dist/main.js"]
