type ConnectResponse = {
  message: string;
};

export async function handleRequest(request: Request) {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    return Response.json({ status: "ok", runtime: "bun", framework: "connectrpc" });
  }

  if (url.pathname === "/rpc.example.v1.Service/Ping" && request.method === "POST") {
    const payload = (await request.json().catch(() => ({}))) as { name?: string };
    const body: ConnectResponse = {
      message: `hello ${payload.name?.trim() || "{{SERVICE_NAME}}"}`,
    };
    return Response.json(body, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

if (import.meta.main) {
  Bun.serve({
    port: Number(Bun.env.PORT ?? 8080),
    fetch: handleRequest,
  });
}
