# Image for the Docker e2e tests: alpine + git + busybox, with a local git
# repository to clone so the tests need no network access.
ARG BASE_IMAGE=alpine/git:v2.54.0
FROM ${BASE_IMAGE}
RUN git init -q -b main /srv/fixture-repo \
 && cd /srv/fixture-repo \
 && echo "fixture v1" > README.md \
 && git add README.md \
 && git -c user.name=fixture -c user.email=fixture@example.com commit -q -m v1 \
 && git tag v1 \
 && echo "fixture v2" > README.md \
 && git -c user.name=fixture -c user.email=fixture@example.com commit -q -am v2
