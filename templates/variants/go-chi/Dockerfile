FROM golang:1.25.4 AS builder

WORKDIR /app

COPY go.mod ./
COPY gen ./gen
COPY internal ./internal
COPY cmd ./cmd

RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/server ./cmd/server

FROM gcr.io/distroless/base-debian12

WORKDIR /app

COPY --from=builder /out/server /app/server

ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["/app/server"]
