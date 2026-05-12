import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { createHttpJsonChatClient } from "@svc/api-client";
import { colors, radius, spacing } from "@svc/tokens";

const client = createHttpJsonChatClient({
  baseUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080",
});

type RoundTripState = {
  username: string;
  message: string;
  error: string;
};

export default function Index() {
  const [state, setState] = useState<RoundTripState>({
    username: "",
    message: "Waiting for HTTP JSON...",
    error: "",
  });

  const runRoundTrip = useCallback(async () => {
    const suffix = Date.now().toString(36);
    const userResponse = await client.createUser({
      username: `mobile-${suffix}`,
      displayName: "Mobile Demo",
    });
    if (!userResponse.user) {
      throw new Error("CreateUser returned no user");
    }

    let surfacedError = "";
    try {
      await client.createUser({ username: "" });
    } catch (error) {
      surfacedError = error instanceof Error ? error.message : String(error);
      console.error(error);
    }

    setState({
      username: userResponse.user.username,
      message: "Hello from Expo and ConnectRPC.",
      error: surfacedError,
    });
  }, []);

  useEffect(() => {
    runRoundTrip().catch((error) => {
      setState((current) => ({
        ...current,
          message: "HTTP JSON request failed.",
        error: error instanceof Error ? error.message : String(error),
      }));
      console.error(error);
    });
  }, [runRoundTrip]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Proto-first mobile</Text>
        <Text style={styles.title}>Agent-first Expo app</Text>
        <Text style={styles.subtitle} selectable>
          Native React Native UI calling the shared ChatService contract over plain HTTP JSON.
        </Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Latest user</Text>
        <Text style={styles.value} selectable>
          {state.username || "No user yet"}
        </Text>
        <Text style={styles.message} selectable>
          {state.message}
        </Text>
      </View>

      {state.error ? (
        <View style={styles.errorPanel}>
          <Text style={styles.label}>Surfaced error</Text>
          <Text style={styles.errorText} selectable>
            {state.error}
          </Text>
        </View>
      ) : null}

      <Pressable style={styles.button} onPress={() => runRoundTrip()}>
        <Text style={styles.buttonText}>Run round-trip</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.xl,
    gap: spacing.lg,
  },
  header: {
    gap: spacing.sm,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: {
    color: colors.foreground,
    fontSize: 32,
    fontWeight: "800",
  },
  subtitle: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 22,
  },
  panel: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  errorPanel: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderWidth: 1,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "700",
  },
  value: {
    color: colors.foreground,
    fontSize: 20,
    fontWeight: "700",
  },
  message: {
    color: colors.foreground,
    fontSize: 16,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
  },
  button: {
    alignItems: "center",
    borderRadius: radius.md,
    borderCurve: "continuous",
    backgroundColor: colors.accent,
    padding: spacing.md,
  },
  buttonText: {
    color: colors.accentForeground,
    fontSize: 16,
    fontWeight: "700",
  },
});
