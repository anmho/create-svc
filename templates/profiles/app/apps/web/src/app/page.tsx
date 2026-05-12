import { MessageCircle, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createDemoChat } from "@/lib/demo-chat";

export const dynamic = "force-dynamic";

export default async function Home() {
  const demo = await createDemoChat();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <MessageCircle className="h-4 w-4" />
          ConnectRPC app workspace
        </div>
        <h1 className="text-4xl font-semibold tracking-normal">Agent-first mobile and web starter</h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Next.js renders this page through a server-side HTTP JSON client backed by Protobuf-ES models. Expo uses the same proto contract over plain HTTP.
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Latest chat message</CardTitle>
            <CardDescription>Created through the shared ChatService contract.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="rounded-md border bg-muted p-4">
              <p className="text-sm text-muted-foreground">{demo.user.username}</p>
              <p className="text-lg font-medium">{demo.message.body}</p>
            </div>
            <Button>Web HTTP JSON round-trip complete</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" />
              <CardTitle>Mobile parity</CardTitle>
            </div>
            <CardDescription>Expo Go calls the same HTTP JSON edge on the iOS Simulator.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Run <code className="font-mono">bun run go</code> to start API, web, and mobile together.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
