# AgentRegistry, plus git.
#
# The published server image resolves git-sourced Skills and Plugins by shelling
# out to `git ls-remote`, but ships no git binary — so every such resource lands
# in `Ready: False` with `SourceUnresolvable: exec: "git": executable file not
# found in $PATH`. That makes the whole git-sourced half of the catalog, which
# is what Executor's GitHub quick add produces, inert.
#
# This adds git on top of the published image and changes nothing else: same
# CMD, same user, same version pin. Drop this file and point the compose service
# back at the upstream image once it carries git itself.
ARG AGENTREGISTRY_VERSION=v0.4.0
FROM ghcr.io/agentregistry-dev/agentregistry/server:${AGENTREGISTRY_VERSION}

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
