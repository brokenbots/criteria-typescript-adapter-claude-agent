# syntax=docker/dockerfile:1
FROM debian:bookworm-slim
COPY bin/criteria-adapter-claude-agent /criteria-adapter-claude-agent
COPY proto /proto
ENTRYPOINT ["/criteria-adapter-claude-agent"]
