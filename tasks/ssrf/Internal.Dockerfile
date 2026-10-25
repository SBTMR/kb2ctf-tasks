FROM golang:1.26-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c AS builder
WORKDIR /src
COPY internal/go.mod internal/main.go ./
RUN gofmt -w *.go && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /lab-service .
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN groupadd --gid 10001 lab && useradd --uid 10001 --gid lab --no-create-home lab
COPY --from=builder /lab-service /usr/local/bin/lab-service
USER 10001:10001
EXPOSE 1337 8080
CMD ["/usr/local/bin/lab-service"]
