# Egress proxy for Docker sandboxes with a `spec.network` allowlist. The Docker
# provider runs one next to each such sandbox; see README.md, "Network
# allowlists". It is a static Rust binary on an empty base image.
#
# Build from the repository root:
#   docker build -t sandbox-egress-proxy images/egress-proxy

# Keep the Rust version in step with rust-toolchain.toml.
FROM --platform=$BUILDPLATFORM rust:1.99.0-slim-trixie AS build
# The binary is cross-compiled on the build platform for each target platform,
# so multi-platform builds need no emulation. rust-lld links the static musl
# binary for either architecture without a C cross toolchain; build scripts
# and proc macros are built for the (glibc) build platform with its own linker.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x86_64-unknown-linux-musl ;; \
      arm64) echo aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac > /rust-target \
 && rustup target add "$(cat /rust-target)"
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    cargo build --release --locked --target "$(cat /rust-target)" \
 && cp "target/$(cat /rust-target)/release/sandbox-egress-proxy" /egress-proxy

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/schemavaults/sandbox-management-sdk" \
      org.opencontainers.image.description="Egress proxy that enforces network allowlists for @schemavaults/sandbox-management-sdk Docker sandboxes" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /egress-proxy /egress-proxy
# There is no /etc/passwd to name a user in: 65532 is the conventional "nonroot".
USER 65532:65532
EXPOSE 3128
# The provider waits for "healthy" before starting the sandbox; --start-interval
# makes that take milliseconds instead of a full interval.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=100ms --retries=3 \
  CMD ["/egress-proxy", "--health"]
ENTRYPOINT ["/egress-proxy"]
